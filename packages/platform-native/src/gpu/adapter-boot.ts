// ============================================================================
// adapter-boot.ts — policy-driven adapter + device acquisition for host boots
//
// The single place the adapter/device dance happens for the host (native-
// host.ts) and the dev shell's early boot (early-host.ts):
//
//   planGpuBoot      → resolve policy, arm the crash sentinel, honor the
//                      crash latch and any explicit adapter choice
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
import { denyReasonForAdapter, planGpuBoot, type GpuBootPlan, type GpuPolicyInput } from "./adapter-policy";
import { computeDeviceDescriptor } from "./device-request";
import type { NativeAdapterInfo, WgpuAdapter, WgpuDevice, WgpuGPU } from "./wgpu-device";

const log = createLogger("info");

export interface AcquireGpuOptions extends GpuPolicyInput {
  powerPreference?: "low-power" | "high-performance";
  /** Device descriptor factory — native-host and the early boot pass
   *  computeDeviceDescriptor so the union limits/features stay identical. */
  describeDevice?: (adapter: WgpuAdapter) => GPUDeviceDescriptor;
}

export interface AcquiredGpu {
  adapter: WgpuAdapter;
  device: WgpuDevice;
  info: NativeAdapterInfo | null;
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
  const plan = planGpuBoot({ appId: opts.appId, gameDir: opts.gameDir });
  const { policy } = plan;

  log.info("gpu",
    `gpu policy: adapter=${policy.adapter} backend=${policy.backend} ` +
    `softwareFallback=${policy.softwareFallback} (${policy.source})`);

  const requestAdapter = (forceFallback: boolean) =>
    gpu.requestAdapter({ powerPreference, forceFallbackAdapter: forceFallback });

  let adapter: WgpuAdapter | null = null;
  let usedSoftware = false;

  const mayFallback = policy.softwareFallback && policy.adapter !== "hardware";

  if (plan.tryHardwareFirst) {
    adapter = await requestAdapter(false);
    if (adapter) {
      const reason = denyReasonForAdapter(adapter.nativeInfo, policy.deny);
      if (reason) {
        adapter.release();
        adapter = null;
        if (mayFallback) {
          log.warn("gpu", `${reason} — falling back to the software adapter`);
        } else {
          log.error("gpu", `${reason} — no software fallback permitted (adapter=${policy.adapter})`);
        }
      }
    } else if (mayFallback) {
      log.warn("gpu", "hardware adapter request returned null — trying the software adapter");
    }
  }

  // Device request on the hardware adapter — a clean failure (returned
  // error, not a process abort) retries on the software adapter.
  if (adapter && !adapter.__ddSoftwareAdapter) {
    try {
      const device = await adapter.requestDevice(describe(adapter));
      return finish(adapter, device, false, plan);
    } catch (e) {
      if (!mayFallback) throw e;
      log.warn("gpu", `hardware device request failed — falling back to the software adapter (${(e as Error).message ?? e})`);
      adapter.release();
      adapter = null;
    }
  }

  // Software path — explicit software mode, a denied/null hardware adapter,
  // or a failed hardware device request. softwareFallback=false in auto
  // mode only disables the failovers above; when the adapter mode IS
  // software the fallback adapter is the intended device.
  if (!adapter && (plan.tryHardwareFirst ? mayFallback : true)) {
    adapter = await requestAdapter(true);
    usedSoftware = !!adapter;
  }
  if (!adapter) return null;
  const device = await adapter.requestDevice(describe(adapter));
  return finish(adapter, device, usedSoftware, plan);
}

function finish(
  adapter: WgpuAdapter,
  device: WgpuDevice,
  usedSoftware: boolean,
  plan: GpuBootPlan,
): AcquiredGpu {
  const info = adapter.nativeInfo;
  if (usedSoftware) {
    log.warn("gpu", `running on the software adapter — ${info?.name ?? "?"} (slower; no hardware acceleration)`);
  } else {
    log.info("gpu", `adapter: ${info?.name ?? "?"} (driver ${info?.driver ?? "?"}, backend ${info?.backend ?? "?"})`);
  }
  return { adapter, device, info, softwareFallback: usedSoftware, plan };
}
