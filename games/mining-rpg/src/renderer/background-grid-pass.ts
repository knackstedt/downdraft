// ============================================================================
// BackgroundGridPass — renders the build materials layer (scaffolding, ladders,
// ropes) with material-specific shape masks.
//
// Uses a separate shader (background-render.wgsl) that draws distinct shapes
// per material type instead of full squares. The background grid is at the
// same resolution as the foreground active grid. Rendered between the backdrop
// (cave walls) and the foreground (sand/stone/water) so build materials appear
// behind terrain.
// ============================================================================

import { FULLSCREEN_VS } from "@downdraft/core";
import { buildPalette, PALETTE_SIZE, SHADES_PER_MATERIAL } from "@downdraft/library-sand";
import BG_FS from "../shaders/background-render.wgsl?raw";

export class BackgroundGridPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private gridTexture: GPUTexture | null = null;
  private gridView: GPUTextureView | null = null;
  private paletteTexture: GPUTexture | null = null;
  private paletteView: GPUTextureView | null = null;
  private lightView: GPUTextureView | null = null;
  private volumetricView: GPUTextureView | null = null;
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, gridW: number, gridH: number) {
    this.device = device;
    this.format = format;
    this.gridW = gridW;
    this.gridH = gridH;
  }

  init(canvasW: number, canvasH: number): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cameraBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.createGridTexture();

    const pal = buildPalette();
    const palW = PALETTE_SIZE * SHADES_PER_MATERIAL;
    this.paletteTexture = this.device.createTexture({
      size: [palW, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.paletteView = this.paletteTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      pal as unknown as BufferSource,
      { bytesPerRow: palW * 4, rowsPerImage: 1 },
      [palW, 1],
    );

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
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const shader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + BG_FS });
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
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.createBindGroup();
    this.updateUniforms();
    this.updateCamera(0, 0, 4, canvasW, canvasH);
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
    if (!this.bindGroupLayout || !this.gridView || !this.paletteView ||
        !this.uniformBuffer || !this.cameraBuffer || !this.dummyView) return;
    const lView = this.lightView ?? this.dummyView;
    const vView = this.volumetricView ?? this.dummyView;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
        { binding: 3, resource: { buffer: this.cameraBuffer } },
        { binding: 4, resource: lView },
        { binding: 5, resource: vView },
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

  resize(gridW: number, gridH: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
    this.createGridTexture();
    this.createBindGroup();
  }

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
    const u = new Float32Array([this.gridW, this.gridH, performance.now() / 1000, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  updateCamera(camX: number, camY: number, zoom: number, canvasW: number, canvasH: number, depth: number = 0): void {
    const u = new Float32Array([camX, camY, zoom, canvasW, canvasH, depth, 0, 0]);
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
    this.paletteTexture?.destroy();
    this.dummyTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.cameraBuffer?.destroy();
  }
}
