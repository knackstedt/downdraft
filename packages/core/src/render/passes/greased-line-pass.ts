import { type Mat4 } from "wgpu-matrix";
import type { GreasedLineData } from "../../mesh/greased-line.ts";
import { RenderPass } from "../render-pass.ts";
import type { FrameGraphBuilder, GraphRenderContext } from "../frame-graph.ts";
import type { TextureHandle } from "../frame-graph.ts";

const GREASED_LINE_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  resolution: vec2<f32>,
  _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) sideOffset: f32,
  @location(2) width: f32,
  @location(3) dashU: f32,
  @location(4) sideV: f32,
  @location(5) color: vec4<f32>,
  @location(6) lineT: f32,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) dashU: f32,
  @location(2) sideV: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let clipPos = camera.viewProj * vec4<f32>(input.position, 1.0);
  let normal = vec2<f32>(-clipPos.w, 0.0);
  let aspect = camera.resolution.x / max(camera.resolution.y, 1.0);
  let offset = input.sideOffset * input.width / vec2<f32>(camera.resolution.x, camera.resolution.y) * clipPos.w * 0.5;
  offset.x = offset.x / aspect;
  output.clipPosition = vec4<f32>(
    clipPos.x + offset.x,
    clipPos.y + offset.y,
    clipPos.z,
    clipPos.w,
  );
  output.color = input.color;
  output.dashU = input.dashU;
  output.sideV = input.sideV;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dash = fract(input.dashU);
  if (input.dashU > 0.0 && dash < 0.35) {
    discard;
  }
  return input.color;
}
`;

export class GreasedLinePass extends RenderPass {
  name = "greased-line";
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;

  private device: GPUDevice | null;
  private surfaceFormat: GPUTextureFormat;
  private shaderModule: GPUShaderModule | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private lines: Array<{ data: GreasedLineData; modelMatrix: Mat4 }> = [];
  private vertexBuffers: Map<GreasedLineData, GPUBuffer> = new Map();
  private indexBuffers: Map<GreasedLineData, GPUBuffer> = new Map();

  constructor(device: GPUDevice | null, surfaceFormat: GPUTextureFormat) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
  }

  prepare(device: GPUDevice): void {
    if (!this.device) this.device = device;
    if (!this.shaderModule && this.device) {
      this.shaderModule = this.device.createShaderModule({ code: GREASED_LINE_SHADER });
    }
    if (!this.cameraBuffer && this.device) {
      this.cameraBuffer = this.device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
  }

  private ensurePipeline(): void {
    if (this.pipeline || !this.device || !this.shaderModule || !this.cameraBuffer) return;
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 48,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32" },
            { shaderLocation: 2, offset: 16, format: "float32" },
            { shaderLocation: 3, offset: 20, format: "float32" },
            { shaderLocation: 4, offset: 24, format: "float32" },
            { shaderLocation: 5, offset: 28, format: "float32x4" },
            { shaderLocation: 6, offset: 44, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
      ],
    });
  }

  addLine(data: GreasedLineData, modelMatrix: Mat4): void {
    this.lines.push({ data, modelMatrix });
  }

  clearLines(): void {
    this.lines.length = 0;
  }

  hasLines(): boolean {
    return this.lines.length > 0;
  }

  setCameraViewProj(viewProj: Mat4, resolution: [number, number]): void {
    if (!this.device || !this.cameraBuffer) return;
    const data = new Float32Array(20);
    data.set(viewProj as Float32Array, 0);
    data[16] = resolution[0];
    data[17] = resolution[1];
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.device || this.lines.length === 0 || !ctx.pass) return;
    this.ensurePipeline();
    if (!this.pipeline || !this.bindGroup) return;

    this.setCameraViewProj(ctx.viewProj, [ctx.width, ctx.height]);

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);

    for (const line of this.lines) {
      const vb = this.getVertexBuffer(line.data);
      const ib = this.getIndexBuffer(line.data);
      tracked.setVertexBuffer(0, vb);
      tracked.setIndexBuffer(ib, line.data.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(line.data.indexCount);
    }
  }

  private getVertexBuffer(data: GreasedLineData): GPUBuffer {
    let buf = this.vertexBuffers.get(data);
    if (!buf && this.device) {
      buf = this.device.createBuffer({
        size: data.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, data.vertices.buffer);
      this.vertexBuffers.set(data, buf);
    }
    return buf!;
  }

  private getIndexBuffer(data: GreasedLineData): GPUBuffer {
    let buf = this.indexBuffers.get(data);
    if (!buf && this.device) {
      buf = this.device.createBuffer({
        size: data.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, data.indices.buffer);
      this.indexBuffers.set(data, buf);
    }
    return buf!;
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
  }
}
