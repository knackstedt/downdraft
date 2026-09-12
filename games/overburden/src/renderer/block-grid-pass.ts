// ============================================================================
// BlockGridPass — renders the foreground + background block planes to the canvas.
//
// Packs fg (lower 16 bits) + bg (upper 16 bits) into a single r32uint texture.
// Uses a fullscreen quad shader that samples the grid texture and a palette
// texture to produce the final image.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import { FULLSCREEN_VS } from "@downdraft/core";
import BLOCK_RENDER_FS from "../shaders/block-render.wgsl?raw";
import { getBlockPalette } from "../shared/block-registry";
import { ACTIVE_GRID_H, ACTIVE_GRID_W } from "../shared/constants";

export class BlockGridPass {
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
  private lightTexture: GPUTexture | null = null;
  private lightView: GPUTextureView | null = null;
  private exploredTexture: GPUTexture | null = null;
  private exploredView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;

  // Scratch buffers for packing data (padded to 256-byte aligned rows for WebGPU)
  private packedGrid: Uint32Array;
  private paddedLight: Uint8Array;
  private paddedExplored: Uint8Array;
  private paddedLightRowBytes: number; // RGBA8 light (4 bytes/pixel, 256-aligned)
  private paddedExploredRowBytes: number; // R8 explored (1 byte/pixel, 256-aligned)

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.gridW = ACTIVE_GRID_W;
    this.gridH = ACTIVE_GRID_H;
    this.packedGrid = new Uint32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    // Light: rgba8unorm (4 bytes/pixel). Explored: r8unorm (1 byte/pixel).
    // bytesPerRow must be multiple of 256 for WebGPU texture uploads.
    this.paddedLightRowBytes = Math.ceil((ACTIVE_GRID_W * 4) / 256) * 256;
    this.paddedExploredRowBytes = Math.ceil(ACTIVE_GRID_W / 256) * 256;
    this.paddedLight = new Uint8Array(this.paddedLightRowBytes * ACTIVE_GRID_H);
    this.paddedExplored = new Uint8Array(this.paddedExploredRowBytes * ACTIVE_GRID_H);
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraBuffer = this.device.createBuffer({
      size: 48, // 12 floats: camX, camY, zoom, canvasW, canvasH, daylight, mineX, mineY, mineDamage, _pad, _pad, _pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.createTextures();

    // Palette texture: 256 blocks × 1 pixel RGBA
    const palette = getBlockPalette();
    this.paletteTexture = this.device.createTexture({
      size: [256, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.paletteView = this.paletteTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      palette as unknown as BufferSource,
      { bytesPerRow: 256 * 4, rowsPerImage: 1 },
      [256, 1],
    );

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },  // grid (packed)
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // palette
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // light
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // explored
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },      // uniforms
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },      // camera
      ],
    });

    const shader = createValidatedShaderModule(this.device, { code: FULLSCREEN_VS + "\n" + BLOCK_RENDER_FS, label: "BlockGridPass" });
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
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.createBindGroup();
    this.updateUniforms();
  }

  private createTextures(): void {
    // Grid texture (r32uint — packed fg | bg << 16)
    this.gridTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gridView = this.gridTexture.createView();

    // Light texture (rgba8unorm — RGB volumetric light color + A pad)
    this.lightTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.lightView = this.lightTexture.createView();

    // Explored texture (r8unorm — fog of war 0 or 1)
    this.exploredTexture = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.exploredView = this.exploredTexture.createView();
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.gridView || !this.paletteView ||
        !this.lightView || !this.exploredView || !this.uniformBuffer || !this.cameraBuffer) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.lightView },
        { binding: 3, resource: this.exploredView },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
        { binding: 5, resource: { buffer: this.cameraBuffer } },
      ],
    });
  }

  updateGrid(foreground: Uint16Array, background: Uint16Array): void {
    if (!this.gridTexture) return;
    // Pack fg (lower 16) + bg (upper 16) into Uint32Array.
    // Strip flow bits from foreground (lower 8 bits = block ID).
    const n = foreground.length;
    for (let i = 0; i < n; i++) {
      this.packedGrid[i] = (foreground[i] & 0xFF) | ((background[i] & 0xFF) << 16);
    }
    this.device.queue.writeTexture(
      { texture: this.gridTexture },
      this.packedGrid.buffer as BufferSource,
      { bytesPerRow: this.gridW * 4, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateLight(grid: Uint8Array): void {
    if (!this.lightTexture) return;
    // Copy RGBA8 rows into padded buffer (bytesPerRow must be 256-aligned).
    // grid is RGBA8: 4 bytes/cell, row length = gridW * 4.
    const srcRowBytes = this.gridW * 4;
    for (let y = 0; y < this.gridH; y++) {
      this.paddedLight.set(
        grid.subarray(y * srcRowBytes, (y + 1) * srcRowBytes),
        y * this.paddedLightRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.lightTexture },
      this.paddedLight.buffer as BufferSource,
      { bytesPerRow: this.paddedLightRowBytes, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateExplored(grid: Uint8Array): void {
    if (!this.exploredTexture) return;
    // Copy into padded buffer (bytesPerRow must be multiple of 256 for WebGPU)
    for (let y = 0; y < this.gridH; y++) {
      this.paddedExplored.set(
        grid.subarray(y * this.gridW, (y + 1) * this.gridW),
        y * this.paddedExploredRowBytes,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.exploredTexture },
      this.paddedExplored.buffer as BufferSource,
      { bytesPerRow: this.paddedExploredRowBytes, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateUniforms(): void {
    const u = new Float32Array([this.gridW, this.gridH, performance.now() / 1000, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  updateCamera(
    camX: number, camY: number, zoom: number,
    canvasW: number, canvasH: number, daylight: number,
    mineX: number = -1, mineY: number = -1, mineDamage: number = 0,
  ): void {
    const u = new Float32Array([camX, camY, zoom, canvasW, canvasH, daylight, mineX, mineY, mineDamage, 0, 0, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
}
