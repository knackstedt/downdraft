import { type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";
import { destroyMapValues } from "../resource-tracker";

const DEPTH_PREPASS_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  return camera.viewProj * worldPos;
}
`;

export class DepthPrepass extends RenderPass {
  name = "depth-prepass";
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipelines: Map<number, GPURenderPipeline> = new Map();
  private bindGroups: Map<number, GPUBindGroup> = new Map();
  private shaderModule: GPUShaderModule | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();

  constructor(device: GPUDevice) {
    super();
    this.device = device;
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: DEPTH_PREPASS_SHADER });
    }

    this.cameraBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private getPipeline(stride: number): GPURenderPipeline {
    let pipeline = this.pipelines.get(stride);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule!,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
            ],
          }],
        },
        primitive: { topology: "triangle-list", cullMode: "back" },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
      this.pipelines.set(stride, pipeline);
      this.bindGroups.set(stride, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer! } },
          { binding: 1, resource: { buffer: this.modelBuffer! } },
        ],
      }));
    }
    return pipeline;
  }

  setCameraViewProj(viewProj: Mat4): void {
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, viewProj as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (!this.depthHandle) return;
    builder.depthAttachment({
      handle: this.depthHandle,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1.0,
    });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.shaderModule || !ctx.pass) return;
    const mesh = ctx.mesh;
    const modelMatrix = ctx.modelMatrix;

    this.setCameraViewProj(ctx.viewProj);
    this.device.queue.writeBuffer(this.modelBuffer!, 0, modelMatrix as unknown as BufferSource);

    const pipeline = this.getPipeline(mesh.layout.stride);
    const bindGroup = this.bindGroups.get(mesh.layout.stride)!;

    const tracked = ctx.pass;
    tracked.setPipeline(pipeline);
    tracked.setBindGroup(0, bindGroup);
    tracked.setVertexBuffer(0, this.getVertexBuffer(mesh));
    tracked.setIndexBuffer(this.getIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(mesh.indexCount);
  }

  private getVertexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.vertexBuffers.get(mesh);
    if (!buf) {
      buf = this.device.createBuffer({
        size: mesh.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.vertices.buffer);
      this.vertexBuffers.set(mesh, buf);
    }
    return buf;
  }

  private getIndexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.indexBuffers.get(mesh);
    if (!buf) {
      buf = this.device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.indices.buffer);
      this.indexBuffers.set(mesh, buf);
    }
    return buf;
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.modelBuffer?.destroy();
    this.shaderModule?.destroy();
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
    destroyMapValues(this.pipelines);
    destroyMapValues(this.bindGroups);
  }
}
