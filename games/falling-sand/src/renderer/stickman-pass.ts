import STICKMAN_WGSL from "../shaders/stickman.wgsl?raw";

const UNIFORM_SIZE = 48; // 12 float32s

export class StickmanPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
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
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = this.device.createShaderModule({ code: STICKMAN_WGSL });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      }],
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

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  resize(gridW: number, gridH: number): void {
    this.gridW = gridW;
    this.gridH = gridH;
  }

  update(
    px: number, py: number, facing: number, animFrame: number,
    health: number, onGround: boolean, vx: number, vy: number,
  ): void {
    const data = new Float32Array(12);
    data[0] = px;
    data[1] = py;
    data[2] = facing;
    data[3] = animFrame;
    data[4] = this.gridW;
    data[5] = this.gridH;
    data[6] = 0; // canvasW (unused in shader)
    data[7] = 0; // canvasH (unused in shader)
    data[8] = health;
    data[9] = onGround ? 1 : 0;
    data[10] = vx;
    data[11] = vy;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(22); // 22 vertices = 11 line segments
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
