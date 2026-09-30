import { getHostCapabilities } from "../platform/runtime";

/**
 * Whether GPU timestamp queries are safe on this device.
 *
 * The wgpu timestamp path (writeTimestamp / resolveQuerySet / map_async
 * readback) loses the device on lavapipe-class software rasterizers and has
 * been observed to lose real discrete Vulkan devices under sustained in-game
 * use — on native it stays behind DOWNDRAFT_GPU_TIMESTAMPS (debug opt-in),
 * additionally refusing on adapters that report deviceType "cpu" so the
 * flag can't be used to wedge a software-rendered test run.
 *
 * Non-native runtimes always allow it — feature availability is checked
 * separately by the caller.
 */
export function isGpuTimestampSafe(device: GPUDevice): boolean {
  if (getHostCapabilities().runtime !== "native") return true;
  if (!process.env.DOWNDRAFT_GPU_TIMESTAMPS) return false;
  const adapterInfo = (device as { adapterInfo?: { deviceType?: string } | null }).adapterInfo;
  return adapterInfo?.deviceType !== "cpu";
}
