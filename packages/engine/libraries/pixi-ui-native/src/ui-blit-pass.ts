// ============================================================================
// ui-blit-pass.ts — screen-space WebGPU pass that composites the PixiJS UI
// texture over the game frame.
//
// Each frame, after PixiJS has rendered the UI into its GPUTexture (on the
// shared device/queue), the game calls `execute(commandEncoder, targetView)`
// with the swapchain texture view. This begins a render pass on `targetView`
// with loadOp:"load" (preserving the 3D frame), binds the UI texture + a
// linear sampler, and draws a fullscreen triangle with premultiplied-alpha
// blending.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/engine";
import { UI_BLIT_WGSL } from "./shaders/ui-blit.wgsl";

export class UiBlitPass {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  private format: GPUTextureFormat;
  private disposed = false;

  constructor(device: GPUDevice, targetFormat: GPUTextureFormat) {
    this.device = device;
    this.format = targetFormat;

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const shader = createValidatedShaderModule(device, { code: UI_BLIT_WGSL, label: "UiBlitPass" });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format: targetFormat,
          // Premultiplied alpha blend: the UI texture is premultiplied.
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * Encode the UI blit into `commandEncoder`, sampling `uiTextureView` over
   * `targetView` (the swapchain texture view for the current frame).
   */
  execute(commandEncoder: GPUCommandEncoder, targetView: GPUTextureView, uiTextureView: GPUTextureView): void {
    if (this.disposed || !uiTextureView) return;

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: uiTextureView },
        { binding: 1, resource: this.sampler },
      ],
    });

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: "load",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Pipelines/layouts/samplers are implicitly released with the device.
  }
}
