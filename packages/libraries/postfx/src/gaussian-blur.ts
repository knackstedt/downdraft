// ============================================================================
// Gaussian Blur System — two-pass separable Gaussian blur post-process
//
// Renders the scene to an offscreen color texture, then applies a horizontal
// blur pass (→ blurA texture) + a vertical blur pass (→ canvas). The two-pass
// separable approach is O(w+h) per pixel instead of O(w*h) for a full 2D
// convolution, making it practical for real-time use.
//
// When disabled (or radius ≈ 0), a single blit pass copies the scene to the
// canvas using the same pipeline (the Gaussian kernel degenerates to a
// point-sample at radius 0, since all offsets scale to 0).
//
// Usage:
//   const blur = new GaussianBlurSystem(device, format);
//   blur.init();
//   blur.setEnabled(true);
//   blur.setRadius(4); // blur radius in texels
//   // Each frame:
//   blur.ensureTargets(w, h);
//   // ... render scene into blur.getSceneColorView() ...
//   blur.apply(encoder, canvasView, w, h);
// ============================================================================

import GAUSSIAN_BLUR_WGSL from "./shaders/gaussian-blur.wgsl?raw";

export class GaussianBlurSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // sceneColor: where the game renders the scene (input to blur).
  // blurA: intermediate texture for the horizontal pass output.
  private sceneColor: GPUTexture | null = null;
  private blurA: GPUTexture | null = null;
  private width = 0;
  private height = 0;

  // Bind groups for each pass (recreated when textures resize).
  private bindGroupH: GPUBindGroup | null = null; // sceneColor → blurA
  private bindGroupV: GPUBindGroup | null = null; // blurA → canvas

  private radius = 4;
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shaderModule = this.device.createShaderModule({ code: GAUSSIAN_BLUR_WGSL });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Uniforms: texelSize (vec2) + direction (vec2) + radius (f32) = 20 bytes, padded to 32.
    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_blur",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setRadius(radius: number): void {
    this.radius = Math.max(0, radius);
  }

  getRadius(): number {
    return this.radius;
  }

  /** Ensures offscreen textures match the canvas size. Call each frame (cheap if unchanged). */
  ensureTargets(canvasWidth: number, canvasHeight: number): void {
    if (canvasWidth === this.width && canvasHeight === this.height && this.sceneColor) return;

    this.sceneColor?.destroy();
    this.blurA?.destroy();

    const size: GPUExtent3D = [canvasWidth, canvasHeight, 1];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

    this.sceneColor = this.device.createTexture({ size, format: this.format, usage });
    this.blurA = this.device.createTexture({ size, format: this.format, usage });

    this.width = canvasWidth;
    this.height = canvasHeight;

    this.bindGroupH = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: this.sceneColor.createView() },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: { buffer: this.uniformBuffer! } },
      ],
    });
    this.bindGroupV = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: this.blurA.createView() },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: { buffer: this.uniformBuffer! } },
      ],
    });
  }

  /** The offscreen color texture view the game should render the scene into. */
  getSceneColorView(): GPUTextureView {
    if (!this.sceneColor) throw new Error("GaussianBlurSystem: targets not created. Call ensureTargets() first.");
    return this.sceneColor.createView();
  }

  /**
   * Applies the two-pass blur and outputs to `canvasView`.
   * When disabled (or radius ≈ 0), performs a single blit pass that copies
   * the scene to the canvas via the same pipeline (kernel degenerates to a
   * point-sample at radius 0).
   */
  apply(encoder: GPUCommandEncoder, canvasView: GPUTextureView, canvasWidth: number, canvasHeight: number): void {
    const texelX = 1.0 / canvasWidth;
    const texelY = 1.0 / canvasHeight;

    if (!this.enabled || this.radius < 0.01) {
      // Blit: single pass, sceneColor → canvas. Radius 0 → all taps sample center.
      this.writeUniforms(texelX, texelY, 1.0, 0.0, 0.0);
      const blitBindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sceneColor!.createView() },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: { buffer: this.uniformBuffer! } },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setViewport(0, 0, canvasWidth, canvasHeight, 0, 1);
      pass.setScissorRect(0, 0, canvasWidth, canvasHeight);
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, blitBindGroup);
      pass.draw(3);
      pass.end();
      return;
    }

    // Horizontal pass: sceneColor → blurA
    this.writeUniforms(texelX, texelY, 1.0, 0.0, this.radius);
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.blurA!.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setViewport(0, 0, canvasWidth, canvasHeight, 0, 1);
      pass.setScissorRect(0, 0, canvasWidth, canvasHeight);
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.bindGroupH!);
      pass.draw(3);
      pass.end();
    }

    // Vertical pass: blurA → canvas
    this.writeUniforms(texelX, texelY, 0.0, 1.0, this.radius);
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setViewport(0, 0, canvasWidth, canvasHeight, 0, 1);
      pass.setScissorRect(0, 0, canvasWidth, canvasHeight);
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.bindGroupV!);
      pass.draw(3);
      pass.end();
    }
  }

  private writeUniforms(texelSizeX: number, texelSizeY: number, dirX: number, dirY: number, radius: number): void {
    const data = new Float32Array(8); // 2 vec2 + 1 f32 + 1 pad = 32 bytes
    data[0] = texelSizeX;
    data[1] = texelSizeY;
    data[2] = dirX;
    data[3] = dirY;
    data[4] = radius;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as GPUAllowSharedBufferSource);
  }

  destroy(): void {
    this.sceneColor?.destroy();
    this.blurA?.destroy();
    this.sceneColor = null;
    this.blurA = null;
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.sampler = null;
    this.pipeline?.destroy();
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.bindGroupH = null;
    this.bindGroupV = null;
  }
}
