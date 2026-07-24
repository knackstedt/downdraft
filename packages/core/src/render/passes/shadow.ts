import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import type { MeshData } from "../../mesh/builder.ts";
import { mat4, vec3, type Mat4 } from "wgpu-matrix";

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
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private shadowTexture: GPUTexture | null = null;
  private shadowView: GPUTextureView | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private shadowMapSize: number = 2048;
  private lightViewProj: Mat4 = mat4.identity();
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();

  constructor(device: GPUDevice) {
    super();
    this.device = device;
  }

  prepare(_device: GPUDevice): void {
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

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 48,
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

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.modelBuffer } },
      ],
    });
  }

  setLightViewProj(viewProj: Mat4): void {
    this.lightViewProj = viewProj;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, viewProj as Float32Array as unknown as ArrayBuffer);
  }

  setModelMatrix(model: Mat4): void {
    this.device.queue.writeBuffer(this.modelBuffer!, 0, model as Float32Array as unknown as ArrayBuffer);
  }

  execute(ctx: RenderPassContext, mesh: MeshData, modelMatrix: Mat4): void;
  execute(ctx: RenderPassContext): void;
  execute(ctx: RenderPassContext, mesh?: MeshData, modelMatrix?: Mat4): void {
    if (!this.pipeline || !this.bindGroup || !mesh || !modelMatrix) return;

    this.setModelMatrix(modelMatrix);

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

    const tracked = pass instanceof TrackedRenderPass ? pass : new TrackedRenderPass(pass);
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.setVertexBuffer(0, this.getVertexBuffer(mesh));
    tracked.setIndexBuffer(this.getIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(mesh.indexCount);
    tracked.end();

    ctx.device.queue.submit([encoder.finish()]);
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
  }
}
