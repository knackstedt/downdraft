// ============================================================================
// BackdropPass — renders the low-res backdrop grid with parallax scrolling.
//
// The backdrop grid is a separate r32uint texture (packed RGBA colors, not
// material IDs). The fragment shader applies a parallax factor to the camera
// offset so the backdrop scrolls slower than the foreground.
//
// Unlike SandGridPass, this pass has no palette/props textures — the grid
// cells already contain packed RGBA colors. The pass is rendered first
// (behind the foreground), with no blending (opaque).
// ============================================================================

import { FULLSCREEN_VS } from "@downdraft/core";
import BACKDROP_FS from "../shaders/backdrop-render.wgsl?raw";
import {
    BACKDROP_GRID_H,
    BACKDROP_GRID_W,
    BACKDROP_PARALLAX,
} from "../shared/constants";

export class BackdropPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private gridTexture: GPUTexture | null = null;
  private gridView: GPUTextureView | null = null;
  private lightView: GPUTextureView | null = null;
  private volumetricView: GPUTextureView | null = null;
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.gridW = BACKDROP_GRID_W;
    this.gridH = BACKDROP_GRID_H;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cameraBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.createGridTexture();

    // 1x1 dummy texture for the light binding (before light view is set)
    this.dummyTexture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyView = this.dummyTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.dummyTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const shader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + BACKDROP_FS });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          // No blending — backdrop is opaque, rendered first
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.createBindGroup();
    this.updateUniforms();
  }

  private createGridTexture(): void {
    this.gridTexture?.destroy();
    const tex = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gridTexture = tex;
    this.gridView = tex.createView();
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.gridView || !this.uniformBuffer || !this.cameraBuffer || !this.dummyView) return;
    const lView = this.lightView ?? this.dummyView;
    const vView = this.volumetricView ?? this.dummyView;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: { buffer: this.cameraBuffer } },
        { binding: 3, resource: lView },
        { binding: 4, resource: vView },
      ],
    });
  }

  /** Set the light accumulation texture view (called each frame by the renderer). */
  setLightTexture(view: GPUTextureView | null): void {
    if (this.lightView === view) return;
    this.lightView = view;
    this.createBindGroup();
  }

  /** Set the volumetric light texture view (called each frame by the renderer). */
  setVolumetricTexture(view: GPUTextureView | null): void {
    if (this.volumetricView === view) return;
    this.volumetricView = view;
    this.createBindGroup();
  }

  /** Upload the backdrop grid data to the GPU texture. */
  updateGrid(grid: Uint32Array): void {
    if (!this.gridTexture) return;
    this.device.queue.writeTexture(
      { texture: this.gridTexture },
      grid.buffer as BufferSource,
      { offset: grid.byteOffset, bytesPerRow: this.gridW * 4, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateUniforms(): void {
    const u = new Float32Array([this.gridW, this.gridH, 0, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  /**
   * Update camera uniforms. The camera position (camX, camY) should be in
   * backdrop-local cell coords — the renderer computes this by converting
   * the world-space camera position to backdrop space (parallax * half-res)
   * and subtracting the backdrop grid origin. The shader applies parallax
   * scaling only to the screen offset, not to the camera position.
   */
  updateCamera(camX: number, camY: number, zoom: number, canvasW: number, canvasH: number): void {
    const u = new Float32Array([camX, camY, zoom, canvasW, canvasH, BACKDROP_PARALLAX, 0, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }

  destroy(): void {
    this.gridTexture?.destroy();
    this.dummyTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.cameraBuffer?.destroy();
  }
}
