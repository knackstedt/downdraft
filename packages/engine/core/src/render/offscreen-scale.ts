// ============================================================================
// offscreen-scale.ts — render-resolution scaling via an offscreen color target.
//
// Implements the "pixelation" OffscreenMode contract: the scene renders into a
// color/depth target sized `scale × canvas`, then `applyPostprocess` blits the
// small color target onto the full-size swapchain view with a single
// fullscreen-triangle draw (linear or nearest sampling).
//
// This is what makes `AppRenderer.setResolutionScale()` work on the native
// runtime — the swapchain extent must equal the window size (wgpu validates it
// at acquire), so scaling has to happen on an offscreen target instead.
// ============================================================================

import { FULLSCREEN_VS } from "./fullscreen-vs";
import type { OffscreenMode, ViewportRect } from "./app-renderer";
import { pipelinePool } from "./pipeline-pool";
import { createValidatedShaderModule } from "./shader-validator";

export interface ResolutionScaleOffscreenOptions {
  device: GPUDevice;
  /** Surface/canvas format — the blit pipeline renders this format. */
  surfaceFormat: GPUTextureFormat;
  depthFormat?: GPUTextureFormat;
  /** Render resolution multiplier (1 = native). Any positive value works;
   *  <1 downsamples (performance), >1 supersamples (quality). */
  scale: number;
  /** Upscale filter. "nearest" yields the classic pixelated look. */
  filter?: "nearest" | "linear";
}

export class ResolutionScaleOffscreen implements OffscreenMode {
  readonly type = "pixelation" as const;

  private device: GPUDevice;
  private surfaceFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private scale: number;
  private filter: "nearest" | "linear";

  private colorTexture: GPUTexture | null = null;
  private colorView: GPUTextureView | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private targetW = 0;
  private targetH = 0;

  private blitPipeline: GPURenderPipeline | null = null;
  private blitShaderModule: GPUShaderModule | null = null;
  private blitBindGroupLayout: GPUBindGroupLayout | null = null;
  private blitSampler: GPUSampler | null = null;
  private blitBindGroup: GPUBindGroup | null = null;

  constructor(opts: ResolutionScaleOffscreenOptions) {
    this.device = opts.device;
    this.surfaceFormat = opts.surfaceFormat;
    this.depthFormat = opts.depthFormat ?? "depth32float";
    this.scale = Math.max(0.05, opts.scale);
    this.filter = opts.filter ?? "linear";
  }

  /** The device this mode's textures/pipeline are bound to — a mismatch means
   *  the device was lost and the mode must be rebuilt. */
  get boundDevice(): GPUDevice {
    return this.device;
  }

  setScale(scale: number): void {
    this.scale = Math.max(0.05, scale);
    // Targets resize on the next ensureTargets call.
  }

  getScale(): number {
    return this.scale;
  }

  /** Render-target pixel size for a canvas of `w × h`. */
  getScaledSize(w: number, h: number): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(w * this.scale)),
      height: Math.max(1, Math.round(h * this.scale)),
    };
  }

  ensureTargets(w: number, h: number): void {
    const { width, height } = this.getScaledSize(w, h);
    if (width === this.targetW && height === this.targetH && this.colorTexture && this.depthTexture) return;

    this.colorTexture?.destroy();
    this.depthTexture?.destroy();
    this.targetW = width;
    this.targetH = height;

    this.colorTexture = this.device.createTexture({
      label: "resolution-scale-color",
      size: { width, height },
      format: this.surfaceFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.colorView = this.colorTexture.createView();

    this.depthTexture = this.device.createTexture({
      label: "resolution-scale-depth",
      size: { width, height },
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthView = this.depthTexture.createView();

    this.blitBindGroup = null; // binds the old color view — rebuild lazily
  }

  scaleViewport(v: ViewportRect): ViewportRect {
    const s = this.scale;
    const x = Math.round(v.x * s);
    const y = Math.round(v.y * s);
    return {
      x,
      y,
      // Scale extents from their endpoints so adjacent viewports (split
      // screen) stay exactly contiguous after rounding.
      w: Math.max(1, Math.round((v.x + v.w) * s) - x),
      h: Math.max(1, Math.round((v.y + v.h) * s) - y),
    };
  }

  getColorView(): GPUTextureView {
    return this.colorView!;
  }

  getDepthView(): GPUTextureView {
    return this.depthView!;
  }

  /** Render-target pixel dimensions of the current offscreen targets. */
  getTargetSize(): { width: number; height: number } {
    return { width: this.targetW, height: this.targetH };
  }

  /**
   * Upscale the offscreen color target onto `canvasView` (the full-size
   * swapchain view) with a single fullscreen-triangle draw.
   */
  applyPostprocess(encoder: GPUCommandEncoder, canvasView: GPUTextureView, _w: number, _h: number): void {
    if (!this.colorView) return;
    if (!this.blitPipeline) this.buildBlitPipeline();
    if (!this.blitPipeline) return; // still compiling on the async pool
    if (!this.blitBindGroup) {
      this.blitBindGroup = this.device.createBindGroup({
        layout: this.blitBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.colorView },
          { binding: 1, resource: this.blitSampler! },
        ],
      });
    }

    const pass = encoder.beginRenderPass({
      label: "resolution-scale-blit",
      colorAttachments: [{
        view: canvasView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, this.blitBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private buildBlitPipeline(): void {
    if (!this.blitBindGroupLayout) {
      this.blitBindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
      });
    }
    if (!this.blitSampler) {
      this.blitSampler = this.device.createSampler({
        magFilter: this.filter,
        minFilter: this.filter,
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
    }
    if (!this.blitShaderModule) {
      this.blitShaderModule = createValidatedShaderModule(this.device, {
        code: SCALE_BLIT_WGSL,
        label: "ResolutionScaleOffscreen.blit",
      });
    }
    const module = this.blitShaderModule;
    const bindGroupLayout = this.blitBindGroupLayout;
    this.blitPipeline = pipelinePool(this.device).acquireRender(`resolution-scale-blit:${this.surfaceFormat}`, () => ({
      label: "resolution-scale-blit",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat }],
      },
      primitive: { topology: "triangle-list" },
    }));
  }

  destroy(): void {
    this.colorTexture?.destroy();
    this.depthTexture?.destroy();
    this.colorTexture = null;
    this.colorView = null;
    this.depthTexture = null;
    this.depthView = null;
    this.targetW = 0;
    this.targetH = 0;
    this.blitBindGroup = null;
    this.blitPipeline = null;
    this.blitShaderModule = null;
    this.blitBindGroupLayout = null;
    this.blitSampler = null;
  }
}

const SCALE_BLIT_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(srcTex, srcSampler, input.uv);
}
`;
