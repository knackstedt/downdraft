// ============================================================================
// FogOfWarPass — renders a black overlay over unexplored cells.
//
// Samples the explored grid texture (r8unorm: 0=unexplored, 1=explored)
// and outputs solid black with alpha=1 for unexplored cells, transparent
// for explored cells. Rendered last (on top of all scene passes) with
// alpha blending so explored areas show through.
// ============================================================================

import { FULLSCREEN_VS } from "@downdraft/core";
import FOG_FS from "../shaders/fog-render.wgsl?raw";

export class FogOfWarPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private exploredTexture: GPUTexture | null = null;
  private exploredView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, gridW: number, gridH: number) {
    this.device = device;
    this.format = format;
    this.gridW = gridW;
    this.gridH = gridH;
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

    this.createExploredTexture();

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const shader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + FOG_FS });
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
  }

  private createExploredTexture(): void {
    this.exploredTexture?.destroy();
    const tex = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.exploredTexture = tex;
    this.exploredView = tex.createView();
    // Initialize to all-unexplored (0)
    this.updateGrid(new Uint8Array(this.gridW * this.gridH));
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.exploredView || !this.uniformBuffer || !this.cameraBuffer) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.exploredView },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: { buffer: this.cameraBuffer } },
      ],
    });
  }

  /** Upload the explored grid data (Uint8Array, 1 byte/cell) to the GPU texture.
   *  WebGPU requires bytesPerRow to be a multiple of 256 for writeTexture, so
   *  we pad each row to the next 256-byte boundary when the grid width isn't
   *  already a multiple of 256. */
  updateGrid(explored: Uint8Array): void {
    if (!this.exploredTexture) return;
    const w = this.gridW;
    const h = this.gridH;
    const paddedRow = Math.ceil(w / 256) * 256;
    if (paddedRow === w) {
      // No padding needed — upload directly
      this.device.queue.writeTexture(
        { texture: this.exploredTexture },
        explored as unknown as BufferSource,
        { bytesPerRow: w, rowsPerImage: h },
        [w, h],
      );
    } else {
      // Pad each row to the next 256-byte boundary
      const padded = new Uint8Array(paddedRow * h);
      for (let y = 0; y < h; y++) {
        padded.set(explored.subarray(y * w, y * w + w), y * paddedRow);
      }
      this.device.queue.writeTexture(
        { texture: this.exploredTexture },
        padded as unknown as BufferSource,
        { bytesPerRow: paddedRow, rowsPerImage: h },
        [w, h],
      );
    }
  }

  updateUniforms(): void {
    const u = new Float32Array([this.gridW, this.gridH, 0, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  updateCamera(camX: number, camY: number, zoom: number, canvasW: number, canvasH: number, depth: number = 0, surfaceLocalY: number = -99999): void {
    const u = new Float32Array([camX, camY, zoom, canvasW, canvasH, depth, surfaceLocalY, 0]);
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }

  destroy(): void {
    this.exploredTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.cameraBuffer?.destroy();
  }
}
