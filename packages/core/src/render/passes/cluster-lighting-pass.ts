import { type Mat4 } from "wgpu-matrix";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import type { GBufferViews } from "../g-buffer";
import { createIBLShaderChunk } from "../ibl-bind-group";
import type { LightUniformData } from "../lighting";
import { packLightUniform } from "../lighting";
import type { ClusterGrid } from "../lighting/cluster-grid";
import { RenderPass } from "../render-pass";

const IBL_CHUNK = createIBLShaderChunk(1, true);

const CLUSTER_LIGHTING_SHADER = /* wgsl */ `
${IBL_CHUNK}

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

struct ClusterUniforms {
  clusterDims: vec3<u32>,
  screenWidth: f32,
  screenHeight: f32,
  nearPlane: f32,
  farPlane: f32,
  numLights: u32,
  _pad: u32,
};

struct LightData {
  position: vec4<f32>,
  color: vec4<f32>,
  direction: vec4<f32>,
  params: vec4<f32>,
};

struct ClusterEntry {
  offset: u32,
  count: u32,
};

struct LightUniforms {
  dirDirection: vec4<f32>,
  dirColor: vec4<f32>,
  hemiDirIntensity: vec4<f32>,
  hemiSkyColor: vec4<f32>,
  hemiGroundColor: vec4<f32>,
  ambient: vec4<f32>,
  lightCount: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var metallicEmissiveTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var shadowMapTex: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
@group(0) @binding(7) var<uniform> lights: LightUniforms;
@group(0) @binding(8) var<uniform> lightViewProj: mat4x4<f32>;

// Cluster bindings (group 2)
@group(2) @binding(0) var<uniform> clusterUniforms: ClusterUniforms;
@group(2) @binding(1) var<storage> clusterLightData: array<LightData>;
@group(2) @binding(2) var<storage> clusterLightGrid: array<ClusterEntry>;
@group(2) @binding(3) var<storage> clusterLightIndexList: array<u32>;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let worldPos = camera.invViewProj * vec4<f32>(ndc, 1.0);
  return worldPos.xyz / worldPos.w;
}

fn pbrBRDF(
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  N: vec3<f32>,
  V: vec3<f32>,
  L: vec3<f32>,
  lightColor: vec3<f32>,
  intensity: f32,
) -> vec3<f32> {
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);
  let NdotV = max(dot(N, V), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  let F0 = mix(vec3<f32>(0.04, 0.04, 0.04), albedo, metallic);
  let fresnel = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);

  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let denom = NdotH * NdotH * (alpha2 - 1.0) + 1.0;
  let D = alpha2 / (3.14159265 * denom * denom);

  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let G1V = NdotV / (NdotV * (1.0 - k) + k);
  let G1L = NdotL / (NdotL * (1.0 - k) + k);
  let G = G1V * G1L;

  let kD = (1.0 - metallic) * (1.0 - fresnel);
  let diffuse = kD * albedo / 3.14159265;
  let specular = (fresnel * D * G) / max(4.0 * NdotV * NdotL, 0.001);

  return (diffuse + specular) * lightColor * intensity * NdotL;
}

fn shadowFactor(worldPos: vec3<f32>) -> f32 {
  if (lights.dirColor.w < 0.5) { return 1.0; }
  let shadowCoord = lightViewProj * vec4<f32>(worldPos, 1.0);
  let shadowUV = shadowCoord.xy / shadowCoord.w * 0.5 + 0.5;
  let shadowDepth = shadowCoord.z / shadowCoord.w;
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }
  let bias = 0.001;
  return textureSampleCompare(shadowMapTex, shadowSampler, shadowUV, shadowDepth - bias);
}

fn hemisphereAmbient(N: vec3<f32>) -> vec3<f32> {
  if (lights.hemiDirIntensity.w < 0.5) {
    return lights.ambient.rgb * lights.ambient.w;
  }
  let up = normalize(lights.hemiDirIntensity.xyz);
  let hemiMix = max(dot(N, up), 0.0);
  return mix(lights.hemiGroundColor.rgb, lights.hemiSkyColor.rgb, hemiMix) * lights.hemiDirIntensity.w;
}

fn computeClusterIndex(uv: vec2<f32>, viewDepth: f32) -> u32 {
  let dims = clusterUniforms.clusterDims;
  let cx = min(u32(uv.x * f32(dims.x)), dims.x - 1u);
  let cy = min(u32(uv.y * f32(dims.y)), dims.y - 1u);

  let near = clusterUniforms.nearPlane;
  let far = clusterUniforms.farPlane;
  let logDepth = log(viewDepth / near) / log(far / near);
  let cz = min(u32(logDepth * f32(dims.z)), dims.z - 1u);

  return cx + cy * dims.x + cz * dims.x * dims.y;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(albedoTex, 0));
  let texel = vec2<i32>(input.uv * dims);

  let albedoAO = textureLoad(albedoTex, texel, 0);
  let normalRough = textureLoad(normalTex, texel, 0);
  let metallicEmissive = textureLoad(metallicEmissiveTex, texel, 0);
  let depth = textureLoad(depthTex, texel, 0);

  if (depth >= 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let albedo = albedoAO.rgb;
  let ao = albedoAO.a;
  let N = normalize(normalRough.rgb * 2.0 - 1.0);
  let roughness = normalRough.a;
  let metallic = metallicEmissive.r;
  let emissive = metallicEmissive.gba;

  let worldPos = reconstructWorldPos(input.uv, depth);
  let V = normalize(camera.cameraPos - worldPos);

  var color = vec3<f32>(0.0);
  let ambientTerm = hemisphereAmbient(N) * ao;
  let R = reflect(-V, N);
  let F0 = mix(vec3<f32>(0.04, 0.04, 0.04), albedo, metallic);
  let NdotV = max(dot(N, V), 0.0);
  let F_ibl = F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - NdotV, 0.0, 1.0), 5.0);
  let iblDiffuse = getIBLDiffuse(N) * ao;
  let iblSpecular = getIBLSpecular(N, R, roughness) * F_ibl * ao;
  let kD_ibl = (1.0 - metallic) * (1.0 / 3.14159265);
  color += albedo * kD_ibl * (iblDiffuse + ambientTerm) + iblSpecular;

  // Directional light with shadow
  let L = normalize(-lights.dirDirection.xyz);
  let shadow = max(shadowFactor(worldPos), 0.35);
  color += pbrBRDF(albedo, metallic, roughness, N, V, L, lights.dirColor.rgb, lights.dirDirection.w) * shadow;

  // Clustered point/spot lights
  let viewDepth = length(camera.cameraPos - worldPos);
  let clusterIdx = computeClusterIndex(input.uv, viewDepth);
  let entry = clusterLightGrid[clusterIdx];
  let lightCount = entry.count;
  let lightOffset = entry.offset;

  for (var i = 0u; i < lightCount; i = i + 1u) {
    let lightIdx = clusterLightIndexList[lightOffset + i];
    let light = clusterLightData[lightIdx];
    let lightType = u32(light.direction.w);
    let lightRange = light.position.w;

    let toLight = light.position.xyz - worldPos;
    let dist = length(toLight);
    if (dist > lightRange) { continue; }
    let Lp = toLight / max(dist, 0.001);
    let attenuation = 1.0 / (1.0 + 0.5 * dist * dist);

    if (lightType == 0u) {
      // Point light
      color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, light.color.rgb, light.color.w) * attenuation;
    } else if (lightType == 1u) {
      // Spot light
      let spotCos = dot(-Lp, light.direction.xyz);
      let outerCos = light.params.y;
      let innerCos = light.params.x;
      if (spotCos < outerCos) { continue; }
      let spotAtten = smoothstep(outerCos, innerCos, spotCos);
      color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, light.color.rgb, light.color.w) * attenuation * spotAtten;
    } else {
      // Rect area light (simplified as point light with area attenuation)
      color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, light.color.rgb, light.color.w) * attenuation;
    }
  }

  color += emissive;
  return vec4<f32>(color, 1.0);
}
`;

export class ClusterLightingPass extends RenderPass {
  name = "cluster-lighting";
  gbufferAlbedoHandle: TextureHandle | null = null;
  gbufferNormalHandle: TextureHandle | null = null;
  gbufferMetallicEmissiveHandle: TextureHandle | null = null;
  gbufferDepthHandle: TextureHandle | null = null;
  shadowHandle: TextureHandle | null = null;
  hdrHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private surfaceFormat: GPUTextureFormat;
  private width: number;
  private height: number;

  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private lightViewProjBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private clusterBindGroup: GPUBindGroup | null = null;
  private iblBindGroup: GPUBindGroup | null = null;
  private iblBindGroupLayout: GPUBindGroupLayout | null = null;
  private dummyDepthTexture: GPUTexture | null = null;
  private dummyDepthView: GPUTextureView | null = null;
  private dummyShadowSampler: GPUSampler | null = null;
  private clusterGrid: ClusterGrid;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, width: number, height: number, clusterGrid: ClusterGrid) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.width = width;
    this.height = height;
    this.clusterGrid = clusterGrid;
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: CLUSTER_LIGHTING_SHADER });
    }

    this.cameraBuffer = this.device.createBuffer({
      size: 208,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightViewProjBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.shaderModule, entryPoint: "vs_main" },
      fragment: { module: this.shaderModule, entryPoint: "fs_main", targets: [{ format: this.surfaceFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.iblBindGroupLayout = this.pipeline.getBindGroupLayout(1);
  }

  updateCamera(
    viewProj: Mat4,
    prevViewProj: Mat4,
    invViewProj: Mat4,
    cameraPos: [number, number, number],
  ): void {
    const data = new Float32Array(52);
    data.set(viewProj as Float32Array, 0);
    data.set(prevViewProj as Float32Array, 16);
    data.set(invViewProj as Float32Array, 32);
    data[48] = cameraPos[0];
    data[49] = cameraPos[1];
    data[50] = cameraPos[2];
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, data as unknown as BufferSource);
  }

  updateLights(lightData: LightUniformData): void {
    const packed = packLightUniform(lightData);
    this.device.queue.writeBuffer(this.lightBuffer!, 0, packed as unknown as BufferSource);
  }

  updateLightViewProj(viewProj: Mat4): void {
    this.device.queue.writeBuffer(this.lightViewProjBuffer!, 0, viewProj as unknown as BufferSource);
  }

  createBindGroup(
    gbufferViews: GBufferViews,
    shadowView: GPUTextureView | null,
    shadowSampler: GPUSampler | null,
  ): GPUBindGroup | null {
    if (!this.pipeline) return null;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.cameraBuffer! } },
      { binding: 1, resource: gbufferViews.albedo },
      { binding: 2, resource: gbufferViews.normal },
      { binding: 3, resource: gbufferViews.metallicEmissive },
      { binding: 4, resource: gbufferViews.depth },
    ];
    if (shadowView && shadowSampler) {
      entries.push({ binding: 5, resource: shadowView });
      entries.push({ binding: 6, resource: shadowSampler });
    } else {
      if (!this.dummyDepthTexture) {
        this.dummyDepthTexture = this.device.createTexture({
          size: [1, 1],
          format: "depth32float",
          usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        this.dummyDepthView = this.dummyDepthTexture.createView();
        this.dummyShadowSampler = this.device.createSampler({ compare: "less" });
      }
      entries.push({ binding: 5, resource: this.dummyDepthView! });
      entries.push({ binding: 6, resource: this.dummyShadowSampler! });
    }
    entries.push({ binding: 7, resource: { buffer: this.lightBuffer! } });
    entries.push({ binding: 8, resource: { buffer: this.lightViewProjBuffer! } });

    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  createClusterBindGroup(): GPUBindGroup | null {
    if (!this.pipeline) return null;
    const uniformBuf = this.clusterGrid.getUniformBuffer();
    const lightDataBuf = this.clusterGrid.getLightDataBuffer();
    const lightGridBuf = this.clusterGrid.getLightGridBuffer();
    const indexListBuf = this.clusterGrid.getLightIndexListBuffer();
    if (!uniformBuf || !lightDataBuf || !lightGridBuf || !indexListBuf) return null;

    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf as GPUBuffer } },
        { binding: 1, resource: { buffer: lightDataBuf as GPUBuffer } },
        { binding: 2, resource: { buffer: lightGridBuf as GPUBuffer } },
        { binding: 3, resource: { buffer: indexListBuf as GPUBuffer } },
      ],
    });
  }

  setIBLBindGroup(bg: GPUBindGroup): void {
    this.iblBindGroup = bg;
  }

  getIBLBindGroupLayout(): GPUBindGroupLayout | null {
    return this.iblBindGroupLayout;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.gbufferAlbedoHandle) builder.read(this.gbufferAlbedoHandle);
    if (this.gbufferNormalHandle) builder.read(this.gbufferNormalHandle);
    if (this.gbufferMetallicEmissiveHandle) builder.read(this.gbufferMetallicEmissiveHandle);
    if (this.gbufferDepthHandle) builder.read(this.gbufferDepthHandle);
    if (this.shadowHandle) builder.read(this.shadowHandle);
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !ctx.pass) return;

    const gbufferViews: GBufferViews = {
      albedo: ctx.getView(this.gbufferAlbedoHandle!),
      normal: ctx.getView(this.gbufferNormalHandle!),
      metallicEmissive: ctx.getView(this.gbufferMetallicEmissiveHandle!),
      roughnessAO: ctx.getView(this.gbufferAlbedoHandle!),
      velocity: ctx.getView(this.gbufferNormalHandle!),
      depth: ctx.getView(this.gbufferDepthHandle!),
    };
    const shadowView = this.shadowHandle ? ctx.getView(this.shadowHandle) : null;
    const bindGroup = this.createBindGroup(gbufferViews, shadowView, ctx.shadowSampler);
    if (!bindGroup) return;

    this.updateCamera(ctx.viewProj, ctx.prevViewProj, ctx.invViewProj, ctx.cameraPos);
    this.updateLightViewProj(ctx.lightViewProj);
    this.updateLights(ctx.lightData);

    if (!this.clusterBindGroup) {
      this.clusterBindGroup = this.createClusterBindGroup();
    }

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, bindGroup);
    if (this.iblBindGroup) {
      tracked.setBindGroup(1, this.iblBindGroup);
    }
    if (this.clusterBindGroup) {
      tracked.setBindGroup(2, this.clusterBindGroup);
    }
    tracked.draw(6);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.lightViewProjBuffer?.destroy();
    this.dummyDepthTexture?.destroy();
  }
}
