// ============================================================================
// @downdraft/engine/libraries/gpu-kernels — gpu.js-style JS→WGSL kernels on the
// shared GPUDevice. Kernels write into ordinary storage buffers, so results
// can feed renderer/compute pipelines with zero copies, and `readInto` can
// land output directly in a SharedArrayBuffer view.
// ============================================================================

export { GpuKernel, createKernel } from "./kernel";
export type { KernelArg, KernelFn, KernelOptions, KernelThis } from "./kernel";
export { transpileKernel, wgslF32, KernelSyntaxError } from "./transpile";
export type { KernelArgKind, KernelBinding, TranspileOptions, TranspileResult } from "./transpile";
