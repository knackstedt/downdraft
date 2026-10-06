// ============================================================================
// device-request.ts — the shared requestDevice descriptor for host-owned
// devices. Extracted so the dev shell's early-boot path (early-host.ts) and
// createNativeHost() request the SAME limits/features union — an early
// device adopted by the full host must satisfy everything GameRenderer asks.
// ============================================================================

import type { WgpuAdapter } from "./wgpu-device";

/**
 * Build the GPUDeviceDescriptor the native host requests. Limits/features
 * are the UNION of what the host and GameRenderer request, clamped to what
 * the adapter reports — requesting a limit above the adapter's max fails
 * requestDevice.
 */
export function computeDeviceDescriptor(adapter: WgpuAdapter): GPUDeviceDescriptor {
  const adapterLimits = adapter.limits as unknown as Record<string, number>;
  const requiredLimits: Record<string, number> = {};
  const requestLimit = (key: string, want: number): void => {
    const have = Number(adapterLimits[key]);
    if (Number.isFinite(have) && have > 0) requiredLimits[key] = Math.min(want, have);
  };
  requestLimit("maxStorageBufferBindingSize", 256 * 1024 * 1024);
  requestLimit("maxStorageBuffersPerShaderStage", 16);
  requestLimit("maxSampledTexturesPerShaderStage", 32);
  requestLimit("maxSamplersPerShaderStage", 32);
  requestLimit("maxTextureArrayLayers", 512);
  // Timestamp queries are opt-in on native: the wgpu timestamp path loses
  // the device on lavapipe-class rasterizers AND has been observed to lose
  // real discrete Vulkan devices under sustained in-game use — keep it behind
  // DOWNDRAFT_GPU_TIMESTAMPS until the driver-level issue is resolved
  // upstream. The base feature is still requested unconditionally (harmless
  // while unused; consumers gate on isGpuTimestampSafe).
  const adapterType = (adapter as unknown as { nativeInfo?: { deviceType?: string } | null }).nativeInfo?.deviceType;
  const wantTimestampExtensions =
    !!process.env.DOWNDRAFT_GPU_TIMESTAMPS && adapterType !== "cpu";
  const timestampFeatures = [
    "timestamp-query",
    ...(wantTimestampExtensions
      ? ["timestamp-query-inside-passes", "timestamp-query-inside-encoders"]
      : []),
  ].filter((f) => adapter.features.has(f as GPUFeatureName));
  return {
    requiredFeatures: timestampFeatures as GPUFeatureName[],
    requiredLimits,
  };
}
