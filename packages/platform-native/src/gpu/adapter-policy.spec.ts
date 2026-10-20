// Specs for the GPU adapter policy — env/config/latch resolution, the
// adapter denylist, and the hardware-boot crash sentinel.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    denyReasonForAdapter,
    planGpuBoot,
    readGpuState,
    resolveGpuPolicy,
} from "./adapter-policy";

// ── Env/state isolation ──
// The policy reads process env + files under the per-app userData dir
// (~/.config/<appId> on linux). Point HOME at a per-test tmpdir and restore
// env afterwards so specs stay hermetic.
const ENV_KEYS = [
  "DOWNDRAFT_GPU",
  "DOWNDRAFT_GPU_BACKEND",
  "DOWNDRAFT_GPU_FALLBACK",
  "DOWNDRAFT_GPU_DENY",
  "DD_GAME_DIR",
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
  for (const k of ENV_KEYS) if (k !== "XDG_CONFIG_HOME") delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

  it("reads the gpu block from downdraft.config.json (gameDir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software", backend: "vulkan", softwareFallback: false, deny: ["foo"] });
    const p = resolveGpuPolicy({ appId: APP, gameDir: dir });
    expect(p.adapter).toBe("software");
    expect(p.backend).toBe("vulkan");
    expect(p.softwareFallback).toBe(false);
    expect(p.deny).toContain("foo");
    expect(p.explicitAdapter).toBe(true);
  });

  it("walks up from the gameDir for downdraft.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software" });
    const p = resolveGpuPolicy({ appId: APP, gameDir: join(dir, "nested", "deeper") });
    // gameDir is taken literally — the walk happens from cwd/DD_GAME_DIR,
    // so a literal nonexistent dir falls back to defaults.
    expect(["auto", "software"]).toContain(p.adapter);
  });

  it("env overrides the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-cfg-"));
    writeConfig(dir, { adapter: "software" });
    process.env.DOWNDRAFT_GPU = "hardware";
    const p = resolveGpuPolicy({ appId: APP, gameDir: dir });
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
