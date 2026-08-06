import type { ShaderGraphProfile } from "@downdraft/shader-graph";
import { getProfile } from "@downdraft/shader-graph";
import { mat4, type Mat4 } from "wgpu-matrix";
import type { Material } from "../../material/material";
import type { MeshData } from "../../mesh/builder";
import type { BindlessMaterialManager, BindlessTextureRegistry, MaterialParams } from "../bindless";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const GBUFFER_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
  prevModelMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) prevClipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = camera.modelMatrix * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.worldPos = worldPos.xyz;
  output.worldNormal = normalize((camera.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.uv = input.uv;
  output.color = input.color;
  let prevWorldPos = camera.prevModelMatrix * vec4<f32>(input.position, 1.0);
  output.prevClipPosition = camera.prevViewProj * prevWorldPos;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32>,
                                    @location(1) vec4<f32>,
                                    @location(2) vec4<f32>,
                                    @location(3) vec2<f32> {
  // GBuffer0: albedo (RGB) + AO (A)
  let albedo = input.color.rgb;
  let ao = 1.0;
  // GBuffer1: normal (RGB) + roughness (A)
  let encodedNormal = normalize(input.worldNormal) * 0.5 + 0.5;
  let roughness = 0.5;
  // GBuffer2: metallic (R) + emissive (GBA)
  let metallic = 0.0;
  let emissive = vec3<f32>(0.0);
  // Velocity: screen-space motion (curr - prev)
  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  return vec4<f32>(albedo, ao),
         vec4<f32>(encodedNormal, roughness),
         vec4<f32>(metallic, emissive),
         velocity;
}
`;

const PBR_GBUFFER_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;
@group(0) @binding(2) var prevModelUniform: mat4x4<f32>;
@group(0) @binding(3) var<uniform> materialIndex: u32;

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
  @location(3) tangent: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) worldNormal: vec3<f32>,
  @location(3) worldTangent: vec3<f32>,
  @location(4) worldBitangent: vec3<f32>,
  @location(5) prevClipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.worldPosition = worldPos.xyz;
  output.uv = input.uv;

  let normalMatrix = mat3x3<f32>(
    modelUniform[0].xyz,
    modelUniform[1].xyz,
    modelUniform[2].xyz,
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  output.worldTangent = normalize(normalMatrix * input.tangent.xyz);
  output.worldBitangent = cross(output.worldNormal, output.worldTangent) * input.tangent.w;

  let prevWorldPos = prevModelUniform * vec4<f32>(input.position, 1.0);
  output.prevClipPosition = camera.prevViewProj * prevWorldPos;

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> (
  @location(0) vec4<f32>,
  @location(1) vec4<f32>,
  @location(2) vec4<f32>,
  @location(3) vec2<f32>,
) {
  let m = bindlessMaterials[materialIndex];
  let albArr = unpackArrayIndex(m.albedoTex);
  let albLayer = unpackLayerIndex(m.albedoTex);
  let albedo = sampleBindlessArray(albArr, input.uv, albLayer) * m.baseColor;

  let mrArr = unpackArrayIndex(m.metallicRoughnessTex);
  let mrLayer = unpackLayerIndex(m.metallicRoughnessTex);
  let mr = sampleBindlessArray(mrArr, input.uv, mrLayer);
  let metallic = mr.b * m.metallic;
  let roughness = mr.g * m.roughness;

  let aoHandle = m.aoEmissiveTex & 0xFFFFu;
  let aoArr = unpackArrayIndex(aoHandle);
  let aoLayer = unpackLayerIndex(aoHandle);
  let ao = sampleBindlessArray(aoArr, input.uv, aoLayer).r;

  let emHandle = (m.aoEmissiveTex >> 16u) & 0xFFFFu;
  let emArr = unpackArrayIndex(emHandle);
  let emLayer = unpackLayerIndex(emHandle);
  let emissive = sampleBindlessArray(emArr, input.uv, emLayer).rgb * m.emissiveIntensity;

  let nArr = unpackArrayIndex(m.normalTex);
  let nLayer = unpackLayerIndex(m.normalTex);
  let tangentNormal = sampleBindlessArray(nArr, input.uv, nLayer).xyz * 2.0 - 1.0;
  let TBN = mat3x3<f32>(
    input.worldTangent,
    input.worldBitangent,
    input.worldNormal,
  );
  let worldNormal = normalize(TBN * tangentNormal);
  let encodedNormal = (worldNormal * 0.5 + 0.5);

  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  return (
    vec4<f32>(albedo.rgb, ao),
    vec4<f32>(encodedNormal, roughness),
    vec4<f32>(metallic, emissive.r, emissive.g, emissive.b),
    velocity,
  );
}
`;

const SIMPLE_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = camera.modelMatrix * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.color = input.color;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let lambert = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let intensity = ambient + lambert * 0.7;
  return vec4<f32>(input.color.rgb * intensity, input.color.a);
}
`;

export type OpaquePassMode = "gbuffer" | "simple";

export interface PBRMaterialResources {
  // Bindless path: texture sourceIds registered in the BindlessTextureRegistry.
  // When set, the OpaquePass PBR path uses @group(3) for materials.
  albedoTextureSourceId?: string;
  normalTextureSourceId?: string;
  metallicRoughnessTextureSourceId?: string;
  aoTextureSourceId?: string;
  emissiveTextureSourceId?: string;
  baseColor: [number, number, number, number];
  roughness: number;
  metallic: number;
  emissiveIntensity: number;
}

export class OpaquePass extends RenderPass {
  name = "opaque";
  // Graph handles (set by RenderLoop before graph build)
  gbufferAlbedoHandle: TextureHandle | null = null;
  gbufferNormalHandle: TextureHandle | null = null;
  gbufferMetallicEmissiveHandle: TextureHandle | null = null;
  gbufferVelocityHandle: TextureHandle | null = null;
  gbufferDepthHandle: TextureHandle | null = null;
  surfaceHandle: TextureHandle | null = null;  // for simple mode
  depthHandle: TextureHandle | null = null;  // for simple mode depth
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private mesh: MeshData | null = null;
  private depthTexture: GPUTexture | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private surfaceFormat: GPUTextureFormat;
  private mode: OpaquePassMode;
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private modelMatrix: Mat4 = mat4.identity();
  private prevModelMatrix: Mat4 = mat4.identity();
  private prevViewProj: Mat4 = mat4.identity();
  private pbrPipeline: GPURenderPipeline | null = null;
  private pbrShaderModule: GPUShaderModule | null = null;
  private pbrCameraBuffer: GPUBuffer | null = null;
  private pbrModelBuffer: GPUBuffer | null = null;
  private pbrPrevModelBuffer: GPUBuffer | null = null;
  private pbrMaterialIndexBuffer: GPUBuffer | null = null;
  private pbrCameraBindGroup: GPUBindGroup | null = null;
  private pbrMaterial: PBRMaterialResources | null = null;
  private pbrMaterialIndex: number = 0;
  private pbrMaterialRegistered: boolean = false;
  // Bindless deps (optional — when set, the PBR path uses @group(3))
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessBindGroup: GPUBindGroup | null = null;
  private lastViewProj: Mat4 = mat4.identity();
  private graphMaterial: Material | null = null;
  private graphPipeline: GPURenderPipeline | null = null;
  private graphShaderModule: GPUShaderModule | null = null;
  private graphCameraBuffer: GPUBuffer | null = null;
  private graphBindGroup: GPUBindGroup | null = null;
  private graphProfile: ShaderGraphProfile | null = null;
  private graphExtraBindGroups: Map<number, GPUBindGroup> = new Map();
  private graphInstanceBuffer: GPUBuffer | null = null;
  private graphInstanceCount: number = 0;
  private graphUniformData: Float32Array | null = null;

  constructor(device: GPUDevice, surfaceFormat?: GPUTextureFormat, mode: OpaquePassMode = "gbuffer") {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat ?? (navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm");
    this.mode = mode;
  }

  setMesh(mesh: MeshData): void {
    this.mesh = mesh;
    this.vertexBuffer = this.device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices.buffer);

    this.indexBuffer = this.device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices.buffer);
  }

  setShaderSource(wgsl: string): void {
    this.shaderModule = this.device.createShaderModule({ code: wgsl });
    this.pipeline = null;
  }

  setModelMatrix(model: Mat4): void {
    this.prevModelMatrix = this.modelMatrix;
    this.modelMatrix = model;
  }

  setPrevViewProj(prevViewProj: Mat4): void {
    this.prevViewProj = prevViewProj;
  }

  /** Provide bindless deps. When set, the PBR path uses @group(3) for materials. */
  setBindlessDeps(
    registry: BindlessTextureRegistry | null,
    materialManager: BindlessMaterialManager | null,
    bindGroup: GPUBindGroup | null,
  ): void {
    this.bindlessRegistry = registry;
    this.bindlessMaterialManager = materialManager;
    this.bindlessBindGroup = bindGroup;
    this.pbrPipeline = null; // rebuild pipeline with bindless layout
    this.pbrMaterialRegistered = false;
  }

  /** Update the bindless bind group for the frame (call before execute). */
  setBindlessBindGroup(bg: GPUBindGroup | null): void {
    this.bindlessBindGroup = bg;
  }

  setPBRMaterial(resources: PBRMaterialResources): void {
    this.pbrMaterial = resources;
    this.pbrPipeline = null;
    this.pbrMaterialRegistered = false;
  }

  setMaterial(material: Material): void {
    if (!material.inlineShaderSource) return;
    this.graphMaterial = material;
    this.graphPipeline = null;
    this.graphBindGroup = null;
    this.graphExtraBindGroups.clear();
    if (material.profile) {
      this.graphProfile = getProfile(material.profile) ?? null;
    }
  }

  setGraphProfile(profile: ShaderGraphProfile): void {
    this.graphProfile = profile;
    this.graphPipeline = null;
    this.graphBindGroup = null;
    this.graphExtraBindGroups.clear();
  }

  setExtraBindGroup(group: number, bindGroup: GPUBindGroup): void {
    this.graphExtraBindGroups.set(group, bindGroup);
  }

  setInstanceBuffer(buffer: GPUBuffer, count: number): void {
    this.graphInstanceBuffer = buffer;
    this.graphInstanceCount = count;
  }

  setGraphUniformData(data: Float32Array): void {
    this.graphUniformData = data;
  }

  private ensureGraphPipeline(): void {
    if (this.graphPipeline || !this.mesh || !this.graphMaterial?.inlineShaderSource) return;

    this.graphShaderModule = this.device.createShaderModule({ code: this.graphMaterial.inlineShaderSource });

    const profile = this.graphProfile;
    const uniformSize = profile
      ? this.calcUniformSize(profile)
      : 192;

    this.graphCameraBuffer = this.device.createBuffer({
      size: Math.max(uniformSize, 16),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vertexAttrs = profile
      ? profile.vertexLayout.attributes.map((a) => ({
          shaderLocation: a.location,
          offset: a.offset,
          format: a.format as GPUVertexFormat,
        }))
      : [
          { shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat },
          { shaderLocation: 1, offset: 12, format: "float32x3" as GPUVertexFormat },
          { shaderLocation: 2, offset: 24, format: "float32x2" as GPUVertexFormat },
        ];

    const stride = profile?.vertexLayout.stride ?? this.mesh.layout.stride;

    const targets = profile
      ? this.getProfileTargets(profile)
      : [{ format: this.surfaceFormat }];

    const topology = profile?.topology ?? "triangle-list";
    const cullMode = this.graphMaterial.cullMode === "front" ? "front" : this.graphMaterial.cullMode === "none" ? "none" : "back";
    const depthWrite = profile?.depthWriteEnabled ?? true;

    this.graphPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.graphShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: stride,
          attributes: vertexAttrs,
        }],
      },
      fragment: {
        module: this.graphShaderModule,
        entryPoint: "fs_main",
        targets,
      },
      primitive: {
        topology: topology as GPUPrimitiveTopology,
        cullMode: cullMode as GPUCullMode,
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: depthWrite,
        depthCompare: "less",
      },
    });

    // Build bind group 0 — uniform buffer + any profile-defined group 0 bindings
    const group0Entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.graphCameraBuffer } },
    ];

    // Add profile-defined bindings for group 0 (e.g. sampler, texture, storage)
    if (profile) {
      const g0 = profile.bindGroups.find((bg) => bg.group === 0);
      if (g0) {
        for (const entry of g0.entries) {
          if (entry.binding === 0) continue; // Already added uniform
          // These resources need to be provided externally — skip if not set
        }
      }
    }

    this.graphBindGroup = this.device.createBindGroup({
      layout: this.graphPipeline.getBindGroupLayout(0),
      entries: group0Entries,
    });
  }

  private calcUniformSize(profile: ShaderGraphProfile): number {
    let size = 0;
    for (const field of profile.uniformFields) {
      if (field.type === "mat4x4<f32>") size += 64;
      else if (field.type === "vec4<f32>") size += 16;
      else if (field.type === "vec3<f32>") size += 16; // vec3 aligned to 16
      else if (field.type === "vec2<f32>") size += 8;
      else if (field.type === "f32") size += 4;
      else if (field.type === "u32") size += 4;
      else size += 16;
    }
    // Align to 16
    return Math.ceil(size / 16) * 16;
  }

  private getProfileTargets(profile: ShaderGraphProfile): GPUColorTargetState[] {
    if (profile.blend === "transparent") {
      return [{
        format: this.surfaceFormat,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }];
    }
    if (profile.blend === "additive") {
      return [{
        format: this.surfaceFormat,
        blend: {
          color: { srcFactor: "one", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        },
      }];
    }
    return [{ format: this.surfaceFormat }];
  }

  private updateGraphCamera(viewProj: Mat4): void {
    if (!this.graphCameraBuffer) return;
    // If custom uniform data is provided, use it directly
    if (this.graphUniformData) {
      this.device.queue.writeBuffer(this.graphCameraBuffer, 0, this.graphUniformData as unknown as BufferSource);
      return;
    }
    // Default: write viewProj + modelMatrix + cameraPos + time
    const profile = this.graphProfile;
    const size = profile ? this.calcUniformSize(profile) : 192;
    const data = new Float32Array(size / 4);
    data.set(viewProj as Float32Array, 0);
    if (profile) {
      let offset = 16; // after viewProj (mat4x4)
      const hasModelMatrix = profile.uniformFields.some((f) => f.name === "modelMatrix");
      if (hasModelMatrix) {
        data.set(this.modelMatrix as Float32Array, offset);
        offset += 16;
      }
      // cameraPos (vec3) + time (f32) = 4 floats
      data.set([0, 0, 0, 0], offset);
    } else {
      data.set(this.modelMatrix as Float32Array, 16);
      data.set([0, 0, 0, 0], 32);
    }
    this.device.queue.writeBuffer(this.graphCameraBuffer, 0, data as unknown as BufferSource);
  }

  private ensurePBRPipeline(): void {
    if (this.pbrPipeline || !this.mesh) return;

    if (!this.pbrShaderModule) {
      this.pbrShaderModule = this.device.createShaderModule({ code: PBR_GBUFFER_SHADER });
    }

    this.pbrCameraBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrModelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrPrevModelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrMaterialIndexBuffer = this.device.createBuffer({
      size: 16, // u32 + padding (uniform buffer min alignment)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pbrPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.pbrShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: this.mesh.layout.stride,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.pbrShaderModule,
        entryPoint: "fs_main",
        targets: [
          { format: "rgba8unorm" },
          { format: "rgba8unorm" },
          { format: "rgba8unorm" },
          { format: "rg16float" },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.pbrCameraBindGroup = this.device.createBindGroup({
      layout: this.pbrPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pbrCameraBuffer } },
        { binding: 1, resource: { buffer: this.pbrModelBuffer } },
        { binding: 2, resource: { buffer: this.pbrPrevModelBuffer } },
        { binding: 3, resource: { buffer: this.pbrMaterialIndexBuffer } },
      ],
    });
  }

  /** Register/update the PBR material in the bindless material manager. */
  private ensurePBRMaterialRegistered(): void {
    if (this.pbrMaterialRegistered || !this.pbrMaterial || !this.bindlessRegistry || !this.bindlessMaterialManager) return;
    const mat = this.pbrMaterial;
    const registry = this.bindlessRegistry;
    const params: MaterialParams = {
      baseColor: mat.baseColor,
      roughness: mat.roughness,
      metallic: mat.metallic,
      emissiveIntensity: mat.emissiveIntensity,
      albedoTexHandle: mat.albedoTextureSourceId
        ? registry.getHandle(mat.albedoTextureSourceId) ?? registry.defaultWhiteHandle
        : registry.defaultWhiteHandle,
      normalTexHandle: mat.normalTextureSourceId
        ? registry.getHandle(mat.normalTextureSourceId) ?? registry.defaultWhiteHandle
        : registry.defaultWhiteHandle,
      metallicRoughnessTexHandle: mat.metallicRoughnessTextureSourceId
        ? registry.getHandle(mat.metallicRoughnessTextureSourceId) ?? registry.defaultWhiteHandle
        : registry.defaultWhiteHandle,
      aoTexHandle: mat.aoTextureSourceId
        ? registry.getHandle(mat.aoTextureSourceId) ?? registry.defaultWhiteHandle
        : registry.defaultWhiteHandle,
      emissiveTexHandle: mat.emissiveTextureSourceId
        ? registry.getHandle(mat.emissiveTextureSourceId) ?? registry.defaultWhiteHandle
        : registry.defaultWhiteHandle,
    };
    this.pbrMaterialIndex = this.bindlessMaterialManager.registerMaterial(params);
    // Write the material index into the uniform buffer (u32 at offset 0).
    const idxData = new Uint32Array(1);
    idxData[0] = this.pbrMaterialIndex;
    this.device.queue.writeBuffer(this.pbrMaterialIndexBuffer!, 0, idxData as unknown as BufferSource);
    this.pbrMaterialRegistered = true;
  }

  private updatePBRCamera(viewProj: Mat4): void {
    if (!this.pbrCameraBuffer || !this.pbrModelBuffer || !this.pbrPrevModelBuffer) return;
    const camData = new Float32Array(32);
    camData.set(viewProj as Float32Array, 0);
    camData.set(this.prevViewProj as Float32Array, 16);
    this.device.queue.writeBuffer(this.pbrCameraBuffer, 0, camData as unknown as BufferSource);
    this.device.queue.writeBuffer(this.pbrModelBuffer, 0, this.modelMatrix as unknown as BufferSource);
    this.device.queue.writeBuffer(this.pbrPrevModelBuffer, 0, this.prevModelMatrix as unknown as BufferSource);
  }

  prepare(_device: GPUDevice): void {
    if (!this.mesh) return;

    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({
        code: this.mode === "gbuffer" ? GBUFFER_SHADER : SIMPLE_SHADER,
      });
    }

    if (this.mode === "gbuffer") {
      this.cameraBuffer = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    } else {
      this.cameraBuffer = this.device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    if (this.mode === "gbuffer") {
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: this.mesh.layout.stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.shaderModule,
          entryPoint: "fs_main",
          targets: [
            { format: "rgba8unorm" },
            { format: "rgba8unorm" },
            { format: "rgba8unorm" },
            { format: "rg16float" },
          ],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "back",
        },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    } else {
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: this.mesh.layout.stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.shaderModule,
          entryPoint: "fs_main",
          targets: [{ format: this.surfaceFormat }],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "back",
        },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    }

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer! } }],
    });
  }

  updateCamera(viewProj: Mat4): void {
    if (!this.cameraBuffer) return;
    this.lastViewProj = viewProj;
    if (this.mode === "gbuffer") {
      const data = new Float32Array(64);
      data.set(viewProj as Float32Array, 0);
      data.set(this.prevViewProj as Float32Array, 16);
      data.set(this.modelMatrix as Float32Array, 32);
      data.set(this.prevModelMatrix as Float32Array, 48);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
    } else {
      const data = new Float32Array(32);
      data.set(viewProj as Float32Array, 0);
      data.set(this.modelMatrix as Float32Array, 16);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
    }
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.mode === "gbuffer") {
      if (this.gbufferAlbedoHandle) builder.colorAttachment({ handle: this.gbufferAlbedoHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } });
      if (this.gbufferNormalHandle) builder.colorAttachment({ handle: this.gbufferNormalHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 1 } });
      if (this.gbufferMetallicEmissiveHandle) builder.colorAttachment({ handle: this.gbufferMetallicEmissiveHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } });
      if (this.gbufferVelocityHandle) builder.colorAttachment({ handle: this.gbufferVelocityHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } });
      if (this.gbufferDepthHandle) builder.depthAttachment({ handle: this.gbufferDepthHandle, depthLoadOp: "load", depthStoreOp: "store", depthClearValue: 1.0 });
    } else {
      if (this.surfaceHandle) builder.colorAttachment({ handle: this.surfaceHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0.1, g: 0.1, b: 0.12, a: 1 } });
      if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1.0 });
    }
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.vertexBuffer || !this.indexBuffer || !this.mesh || !ctx.pass) return;

    this.setPrevViewProj(ctx.prevViewProj);
    this.updateCamera(ctx.viewProj);

    const tracked = ctx.pass;

    if (this.graphMaterial && this.graphMaterial.inlineShaderSource) {
      this.ensureGraphPipeline();
      if (!this.graphPipeline || !this.graphBindGroup) return;
      this.updateGraphCamera(this.lastViewProj);
      tracked.setPipeline(this.graphPipeline);
      tracked.setBindGroup(0, this.graphBindGroup);
      // Set extra bind groups (lights, IBL, etc.)
      for (const [group, bg] of this.graphExtraBindGroups) {
        tracked.setBindGroup(group, bg);
      }
      tracked.setVertexBuffer(0, this.vertexBuffer);
      tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      if (this.graphInstanceBuffer && this.graphInstanceCount > 0) {
        tracked.drawIndexed(this.mesh.indexCount, this.graphInstanceCount);
      } else {
        tracked.drawIndexed(this.mesh.indexCount);
      }
      return;
    }

    if (this.pbrMaterial && this.mode === "gbuffer") {
      this.ensurePBRPipeline();
      this.ensurePBRMaterialRegistered();
      if (!this.pbrPipeline || !this.pbrCameraBindGroup) return;
      this.updatePBRCamera(this.lastViewProj);
      tracked.setPipeline(this.pbrPipeline);
      tracked.setBindGroup(0, this.pbrCameraBindGroup);
      // Bindless material bind group (@group(3)) — set once per frame by the host.
      if (this.bindlessBindGroup) tracked.setBindGroup(3, this.bindlessBindGroup);
      tracked.setVertexBuffer(0, this.vertexBuffer);
      tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(this.mesh.indexCount);
      return;
    }

    if (!this.pipeline || !this.bindGroup) return;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.setVertexBuffer(0, this.vertexBuffer);
    tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(this.mesh.indexCount);
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.pipeline?.getBindGroupLayout(0) ?? null;
  }

  ensureDepthTexture(width: number, height: number): GPUTexture {
    if (this.depthTexture) {
      if (this.depthTexture.width === width && this.depthTexture.height === height) {
        return this.depthTexture;
      }
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.depthTexture;
  }

  getDepthTextureView(): GPUTextureView | null {
    return this.depthTexture?.createView() ?? null;
  }

  getVertexBuffer(): GPUBuffer | null {
    return this.vertexBuffer;
  }

  getIndexBuffer(): GPUBuffer | null {
    return this.indexBuffer;
  }

  getIndexCount(): number {
    return this.mesh?.indexCount ?? 0;
  }

  getIndexFormat(): GPUIndexFormat {
    return this.mesh?.indices instanceof Uint16Array ? "uint16" : "uint32";
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.depthTexture?.destroy();
    this.cameraBuffer?.destroy();
    this.pbrCameraBuffer?.destroy();
    this.pbrModelBuffer?.destroy();
    this.pbrPrevModelBuffer?.destroy();
    this.pbrMaterialIndexBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.depthTexture = null;
    this.cameraBuffer = null;
    this.pbrPipeline = null;
    this.pbrCameraBuffer = null;
    this.pbrModelBuffer = null;
    this.pbrPrevModelBuffer = null;
    this.pbrMaterialIndexBuffer = null;
    this.pbrMaterial = null;
    this.pbrMaterialRegistered = false;
    this.graphCameraBuffer?.destroy();
    this.graphPipeline = null;
    this.graphShaderModule = null;
    this.graphCameraBuffer = null;
    this.graphBindGroup = null;
    this.graphMaterial = null;
    this.graphProfile = null;
    this.graphExtraBindGroups.clear();
    this.graphInstanceBuffer = null;
    this.graphInstanceCount = 0;
    this.graphUniformData = null;
  }
}
