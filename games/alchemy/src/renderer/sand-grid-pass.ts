import { buildMaterialProps, buildPalette, PALETTE_SIZE, SHADES_PER_MATERIAL } from "@downdraft/library-sand";
import FULLSCREEN_VS from "../shaders/fullscreen-vs.wgsl?raw";
import SAND_FS from "../shaders/sand-render.wgsl?raw";

/**
 * SandGridPass for the alchemy game — single cauldron layer, no offscreen
 * reflection layering (unlike falling-sand's multi-layer setup).
 */
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
  private propsTexture: GPUTexture | null = null;
  private propsView: GPUTextureView | null = null;
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
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
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
    if (!this.bindGroupLayout || !this.gridView || !this.paletteView || !this.propsView || !this.uniformBuffer) return;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridView },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.propsView },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  resize(gridW: number, gridH: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
    this.createGridTexture();
    this.createBindGroup();
  }

  updateGrid(grid: Uint32Array): void {
    this.device.queue.writeTexture(
      { texture: this.gridTexture! },
      grid.buffer as BufferSource,
      { offset: grid.byteOffset, bytesPerRow: this.gridW * 4, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateUniforms(): void {
    const u = new Float32Array([this.gridW, this.gridH, performance.now() / 1000, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }
}
