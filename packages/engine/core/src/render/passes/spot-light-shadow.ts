import { createValidatedShaderModule } from "../shader-validator";
import type { StructView, WgslStruct } from "@downdraft/engine/shader-graph";
import { f32, mat4x4f, vec4f, wgsl } from "@downdraft/engine/shader-graph";
import { mat4, vec3, type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";
import { destroyMapValues } from "../resource-tracker";
import { TrackedRenderPass } from "../tracked-render-pass";

export const MAX_SPOT_LIGHT_SHADOWS = 4;

const SpotShadowUniforms: WgslStruct = wgsl.struct("SpotShadowUniforms", {
  viewProj: mat4x4f,
  lightPos: vec4f,
  bias: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
});

const SPOT_SHADOW_SHADER = /* wgsl */ `
${SpotShadowUniforms.wgsl}

@group(0) @binding(0) var<uniform> spotShadow: SpotShadowUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  return spotShadow.viewProj * worldPos;
}
`;

export interface SpotLightShadowData {
  position: [number, number, number];
  direction: [number, number, number];
  range: number;
  outerConeAngle: number;
}

export class SpotLightShadowPass extends RenderPass {
  name = "spot-light-shadow";
  passType = PassType.Custom;
  shadowHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private shadowMapSize: number;
  private shaderModule: GPUShaderModule | null = null;
  private shadowTextures: GPUTexture[] = [];
  private shadowViews: GPUTextureView[] = [];
  private shadowSamplers: GPUSampler[] = [];
  private uniformBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private viewProjBuffer: GPUBuffer | null = null;
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;
  private pipelines: Map<number, GPURenderPipeline> = new Map();
  private bindGroups: Map<number, GPUBindGroup> = new Map();
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private viewProjs: Mat4[] = [];

  constructor(device: GPUDevice, shadowMapSize: number = 1024) {
    super();
    this.device = device;
    this.shadowMapSize = shadowMapSize;
    for (let i = 0; i < MAX_SPOT_LIGHT_SHADOWS; i++) {
      this.viewProjs.push(mat4.identity());
    }
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = createValidatedShaderModule(this.device, { code: SPOT_SHADOW_SHADER, label: "SpotLightShadowPass" });
    }

    for (let i = 0; i < MAX_SPOT_LIGHT_SHADOWS; i++) {
      const tex = this.device.createTexture({
        size: [this.shadowMapSize, this.shadowMapSize],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.shadowTextures.push(tex);
      this.shadowViews.push(tex.createView());
      this.shadowSamplers.push(this.device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" }));
    }

    this.uniformBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuf = new Float32Array(SpotShadowUniforms.floatCount);
    this._uniformView = SpotShadowUniforms.view(this._uniformBuf);

    this.modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.viewProjBuffer = this.device.createBuffer({
      size: MAX_SPOT_LIGHT_SHADOWS * 64,
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
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
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

  computeSpotViewProj(
    lightIndex: number,
    position: [number, number, number],
    direction: [number, number, number],
    range: number,
    outerConeAngle: number,
  ): Mat4 {
    const target = vec3.create(
      position[0] + direction[0] * range,
      position[1] + direction[1] * range,
      position[2] + direction[2] * range,
    );
    const view = mat4.lookAt(
      vec3.create(...position),
      target,
      vec3.create(0, 1, 0),
    );
    const fov = Math.min(outerConeAngle * 2.0, Math.PI * 0.9);
    const proj = mat4.perspective(fov, 1.0, 0.1, range);
    const vp = mat4.multiply(proj, view);
    this.viewProjs[lightIndex] = vp;
    return vp;
  }

  renderSpotLightShadow(
    encoder: GPUCommandEncoder,
    lightIndex: number,
    meshes: Array<{ mesh: MeshData; model: Mat4 }>,
  ): void {
    if (lightIndex >= MAX_SPOT_LIGHT_SHADOWS || !this.shaderModule) return;

    const view = this.shadowViews[lightIndex];
    const vp = this.viewProjs[lightIndex];

    const uv = this._uniformView!;
    uv.set("viewProj", vp);
    uv.set("lightPos", [0, 0, 0, 0]);
    uv.set("bias", 0.001);
    uv.set("_pad0", 0);
    uv.set("_pad1", 0);
    uv.set("_pad2", 0);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this._uniformBuf as unknown as BufferSource);

    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    const tracked = new TrackedRenderPass(pass);
    meshes.forEach(({ mesh, model }) => {
      this.device.queue.writeBuffer(this.modelBuffer!, 0, model as unknown as BufferSource);
      const pipeline = this.getPipeline(mesh.layout.stride);
      const bindGroup = this.bindGroups.get(mesh.layout.stride)!;
      tracked.setPipeline(pipeline);
      tracked.setBindGroup(0, bindGroup);
      tracked.setVertexBuffer(0, this.getVertexBuffer(mesh));
      tracked.setIndexBuffer(this.getIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(mesh.indexCount);
    });
    tracked.end();
  }

  getShadowView(index: number): GPUTextureView | null {
    return this.shadowViews[index] ?? null;
  }

  getShadowSampler(index: number): GPUSampler | null {
    return this.shadowSamplers[index] ?? null;
  }

  getViewProj(index: number): Mat4 | null {
    return this.viewProjs[index] ?? null;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.shadowHandle) {
      builder.write(this.shadowHandle);
    }
  }

  execute(_ctx: GraphRenderContext): void {
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
    this.shadowTextures.forEach((tex) => { tex.destroy();; });
    // GPUSampler has no destroy() — it's GC'd automatically.
    this.shadowSamplers.length = 0;
    this.uniformBuffer?.destroy();
    this.modelBuffer?.destroy();
    this.viewProjBuffer?.destroy();
    this._uniformView = null;
    this._uniformBuf = null;
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
    destroyMapValues(this.pipelines);
    destroyMapValues(this.bindGroups);
  }
}
