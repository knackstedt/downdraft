// ============================================================================
// wgpu-wrapper.ts — re-export barrel for the WebGPU wrapper modules.
//
// The implementation was split out of this file into focused modules:
//   enums.ts           — enum/string mappings + descriptor normalization
//   limits.ts          — WGPULimits/features query + serialization
//   registry.ts        — FinalizationRegistry-based native handle cleanup
//   wgpu-device.ts     — WgpuGPU / WgpuAdapter / WgpuDevice / WgpuQueue
//   wgpu-resources.ts  — buffers, textures, samplers, shaders, layouts,
//                        bind groups, pipelines, query sets, command buffers
//   wgpu-encoder.ts    — command encoder + render/compute pass encoders
//
// All public class names are preserved — existing imports from
// "./wgpu-wrapper" continue to work.
// ============================================================================

export { WgpuAdapter, WgpuDevice, WgpuGPU, WgpuQueue } from "./wgpu-device";
export {
    WgpuCommandEncoder, WgpuComputePassEncoder, WgpuRenderPassEncoder
} from "./wgpu-encoder";
export {
    WgpuBindGroup, WgpuBindGroupLayout, WgpuBuffer, WgpuCommandBuffer, WgpuComputePipeline, WgpuPipelineLayout, WgpuQuerySet, WgpuRenderPipeline, WgpuSampler, WgpuShaderModule, WgpuTexture,
    WgpuTextureView
} from "./wgpu-resources";

