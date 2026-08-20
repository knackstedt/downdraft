import STICKMAN_WGSL from "../shaders/stickman.wgsl?raw";

const UNIFORM_SIZE = 64; // 16 float32s (13 used, padded to 16 for WebGPU alignment)

export class StickmanPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private lightView: GPUTextureView | null = null;
  private dummyTexture: GPUTexture | null = null;
  private dummyView: GPUTextureView | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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

    const shader = this.device.createShaderModule({ code: STICKMAN_WGSL });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "line-list" },
    });

    this.createBindGroup();
  }

  private createBindGroup(): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.dummyView) return;
    const lView = this.lightView ?? this.dummyView;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: lView },
      ],
    });
  }

  /** Set the light accumulation texture view (called each frame by the renderer). */
  setLightTexture(view: GPUTextureView | null): void {
    if (this.lightView === view) return;
    this.lightView = view;
    this.createBindGroup();
  }

  update(
    px: number, py: number, facing: number, animFrame: number,
    camX: number, camY: number, zoom: number,
    canvasW: number, canvasH: number,
    health: number, onGround: boolean, vx: number, vy: number,
  ): void {
    const data = new Float32Array(16);
    data[0] = px;
    data[1] = py;
    data[2] = facing;
    data[3] = animFrame;
    data[4] = camX;
    data[5] = camY;
    data[6] = zoom;
    data[7] = canvasW;
    data[8] = canvasH;
    data[9] = health;
    data[10] = onGround ? 1 : 0;
    data[11] = vx;
    data[12] = vy;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(22);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.dummyTexture?.destroy();
  }
}
