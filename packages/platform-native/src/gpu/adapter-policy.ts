// ============================================================================
// adapter-policy.ts — GPU adapter/backend policy resolution + crash recovery
//
// The "GPU settings" for an app, highest precedence first:
//
//   1. Spawn-time env vars — DOWNDRAFT_GPU (swiftshader|hardware|auto),
//      DOWNDRAFT_GPU_MODE (performance|stability), DOWNDRAFT_GPU_BACKEND
//      (vulkan|gl), DOWNDRAFT_GPU_FALLBACK (0|1), DOWNDRAFT_GPU_DENY
//      (comma-separated driver/name substrings).
//   2. downdraft.config.json "gpu" block — the per-app settings file:
//        { "gpu": { "mode": "performance"|"stability",
//                   "adapter": "auto"|"hardware"|"software",
//                   "backend": "auto"|"vulkan"|"gl",
//                   "softwareFallback": true|false,
//                   "glFallback": true|false,
//                   "deny": ["driver-substring", ...] } }
//      "mode" is the coarse app knob — a preset: "performance" (games)
//      means hardware-only, never silently degrade; "stability" (desktop
//      apps) means the graceful chain vulkan → gl(virgl) → software.
//      The granular fields may be set beside it to override individual
//      pieces of the preset.
//      Resolved from DD_GAME_DIR, else by walking up from cwd — games set
//      it declaratively; standalone configs flow through `draft dev`.
//   3. Persisted engine state — <userData>/gpu/gpu-state.json. The boot
//      sentinel (below) latches `latchedAdapter: "software"` after repeated
//      hardware-boot deaths so crashy drivers stop being retried. Delete
//      the file (or set adapter:"hardware") to try hardware again.
//
// Non-game apps — test-beds and bespoke createNativeHost callers with no
// downdraft.config.json — get the defaults wholesale: auto adapter with
// softwareFallback ON, so a crashy hardware driver degrades to the
// software adapter instead of killing the app.
//
// Crash recovery: adapter requests that die inside the driver (Venus and
// other virtualization layers abort() rather than return an error) kill the
// process before JS can retry — the ONLY fallback that works there is
// trying again next boot. planGpuBoot() therefore writes a sentinel file
// before every hardware attempt and removes it once a frame has been
// presented (or on clean exit). A stale sentinel on the next boot counts as
// a hardware-boot crash; after CRASH_LATCH_THRESHOLD it latches the app
// onto the software adapter.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNativeUserDataDir } from "../bridge/user-data-dir";

const log = createLogger("info");

// ── Types ──

/** Adapter selection mode. "auto" tries the real adapter first and may
 *  fall back to wgpu's software adapter (llvmpipe/lavapipe — the
 *  "swiftshader" path). "software" goes straight to the fallback adapter.
 *  "hardware" insists on the real adapter (no fallback). */
export type GpuAdapterMode = "auto" | "hardware" | "software";

/** Backend restrictor — maps onto wgpu_shim_create_instance_ex. */
export type GpuBackend = "auto" | "vulkan" | "gl" | "metal" | "dx12";

/** Graphics-mode preset — the "app settings" knob:
 *    performance — hardware adapter or nothing (games): no fallback chain.
 *    stability   — degrade gracefully (desktop apps): try the primary
 *                  backend, then the GL backend (virgl), then software. */
export type GpuMode = "performance" | "stability";

export interface GpuPolicy {
  adapter: GpuAdapterMode;
  backend: GpuBackend;
  /** auto mode: retry on the software adapter when the hardware attempt
   *  fails, is denied, or crashed last boot. */
  softwareFallback: boolean;
  /** auto+backend:auto: after the primary hardware attempt fails or is
   *  denied, retry on the GLES backend (virgl/ANGLE) before dropping to
   *  the software adapter. Set by mode:"stability" or "glFallback":true. */
  glFallback: boolean;
  /** Extra denylist substrings (matched case-insensitively against the
   *  adapter's driver|name|backend). */
  deny: string[];
  /** The adapter mode came from an explicit env/config choice — the crash
   *  latch must not override a deliberate hardware/software request. */
  explicitAdapter: boolean;
  /** Human-readable resolution trail for boot logs. */
  source: string;
}

export interface GpuPolicyInput {
  /** Per-app id — resolves the userData dir for the persisted crash latch. */
  appId?: string;
  /** Dir containing downdraft.config.json. Defaults to DD_GAME_DIR, then a
   *  cwd walk — non-game apps have no config and take the defaults. */
  gameDir?: string;
}

// ── Adapter denylist ──
// Drivers that are known to abort() the process (rather than return an
// error) somewhere in request_device/swapchain setup on this stack — the
// check runs after adapter info is readable but BEFORE requestDevice, which
// is the only safe interception point.
//   venus     — Mesa's virtio-gpu Vulkan passthrough (aborts in vkCreateDevice)
//   gfxstream — Android Emulator's Vulkan forwarder (same failure class)
const BUILTIN_DENY = ["venus", "gfxstream"];

export interface AdapterIdentity {
  driver?: string;
  name?: string;
  backend?: string;
  deviceType?: string;
}

/**
 * Why this adapter must not reach requestDevice, or null when it's allowed.
 * `extra` extends the built-in denylist (config "gpu.deny" /
 * DOWNDRAFT_GPU_DENY).
 */
export function denyReasonForAdapter(
  info: AdapterIdentity | null | undefined,
  extra: readonly string[] = [],
): string | null {
  if (!info) return null;
  const hay = `${info.driver ?? ""}|${info.name ?? ""}|${info.backend ?? ""}`.toLowerCase();
  const hit = [...BUILTIN_DENY, ...extra].find((d) => d && hay.includes(d.toLowerCase()));
  return hit
    ? `denied adapter "${info.name ?? "?"}" (driver "${info.driver ?? "?"}", backend "${info.backend ?? "?"}") — matches denylist entry "${hit}"`
    : null;
}

// ── downdraft.config.json "gpu" block ──

const ADAPTER_MODES: ReadonlySet<string> = new Set(["auto", "hardware", "software"]);
const BACKENDS: ReadonlySet<string> = new Set(["auto", "vulkan", "gl", "metal", "dx12"]);
const GPU_MODES: ReadonlySet<string> = new Set(["performance", "stability"]);

/** Apply a mode preset — granular fields set alongside it still win. */
function applyMode(policy: GpuPolicy, mode: GpuMode): void {
  if (mode === "performance") {
    policy.adapter = "hardware";
    policy.softwareFallback = false;
    policy.glFallback = false;
  } else {
    policy.adapter = "auto";
    policy.softwareFallback = true;
    policy.glFallback = true;
  }
}

/** dir → parsed "gpu" block (null = no config / no block). Cached — the
 *  file is static per boot and the resolver runs on several call sites. */
const configCache = new Map<string, Record<string, unknown> | null>();

/** Walk up from `seed` for downdraft.config.json. */
function findConfigDir(seed: string): string | null {
  let dir = seed;
  for (;;) {
    if (existsSync(join(dir, "downdraft.config.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readGpuConfigBlock(gameDir?: string): Record<string, unknown> {
  const dir = gameDir ?? process.env.DD_GAME_DIR ?? findConfigDir(process.cwd());
  if (!dir) return {};
  if (configCache.has(dir)) return configCache.get(dir) ?? {};
  let gpu: Record<string, unknown> | null = null;
  try {
    const cfg = JSON.parse(readFileSync(join(dir, "downdraft.config.json"), "utf8"));
    if (cfg?.gpu && typeof cfg.gpu === "object") gpu = cfg.gpu;
  } catch { /* missing/invalid config — defaults apply */ }
  configCache.set(dir, gpu);
  return gpu ?? {};
}

// ── Persisted engine state (crash latch) ──

export interface GpuPersistedState {
  /** Set after repeated hardware-boot deaths — forces the software adapter
   *  until cleared (config adapter:"hardware" overrides it). */
  latchedAdapter?: "software";
  /** Consecutive boots that died mid hardware-attempt. */
  hardwareBootCrashes?: number;
  /** ISO timestamp of the last detected hardware-boot crash. */
  lastHardwareCrash?: string;
}

function gpuStateDir(input: GpuPolicyInput): string {
  const base = input.appId
    ? resolveNativeUserDataDir(input.appId)
    : join(homedir(), ".downdraft");
  return join(base, "gpu");
}

function gpuStatePath(input: GpuPolicyInput): string {
  return join(gpuStateDir(input), "gpu-state.json");
}

function gpuSentinelPath(input: GpuPolicyInput): string {
  return join(gpuStateDir(input), "hardware-boot.pending");
}

export function readGpuState(input: GpuPolicyInput = {}): GpuPersistedState {
  try {
    const s = JSON.parse(readFileSync(gpuStatePath(input), "utf8"));
    if (s && typeof s === "object") return s as GpuPersistedState;
  } catch { /* absent/corrupt — clean state */ }
  return {};
}

function writeGpuState(input: GpuPolicyInput, state: GpuPersistedState): void {
  try {
    mkdirSync(gpuStateDir(input), { recursive: true });
    writeFileSync(gpuStatePath(input), JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn("gpu", `gpu-state persist failed: ${(e as Error).message}`);
  }
}

// ── Policy resolution ──

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "1" || v.toLowerCase() === "true") return true;
    if (v === "0" || v.toLowerCase() === "false") return false;
  }
  return undefined;
}

export function resolveGpuPolicy(input: GpuPolicyInput = {}): GpuPolicy {
  const source: string[] = ["defaults"];
  const policy: GpuPolicy = {
    adapter: "auto",
    backend: "auto",
    softwareFallback: true,
    glFallback: false,
    deny: [],
    explicitAdapter: false,
    source: "",
  };

  // downdraft.config.json "gpu" block — mode preset first, then the
  // explicit granular fields (they outrank the preset they sit beside).
  const cfg = readGpuConfigBlock(input.gameDir);
  if (Object.keys(cfg).length) source.push("downdraft.config.json");
  if (typeof cfg.mode === "string" && GPU_MODES.has(cfg.mode)) {
    applyMode(policy, cfg.mode as GpuMode);
    source.push(`mode=${cfg.mode}`);
  }
  if (typeof cfg.adapter === "string" && ADAPTER_MODES.has(cfg.adapter)) {
    policy.adapter = cfg.adapter as GpuAdapterMode;
  }
  if (typeof cfg.backend === "string" && BACKENDS.has(cfg.backend)) {
    policy.backend = cfg.backend as GpuBackend;
  }
  const cfgFallback = parseBool(cfg.softwareFallback);
  if (cfgFallback !== undefined) policy.softwareFallback = cfgFallback;
  const cfgGl = parseBool(cfg.glFallback);
  if (cfgGl !== undefined) policy.glFallback = cfgGl;
  if (Array.isArray(cfg.deny)) {
    policy.deny.push(...cfg.deny.filter((d): d is string => typeof d === "string"));
  }

  // env — spawn-time overrides, outrank the config file
  const envMode = process.env.DOWNDRAFT_GPU_MODE;
  if (envMode && GPU_MODES.has(envMode)) {
    applyMode(policy, envMode as GpuMode);
    source.push(`DOWNDRAFT_GPU_MODE=${envMode}`);
  }
  const envGpu = process.env.DOWNDRAFT_GPU;
  if (envGpu === "swiftshader") { policy.adapter = "software"; source.push("DOWNDRAFT_GPU=swiftshader"); }
  else if (envGpu === "hardware") { policy.adapter = "hardware"; source.push("DOWNDRAFT_GPU=hardware"); }
  else if (envGpu === "auto") { policy.adapter = "auto"; source.push("DOWNDRAFT_GPU=auto"); }
  const envBackend = process.env.DOWNDRAFT_GPU_BACKEND;
  if (envBackend && BACKENDS.has(envBackend)) {
    policy.backend = envBackend as GpuBackend;
    source.push(`DOWNDRAFT_GPU_BACKEND=${envBackend}`);
  }
  const envFallback = parseBool(process.env.DOWNDRAFT_GPU_FALLBACK);
  if (envFallback !== undefined) { policy.softwareFallback = envFallback; source.push("DOWNDRAFT_GPU_FALLBACK"); }
  const envDeny = process.env.DOWNDRAFT_GPU_DENY;
  if (envDeny) {
    policy.deny.push(...envDeny.split(",").map((d) => d.trim()).filter(Boolean));
    source.push("DOWNDRAFT_GPU_DENY");
  }

  policy.explicitAdapter = policy.adapter !== "auto";

  // Persisted crash latch — applies only when nothing explicitly chose the
  // adapter (auto). An explicit hardware/software choice wins.
  if (policy.adapter === "auto") {
    const state = readGpuState(input);
    if (state.latchedAdapter === "software") {
      policy.adapter = "software";
      source.push(`gpu-state latch (${state.hardwareBootCrashes ?? "?"} hardware-boot crashes)`);
    }
  }

  // The software adapter doesn't exist on every backend — GLES has no
  // fallback adapters at all (llvmpipe lives on Vulkan, WARP on Dx12). A
  // software resolution must therefore relax a GL-only backend restriction
  // so the fallback adapter can come from any backend.
  if (policy.adapter === "software" && policy.backend === "gl") {
    source.push("backend=gl → auto (software adapter)");
    policy.backend = "auto";
  }

  policy.source = source.join(" → ");
  return policy;
}

// ── Boot plan + crash sentinel ──

/** After this many consecutive hardware-boot deaths, latch the app onto
 *  the software adapter until gpu-state.json is removed or the config
 *  explicitly requests hardware. */
export const CRASH_LATCH_THRESHOLD = 2;

/** Per-process identity stamped into the sentinel — the dev shell's early
 *  boot and createNativeHost both plan within ONE process; a sentinel that
 *  carries our nonce is our own in-flight attempt, not a previous crash. */
const PROCESS_NONCE = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface GpuBootPlan {
  /** The resolved policy (post-latch). */
  policy: GpuPolicy;
  /** Attempt the real adapter first? False → go straight to the software
   *  adapter (explicit software mode or latched after crashes). */
  tryHardwareFirst: boolean;
  /** True when a stale sentinel from a previous dead boot was detected. */
  detectedCrash: boolean;
  /** Call when the GPU stack is proven healthy — the first presented frame
   *  (NativeCanvasContext's first acquire) or a clean host teardown. Clears
   *  the sentinel and the crash counter; also clears the latch when the
   *  healthy boot ran on hardware. Idempotent. */
  markHealthy(): void;
}

/**
 * Resolve the GPU plan for this boot and arm the crash sentinel when a
 * hardware adapter will be attempted. MUST run before the adapter request —
 * a driver that aborts mid-request leaves the sentinel behind for the next
 * boot to find.
 */
export function planGpuBoot(input: GpuPolicyInput = {}): GpuBootPlan {
  const policy = resolveGpuPolicy(input);
  const sentinelPath = gpuSentinelPath(input);
  // An explicit adapter choice (env/config) overrides the crash latch —
  // the user asked for this mode on purpose.
  const explicitAdapter = policy.explicitAdapter;

  const state = readGpuState(input);
  let detectedCrash = false;

  if (existsSync(sentinelPath)) {
    let stale = true;
    try {
      const marker = JSON.parse(readFileSync(sentinelPath, "utf8"));
      stale = marker?.nonce !== PROCESS_NONCE;
    } catch { /* unparseable marker — treat as stale */ }
    if (stale) {
      detectedCrash = true;
      state.hardwareBootCrashes = (state.hardwareBootCrashes ?? 0) + 1;
      state.lastHardwareCrash = new Date().toISOString();
      if ((state.hardwareBootCrashes ?? 0) >= CRASH_LATCH_THRESHOLD && !explicitAdapter) {
        state.latchedAdapter = "software";
      }
      writeGpuState(input, state);
      log.error("gpu",
        `previous hardware GPU boot died before first frame (crash #${state.hardwareBootCrashes})` +
        (state.latchedAdapter && !explicitAdapter ? " — latching software adapter" : ""));
    }
    // The marker is consumed — a boot that now goes software-only (latched)
    // must not leave it behind to be re-counted next boot.
    clearSentinel();
  }

  // Re-apply the latch the stale-sentinel pass may just have set.
  if (policy.adapter === "auto" && state.latchedAdapter === "software") {
    policy.adapter = "software";
  }

  const tryHardwareFirst = policy.adapter !== "software";
  if (tryHardwareFirst) {
    try {
      mkdirSync(gpuStateDir(input), { recursive: true });
      writeFileSync(sentinelPath, JSON.stringify({ nonce: PROCESS_NONCE, pid: process.pid, ts: Date.now() }));
      // Clean exits aren't crashes — disarm on process exit so apps that
      // quit before first frame don't false-positive the next boot.
      process.once("exit", clearSentinel);
    } catch { /* no writable state dir — sentinel just doesn't arm */ }
  }

  function clearSentinel(): void {
    try { rmSync(sentinelPath); } catch { /* already gone */ }
  }

  let marked = false;
  const markHealthy = (): void => {
    if (marked) return;
    marked = true;
    clearSentinel();
    const s = readGpuState(input);
    // A proven-healthy boot resets the crash streak; a healthy HARDWARE
    // boot also clears the latch (explicit hardware choice that now works).
    if ((s.hardwareBootCrashes ?? 0) > 0 || (s.latchedAdapter && tryHardwareFirst)) {
      const next: GpuPersistedState = { ...s, hardwareBootCrashes: 0 };
      if (tryHardwareFirst) delete next.latchedAdapter;
      writeGpuState(input, next);
    }
  };

  return { policy, tryHardwareFirst, detectedCrash, markHealthy };
}
