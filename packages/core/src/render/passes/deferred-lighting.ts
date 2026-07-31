import { type Mat4 } from "wgpu-matrix";
import type { GBufferViews } from "../g-buffer.ts";
import type { LightUniformData } from "../lighting.ts";
import { MAX_POINT_LIGHTS, packLightUniform, packPointLights } from "../lighting.ts";
import { RenderPass } from "../render-pass.ts";

const DEFERRED_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var metallicEmissiveTex: texture_2d<f32>;
@group(0) @binding(4) var depthTex: texture_depth_2d;
@group(0) @binding(5) var shadowMapTex: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;

struct LightUniforms {
  dirDirection: vec4<f32>,
  dirColor: vec4<f32>,
  ambient: vec4<f32>,
  lightCount: vec4<f32>,
};

@group(0) @binding(7) var<uniform> lights: LightUniforms;
@group(0) @binding(8) var<storage> pointLights: array<vec4<f32>>;
@group(0) @binding(9) var<uniform> lightViewProj: mat4x4<f32>;

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
  color += albedo * lights.ambient.rgb * lights.ambient.w * ao;

  let L = normalize(-lights.dirDirection.xyz);
  let shadow = max(shadowFactor(worldPos), 0.35);
  color += pbrBRDF(albedo, metallic, roughness, N, V, L, lights.dirColor.rgb, lights.dirDirection.w) * shadow;

  let count = u32(lights.lightCount.x);
  for (var i = 0u; i < 8u; i = i + 1u) {
    if (i >= count) { break; }
    let pos = pointLights[i * 2u].xyz;
    let intensity = pointLights[i * 2u].w;
    let lightColor = pointLights[i * 2u + 1u].xyz;
    let range = pointLights[i * 2u + 1u].w;
    let toLight = pos - worldPos;
    let dist = length(toLight);
    if (dist > range) { continue; }
    let Lp = toLight / dist;
    let attenuation = 1.0 / (1.0 + 0.5 * dist * dist);
    color += pbrBRDF(albedo, metallic, roughness, N, V, Lp, lightColor, intensity) * attenuation;
  }

  color += emissive;
  return vec4<f32>(color, 1.0);
}
`;

export class DeferredLightingPass extends RenderPass {
  name = "deferred-lighting";
  // Graph handles (set by RenderLoop before graph build)
  gbufferAlbedoHandle: TextureHandle | null = null;
  gbufferNormalHandle: TextureHandle | null = null;
  gbufferMetallicEmissiveHandle: TextureHandle | null = null;
  gbufferDepthHandle: TextureHandle | null = null;
  shadowHandle: TextureHandle | null = null;
  hdrHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private pointLightBuffer: GPUBuffer | null = null;
  private lightViewProjBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private dummyDepthTexture: GPUTexture | null = null;
  private dummyDepthView: GPUTextureView | null = null;
  private dummyShadowSampler: GPUSampler | null = null;
  private surfaceFormat: GPUTextureFormat;
  private width: number;
  private height: number;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, width: number, height: number) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.width = width;
    this.height = height;
  }

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({ code: DEFERRED_SHADER });
    }

    this.cameraBuffer = this.device.createBuffer({
      size: 208,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pointLightBuffer = this.device.createBuffer({
      size: MAX_POINT_LIGHTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.lightViewProjBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
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
    const pointPacked = packPointLights(lightData);
    this.device.queue.writeBuffer(this.pointLightBuffer!, 0, pointPacked as unknown as BufferSource);
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
    entries.push({ binding: 8, resource: { buffer: this.pointLightBuffer! } });
    entries.push({ binding: 9, resource: { buffer: this.lightViewProjBuffer! } });

    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setup(builder: FrameGraphBuilder): void {
    // Read gbuffer textures
    if (this.gbufferAlbedoHandle) builder.read(this.gbufferAlbedoHandle);
    if (this.gbufferNormalHandle) builder.read(this.gbufferNormalHandle);
    if (this.gbufferMetallicEmissiveHandle) builder.read(this.gbufferMetallicEmissiveHandle);
    if (this.gbufferDepthHandle) builder.read(this.gbufferDepthHandle);
    // Read shadow map
    if (this.shadowHandle) builder.read(this.shadowHandle);
    // Write HDR
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !ctx.pass) return;

    // Build bind group from resolved views
    const gbufferViews: GBufferViews = {
      albedo: ctx.getView(this.gbufferAlbedoHandle!),
      normal: ctx.getView(this.gbufferNormalHandle!),
      metallicEmissive: ctx.getView(this.gbufferMetallicEmissiveHandle!),
      depth: ctx.getView(this.gbufferDepthHandle!),
    };
    const shadowView = this.shadowHandle ? ctx.getView(this.shadowHandle) : null;
    const bindGroup = this.createBindGroup(gbufferViews, shadowView, ctx.shadowSampler);

    // Update camera and lighting uniforms
    this.updateCamera(ctx.viewProj, ctx.prevViewProj, ctx.invViewProj, ctx.cameraPos);
    this.updateLightViewProj(ctx.lightViewProj);
    this.updateLights(ctx.lightData);

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, bindGroup);
    tracked.draw(6);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.pointLightBuffer?.destroy();
    this.lightViewProjBuffer?.destroy();
    this.dummyDepthTexture?.destroy();
  }
}
