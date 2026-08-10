import { GRID_H, GRID_W } from "../shared/constants";
import { buildPalette } from "../simulation/palette";

import FULLSCREEN_VS from "../shaders/fullscreen-vs.wgsl?raw";
import SAND_FS from "../shaders/sand-render.wgsl?raw";

export class SandGridPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private gridTexture: GPUTexture | null = null;
  private gridView: GPUTextureView | null = null;
  private paletteTexture: GPUTexture | null = null;
  private paletteView: GPUTextureView | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.gridTexture = this.device.createTexture({
      size: [GRID_W, GRID_H],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gridView = this.gridTexture.createView();

    const pal = buildPalette();
    this.paletteTexture = this.device.createTexture({
      size: [16, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.paletteView = this.paletteTexture.createView();
    this.device.queue.writeTexture(
      { texture: this.paletteTexture },
      pal as unknown as BufferSource,
      { bytesPerRow: 16 * 4, rowsPerImage: 1 },
      [16, 1],
    );

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const shader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + SAND_FS });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  updateGrid(grid: Uint32Array): void {
    this.device.queue.writeTexture(
      { texture: this.gridTexture! },
      grid.buffer,
      { bytesPerRow: GRID_W * 4, rowsPerImage: GRID_H },
      [GRID_W, GRID_H],
    );
    const u = new Float32Array([GRID_W, GRID_H, performance.now() / 1000, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  render(encoder: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    encoder.setPipeline(this.pipeline);
    encoder.setBindGroup(0, this.bindGroup);
    encoder.draw(3);
  }
}
