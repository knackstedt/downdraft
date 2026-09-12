// ============================================================================
// SandGridPass — renders the active grid texture to the canvas using the
// material palette, with camera-based panning/zooming.
//
// Adapted from falling-sand's SandGridPass. Key difference: the fragment
// shader uses camera uniforms (offset + zoom) to sample a sub-rect of the
// grid texture instead of mapping the whole grid to the screen.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import { FULLSCREEN_VS } from "@downdraft/core";
import {
    buildMaterialProps,
    buildPalette,
    PALETTE_SIZE,
    SHADES_PER_MATERIAL,
} from "@downdraft/library-sand";
import SAND_FS from "../shaders/sand-render.wgsl?raw";

export class SandGridPass {
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
  private propsTexture: GPUTexture | null = null;
  private propsView: GPUTextureView | null = null;
  // 1x1 dummy texture for the "behind" binding (unused in mining-rpg for now)
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;
  // Light texture view (set each frame by the renderer)
  private lightView: GPUTextureView | null = null;
  // Volumetric light texture view (set each frame by the renderer)
  private volumetricView: GPUTextureView | null = null;
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

    // Camera uniform buffer (32 bytes = 8 floats, but WebGPU requires 16-byte alignment)
    this.cameraBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1x1 dummy texture for the "behind" binding
    this.dummyTexture = this.device.createTexture({
      size: [1, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyView = this.dummyTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.dummyTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

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

    const props = buildMaterialProps();
    this.propsTexture = this.device.createTexture({
      size: [PALETTE_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.propsView = this.propsTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.propsTexture },
      props as unknown as BufferSource,
      { bytesPerRow: PALETTE_SIZE * 4, rowsPerImage: 1 },
      [PALETTE_SIZE, 1],
    );

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const shader = createValidatedShaderModule(this.device, { code: FULLSCREEN_VS + "\n" + SAND_FS, label: "SandGridPass" });
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
    if (!this.bindGroupLayout || !this.gridView || !this.paletteView || !this.propsView ||
        !this.uniformBuffer || !this.cameraBuffer || !this.dummyView) return;
    // Use a 1x1 dummy texture for the light binding if no light view is set yet
    const lView = this.lightView ?? this.dummyView;
    const vView = this.volumetricView ?? this.dummyView;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.propsView },
        { binding: 3, resource: this.dummyView },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
        { binding: 5, resource: { buffer: this.cameraBuffer } },
        { binding: 6, resource: lView },
        { binding: 7, resource: vView },
      ],
    });
  }

  /** Get the grid texture view (for sharing with the volumetric light compute pass). */
  getGridView(): GPUTextureView | null {
    return this.gridView;
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
}
