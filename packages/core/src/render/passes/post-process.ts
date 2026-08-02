import type { RenderBackend } from "../backend/render-backend.ts";
import { wgslShader } from "../backend/shader-source.ts";
import type { BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, BackendSampler, BackendTexture, BackendTextureView } from "../backend/types.ts";
import { SHADER_STAGE_FRAGMENT, SHADER_STAGE_VERTEX } from "../backend/types.ts";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";

const FULLSCREEN_VS = `
struct FullscreenOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> FullscreenOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: FullscreenOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}
`;

const TAA_SHADER = FULLSCREEN_VS + `
struct TAAUniforms {
  blendFactor: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var<uniform> u: TAAUniforms;
@group(0) @binding(1) var currentTex: texture_2d<f32>;
@group(0) @binding(2) var historyTex: texture_2d<f32>;
@group(0) @binding(3) var velocityTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

fn rgbToYCoCg(rgb: vec3<f32>) -> vec3<f32> {
  let co = rgb.r - rgb.b;
  let tmp = rgb.b + co * 0.5;
  let cg = rgb.g - tmp;
  let y = tmp + cg * 0.5;
  return vec3<f32>(y, co, cg);
}
fn yCoCgToRGB(ycocg: vec3<f32>) -> vec3<f32> {
  let tmp = ycocg.x - ycocg.z * 0.5;
  let g = ycocg.z + tmp;
  let b = tmp - ycocg.y * 0.5;
  let r = ycocg.y + b;
  return vec3<f32>(r, g, b);
}

@fragment
fn taa_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(currentTex, 0));
  let texelSize = vec2<f32>(1.0 / dims.x, 1.0 / dims.y);

  let current = textureSample(currentTex, texSampler, uv).rgb;
  let velocity = textureSample(velocityTex, texSampler, uv).rg;
  let historyUV = uv - velocity;
  let history = textureSample(historyTex, texSampler, historyUV).rgb;

  let tl = textureSample(currentTex, texSampler, uv + vec2<f32>(-1.0, -1.0) * texelSize).rgb;
  let tr = textureSample(currentTex, texSampler, uv + vec2<f32>( 1.0, -1.0) * texelSize).rgb;
  let bl = textureSample(currentTex, texSampler, uv + vec2<f32>(-1.0,  1.0) * texelSize).rgb;
  let br = textureSample(currentTex, texSampler, uv + vec2<f32>( 1.0,  1.0) * texelSize).rgb;
  let l = textureSample(currentTex, texSampler, uv + vec2<f32>(-1.0,  0.0) * texelSize).rgb;
  let r2 = textureSample(currentTex, texSampler, uv + vec2<f32>( 1.0,  0.0) * texelSize).rgb;
  let t = textureSample(currentTex, texSampler, uv + vec2<f32>( 0.0, -1.0) * texelSize).rgb;
  let b2 = textureSample(currentTex, texSampler, uv + vec2<f32>( 0.0,  1.0) * texelSize).rgb;

  let ycocgCenter = rgbToYCoCg(current);
  var minC = ycocgCenter;
  var maxC = ycocgCenter;
  let neighbors = array<vec3<f32>, 8>(tl, tr, bl, br, l, r2, t, b2);
  for (var i = 0u; i < 8u; i = i + 1u) {
    let ycocg = rgbToYCoCg(neighbors[i]);
    minC = min(minC, ycocg);
    maxC = max(maxC, ycocg);
  }
  let clampedHistory = yCoCgToRGB(clamp(rgbToYCoCg(history), minC, maxC));
  let result = mix(clampedHistory, current, u.blendFactor);
  return vec4<f32>(result, 1.0);
}
`;

const BLOOM_SHADER = FULLSCREEN_VS + `
struct BloomUniforms {
  threshold: f32,
  softThreshold: f32,
  directionX: f32,
  directionY: f32,
};
@group(0) @binding(0) var<uniform> u: BloomUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn bloom_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dir = vec2<f32>(u.directionX, u.directionY);
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);
  var color = textureSample(sourceTex, texSampler, uv).rgb * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = dir * offsets[i];
    color += textureSample(sourceTex, texSampler, uv + offset).rgb * weights[i];
    color += textureSample(sourceTex, texSampler, uv - offset).rgb * weights[i];
  }
  if (u.directionX > 1.0) {
    let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
    let knee = u.threshold * u.softThreshold + 0.00001;
    let softFactor = clamp(luma - u.threshold + knee, 0.0, 2.0 * knee);
    let contribution = softFactor * softFactor / (4.0 * knee + 0.00001) + u.threshold - knee;
    color *= max(contribution / max(luma, 0.00001), 0.0);
  }
  return vec4<f32>(color, 1.0);
}
`;

const TONEMAP_SHADER = FULLSCREEN_VS + `
struct PostProcessUniforms {
  exposure: f32,
  bloomIntensity: f32,
  gamma: f32,
  contrast: f32,
  saturation: f32,
  vignette: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> u: PostProcessUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn fxaa(uv: vec2<f32>, texelSize: vec2<f32>) -> vec3<f32> {
  let lumaThreshold = 0.0625;
  let mulReduce = 1.0 / 8.0;
  let minReduce = 1.0 / 128.0;
  let lumaTL = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>(-1.0, -1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaTR = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>( 1.0, -1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaBL = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>(-1.0,  1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaBR = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>( 1.0,  1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaM = dot(textureSample(sourceTex, texSampler, uv).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaMin = min(lumaM, min(min(lumaTL, lumaTR), min(lumaBL, lumaBR)));
  let lumaMax = max(lumaM, max(max(lumaTL, lumaTR), max(lumaBL, lumaBR)));
  let lumaRange = lumaMax - lumaMin;
  if (lumaRange < max(lumaThreshold, lumaMax * mulReduce)) {
    return textureSample(sourceTex, texSampler, uv).rgb;
  }
  let dir = vec2<f32>(
    -((lumaTL + lumaTR) - (lumaBL + lumaBR)),
    ((lumaTL + lumaBL) - (lumaTR + lumaBR)),
  );
  let dirReduce = max(lumaM * mulReduce, minReduce);
  let dirScale = 1.0 / min(abs(dir.x) + abs(dir.y), dirReduce);
  let dirAdj = clamp(dir * dirScale, vec2<f32>(-2.0), vec2<f32>(2.0)) * texelSize;
  let rgbN1 = textureSample(sourceTex, texSampler, uv + dirAdj * 0.5).rgb;
  let rgbN2 = textureSample(sourceTex, texSampler, uv - dirAdj * 0.5).rgb;
  let rgbP1 = textureSample(sourceTex, texSampler, uv + dirAdj * 1.0).rgb;
  let rgbP2 = textureSample(sourceTex, texSampler, uv - dirAdj * 1.0).rgb;
  return (rgbN1 + rgbN2 + rgbP1 + rgbP2) * 0.25;
}

@fragment
fn tonemap_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(sourceTex, 0));
  let texelSize = vec2<f32>(1.0 / dims.x, 1.0 / dims.y);
  var color = fxaa(uv, texelSize);
  let bloom = textureSample(bloomTex, texSampler, uv).rgb;
  color += bloom * u.bloomIntensity;
  color *= u.exposure;
  color = acesTonemap(color);
  color = (color - 0.5) * u.contrast + 0.5;
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  color = mix(vec3<f32>(luma), color, u.saturation);
  let center = uv - 0.5;
  let dist = dot(center, center);
  color *= 1.0 - dist * u.vignette;
  color = pow(color, vec3<f32>(1.0 / u.gamma));
  return vec4<f32>(color, 1.0);
}
`;

export interface PostProcessSettings {
  exposure: number;
  bloomThreshold: number;
  bloomIntensity: number;
  gamma: number;
  contrast: number;
  saturation: number;
  vignette: number;
  taaBlendFactor: number;
  bloomSoftThreshold: number;
}

export const DEFAULT_POST_PROCESS_SETTINGS: PostProcessSettings = {
  exposure: 1.0,
  bloomThreshold: 1.0,
  bloomIntensity: 0.3,
  gamma: 2.2,
  contrast: 1.0,
  saturation: 1.0,
  vignette: 0.3,
  taaBlendFactor: 0.1,
  bloomSoftThreshold: 0.5,
};

export class PostProcessPass extends RenderPass {
  name = "post-process";
  passType = PassType.Custom;
  // Graph handles (set by RenderLoop before graph build)
  hdrHandle: TextureHandle | null = null;
  velocityHandle: TextureHandle | null = null;
  surfaceHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private surfaceFormat: GPUTextureFormat;
  private width: number;
  private height: number;
  private settings: PostProcessSettings = DEFAULT_POST_PROCESS_SETTINGS;

  private taaPipeline: GPURenderPipeline | null = null;
  private bloomPipeline: GPURenderPipeline | null = null;
  private tonemapPipeline: GPURenderPipeline | null = null;

  private taaUniformBuffer: GPUBuffer | null = null;
  private bloomBrightUniformBuffer: GPUBuffer | null = null;
  private bloomBlurHUniformBuffer: GPUBuffer | null = null;
  private bloomBlurVUniformBuffer: GPUBuffer | null = null;
  private tonemapUniformBuffer: GPUBuffer | null = null;

  private historyTexture: GPUTexture | null = null;
  private historyView: GPUTextureView | null = null;
  private historyTexture2: GPUTexture | null = null;
  private historyView2: GPUTextureView | null = null;
  private taaOutputTexture: GPUTexture | null = null;
  private taaOutputView: GPUTextureView | null = null;
  private bloomTempTexture: GPUTexture | null = null;
  private bloomTempView: GPUTextureView | null = null;
  private bloomHalfTexture: GPUTexture | null = null;
  private bloomHalfView: GPUTextureView | null = null;

  private sampler: GPUSampler | null = null;

  // Backend-agnostic resources
  private _backend: RenderBackend | null = null;
  private _bgTaaPipeline: BackendRenderPipeline | null = null;
  private _bgBloomPipeline: BackendRenderPipeline | null = null;
  private _bgTonemapPipeline: BackendRenderPipeline | null = null;
  private _bgTaaUniformBuffer: BackendBuffer | null = null;
  private _bgBloomBrightUniformBuffer: BackendBuffer | null = null;
  private _bgBloomBlurHUniformBuffer: BackendBuffer | null = null;
  private _bgBloomBlurVUniformBuffer: BackendBuffer | null = null;
  private _bgTonemapUniformBuffer: BackendBuffer | null = null;
  private _bgHistoryTexture: BackendTexture | null = null;
  private _bgHistoryView: BackendTextureView | null = null;
  private _bgHistoryTexture2: BackendTexture | null = null;
  private _bgHistoryView2: BackendTextureView | null = null;
  private _bgTaaOutputTexture: BackendTexture | null = null;
  private _bgTaaOutputView: BackendTextureView | null = null;
  private _bgBloomTempTexture: BackendTexture | null = null;
  private _bgBloomTempView: BackendTextureView | null = null;
  private _bgBloomHalfTexture: BackendTexture | null = null;
  private _bgBloomHalfView: BackendTextureView | null = null;
  private _bgSampler: BackendSampler | null = null;
  private _bgTaaLayout: BackendBindGroupLayout | null = null;
  private _bgBloomLayout: BackendBindGroupLayout | null = null;
  private _bgTonemapLayout: BackendBindGroupLayout | null = null;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, width: number, height: number) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.width = width;
    this.height = height;
  }

  prepare(_device: GPUDevice, backend?: RenderBackend | null): void {
    if (backend) {
      this.prepareBackend(backend);
      return;
    }
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.taaUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bloomBrightUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bloomBlurHUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bloomBlurVUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.tonemapUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const taaModule = this.device.createShaderModule({ code: TAA_SHADER });
    const bloomModule = this.device.createShaderModule({ code: BLOOM_SHADER });
    const tonemapModule = this.device.createShaderModule({ code: TONEMAP_SHADER });

    const hdrFormat = "rgba16float" as GPUTextureFormat;

    this.taaPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: taaModule, entryPoint: "vs_main" },
      fragment: { module: taaModule, entryPoint: "taa_fs", targets: [{ format: hdrFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.bloomPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: bloomModule, entryPoint: "vs_main" },
      fragment: { module: bloomModule, entryPoint: "bloom_fs", targets: [{ format: hdrFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.tonemapPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: tonemapModule, entryPoint: "vs_main" },
      fragment: { module: tonemapModule, entryPoint: "tonemap_fs", targets: [{ format: this.surfaceFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.createIntermediateTextures();
    this.updateUniforms();
  }

  prepareBackend(backend: RenderBackend): void {
    this._backend = backend;
    this._bgSampler = backend.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this._bgTaaUniformBuffer = backend.createBuffer({ label: "taa-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgBloomBrightUniformBuffer = backend.createBuffer({ label: "bloom-bright-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgBloomBlurHUniformBuffer = backend.createBuffer({ label: "bloom-blur-h-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgBloomBlurVUniformBuffer = backend.createBuffer({ label: "bloom-blur-v-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgTonemapUniformBuffer = backend.createBuffer({ label: "tonemap-uniforms", size: 32, usage: 0x40 | 0x08 });

    this._bgTaaLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 4, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this._bgBloomLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this._bgTonemapLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    const taaModule = backend.createShaderModule(wgslShader(TAA_SHADER, "taa-shader"), "wgsl");
    const bloomModule = backend.createShaderModule(wgslShader(BLOOM_SHADER, "bloom-shader"), "wgsl");
    const tonemapModule = backend.createShaderModule(wgslShader(TONEMAP_SHADER, "tonemap-shader"), "wgsl");

    const hdrFormat = "rgba16float";
    const taaLayout = backend.createPipelineLayout({ label: "taa-layout", bindGroupLayouts: [this._bgTaaLayout] });
    const bloomLayout = backend.createPipelineLayout({ label: "bloom-layout", bindGroupLayouts: [this._bgBloomLayout] });
    const tonemapLayout = backend.createPipelineLayout({ label: "tonemap-layout", bindGroupLayouts: [this._bgTonemapLayout] });

    this._bgTaaPipeline = backend.createRenderPipeline({
      label: "taa-pipeline",
      layout: taaLayout,
      vertex: { module: taaModule, entryPoint: "vs_main" },
      fragment: { module: taaModule, entryPoint: "taa_fs", targets: [{ format: hdrFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this._bgBloomPipeline = backend.createRenderPipeline({
      label: "bloom-pipeline",
      layout: bloomLayout,
      vertex: { module: bloomModule, entryPoint: "vs_main" },
      fragment: { module: bloomModule, entryPoint: "bloom_fs", targets: [{ format: hdrFormat }] },
      primitive: { topology: "triangle-list" },
    });
    this._bgTonemapPipeline = backend.createRenderPipeline({
      label: "tonemap-pipeline",
      layout: tonemapLayout,
      vertex: { module: tonemapModule, entryPoint: "vs_main" },
      fragment: { module: tonemapModule, entryPoint: "tonemap_fs", targets: [{ format: this.surfaceFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.createIntermediateTexturesBackend();
    this.updateUniforms();
  }

  private createIntermediateTextures(): void {
    const hdrFormat = "rgba16float" as GPUTextureFormat;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

    this.historyTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: hdrFormat,
      usage,
    });
    this.historyView = this.historyTexture.createView();

    this.historyTexture2 = this.device.createTexture({
      size: [this.width, this.height],
      format: hdrFormat,
      usage,
    });
    this.historyView2 = this.historyTexture2.createView();

    this.taaOutputTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: hdrFormat,
      usage,
    });
    this.taaOutputView = this.taaOutputTexture.createView();

    const halfW = Math.max(1, Math.floor(this.width / 2));
    const halfH = Math.max(1, Math.floor(this.height / 2));

    this.bloomHalfTexture = this.device.createTexture({
      size: [halfW, halfH],
      format: hdrFormat,
      usage,
    });
    this.bloomHalfView = this.bloomHalfTexture.createView();

    this.bloomTempTexture = this.device.createTexture({
      size: [halfW, halfH],
      format: hdrFormat,
      usage,
    });
    this.bloomTempView = this.bloomTempTexture.createView();
  }

  private createIntermediateTexturesBackend(): void {
    const backend = this._backend!;
    const hdrFormat = "rgba16float";
    const usage = 0x10 | 0x08 | 0x80 | 0x04; // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC | COPY_DST

    this._bgHistoryTexture = backend.createTexture({ label: "taa-history", size: [this.width, this.height], format: hdrFormat, usage });
    this._bgHistoryView = backend.createTextureView(this._bgHistoryTexture);

    this._bgHistoryTexture2 = backend.createTexture({ label: "taa-history2", size: [this.width, this.height], format: hdrFormat, usage });
    this._bgHistoryView2 = backend.createTextureView(this._bgHistoryTexture2);

    this._bgTaaOutputTexture = backend.createTexture({ label: "taa-output", size: [this.width, this.height], format: hdrFormat, usage });
    this._bgTaaOutputView = backend.createTextureView(this._bgTaaOutputTexture);

    const halfW = Math.max(1, Math.floor(this.width / 2));
    const halfH = Math.max(1, Math.floor(this.height / 2));

    this._bgBloomHalfTexture = backend.createTexture({ label: "bloom-half", size: [halfW, halfH], format: hdrFormat, usage });
    this._bgBloomHalfView = backend.createTextureView(this._bgBloomHalfTexture);

    this._bgBloomTempTexture = backend.createTexture({ label: "bloom-temp", size: [halfW, halfH], format: hdrFormat, usage });
    this._bgBloomTempView = backend.createTextureView(this._bgBloomTempTexture);
  }

  private updateUniforms(): void {
    const taaData = new Float32Array(4);
    taaData[0] = this.settings.taaBlendFactor;
    const tonemapData = new Float32Array(8);
    tonemapData[0] = this.settings.exposure;
    tonemapData[1] = this.settings.bloomIntensity;
    tonemapData[2] = this.settings.gamma;
    tonemapData[3] = this.settings.contrast;
    tonemapData[4] = this.settings.saturation;
    tonemapData[5] = this.settings.vignette;
    if (this._backend && this._bgTaaUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgTaaUniformBuffer, 0, taaData as unknown as BufferSource);
      this._backend.queue.writeBuffer(this._bgTonemapUniformBuffer!, 0, tonemapData as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.taaUniformBuffer!, 0, taaData as unknown as BufferSource);
      this.device.queue.writeBuffer(this.tonemapUniformBuffer!, 0, tonemapData as unknown as BufferSource);
    }
  }

  setSettings(settings: Partial<PostProcessSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.updateUniforms();
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.historyTexture?.destroy();
    this.historyTexture2?.destroy();
    this.taaOutputTexture?.destroy();
    this.bloomHalfTexture?.destroy();
    this.bloomTempTexture?.destroy();
    if (this._backend) {
      this.createIntermediateTexturesBackend();
    } else {
      this.createIntermediateTextures();
    }
  }

  executeTAA(
    ctx: GraphRenderContext,
    currentView: GPUTextureView,
    velocityView: GPUTextureView,
    outputView: GPUTextureView,
  ): GPUTextureView {
    if (!this.taaPipeline || !this.sampler) return outputView;

    const bindGroup = this.device.createBindGroup({
      layout: this.taaPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.taaUniformBuffer! } },
        { binding: 1, resource: currentView },
        { binding: 2, resource: this.historyView! },
        { binding: 3, resource: velocityView },
        { binding: 4, resource: this.sampler },
      ],
    });

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.taaOutputView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.taaPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();

    encoder.copyTextureToTexture(
      { texture: this.taaOutputTexture! },
      { texture: this.historyTexture2! },
      { width: this.width, height: this.height },
    );

    ctx.device.queue.submit([encoder.finish()]);

    const tmpTex = this.historyTexture;
    const tmpView = this.historyView;
    this.historyTexture = this.historyTexture2;
    this.historyView = this.historyView2;
    this.historyTexture2 = tmpTex;
    this.historyView2 = tmpView;

    return this.taaOutputView!;
  }

  executeBloom(
    ctx: GraphRenderContext,
    sourceView: GPUTextureView,
  ): GPUTextureView {
    if (!this.bloomPipeline || !this.sampler) return sourceView;

    const halfW = Math.max(1, Math.floor(this.width / 2));
    const halfH = Math.max(1, Math.floor(this.height / 2));

    const brightBindGroup = this.device.createBindGroup({
      layout: this.bloomPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bloomBrightUniformBuffer! } },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: this.sampler },
      ],
    });

    const blurHBindGroup = this.device.createBindGroup({
      layout: this.bloomPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bloomBlurHUniformBuffer! } },
        { binding: 1, resource: this.bloomHalfView! },
        { binding: 2, resource: this.sampler },
      ],
    });

    const blurVBindGroup = this.device.createBindGroup({
      layout: this.bloomPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bloomBlurVUniformBuffer! } },
        { binding: 1, resource: this.bloomTempView! },
        { binding: 2, resource: this.sampler },
      ],
    });

    const brightData = new Float32Array(4);
    brightData[0] = this.settings.bloomThreshold;
    brightData[1] = this.settings.bloomSoftThreshold;
    brightData[2] = 2.0;
    brightData[3] = 0.0;
    this.device.queue.writeBuffer(this.bloomBrightUniformBuffer!, 0, brightData as unknown as BufferSource);

    const blurHData = new Float32Array(4);
    blurHData[2] = 1.0 / halfW;
    blurHData[3] = 0.0;
    this.device.queue.writeBuffer(this.bloomBlurHUniformBuffer!, 0, blurHData as unknown as BufferSource);

    const blurVData = new Float32Array(4);
    blurVData[2] = 0.0;
    blurVData[3] = 1.0 / halfH;
    this.device.queue.writeBuffer(this.bloomBlurVUniformBuffer!, 0, blurVData as unknown as BufferSource);

    const encoder = ctx.device.createCommandEncoder();

    let pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomHalfView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.bloomPipeline);
    pass.setBindGroup(0, brightBindGroup);
    pass.draw(6);
    pass.end();

    pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomTempView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.bloomPipeline);
    pass.setBindGroup(0, blurHBindGroup);
    pass.draw(6);
    pass.end();

    pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomHalfView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.bloomPipeline);
    pass.setBindGroup(0, blurVBindGroup);
    pass.draw(6);
    pass.end();

    ctx.device.queue.submit([encoder.finish()]);

    return this.bloomHalfView!;
  }

  executeTonemap(
    ctx: GraphRenderContext,
    sourceView: GPUTextureView,
    bloomView: GPUTextureView,
    outputView: GPUTextureView,
  ): void {
    if (!this.tonemapPipeline || !this.sampler) return;

    const bindGroup = this.device.createBindGroup({
      layout: this.tonemapPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.tonemapUniformBuffer! } },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: bloomView },
        { binding: 3, resource: this.sampler },
      ],
    });

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.tonemapPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.hdrHandle) builder.read(this.hdrHandle);
    if (this.velocityHandle) builder.read(this.velocityHandle);
    if (this.surfaceHandle) builder.write(this.surfaceHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.hdrHandle || !this.surfaceHandle) return;
    if (ctx.backend && this._bgTaaPipeline) {
      this.executeBackend(ctx);
      return;
    }
    if (!ctx.device) return;

    const hdrView = ctx.getView(this.hdrHandle);
    const surfaceView = ctx.getView(this.surfaceHandle);
    const velocityView = this.velocityHandle ? ctx.getView(this.velocityHandle) : hdrView;

    // TAA stage
    const taaOutput = this.executeTAA(ctx, hdrView, velocityView, this.taaOutputView!);

    // Bloom stage (if enabled)
    let bloomView = taaOutput;
    if (ctx.bloomEnabled) {
      bloomView = this.executeBloom(ctx, taaOutput);
    }

    // Tonemap stage → output to surface
    this.executeTonemap(ctx, taaOutput, bloomView, surfaceView);
  }

  private executeBackend(ctx: GraphRenderContext): void {
    const backend = ctx.backend!;
    const hdrView = ctx.getBackendView(this.hdrHandle!);
    const surfaceView = ctx.getBackendView(this.surfaceHandle!);
    const velocityView = this.velocityHandle ? ctx.getBackendView(this.velocityHandle) : hdrView;

    // TAA stage
    const taaOutput = this.executeTAABackend(backend, hdrView, velocityView);

    // Bloom stage (if enabled)
    let bloomView = taaOutput;
    if (ctx.bloomEnabled) {
      bloomView = this.executeBloomBackend(backend, taaOutput);
    }

    // Tonemap stage → output to surface
    this.executeTonemapBackend(backend, taaOutput, bloomView, surfaceView);
  }

  private executeTAABackend(backend: RenderBackend, currentView: BackendTextureView, velocityView: BackendTextureView): BackendTextureView {
    if (!this._bgTaaPipeline || !this._bgSampler) return this._bgTaaOutputView!;

    const bindGroup = backend.createBindGroup({
      layout: this._bgTaaLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgTaaUniformBuffer! } },
        { binding: 1, resource: { textureView: currentView } },
        { binding: 2, resource: { textureView: this._bgHistoryView! } },
        { binding: 3, resource: { textureView: velocityView } },
        { binding: 4, resource: { sampler: this._bgSampler } },
      ],
    });

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._bgTaaOutputView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this._bgTaaPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();

    encoder.copyTextureToTexture(
      { texture: this._bgTaaOutputTexture!, mipLevel: 0, origin: [0, 0, 0] },
      { texture: this._bgHistoryTexture2!, mipLevel: 0, origin: [0, 0, 0] },
      [this.width, this.height],
    );

    backend.queue.submit([encoder.finish()]);

    const tmpTex = this._bgHistoryTexture;
    const tmpView = this._bgHistoryView;
    this._bgHistoryTexture = this._bgHistoryTexture2;
    this._bgHistoryView = this._bgHistoryView2;
    this._bgHistoryTexture2 = tmpTex;
    this._bgHistoryView2 = tmpView;

    return this._bgTaaOutputView!;
  }

  private executeBloomBackend(backend: RenderBackend, sourceView: BackendTextureView): BackendTextureView {
    if (!this._bgBloomPipeline || !this._bgSampler) return sourceView;

    const halfW = Math.max(1, Math.floor(this.width / 2));
    const halfH = Math.max(1, Math.floor(this.height / 2));

    const brightBindGroup = backend.createBindGroup({
      layout: this._bgBloomLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgBloomBrightUniformBuffer! } },
        { binding: 1, resource: { textureView: sourceView } },
        { binding: 2, resource: { sampler: this._bgSampler } },
      ],
    });

    const blurHBindGroup = backend.createBindGroup({
      layout: this._bgBloomLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgBloomBlurHUniformBuffer! } },
        { binding: 1, resource: { textureView: this._bgBloomHalfView! } },
        { binding: 2, resource: { sampler: this._bgSampler } },
      ],
    });

    const blurVBindGroup = backend.createBindGroup({
      layout: this._bgBloomLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgBloomBlurVUniformBuffer! } },
        { binding: 1, resource: { textureView: this._bgBloomTempView! } },
        { binding: 2, resource: { sampler: this._bgSampler } },
      ],
    });

    const brightData = new Float32Array(4);
    brightData[0] = this.settings.bloomThreshold;
    brightData[1] = this.settings.bloomSoftThreshold;
    brightData[2] = 2.0;
    brightData[3] = 0.0;
    backend.queue.writeBuffer(this._bgBloomBrightUniformBuffer!, 0, brightData as unknown as BufferSource);

    const blurHData = new Float32Array(4);
    blurHData[2] = 1.0 / halfW;
    blurHData[3] = 0.0;
    backend.queue.writeBuffer(this._bgBloomBlurHUniformBuffer!, 0, blurHData as unknown as BufferSource);

    const blurVData = new Float32Array(4);
    blurVData[2] = 0.0;
    blurVData[3] = 1.0 / halfH;
    backend.queue.writeBuffer(this._bgBloomBlurVUniformBuffer!, 0, blurVData as unknown as BufferSource);

    const encoder = backend.createCommandEncoder();

    let pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._bgBloomHalfView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this._bgBloomPipeline);
    pass.setBindGroup(0, brightBindGroup);
    pass.draw(6);
    pass.end();

    pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._bgBloomTempView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this._bgBloomPipeline);
    pass.setBindGroup(0, blurHBindGroup);
    pass.draw(6);
    pass.end();

    pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._bgBloomHalfView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this._bgBloomPipeline);
    pass.setBindGroup(0, blurVBindGroup);
    pass.draw(6);
    pass.end();

    backend.queue.submit([encoder.finish()]);

    return this._bgBloomHalfView!;
  }

  private executeTonemapBackend(backend: RenderBackend, sourceView: BackendTextureView, bloomView: BackendTextureView, outputView: BackendTextureView): void {
    if (!this._bgTonemapPipeline || !this._bgSampler) return;

    const bindGroup = backend.createBindGroup({
      layout: this._bgTonemapLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgTonemapUniformBuffer! } },
        { binding: 1, resource: { textureView: sourceView } },
        { binding: 2, resource: { textureView: bloomView } },
        { binding: 3, resource: { sampler: this._bgSampler } },
      ],
    });

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this._bgTonemapPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    backend.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.historyTexture?.destroy();
    this.historyTexture2?.destroy();
    this.taaOutputTexture?.destroy();
    this.bloomHalfTexture?.destroy();
    this.bloomTempTexture?.destroy();
    this.taaUniformBuffer?.destroy();
    this.bloomBrightUniformBuffer?.destroy();
    this.bloomBlurHUniformBuffer?.destroy();
    this.bloomBlurVUniformBuffer?.destroy();
    this.tonemapUniformBuffer?.destroy();
  }
}
