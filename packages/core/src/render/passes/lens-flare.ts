import type { RenderBackend } from "../backend/render-backend.ts";
import { wgslShader } from "../backend/shader-source.ts";
import type { BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, BackendSampler } from "../backend/types.ts";
import { SHADER_STAGE_FRAGMENT, SHADER_STAGE_VERTEX } from "../backend/types.ts";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";

const FULLSCREEN_VS = /* wgsl */ `
struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  output.clipPosition = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - y * 0.5);
  return output;
}
`;

const LENS_FLARE_FS = /* wgsl */ `
struct LensFlareUniforms {
  lightScreenPos: vec2<f32>,
  intensity: f32,
  threshold: f32,
  ghostCount: f32,
  ghostSpacing: f32,
  haloWidth: f32,
  starSamples: f32,
  _pad0: f32,
  tint: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: LensFlareUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

fn hash(p: f32) -> f32 {
  return fract(sin(p * 91.345) * 47453.5453);
}

@fragment
fn lens_flare_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let center = vec2<f32>(0.5, 0.5);
  let lightPos = u.lightScreenPos;
  let dir = lightPos - center;
  let dist = length(dir);
  let ndir = dir / max(dist, 0.0001);

  // Check if light is occluded by sampling depth at light position
  let lightDepth = textureSample(depthTex, texSampler, lightPos).r;
  let sceneDepth = textureSample(depthTex, texSampler, uv).r;

  var flare = vec3<f32>(0.0);

  // Ghost chain — from light position toward center, each ghost at increasing distance
  let ghostCount = u32(u.ghostCount);
  for (var i = 0u; i < 16u; i++) {
    if (i >= ghostCount) { break; }
    let t = (f32(i) + 1.0) * u.ghostSpacing;
    let ghostPos = lightPos - ndir * dist * t;
    let ghostUV = ghostPos;
    let ghostDist = length(uv - ghostUV);
    let falloff = 1.0 / (1.0 + ghostDist * ghostDist * 200.0);
    let scale = 1.0 - f32(i) / f32(ghostCount);
    let ghostColor = textureSample(colorTex, texSampler, ghostUV).rgb;
    flare += ghostColor * falloff * scale * u.intensity * u.tint;
  }

  // Halo — ring around the lens-to-light axis
  let haloAxis = lightPos - center;
  let haloDist = length(uv - center - haloAxis * 0.5);
  let haloRadius = length(haloAxis) * 0.5;
  let haloRing = abs(haloDist - haloRadius);
  let haloFalloff = 1.0 / (1.0 + haloRing * haloRing * 100.0 / u.haloWidth);
  flare += u.tint * haloFalloff * u.intensity * 0.5;

  // Star streaks — anamorphic horizontal lines from the light position
  let starSamples = u32(u.starSamples);
  let toLight = lightPos - uv;
  let horizDist = abs(toLight.x);
  let vertDist = abs(toLight.y);
  let streakFalloff = 1.0 / (1.0 + horizDist * horizDist * 50.0) * (1.0 / (1.0 + vertDist * vertDist * 500.0));
  flare += u.tint * streakFalloff * u.intensity * 0.3;

  // Bright spot at light position
  let lightDist = length(uv - lightPos);
  let lightFalloff = 1.0 / (1.0 + lightDist * lightDist * 300.0);
  let lightColor = textureSample(colorTex, texSampler, lightPos).rgb;
  let luma = dot(lightColor, vec3<f32>(0.299, 0.587, 0.114));
  if (luma > u.threshold) {
    flare += lightColor * lightFalloff * u.intensity;
  }

  return vec4<f32>(flare, 1.0);
}
`;

export interface LensFlareSettings {
  intensity: number;
  threshold: number;
  ghostCount: number;
  ghostSpacing: number;
  haloWidth: number;
  starSamples: number;
  tint: [number, number, number];
}

export const DEFAULT_LENS_FLARE_SETTINGS: LensFlareSettings = {
  intensity: 0.8,
  threshold: 0.9,
  ghostCount: 8,
  ghostSpacing: 0.15,
  haloWidth: 0.2,
  starSamples: 1,
  tint: [1.0, 0.9, 0.8],
};

export class LensFlarePass extends RenderPass {
  name = "lens-flare";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: LensFlareSettings;
  private lightScreenPos: [number, number] = [0.5, 0.5];
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  private _backend: RenderBackend | null = null;
  private _bgPipeline: BackendRenderPipeline | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgSampler: BackendSampler | null = null;
  private _bgLayout: BackendBindGroupLayout | null = null;

  constructor(device: GPUDevice, settings: Partial<LensFlareSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_LENS_FLARE_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice, backend?: RenderBackend | null): void {
    if (backend) {
      this.prepareBackend(backend);
      return;
    }
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const fsModule = this.device.createShaderModule({ code: LENS_FLARE_FS });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: fsModule,
        entryPoint: "lens_flare_fs",
        targets: [{ format: "rgba16float", blend: {
          alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        } }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private prepareBackend(backend: RenderBackend): void {
    this._backend = backend;
    this._bgSampler = backend.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this._bgUniformBuffer = backend.createBuffer({ label: "lens-flare-uniforms", size: 48, usage: 0x40 | 0x08 });
    this._bgLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const vsModule = backend.createShaderModule(wgslShader(FULLSCREEN_VS, "fullscreen-vs"), "wgsl");
    const fsModule = backend.createShaderModule(wgslShader(LENS_FLARE_FS, "lens-flare-fs"), "wgsl");
    const layout = backend.createPipelineLayout({ label: "lens-flare-layout", bindGroupLayouts: [this._bgLayout] });
    this._bgPipeline = backend.createRenderPipeline({
      label: "lens-flare-pipeline",
      layout,
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: fsModule, entryPoint: "lens_flare_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<LensFlareSettings>): void {
    Object.assign(this.settings, settings);
  }

  setLightScreenPos(x: number, y: number): void {
    this.lightScreenPos = [x, y];
  }

  private writeUniforms(): void {
    const data = new Float32Array(12);
    data[0] = this.lightScreenPos[0];
    data[1] = this.lightScreenPos[1];
    data[2] = this.settings.intensity;
    data[3] = this.settings.threshold;
    data[4] = this.settings.ghostCount;
    data[5] = this.settings.ghostSpacing;
    data[6] = this.settings.haloWidth;
    data[7] = this.settings.starSamples;
    data[8] = this.settings.tint[0];
    data[9] = this.settings.tint[1];
    data[10] = this.settings.tint[2];
    data[11] = 0.0;
    if (this._backend && this._bgUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgUniformBuffer, 0, data as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
    }
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.depthHandle || !this.outputHandle) return;
    this.writeUniforms();

    if (ctx.backend && this._bgPipeline) {
      this.executeBackend(ctx);
      return;
    }
    if (!this.pipeline || !ctx.device) return;

    const colorView = ctx.getView(this.colorHandle);
    const depthView = ctx.getView(this.depthHandle);
    const outputView = ctx.getView(this.outputHandle);

    const bindGroup = ctx.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: depthView },
        { binding: 3, resource: this.sampler! },
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
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
  }

  private executeBackend(ctx: GraphRenderContext): void {
    const backend = ctx.backend!;
    const colorView = ctx.getBackendView(this.colorHandle!);
    const depthView = ctx.getBackendView(this.depthHandle!);
    const outputView = ctx.getBackendView(this.outputHandle!);

    const bindGroup = backend.createBindGroup({
      layout: this._bgLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
        { binding: 1, resource: { textureView: colorView } },
        { binding: 2, resource: { textureView: depthView } },
        { binding: 3, resource: { sampler: this._bgSampler! } },
      ],
    });

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(this._bgPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    backend.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
