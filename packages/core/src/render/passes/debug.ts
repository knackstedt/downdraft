import { RenderPass, type RenderPassContext } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import type { DebugDrawQueue } from "../../debug-draw/queue.ts";
import { mat4, type Mat4 } from "wgpu-matrix";

const DEBUG_LINE_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct LineVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct LineVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: LineVertexInput) -> LineVertexOutput {
  var output: LineVertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: LineVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

const DEBUG_POINT_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct PointVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) size: f32,
};

struct PointVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointSize: f32,
};

@vertex
fn vs_main(input: PointVertexInput) -> PointVertexOutput {
  var output: PointVertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.pointSize = input.size;
  return output;
}

@fragment
fn fs_main(input: PointVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

const LINE_STRIDE = 28; // 3 floats pos + 4 floats color = 7 floats * 4 bytes
const POINT_STRIDE = 32; // 3 floats pos + 4 floats color + 1 float size = 8 floats * 4 bytes

export class DebugRenderPass extends RenderPass {
  name = "debug";
  private debugQueue: DebugDrawQueue | null = null;
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private linePipeline: GPURenderPipeline | null = null;
  private pointPipeline: GPURenderPipeline | null = null;
  private lineVertexBuffer: GPUBuffer | null = null;
  private pointVertexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private lineBindGroup: GPUBindGroup | null = null;
  private pointBindGroup: GPUBindGroup | null = null;
  private lineShaderModule: GPUShaderModule | null = null;
  private pointShaderModule: GPUShaderModule | null = null;
  private maxLineVertices: number = 8192;
  private maxPointVertices: number = 4096;

  constructor(surfaceFormat: GPUTextureFormat = "rgba16float") {
    super();
    this.surfaceFormat = surfaceFormat;
  }

  setDebugQueue(queue: DebugDrawQueue): void {
    this.debugQueue = queue;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.lineShaderModule = device.createShaderModule({ code: DEBUG_LINE_SHADER });
    this.pointShaderModule = device.createShaderModule({ code: DEBUG_POINT_SHADER });

    this.cameraBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lineVertexBuffer = device.createBuffer({
      size: this.maxLineVertices * LINE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.pointVertexBuffer = device.createBuffer({
      size: this.maxPointVertices * POINT_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.linePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.lineShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: LINE_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.lineShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "line-list" },
    });

    this.pointPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.pointShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: POINT_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
            { shaderLocation: 2, offset: 28, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: this.pointShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "point-list" },
    });

    this.lineBindGroup = device.createBindGroup({
      layout: this.linePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.pointBindGroup = device.createBindGroup({
      layout: this.pointPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });
  }

  setCameraViewProj(viewProj: Mat4): void {
    if (!this.device || !this.cameraBuffer) return;
    this.device.queue.writeBuffer(this.cameraBuffer, 0, viewProj as unknown as BufferSource);
  }

  execute(ctx: RenderPassContext): void {
    if (!this.debugQueue || this.debugQueue.isEmpty() || !this.device) return;
    if (!this.linePipeline || !this.pointPipeline || !this.lineBindGroup || !this.pointBindGroup) return;

    const lines = this.debugQueue.getLines();
    const points = this.debugQueue.getPoints();

    const tracked = ctx.pass instanceof TrackedRenderPass ? ctx.pass : new TrackedRenderPass(ctx.pass);

    if (lines.length > 0) {
      const vertexCount = Math.min(lines.length * 2, this.maxLineVertices);
      const data = new Float32Array(vertexCount * 7);
      let offset = 0;
      for (let i = 0; i < lines.length && offset / 7 < this.maxLineVertices; i++) {
        const line = lines[i];
        data[offset++] = line.from[0];
        data[offset++] = line.from[1];
        data[offset++] = line.from[2];
        data[offset++] = line.color[0];
        data[offset++] = line.color[1];
        data[offset++] = line.color[2];
        data[offset++] = line.color[3];
        data[offset++] = line.to[0];
        data[offset++] = line.to[1];
        data[offset++] = line.to[2];
        data[offset++] = line.color[0];
        data[offset++] = line.color[1];
        data[offset++] = line.color[2];
        data[offset++] = line.color[3];
      }
      this.device.queue.writeBuffer(this.lineVertexBuffer!, 0, data.subarray(0, vertexCount * 7) as unknown as BufferSource);
      tracked.setPipeline(this.linePipeline);
      tracked.setBindGroup(0, this.lineBindGroup);
      tracked.setVertexBuffer(0, this.lineVertexBuffer!);
      tracked.draw(vertexCount);
    }

    if (points.length > 0) {
      const vertexCount = Math.min(points.length, this.maxPointVertices);
      const data = new Float32Array(vertexCount * 8);
      let offset = 0;
      for (let i = 0; i < vertexCount; i++) {
        const pt = points[i];
        data[offset++] = pt.pos[0];
        data[offset++] = pt.pos[1];
        data[offset++] = pt.pos[2];
        data[offset++] = pt.color[0];
        data[offset++] = pt.color[1];
        data[offset++] = pt.color[2];
        data[offset++] = pt.color[3];
        data[offset++] = pt.size;
      }
      this.device.queue.writeBuffer(this.pointVertexBuffer!, 0, data.subarray(0, vertexCount * 8) as unknown as BufferSource);
      tracked.setPipeline(this.pointPipeline);
      tracked.setBindGroup(0, this.pointBindGroup);
      tracked.setVertexBuffer(0, this.pointVertexBuffer!);
      tracked.draw(vertexCount);
    }

    this.debugQueue.clearFrame();
  }

  destroy(): void {
    this.lineVertexBuffer?.destroy();
    this.pointVertexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.lineVertexBuffer = null;
    this.pointVertexBuffer = null;
    this.cameraBuffer = null;
  }
}
