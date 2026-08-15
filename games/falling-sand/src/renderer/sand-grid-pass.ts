import { buildMaterialProps, buildPalette, PALETTE_SIZE, SHADES_PER_MATERIAL } from "@downdraft/library-sand";
import FULLSCREEN_VS from "../shaders/fullscreen-vs.wgsl?raw";
import SAND_FS from "../shaders/sand-render.wgsl?raw";

export class SandGridPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroups: (GPUBindGroup | null)[] = [];
  private uniformBuffer: GPUBuffer | null = null;
  private gridTextures: (GPUTexture | null)[] = [];
  private gridViews: (GPUTextureView | null)[] = [];
  private paletteTexture: GPUTexture | null = null;
  private paletteView: GPUTextureView | null = null;
  private propsTexture: GPUTexture | null = null;
  private propsView: GPUTextureView | null = null;
  // Offscreen targets: one per layer (except the frontmost).
  // Layer i's offscreen target is sampled by layer i+1 for reflections.
  private offscreenTargets: (GPUTexture | null)[] = [];
  private offscreenViews: (GPUTextureView | null)[] = [];
  // 1×1 dummy texture for the backmost layer (no behind-layer to reflect)
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;
  gridW: number;
  gridH: number;
  numLayers: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, gridW: number, gridH: number, numLayers: number) {
    this.device = device;
    this.format = format;
    this.gridW = gridW;
    this.gridH = gridH;
    this.numLayers = numLayers;
    this.bindGroups = new Array(numLayers).fill(null);
    this.gridTextures = new Array(numLayers).fill(null);
    this.gridViews = new Array(numLayers).fill(null);
    this.offscreenTargets = new Array(numLayers).fill(null);
    this.offscreenViews = new Array(numLayers).fill(null);
  }

  init(canvasW: number, canvasH: number): void {
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1×1 dummy texture for layers with no behind-layer
    this.dummyTexture = this.device.createTexture({
      size: [1, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyView = this.dummyTexture.createView();
    // Clear it to black
    this.device.queue.writeTexture(
      { texture: this.dummyTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    for (let i = 0; i < this.numLayers; i++) {
      this.createGridTexture(i);
      // Only create offscreen targets for layers that will be reflected (all but the frontmost)
      if (i < this.numLayers - 1) {
        this.createOffscreenTarget(i, canvasW, canvasH);
      }
    }

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

    for (let i = 0; i < this.numLayers; i++) {
      this.createBindGroup(i);
    }
  }

  private createGridTexture(layer: number): void {
    this.gridTextures[layer]?.destroy();
    const tex = this.device.createTexture({
      size: [this.gridW, this.gridH],
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gridTextures[layer] = tex;
    this.gridViews[layer] = tex.createView();
  }

  private createOffscreenTarget(layer: number, w: number, h: number): void {
    this.offscreenTargets[layer]?.destroy();
    const tex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.offscreenTargets[layer] = tex;
    this.offscreenViews[layer] = tex.createView();
  }

  private createBindGroup(layer: number): void {
    if (!this.bindGroupLayout || !this.gridViews[layer] || !this.paletteView || !this.propsView || !this.uniformBuffer) return;
    // Layer 0 uses the 1×1 dummy; layer i uses layer i-1's offscreen target
    const behindView = layer > 0 ? this.offscreenViews[layer - 1] : this.dummyView;
    this.bindGroups[layer] = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.gridViews[layer]! },
        { binding: 1, resource: this.paletteView },
        { binding: 2, resource: this.propsView },
        { binding: 3, resource: behindView! },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  resize(gridW: number, gridH: number, canvasW: number, canvasH: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
    for (let i = 0; i < this.numLayers; i++) {
      this.createGridTexture(i);
      if (i < this.numLayers - 1) {
        this.createOffscreenTarget(i, canvasW, canvasH);
      }
      this.createBindGroup(i);
    }
  }

  updateGrid(layer: number, grid: Uint32Array): void {
    this.device.queue.writeTexture(
      { texture: this.gridTextures[layer]! },
      grid.buffer as BufferSource,
      { offset: grid.byteOffset, bytesPerRow: this.gridW * 4, rowsPerImage: this.gridH },
      [this.gridW, this.gridH],
    );
  }

  updateUniforms(): void {
    const u = new Float32Array([this.gridW, this.gridH, performance.now() / 1000, 1.0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u);
  }

  getOffscreenView(layer: number): GPUTextureView | null {
    return this.offscreenViews[layer];
  }

  render(pass: GPURenderPassEncoder, layer: number): void {
    if (!this.pipeline || !this.bindGroups[layer]) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[layer]);
    pass.draw(3);
  }
}
