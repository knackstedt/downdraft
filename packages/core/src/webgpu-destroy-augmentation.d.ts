/**
 * WebGPU type augmentation.
 *
 * `@webgpu/types@0.1.71` does not yet declare `.destroy()` on
 * `GPUSampler`, `GPURenderPipeline`, `GPUComputePipeline`, or
 * `GPUShaderModule`, but Chrome's WebGPU implementation provides these
 * methods (they free GPU memory eagerly). This augmentation adds the
 * missing declarations so explicit cleanup calls type-check.
 *
 * GPUBindGroup, GPUBindGroupLayout, and GPUPipelineLayout do NOT have
 * `.destroy()` and are intentionally omitted.
 */

declare interface GPUSampler {
  destroy(): void;
}

declare interface GPURenderPipeline {
  destroy(): void;
}

declare interface GPUComputePipeline {
  destroy(): void;
}

declare interface GPUShaderModule {
  destroy(): void;
}
