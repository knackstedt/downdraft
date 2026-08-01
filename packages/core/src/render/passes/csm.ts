import { mat4, vec3, type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder.ts";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";

export interface CSMSettings {
  cascadeCount: number;
  shadowMapSize: number;
  lambda: number;
  bias: number;
  normalBias: number;
  blendDistance: number;
}

export const DEFAULT_CSM_SETTINGS: CSMSettings = {
  cascadeCount: 4,
  shadowMapSize: 2048,
  lambda: 0.5,
  bias: 0.001,
  normalBias: 0.02,
  blendDistance: 0.15,
};

const MAX_CASCADES = 4;

const CSM_SHADER = /* wgsl */ `
struct CascadeUniforms {
  viewProj: mat4x4<f32>,
  texelSize: vec4<f32>,
};

struct CSMUniforms {
  cascades: array<CascadeUniforms, ${MAX_CASCADES}>,
  cascadeSplits: vec4<f32>,
  lightDir: vec4<f32>,
  cascadeCount: vec4<f32>,
};

@group(0) @binding(0) var<uniform> csm: CSMUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) viewDepth: f32,
  @location(1) worldNormal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = csm.cascades[0].viewProj * worldPos;
  output.viewDepth = output.clipPosition.z / output.clipPosition.w;
  output.worldNormal = normalize((modelUniform * vec4<f32>(input.normal, 0.0)).xyz);
  return output;
}
`;

export class CSMPass extends RenderPass {
  name = "csm";
  passType = PassType.Custom;
  shadowHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: CSMSettings;
  private shaderModule: GPUShaderModule | null = null;
  private shadowTexture: GPUTexture | null = null;
  private shadowView: GPUTextureView | null = null;
  private shadowSampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private pipelines: Map<number, GPURenderPipeline> = new Map();
  private bindGroups: Map<number, GPUBindGroup> = new Map();
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();

  private cascadeViewProjs: Mat4[] = [];
  private cascadeSplits: number[] = [];

  constructor(device: GPUDevice, settings: Partial<CSMSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_CSM_SETTINGS, ...settings };
    for (let i = 0; i < MAX_CASCADES; i++) {
      this.cascadeViewProjs.push(mat4.identity());
      this.cascadeSplits.push(0);
    }
  }

  get cascadeCount(): number {
    return this.settings.cascadeCount;
  }

  get shadowMapSize(): number {
    return this.settings.shadowMapSize;
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: CSM_SHADER });
    }

    this.shadowTexture = this.device.createTexture({
      size: [this.settings.shadowMapSize, this.settings.shadowMapSize, this.settings.cascadeCount],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView({
      dimension: "2d-array",
      arrayLayerCount: this.settings.cascadeCount,
    });

    this.shadowSampler = this.device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    });

    const uniformSize = MAX_CASCADES * 80 + 48;
    this.uniformBuffer = this.device.createBuffer({
      size: uniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  computeCascadeSplits(near: number, far: number): number[] {
    const splits: number[] = [];
    const count = this.settings.cascadeCount;
    const lambda = this.settings.lambda;
    for (let i = 0; i < count; i++) {
      const p = (i + 1) / count;
      const logSplit = near * Math.pow(far / near, p);
      const linearSplit = near + (far - near) * p;
      splits.push(near + (logSplit - near) * lambda + (linearSplit - near) * (1 - lambda));
    }
    this.cascadeSplits = splits;
    return splits;
  }

  computeCascadeViewProjs(
    lightDir: [number, number, number],
    cameraPos: [number, number, number],
    cameraDir: [number, number, number],
    cameraUp: [number, number, number],
    near: number,
    far: number,
    aspect: number,
    fov: number,
  ): void {
    const splits = this.computeCascadeSplits(near, far);
    const tanHalfFov = Math.tan(fov * 0.5);

    for (let i = 0; i < this.settings.cascadeCount; i++) {
      const cascadeNear = i === 0 ? near : splits[i - 1];
      const cascadeFar = splits[i];

      const cascadeMid = (cascadeNear + cascadeFar) * 0.5;
      const cascadeExtent = (cascadeFar - cascadeNear) * 0.5;

      const frustumHeight = tanHalfFov * cascadeMid * 2;
      const frustumWidth = frustumHeight * aspect;

      const maxRadius = Math.sqrt(frustumWidth * frustumWidth + frustumHeight * frustumHeight + 4 * cascadeExtent * cascadeExtent) * 0.55;

      const eye = vec3.create(
        cameraPos[0] - lightDir[0] * maxRadius,
        cameraPos[1] - lightDir[1] * maxRadius,
        cameraPos[2] - lightDir[2] * maxRadius,
      );

      const view = mat4.lookAt(eye, vec3.create(cameraPos[0], cameraPos[1], cameraPos[2]), vec3.create(0, 1, 0));
      const proj = mat4.ortho(-maxRadius, maxRadius, -maxRadius, maxRadius, 0.1, maxRadius * 4);
      this.cascadeViewProjs[i] = mat4.multiply(proj, view);
    }

    this.uploadUniforms();
  }

  private uploadUniforms(): void {
    const cascadeSize = 80;
    const totalSize = MAX_CASCADES * cascadeSize + 48;
    const data = new Float32Array(totalSize / 4);

    for (let i = 0; i < MAX_CASCADES; i++) {
      const off = i * (cascadeSize / 4);
      const vp = this.cascadeViewProjs[i];
      for (let j = 0; j < 16; j++) {
        data[off + j] = vp[j];
      }
      data[off + 16] = 1.0 / this.settings.shadowMapSize;
      data[off + 17] = 1.0 / this.settings.shadowMapSize;
      data[off + 18] = 0;
      data[off + 19] = 0;
    }

    const splitOff = MAX_CASCADES * (cascadeSize / 4);
    for (let i = 0; i < MAX_CASCADES; i++) {
      data[splitOff + i] = this.cascadeSplits[i] ?? 0;
    }

    data[splitOff + 4] = 0;
    data[splitOff + 5] = 0;
    data[splitOff + 6] = 0;
    data[splitOff + 7] = 0;

    data[splitOff + 8] = this.settings.cascadeCount;
    data[splitOff + 9] = this.settings.bias;
    data[splitOff + 10] = this.settings.normalBias;
    data[splitOff + 11] = this.settings.blendDistance;

    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
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
              { shaderLocation: 1, offset: 12, format: "float32x3" },
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

  setModelMatrix(model: Mat4): void {
    this.device.queue.writeBuffer(this.modelBuffer!, 0, model as unknown as BufferSource);
  }

  getShadowView(): GPUTextureView | null {
    return this.shadowView;
  }

  getShadowSampler(): GPUSampler | null {
    return this.shadowSampler;
  }

  getCascadeViewProjs(): Mat4[] {
    return this.cascadeViewProjs;
  }

  getCascadeSplits(): number[] {
    return this.cascadeSplits;
  }

  getSettings(): CSMSettings {
    return this.settings;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.shadowHandle) {
      builder.write(this.shadowHandle);
    }
  }

  renderCascade(
    encoder: GPUCommandEncoder,
    cascadeIndex: number,
    meshes: Array<{ mesh: MeshData; model: Mat4 }>,
  ): void {
    if (!this.shadowView || !this.shaderModule) return;

    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    const tracked = new TrackedRenderPass(pass);
    for (const { mesh, model } of meshes) {
      this.setModelMatrix(model);
      const pipeline = this.getPipeline(mesh.layout.stride);
      const bindGroup = this.bindGroups.get(mesh.layout.stride)!;
      tracked.setPipeline(pipeline);
      tracked.setBindGroup(0, bindGroup);
      tracked.setVertexBuffer(0, this.getVertexBuffer(mesh));
      tracked.setIndexBuffer(this.getIndexBuffer(mesh), mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(mesh.indexCount);
    }
    tracked.end();
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.shaderModule || !ctx.shadowsEnabled) return;
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
