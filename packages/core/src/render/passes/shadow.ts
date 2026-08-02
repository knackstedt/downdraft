import { mat4, type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder.ts";
import type { RenderBackend } from "../backend/render-backend.ts";
import { wgslShader } from "../backend/shader-source.ts";
import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, BackendShaderModule, BackendTexture, BackendTextureView } from "../backend/types.ts";
import { SHADER_STAGE_VERTEX } from "../backend/types.ts";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";

const SHADOW_SHADER = `
struct CameraUniforms {
  lightViewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  return camera.lightViewProj * worldPos;
}
`;

export class ShadowPass extends RenderPass {
  name = "shadow";
  passType = PassType.Custom;
  shadowHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipelines: Map<number, GPURenderPipeline> = new Map();
  private bindGroups: Map<number, GPUBindGroup> = new Map();
  private shaderModule: GPUShaderModule | null = null;
  private shadowTexture: GPUTexture | null = null;
  private shadowView: GPUTextureView | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private shadowMapSize: number = 2048;
  private lightViewProj: Mat4 = mat4.identity();
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();

  // Backend-agnostic resources
  private _backend: RenderBackend | null = null;
  private _bgShaderModule: BackendShaderModule | null = null;
  private _bgPipelines: Map<number, BackendRenderPipeline> = new Map();
  private _bgBindGroups: Map<number, BackendBindGroup> = new Map();
  private _bgShadowTexture: BackendTexture | null = null;
  private _bgShadowView: BackendTextureView | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgModelBuffer: BackendBuffer | null = null;
  private _bgLayout: BackendBindGroupLayout | null = null;
  private _bgVertexBuffers: Map<MeshData, BackendBuffer> = new Map();
  private _bgIndexBuffers: Map<MeshData, BackendBuffer> = new Map();

  constructor(device: GPUDevice) {
    super();
    this.device = device;
  }

  prepare(_device: GPUDevice, backend?: RenderBackend | null): void {
    if (backend) {
      this.prepareBackend(backend);
      return;
    }
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: SHADOW_SHADER });
    }

    this.shadowTexture = this.device.createTexture({
      size: [this.shadowMapSize, this.shadowMapSize],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView();

    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  prepareBackend(backend: RenderBackend): void {
    this._backend = backend;
    this._bgShaderModule = backend.createShaderModule(wgslShader(SHADOW_SHADER, "shadow-shader"), "wgsl");

    this._bgShadowTexture = backend.createTexture({
      label: "shadow-map",
      size: [this.shadowMapSize, this.shadowMapSize],
      format: "depth32float",
      usage: 0x10 | 0x08, // RENDER_ATTACHMENT | TEXTURE_BINDING
    });
    this._bgShadowView = backend.createTextureView(this._bgShadowTexture);

    this._bgUniformBuffer = backend.createBuffer({ label: "shadow-uniforms", size: 64, usage: 0x40 | 0x08 });
    this._bgModelBuffer = backend.createBuffer({ label: "shadow-model", size: 64, usage: 0x40 | 0x08 });

    this._bgLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
      ],
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
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: { buffer: this.modelBuffer! } },
        ],
      }));
    }
    return pipeline;
  }

  setLightViewProj(viewProj: Mat4): void {
    this.lightViewProj = viewProj;
    if (this._backend && this._bgUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgUniformBuffer, 0, viewProj as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, viewProj as unknown as BufferSource);
    }
  }

  setModelMatrix(model: Mat4): void {
    if (this._backend && this._bgModelBuffer) {
      this._backend.queue.writeBuffer(this._bgModelBuffer, 0, model as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.modelBuffer!, 0, model as unknown as BufferSource);
    }
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.shadowHandle) {
      builder.write(this.shadowHandle);
    }
  }

  getShadowTexture(): GPUTexture | null {
    return this.shadowTexture;
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.shaderModule && !this._bgShaderModule) return;
    if (!ctx.shadowsEnabled) return;

    if (ctx.backend && this._bgShaderModule) {
      this.executeBackend(ctx);
      return;
    }
    if (!ctx.device || !this.shaderModule) return;

    this.setLightViewProj(ctx.lightViewProj);
    this.setModelMatrix(ctx.modelMatrix);

    const mesh = ctx.mesh;
    const pipeline = this.getPipeline(mesh.layout.stride);
    const bindGroup = this.bindGroups.get(mesh.layout.stride)!;

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView!,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    const tracked = new TrackedRenderPass(pass);
    tracked.setPipeline(pipeline);
    tracked.setBindGroup(0, bindGroup);
    tracked.setVertexBuffer(0, this.getVertexBuffer(mesh));
    tracked.setIndexBuffer(this.getIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(mesh.indexCount);
    tracked.end();

    ctx.device.queue.submit([encoder.finish()]);
    ctx.addDrawCalls(1);
    ctx.addTriangles(Math.floor(mesh.indexCount / 3));
  }

  private executeBackend(ctx: GraphRenderContext): void {
    const backend = ctx.backend!;

    this.setLightViewProj(ctx.lightViewProj);
    this.setModelMatrix(ctx.modelMatrix);

    const mesh = ctx.mesh;
    const pipeline = this.getBackendPipeline(mesh.layout.stride);
    const bindGroup = this._bgBindGroups.get(mesh.layout.stride)!;

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this._bgShadowView!,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.getBackendVertexBuffer(mesh));
    pass.setIndexBuffer(this.getBackendIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    pass.drawIndexed(mesh.indexCount);
    pass.end();

    backend.queue.submit([encoder.finish()]);
    ctx.addDrawCalls(1);
    ctx.addTriangles(Math.floor(mesh.indexCount / 3));
  }

  private getBackendPipeline(stride: number): BackendRenderPipeline {
    let pipeline = this._bgPipelines.get(stride);
    if (!pipeline) {
      const backend = this._backend!;
      const pipelineLayout = backend.createPipelineLayout({ label: "shadow-layout", bindGroupLayouts: [this._bgLayout!] });
      pipeline = backend.createRenderPipeline({
        label: "shadow-pipeline",
        layout: pipelineLayout,
        vertex: {
          module: this._bgShaderModule!,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: stride,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as const }],
          }],
        },
        primitive: { topology: "triangle-list", cullMode: "back" as const },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less" as const,
        },
      });
      this._bgPipelines.set(stride, pipeline);
      this._bgBindGroups.set(stride, backend.createBindGroup({
        layout: this._bgLayout!,
        entries: [
          { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
          { binding: 1, resource: { buffer: this._bgModelBuffer! } },
        ],
      }));
    }
    return pipeline;
  }

  private getBackendVertexBuffer(mesh: MeshData): BackendBuffer {
    let buf = this._bgVertexBuffers.get(mesh);
    if (!buf) {
      const backend = this._backend!;
      buf = backend.createBuffer({
        label: "shadow-vb",
        size: mesh.vertices.byteLength,
        usage: 0x20 | 0x08, // VERTEX | COPY_DST
      });
      backend.queue.writeBuffer(buf, 0, mesh.vertices.buffer);
      this._bgVertexBuffers.set(mesh, buf);
    }
    return buf;
  }

  private getBackendIndexBuffer(mesh: MeshData): BackendBuffer {
    let buf = this._bgIndexBuffers.get(mesh);
    if (!buf) {
      const backend = this._backend!;
      buf = backend.createBuffer({
        label: "shadow-ib",
        size: mesh.indices.byteLength,
        usage: 0x10 | 0x08, // INDEX | COPY_DST
      });
      backend.queue.writeBuffer(buf, 0, mesh.indices.buffer);
      this._bgIndexBuffers.set(mesh, buf);
    }
    return buf;
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

  getShadowView(): GPUTextureView | null {
    return this.shadowView;
  }

  computeLightViewProj(
    lightDir: [number, number, number],
    sceneCenter: [number, number, number],
    sceneRadius: number,
  ): Mat4 {
    const eye = vec3.create(
      sceneCenter[0] - lightDir[0] * sceneRadius,
      sceneCenter[1] - lightDir[1] * sceneRadius,
      sceneCenter[2] - lightDir[2] * sceneRadius,
    );
    const view = mat4.lookAt(eye, vec3.create(...sceneCenter), vec3.create(0, 1, 0));
    const orthoSize = sceneRadius;
    const proj = mat4.ortho(-orthoSize, orthoSize, -orthoSize, orthoSize, 0.1, sceneRadius * 4);
    return mat4.multiply(proj, view);
  }

  destroy(): void {
    this.shadowTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.modelBuffer?.destroy();
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
    this.pipelines.clear();
    this.bindGroups.clear();
  }
}
