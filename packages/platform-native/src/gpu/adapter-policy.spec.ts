// Specs for the GPU adapter policy — env/config/latch resolution, the
// adapter denylist, and the hardware-boot crash sentinel.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    adapterIdentityChanged,
    denyReasonForAdapter,
    LATCH_RETRY_BASE_MS,
    planGpuBoot,
    readGpuState,
    recordHardwareAttempt,
    resolveGpuPolicy,
} from "./adapter-policy";

// ── Env/state isolation ──
// The policy reads process env + files under the per-app userData dir
// (~/.config/<appId> on linux). Point HOME at a per-test tmpdir and restore
// env afterwards so specs stay hermetic.
const ENV_KEYS = [
  "DOWNDRAFT_GPU",
  "DOWNDRAFT_GPU_MODE",
  "DOWNDRAFT_GPU_BACKEND",
  "DOWNDRAFT_GPU_FALLBACK",
  "DOWNDRAFT_GPU_DENY",
  "DD_APP_DIR",
  "XDG_CONFIG_HOME",
];

let savedEnv: Record<string, string | undefined> = {};
let tmpHome: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpHome = mkdtempSync(join(tmpdir(), "gpu-policy-"));
  // resolveNativeUserDataDir prefers XDG_CONFIG_HOME over ~/.config —
  // hermetic per-test root without depending on homedir() env semantics.
  process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  ENV_KEYS.forEach((k) => { if (k !== "XDG_CONFIG_HOME") delete process.env[k]; });
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

const APP = "spec-app";
const stateDir = () => join(tmpHome, ".config", APP, "gpu");
const writeConfig = (dir: string, gpu: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "downdraft.config.json"), JSON.stringify({ gpu }));
};
const writeState = (state: object) => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "gpu-state.json"), JSON.stringify(state));
};
const writeSentinel = (nonce = "stale-other-process") => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "hardware-boot.pending"), JSON.stringify({ nonce, pid: 1, ts: 1 }));
};

describe("resolveGpuPolicy", () => {
  it("defaults to auto + softwareFallback for apps with no config", () => {
    const p = resolveGpuPolicy({ appId: APP });
    expect(p.adapter).toBe("auto");
    expect(p.backend).toBe("auto");
    expect(p.softwareFallback).toBe(true);
    expect(p.explicitAdapter).toBe(false);
  });

  it("reads the gpu block from downdraft.config.json (appDir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software", backend: "vulkan", softwareFallback: false, deny: ["foo"] });
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.adapter).toBe("software");
    expect(p.backend).toBe("vulkan");
    expect(p.softwareFallback).toBe(false);
    expect(p.deny).toContain("foo");
    expect(p.explicitAdapter).toBe(true);
  });

  it("mode=performance presets hardware-only — no fallback chain (apps)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { mode: "performance" });
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.adapter).toBe("hardware");
    expect(p.softwareFallback).toBe(false);
    expect(p.glFallback).toBe(false);
    expect(p.explicitAdapter).toBe(true);
  });

  it("mode=stability presets the graceful chain — auto + software + gl tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { mode: "stability" });
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.adapter).toBe("auto");
    expect(p.softwareFallback).toBe(true);
    expect(p.glFallback).toBe(true);
  });

  it("granular fields override the mode preset they sit beside", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { mode: "stability", softwareFallback: false });
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.glFallback).toBe(true); // preset applied
    expect(p.softwareFallback).toBe(false); // explicit field wins
  });

  it("DOWNDRAFT_GPU_MODE applies the preset and outranks config fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software" });
    process.env.DOWNDRAFT_GPU_MODE = "performance";
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.adapter).toBe("hardware");
    expect(p.softwareFallback).toBe(false);
  });

  it("performance mode counts as an explicit choice — beats the latch", () => {
    writeState({ latchedAdapter: "software", hardwareBootCrashes: 3 });
    process.env.DOWNDRAFT_GPU_MODE = "performance";
    expect(resolveGpuPolicy({ appId: APP }).adapter).toBe("hardware");
  });

  it("walks up from the appDir for downdraft.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software" });
    const p = resolveGpuPolicy({ appId: APP, appDir: join(dir, "nested", "deeper") });
    // appDir is taken literally — the walk happens from cwd/DD_APP_DIR,
    // so a literal nonexistent dir falls back to defaults.
    expect(["auto", "software"]).toContain(p.adapter);
  });

  it("env overrides the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software" });
    process.env.DOWNDRAFT_GPU = "hardware";
    const p = resolveGpuPolicy({ appId: APP, appDir: dir });
    expect(p.adapter).toBe("hardware");
  });

  it("DOWNDRAFT_GPU=swiftshader selects the software adapter", () => {
    process.env.DOWNDRAFT_GPU = "swiftshader";
    expect(resolveGpuPolicy({ appId: APP }).adapter).toBe("software");
  });

  it("DOWNDRAFT_GPU_FALLBACK=0 disables the software fallback", () => {
    process.env.DOWNDRAFT_GPU_FALLBACK = "0";
    expect(resolveGpuPolicy({ appId: APP }).softwareFallback).toBe(false);
  });

  it("DOWNDRAFT_GPU_DENY appends deny substrings", () => {
    process.env.DOWNDRAFT_GPU_DENY = "foo, bar";
    expect(resolveGpuPolicy({ appId: APP }).deny).toEqual(["foo", "bar"]);
  });

  it("honors the persisted software latch in auto mode", () => {
    writeState({ latchedAdapter: "software", hardwareBootCrashes: 3 });
    const p = resolveGpuPolicy({ appId: APP });
    expect(p.adapter).toBe("software");
    expect(p.explicitAdapter).toBe(false);
  });

  it("relaxes a restrictive backend when the software adapter is selected (no GL fallbacks)", () => {
    process.env.DOWNDRAFT_GPU = "swiftshader";
    process.env.DOWNDRAFT_GPU_BACKEND = "gl";
    const p = resolveGpuPolicy({ appId: APP });
    expect(p.adapter).toBe("software");
    expect(p.backend).toBe("auto");
  });

  it("keeps a restrictive backend for hardware attempts", () => {
    process.env.DOWNDRAFT_GPU = "hardware";
    process.env.DOWNDRAFT_GPU_BACKEND = "gl";
    const p = resolveGpuPolicy({ appId: APP });
    expect(p.backend).toBe("gl");
  });

  it("explicit hardware beats the persisted latch", () => {
    writeState({ latchedAdapter: "software", hardwareBootCrashes: 3 });
    process.env.DOWNDRAFT_GPU = "hardware";
    expect(resolveGpuPolicy({ appId: APP }).adapter).toBe("hardware");
  });
});

describe("denyReasonForAdapter", () => {
  it("denies the venus driver (aborts in requestDevice)", () => {
    const r = denyReasonForAdapter({ name: "Virtio-GPU Venus", driver: "venus", backend: "vulkan" });
    expect(r).toContain("venus");
  });

  it("denies by adapter name too", () => {
    const r = denyReasonForAdapter({ name: "gfxstream virtual gpu", driver: "", backend: "vulkan" });
    expect(r).toContain("gfxstream");
  });

  it("allows real hardware", () => {
    expect(denyReasonForAdapter({ name: "NVIDIA RTX 3090", driver: "nvidia", backend: "vulkan" })).toBeNull();
    expect(denyReasonForAdapter({ name: "llvmpipe", driver: "llvmpipe", backend: "vulkan", deviceType: "cpu" })).toBeNull();
  });

  it("matches extra deny entries case-insensitively", () => {
    const r = denyReasonForAdapter({ name: "SomeGPU", driver: "WeirdDrv" }, ["WEIRDDRV"]);
    expect(r).toContain("WEIRDDRV");
  });
});

describe("planGpuBoot + crash sentinel", () => {
  it("arms the sentinel on a hardware attempt and markHealthy disarms it", () => {
    const plan = planGpuBoot({ appId: APP });
    expect(plan.tryHardwareFirst).toBe(true);
    const sentinel = join(stateDir(), "hardware-boot.pending");
    expect(existsSync(sentinel)).toBe(true);
    plan.markHealthy();
    expect(existsSync(sentinel)).toBe(false);
    expect(readGpuState({ appId: APP }).hardwareBootCrashes ?? 0).toBe(0);
  });

  it("does not re-count its own sentinel when planned twice", () => {
    planGpuBoot({ appId: APP });
    const second = planGpuBoot({ appId: APP });
    expect(second.detectedCrash).toBe(false);
    expect(readGpuState({ appId: APP }).hardwareBootCrashes ?? 0).toBe(0);
    second.markHealthy();
  });

  it("counts a stale sentinel as a previous crash and latches at the threshold", () => {
    writeSentinel();
    const first = planGpuBoot({ appId: APP });
    expect(first.detectedCrash).toBe(true);
    expect(first.tryHardwareFirst).toBe(true); // crash #1 — one retry allowed
    // No markHealthy: simulating a second consecutive process death. The
    // foreign-nonce sentinel overwrites the one `first` armed.
    writeSentinel();
    const second = planGpuBoot({ appId: APP });
    expect(second.detectedCrash).toBe(true);
    expect(second.tryHardwareFirst).toBe(false); // crash #2 — latched
    expect(readGpuState({ appId: APP }).latchedAdapter).toBe("software");

    // The stale marker is consumed — the next plan must not re-count it.
    const third = planGpuBoot({ appId: APP });
    expect(third.detectedCrash).toBe(false);
    expect(third.tryHardwareFirst).toBe(false);
  });

  it("goes straight to software in explicit software mode without arming the sentinel", () => {
    process.env.DOWNDRAFT_GPU = "swiftshader";
    const plan = planGpuBoot({ appId: APP });
    expect(plan.tryHardwareFirst).toBe(false);
    expect(existsSync(join(stateDir(), "hardware-boot.pending"))).toBe(false);
  });
});

describe("crash-latch recovery", () => {
  const latchedState = (extra: object = {}) => ({
    latchedAdapter: "software",
    latchedAt: new Date().toISOString(),
    latchRetryMs: LATCH_RETRY_BASE_MS,
    latchedAdapterInfo: { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" },
    ...extra,
  });

  it("latching snapshots the driver stack that crashed", () => {
    writeState({
      hardwareBootCrashes: 1,
      lastHardwareAdapterInfo: { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" },
    });
    writeSentinel();
    const plan = planGpuBoot({ appId: APP });
    expect(plan.latched).toBe(true);
    const s = readGpuState({ appId: APP });
    expect(s.latchedAdapter).toBe("software");
    expect(s.latchedAdapterInfo?.driverInfo).toBe("535.1");
    expect(s.latchRetryMs).toBe(LATCH_RETRY_BASE_MS);
    expect(s.latchedAt).toBeTruthy();
  });

  it("unlatches when the probed driver stack differs from the one that crashed", () => {
    writeState(latchedState());
    const plan = planGpuBoot({ appId: APP });
    expect(plan.latched).toBe(true);
    expect(plan.tryHardwareFirst).toBe(false);
    const reason = plan.latchRecoveryReason(
      { driver: "nvidia", driverInfo: "550.2", name: "RTX 3090" });
    expect(reason).toContain("changed");
    // Same stack, probation not due → stay on software.
    expect(plan.latchRecoveryReason(
      { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" })).toBeNull();
  });

  it("retryHardware flips the plan and a healthy boot clears all latch state", () => {
    writeState(latchedState());
    const plan = planGpuBoot({ appId: APP });
    plan.retryHardware("test recovery");
    expect(plan.tryHardwareFirst).toBe(true);
    expect(existsSync(join(stateDir(), "hardware-boot.pending"))).toBe(true);
    plan.markHealthy();
    const s = readGpuState({ appId: APP });
    expect(s.latchedAdapter).toBeUndefined();
    expect(s.latchedAdapterInfo).toBeUndefined();
    expect(s.latchRetryMs).toBeUndefined();
    expect(s.latchedAt).toBeUndefined();
    expect(s.probeDead).toBeUndefined();
  });

  it("probation recovers even when the driver stack is unchanged", () => {
    writeState(latchedState({
      latchedAt: new Date(Date.now() - LATCH_RETRY_BASE_MS - 1000).toISOString(),
    }));
    const plan = planGpuBoot({ appId: APP });
    expect(plan.probationDue()).toBe(true);
    expect(plan.latchRecoveryReason(
      { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" }))
      .toContain("probation");
  });

  it("probation not due → no recovery on an unchanged stack", () => {
    writeState(latchedState());
    const plan = planGpuBoot({ appId: APP });
    expect(plan.probationDue()).toBe(false);
    expect(plan.latchRecoveryReason(
      { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" })).toBeNull();
  });

  it("a recovery retry that dies re-latches with a doubled probation window", () => {
    writeState(latchedState());
    writeSentinel(); // the retry's armed sentinel, left behind by the death
    const plan = planGpuBoot({ appId: APP });
    expect(plan.detectedCrash).toBe(true);
    expect(plan.tryHardwareFirst).toBe(false);
    const s = readGpuState({ appId: APP });
    expect(s.latchedAdapter).toBe("software");
    expect(s.latchRetryMs).toBe(LATCH_RETRY_BASE_MS * 2);
  });

  it("a stale probe sentinel sets probeDead — recovery can only retry blind", () => {
    writeState(latchedState());
    writeFileSync(join(stateDir(), "probe-boot.pending"),
      JSON.stringify({ nonce: "stale-other-process", pid: 1, ts: 1 }));
    const plan = planGpuBoot({ appId: APP });
    expect(plan.probeDead).toBe(true);
    expect(readGpuState({ appId: APP }).probeDead).toBe(true);
    // probeDead blocks the probe but not probation itself.
    expect(plan.latched).toBe(true);
  });

  it("recordHardwareAttempt snapshots the driver stack and clears probeDead", () => {
    writeState({ probeDead: true });
    recordHardwareAttempt({ appId: APP }, { driver: "nvidia", driverInfo: "550.2", name: "RTX 3090" });
    const s = readGpuState({ appId: APP });
    expect(s.lastHardwareAdapterInfo?.driverInfo).toBe("550.2");
    expect(s.probeDead).toBeUndefined();
  });

  it("adapterIdentityChanged compares the full stack identity", () => {
    const a = { driver: "nvidia", driverInfo: "535.1", name: "RTX 3090" };
    expect(adapterIdentityChanged(a, { ...a, driverInfo: "550.2" })).toBe(true);
    expect(adapterIdentityChanged(a, { ...a })).toBe(false);
    expect(adapterIdentityChanged(undefined, a)).toBe(false);
    expect(adapterIdentityChanged(a, null)).toBe(false);
  });

  it("explicit software is not 'latched' — no recovery probing", () => {
    writeState(latchedState());
    process.env.DOWNDRAFT_GPU = "swiftshader";
    const plan = planGpuBoot({ appId: APP });
    expect(plan.latched).toBe(false);
    expect(plan.latchRecoveryReason({ driver: "other" })).toBeNull();
  });
});
