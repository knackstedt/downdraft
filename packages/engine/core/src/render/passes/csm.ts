import type { StructView, WgslStruct, WgslType } from "@downdraft/engine/shader-graph";
import { mat4x4f, vec4f, wgsl } from "@downdraft/engine/shader-graph";
import { mat4, vec3, type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";
import { destroyMapValues } from "../resource-tracker";
import { createValidatedShaderModule } from "../shader-validator";
import { TrackedRenderPass } from "../tracked-render-pass";

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

const CascadeUniforms: WgslStruct = wgsl.struct("CascadeUniforms", {
  viewProj: mat4x4f,
  texelSize: vec4f,
});

// CSMUniforms contains a nested struct array (array<CascadeUniforms, N>).
// The wgsl.struct emitter cannot produce valid WGSL for nested struct arrays
// (it would inline the struct declaration inside array<...>), so the WGSL
// declaration below is hand-written. The WgslStruct descriptor is still used
// for the typed view layout (single source of truth for buffer offsets).
const CSMUniforms: WgslStruct = wgsl.struct("CSMUniforms", {
  cascades: wgsl.array(CascadeUniforms as unknown as WgslType, MAX_CASCADES),
  cascadeSplits: vec4f,
  lightDir: vec4f,
  cascadeCount: vec4f,
});

const CSM_SHADER = /* wgsl */ `
${CascadeUniforms.wgsl}

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
  // Per-cascade views for rendering to individual layers of the 2d-array texture.
  private cascadeViews: GPUTextureView[] = [];
  private shadowSampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;
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
      this.shaderModule = createValidatedShaderModule(this.device, { code: CSM_SHADER, label: "CSMPass" });
    }

    // Destroy old shadow resources before creating new ones.
    this.shadowTexture?.destroy();
    this.shadowView = null;
    // GPUTextureView does not have .destroy() — just drop the references.
    this.cascadeViews = [];

    this.shadowTexture = this.device.createTexture({
      size: [this.settings.shadowMapSize, this.settings.shadowMapSize, this.settings.cascadeCount],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView({
      dimension: "2d-array",
      arrayLayerCount: this.settings.cascadeCount,
    });

    // Create per-cascade views for rendering to individual layers
    this.cascadeViews = [];
    for (let i = 0; i < this.settings.cascadeCount; i++) {
      this.cascadeViews.push(this.shadowTexture.createView({
        dimension: "2d",
        baseArrayLayer: i,
        arrayLayerCount: 1,
      }));
    }

    this.shadowSampler = this.device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    });

    const uniformSize = CSMUniforms.size;
    this.uniformBuffer = this.device.createBuffer({
      size: uniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuf = new Float32Array(CSMUniforms.floatCount);
    this._uniformView = CSMUniforms.view(this._uniformBuf);

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
    const buf = this._uniformBuf!;
    const view = this._uniformView!;
    buf.fill(0);

    // Per-cascade viewProj + texelSize — written directly into the preallocated
    // buffer (the typed view does not support indexed array-of-struct access).
    const cascadeStride = CascadeUniforms.floatCount; // 20 floats per cascade
    for (let i = 0; i < MAX_CASCADES; i++) {
      const off = i * cascadeStride;
      buf.set(this.cascadeViewProjs[i], off);
      buf[off + 16] = 1.0 / this.settings.shadowMapSize;
      buf[off + 17] = 1.0 / this.settings.shadowMapSize;
      buf[off + 18] = 0;
      buf[off + 19] = 0;
    }

    view.set("cascadeSplits", [
      this.cascadeSplits[0] ?? 0,
      this.cascadeSplits[1] ?? 0,
      this.cascadeSplits[2] ?? 0,
      this.cascadeSplits[3] ?? 0,
    ]);
    view.set("lightDir", [0, 0, 0, 0]);
    view.set("cascadeCount", [
      this.settings.cascadeCount,
      this.settings.bias,
      this.settings.normalBias,
      this.settings.blendDistance,
    ]);

    this.device.queue.writeBuffer(this.uniformBuffer!, 0, buf as unknown as BufferSource);
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
    // Use the per-cascade view to render to the correct layer of the 2d-array texture
    const cascadeView = this.cascadeViews[cascadeIndex] ?? this.shadowView;

    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: cascadeView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    const tracked = new TrackedRenderPass(pass);
    meshes.forEach(({ mesh, model }) => {
      this.setModelMatrix(model);
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
    this.shadowView = null;
    // GPUSampler has no destroy() — it's GC'd automatically.
    this.shadowSampler = null;
    this.uniformBuffer?.destroy();
    this.modelBuffer?.destroy();
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
