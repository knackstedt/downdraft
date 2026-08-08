import { type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder";
import type { BindlessMaterialManager, BindlessTextureRegistry, MaterialParams } from "../bindless";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const DECAL_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad: vec4<f32>,
};

struct DecalUniforms {
  decalViewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  position: vec3<f32>,
  materialIndex: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> decal: DecalUniforms;
@group(0) @binding(2) var depthTexture: texture_depth_2d;
@group(0) @binding(3) var depthSampler: sampler;

// Bindless material binding model (@group(3))
struct BindlessMaterial {
  baseColor: vec4<f32>,
  roughness: f32,
  metallic: f32,
  emissiveIntensity: f32,
  _pad0: f32,
  albedoTex: u32,
  normalTex: u32,
  metallicRoughnessTex: u32,
  aoEmissiveTex: u32,
};

@group(3) @binding(0) var<storage, read> bindlessMaterials: array<BindlessMaterial>;
@group(3) @binding(1) var albedoArray0: texture_2d_array<f32>;
@group(3) @binding(2) var albedoArray1: texture_2d_array<f32>;
@group(3) @binding(3) var albedoArray2: texture_2d_array<f32>;
@group(3) @binding(4) var albedoArray3: texture_2d_array<f32>;
@group(3) @binding(5) var albedoArray4: texture_2d_array<f32>;
@group(3) @binding(6) var albedoArray5: texture_2d_array<f32>;
@group(3) @binding(7) var albedoArray6: texture_2d_array<f32>;
@group(3) @binding(8) var albedoArray7: texture_2d_array<f32>;
@group(3) @binding(9) var bindlessSamplerRepeat: sampler;
@group(3) @binding(10) var bindlessSamplerClamp: sampler;

fn unpackArrayIndex(handle: u32) -> u32 { return (handle >> 16u) & 0xFFFFu; }
fn unpackLayerIndex(handle: u32) -> u32 { return handle & 0xFFFFu; }

fn sampleBindlessArray(arr: u32, uv: vec2<f32>, layer: u32) -> vec4<f32> {
  switch (arr) {
    case 0u: { return textureSample(albedoArray0, bindlessSamplerRepeat, uv, layer); }
    case 1u: { return textureSample(albedoArray1, bindlessSamplerRepeat, uv, layer); }
    case 2u: { return textureSample(albedoArray2, bindlessSamplerRepeat, uv, layer); }
    case 3u: { return textureSample(albedoArray3, bindlessSamplerRepeat, uv, layer); }
    case 4u: { return textureSample(albedoArray4, bindlessSamplerRepeat, uv, layer); }
    case 5u: { return textureSample(albedoArray5, bindlessSamplerRepeat, uv, layer); }
    case 6u: { return textureSample(albedoArray6, bindlessSamplerRepeat, uv, layer); }
    case 7u: { return textureSample(albedoArray7, bindlessSamplerRepeat, uv, layer); }
    default: { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  }
}

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.worldPos = input.position;
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let clipPos = camera.viewProj * vec4<f32>(input.worldPos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;
  let screenUV = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);

  let depth = textureSample(depthTexture, depthSampler, screenUV);
  let worldDepth = ndc.z;

  if (depth < worldDepth - 0.001) {
    discard;
  }

  let decalClip = decal.decalViewProj * vec4<f32>(input.worldPos, 1.0);
  let decalNDC = decalClip.xyz / decalClip.w;
  if (any(abs(decalNDC) > vec3<f32>(1.0))) {
    discard;
  }

  let decalUV = decalNDC.xy * vec2<f32>(0.5, 0.5) + vec2<f32>(0.5, 0.5);
  // Bindless albedo sample — decals use the albedoTex handle from the material.
  let m = bindlessMaterials[decal.materialIndex];
  let arr = unpackArrayIndex(m.albedoTex);
  let layer = unpackLayerIndex(m.albedoTex);
  let decalColor = sampleBindlessArray(arr, decalUV, layer);

  return vec4<f32>(decalColor.rgb, decalColor.a);
}
`;

export interface DecalItem {
  mesh: MeshData;
  modelMatrix: Mat4;
  decalViewProj: Mat4;
  /** Bindless: sourceId of the decal texture registered in the BindlessTextureRegistry. */
  decalTextureSourceId?: string;
  /** Legacy: decal texture view (used when bindless deps are not set). */
  decalTexture?: GPUTextureView;
  decalSampler?: GPUSampler;
}

export class DecalPass extends RenderPass {
  name = "decal";
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;

  private device: GPUDevice | null;
  private surfaceFormat: GPUTextureFormat;
  private shaderModule: GPUShaderModule | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private decalBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private depthSampler: GPUSampler | null = null;
  private items: DecalItem[] = [];
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();
  // Bindless deps
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessBindGroup: GPUBindGroup | null = null;
  /** Cached materialIndex per decal sourceId. */
  private decalMaterialIndex = new Map<string, number>();

  constructor(device: GPUDevice | null, surfaceFormat: GPUTextureFormat) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
  }

  /** Provide bindless deps. When set, decals use @group(3) for textures. */
  setBindlessDeps(
    registry: BindlessTextureRegistry | null,
    materialManager: BindlessMaterialManager | null,
    bindGroup: GPUBindGroup | null,
  ): void {
    this.bindlessRegistry = registry;
    this.bindlessMaterialManager = materialManager;
    this.bindlessBindGroup = bindGroup;
  }

  setBindlessBindGroup(bg: GPUBindGroup | null): void {
    this.bindlessBindGroup = bg;
  }

  prepare(device: GPUDevice): void {
    if (!this.device) this.device = device;
    if (!this.shaderModule && this.device) {
      this.shaderModule = this.device.createShaderModule({ code: DECAL_SHADER });
    }
    if (!this.cameraBuffer && this.device) {
      this.cameraBuffer = this.device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.decalBuffer && this.device) {
      this.decalBuffer = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.depthSampler && this.device) {
      this.depthSampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        compare: "less",
      });
    }
  }

  setDepthTextureView(view: GPUTextureView): void {
    this.depthTextureView = view;
    this.bindGroup = null; // rebuild bind group with new depth view
  }

  addItem(item: DecalItem): void {
    this.items.push(item);
  }

  clearItems(): void {
    this.items.length = 0;
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.device || this.items.length === 0 || !ctx.pass || !this.depthTextureView) return;
    this.ensurePipeline();
    if (!this.pipeline) return;

    const camData = new Float32Array(20);
    camData.set(ctx.viewProj as Float32Array, 0);
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, camData as unknown as BufferSource);

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);

    // Set the bindless bind group once (@group(3)).
    if (this.bindlessBindGroup) tracked.setBindGroup(3, this.bindlessBindGroup);

    // Create the per-pass bind group once (camera + decal + depth — no texture).
    if (!this.bindGroup && this.depthSampler) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer! } },
          { binding: 1, resource: { buffer: this.decalBuffer! } },
          { binding: 2, resource: this.depthTextureView! },
          { binding: 3, resource: this.depthSampler! },
        ],
      });
    }
    tracked.setBindGroup(0, this.bindGroup!);

    for (const item of this.items) {
      const decalData = new Float32Array(48);
      decalData.set(item.decalViewProj as Float32Array, 0);
      decalData.set(ctx.viewProj as Float32Array, 16);
      decalData[32] = item.modelMatrix[12];
      decalData[33] = item.modelMatrix[13];
      decalData[34] = item.modelMatrix[14];
      // materialIndex (u32) at float slot 35 (byte offset 140).
      const matIdx = this.getOrCreateDecalMaterialIndex(item);
      const dv = new DataView(decalData.buffer);
      dv.setUint32(140, matIdx, true);
      this.device.queue.writeBuffer(this.decalBuffer!, 0, decalData as unknown as BufferSource);

      tracked.setVertexBuffer(0, this.getVertexBuffer(item.mesh));
      tracked.setIndexBuffer(this.getIndexBuffer(item.mesh), item.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(item.mesh.indexCount);
    }
  }

  /** Get or create a bindless material index for a decal item. */
  private getOrCreateDecalMaterialIndex(item: DecalItem): number {
    if (!this.bindlessRegistry || !this.bindlessMaterialManager) return 0;
    const sourceId = item.decalTextureSourceId ?? `decal:${item.modelMatrix[12]},${item.modelMatrix[13]},${item.modelMatrix[14]}`;
    const cached = this.decalMaterialIndex.get(sourceId);
    if (cached !== undefined) return cached;
    const handle = this.bindlessRegistry.getHandle(sourceId) ?? this.bindlessRegistry.defaultWhiteHandle;
    const params: MaterialParams = {
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      emissiveIntensity: 0,
      albedoTexHandle: handle,
      normalTexHandle: this.bindlessRegistry.defaultWhiteHandle,
      metallicRoughnessTexHandle: this.bindlessRegistry.defaultWhiteHandle,
      aoTexHandle: this.bindlessRegistry.defaultWhiteHandle,
      emissiveTexHandle: this.bindlessRegistry.defaultWhiteHandle,
    };
    const idx = this.bindlessMaterialManager.registerMaterial(params);
    this.decalMaterialIndex.set(sourceId, idx);
    return idx;
  }

  private ensurePipeline(): void {
    if (this.pipeline || !this.device || !this.shaderModule || !this.cameraBuffer || !this.decalBuffer) return;
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
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
  }

  private getVertexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.vertexBuffers.get(mesh);
    if (!buf && this.device) {
      buf = this.device.createBuffer({
        size: mesh.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.vertices.buffer);
      this.vertexBuffers.set(mesh, buf);
    }
    return buf!;
  }

  private getIndexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.indexBuffers.get(mesh);
    if (!buf && this.device) {
      buf = this.device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.indices.buffer);
      this.indexBuffers.set(mesh, buf);
    }
    return buf!;
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.decalBuffer?.destroy();
    this.pipeline?.destroy();
    this.shaderModule?.destroy();
    // GPUSampler has no destroy() — it's GC'd automatically.
    this.depthSampler = null;
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
  }
}
