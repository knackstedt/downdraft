// ============================================================================
// adapter-boot.ts — policy-driven adapter + device acquisition for host boots
//
// The single place the adapter/device dance happens for the host (native-
// host.ts) and the dev shell's early boot (early-host.ts):
//
//   planGpuBoot      → resolve policy, arm the crash sentinel, honor the
//                      crash latch and any explicit adapter choice
//   latch probe      → a crash-latched boot still probes the adapter (info
//                      query only) — a changed driver stack or elapsed
//                      probation unlatches and retries hardware
//   adapter request  → real adapter first (unless software-only)
//   deny check       → reject adapters known to abort() in requestDevice —
//                      the info query is the last safe interception point
//   device request   → on clean failure, retry the whole chain on the
//                      software adapter (softwareFallback). Process-abort
//                      failures are unrecoverable in-process — that's what
//                      the sentinel's next-boot latch is for.
//
// Returns the boot plan so the caller can fire markHealthy() at the first
// presented frame / clean teardown.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import { denyReasonForAdapter, planGpuBoot, recordHardwareAttempt, type GpuBootPlan, type GpuPolicyInput } from "./adapter-policy";
import { computeDeviceDescriptor } from "./device-request";
import { WgpuGPU, type NativeAdapterInfo, type WgpuAdapter, type WgpuDevice } from "./wgpu-device";

const log = createLogger("info");

export interface AcquireGpuOptions extends GpuPolicyInput {
  powerPreference?: "low-power" | "high-performance";
  /** Device descriptor factory — native-host and the early boot pass
   *  computeDeviceDescriptor so the union limits/features stay identical. */
  describeDevice?: (adapter: WgpuAdapter) => GPUDeviceDescriptor;
  /** Live window — the GL fallback tier rebinds its wgpu surface onto the
   *  winning instance (surfaces are instance-scoped). */
  window?: { recreateGpuSurface?(instancePtr: ptr): void } | null;
}

export interface AcquiredGpu {
  adapter: WgpuAdapter;
  device: WgpuDevice;
  info: NativeAdapterInfo | null;
  /** The wgpu instance the winning adapter/device live on — the caller's
   *  `gpu` argument for the primary path, a fresh GL-instance WgpuGPU when
   *  the GL fallback tier won. */
  gpu: WgpuGPU;
  /** The device came from the software/fallback adapter. */
  softwareFallback: boolean;
  plan: GpuBootPlan;
}

export async function acquireAdapterAndDevice(
  gpu: WgpuGPU,
  opts: AcquireGpuOptions = {},
): Promise<AcquiredGpu | null> {
  const powerPreference = opts.powerPreference ?? "high-performance";
  const describe = opts.describeDevice ?? computeDeviceDescriptor;
  const plan = planGpuBoot({ appId: opts.appId, appDir: opts.appDir });
  const { policy } = plan;

  log.info("gpu",
    `gpu policy: adapter=${policy.adapter} backend=${policy.backend} ` +
    `softwareFallback=${policy.softwareFallback} glFallback=${policy.glFallback} (${policy.source})`);

  const requestAdapter = (forceFallback: boolean) =>
    gpu.requestAdapter({ powerPreference, forceFallbackAdapter: forceFallback });

  let adapter: WgpuAdapter | null = null;
  let usedSoftware = false;

  const mayFallback = policy.softwareFallback && policy.adapter !== "hardware";
  // GL middle tier (mode:"stability" / glFallback): after the primary
  // backend's adapter is denied or dead, retry on a GLES instance — e.g.
  // virgl over a virtio GPU — before dropping to the software rasterizer.
  // Only when the backend wasn't pinned (a pinned backend means the caller
  // chose it deliberately).
  const mayGlFallback =
    policy.glFallback && policy.adapter === "auto" && policy.backend === "auto";

  // Crash-latched boot — the software adapter came from gpu-state.json,
  // not a user choice. Probe the environment before committing: a
  // requestAdapter + info query is the last safe interception point (the
  // abort risk lives in requestDevice), so it's a cheap check for a driver
  // stack that changed since the crashes — the common "user fixed the
  // driver" case — or an elapsed probation window. When the probe itself
  // can't run (probeDead, or it returned nothing) probation retries go in
  // blind via the normal hardware path below.
  if (!plan.tryHardwareFirst && plan.latched) {
    if (!plan.probeDead) {
      let probe: WgpuAdapter | null = null;
      plan.beginProbe();
      try {
        probe = await requestAdapter(false);
      } catch (e) {
        log.warn("gpu", `latch probe failed — staying on the software adapter (${(e as Error).message ?? e})`);
      } finally {
        // A thrown error still disarms — only a hard process death leaves
        // the sentinel behind to set probeDead.
        plan.endProbe();
      }
      if (probe) {
        const denyReason = denyReasonForAdapter(probe.nativeInfo, policy.deny);
        const recovery = denyReason ? null : plan.latchRecoveryReason(probe.nativeInfo);
        if (recovery) {
          plan.retryHardware(recovery);
          adapter = probe;
        } else {
          probe.release();
          if (denyReason) {
            log.warn("gpu", `${denyReason} — staying on the software adapter`);
          }
        }
      }
    }
    if (!adapter && plan.probationDue()) {
      plan.retryHardware("crash-latch probation elapsed");
    }
  }

  if (plan.tryHardwareFirst && !adapter) {
    adapter = await requestAdapter(false);
    if (adapter) {
      const reason = denyReasonForAdapter(adapter.nativeInfo, policy.deny);
      if (reason) {
        adapter.release();
        adapter = null;
        if (mayFallback || mayGlFallback) {
          log.warn("gpu", `${reason} — trying the ${mayGlFallback ? "GL backend" : "software adapter"}`);
        } else {
          log.error("gpu", `${reason} — no software fallback permitted (adapter=${policy.adapter})`);
        }
      }
    } else if (mayFallback || mayGlFallback) {
      log.warn("gpu", "hardware adapter request returned null");
    }
  }

  // Device request on the hardware adapter — a clean failure (returned
  // error, not a process abort) retries on the lower tiers.
  if (adapter && !adapter.__ddSoftwareAdapter) {
    // Snapshot the driver stack BEFORE requestDevice — a crash here is
    // what the latch attributes, so the record doubles as "who did it".
    recordHardwareAttempt(opts, adapter.nativeInfo);
    try {
      const device = await adapter.requestDevice(describe(adapter));
      return finish(adapter, device, gpu, false, plan);
    } catch (e) {
      if (!mayFallback && !mayGlFallback) throw e;
      log.warn("gpu", `hardware device request failed — falling back (${(e as Error).message ?? e})`);
      adapter.release();
      adapter = null;
    }
  }

  // GL tier — a second instance on the GLES backend. The losing instance's
  // surface must be rebound: wgpu surfaces are instance-scoped. The dead
  // primary instance is left registered (it's the event pump's process-
  // events target) — leaking it is cheaper than unsafe teardown order.
  if (!adapter && mayGlFallback) {
    const glGpu = new WgpuGPU("gl");
    const glAdapter = await glGpu.requestAdapter({ powerPreference });
    if (glAdapter) {
      const reason = denyReasonForAdapter(glAdapter.nativeInfo, policy.deny);
      if (reason) {
        log.warn("gpu", `${reason} — trying the software adapter`);
        glAdapter.release();
      } else {
        try {
          const device = await glAdapter.requestDevice(describe(glAdapter));
          adoptGpuInstance(glGpu, gpu, opts.window);
          return finish(glAdapter, device, glGpu, false, plan);
        } catch (e) {
          log.warn("gpu", `GL device request failed — falling back to the software adapter (${(e as Error).message ?? e})`);
          glAdapter.release();
        }
      }
    } else {
      log.warn("gpu", "no GL adapter — trying the software adapter");
    }
  }

  // Software path — explicit software mode, a denied/null hardware adapter,
  // or a failed hardware device request. softwareFallback=false in auto
  // mode only disables the failovers above; when the adapter mode IS
  // software the fallback adapter is the intended device.
  //
  // The primary instance's ICD filter leaves llvmpipe out when real hardware
  // exists (its ~40MB libLLVM isn't paid until needed), so a null retry gets
  // a dedicated instance that includes software ICDs — same second-instance
  // pattern as the GL tier.
  if (!adapter && (plan.tryHardwareFirst ? mayFallback : true)) {
    adapter = await requestAdapter(true);
    usedSoftware = !!adapter;
    if (!adapter) {
      const swGpu = new WgpuGPU(undefined, { software: true });
      adapter = await swGpu.requestAdapter({ powerPreference, forceFallbackAdapter: true });
      usedSoftware = !!adapter;
      if (adapter) adoptGpuInstance(swGpu, gpu, opts.window);
    }
  }
  if (!adapter) return null;
  const device = await adapter.requestDevice(describe(adapter));
  return finish(adapter, device, gpu, usedSoftware, plan);
}

/**
 * Point the process at the wgpu instance that actually produced the device
 * (the GL fallback tier wins on a second instance). Repoint the gpu/instance
 * globals so navigator.gpu and future surface creation hit the winner, and
 * rebind the window's surface — wgpu surfaces are instance-scoped.
 */
function adoptGpuInstance(winner: WgpuGPU, previous: WgpuGPU, window: AcquireGpuOptions["window"]): void {
  if (winner === previous) return;
  const g = globalThis as Record<string, unknown> & { navigator?: { gpu?: unknown } };
  const ptr = winner.getInstancePtr();
  g.__nativeGpu = winner;
  g.__wgpuInstancePtr = ptr;
  const nav = g.navigator;
  if (nav?.gpu === previous) {
    try { nav.gpu = winner; } catch { /* getter-only */ }
  }
  try { window?.recreateGpuSurface?.(ptr); } catch (e) {
    log.warn("gpu", `surface rebind onto the fallback instance failed (${(e as Error).message ?? e})`);
  }
}

function finish(
  adapter: WgpuAdapter,
  device: WgpuDevice,
  gpu: WgpuGPU,
  usedSoftware: boolean,
  plan: GpuBootPlan,
): AcquiredGpu {
  const info = adapter.nativeInfo;
  if (usedSoftware) {
    log.warn("gpu", `running on the software adapter — ${info?.name ?? "?"} (slower; no hardware acceleration)`);
  } else {
    log.info("gpu", `adapter: ${info?.name ?? "?"} (driver ${info?.driver ?? "?"}, backend ${info?.backend ?? "?"})`);
  }
  return { adapter, device, gpu, info, softwareFallback: usedSoftware, plan };
}
