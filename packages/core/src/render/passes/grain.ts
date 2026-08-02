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

const GRAIN_FS = /* wgsl */ `
struct GrainUniforms {
  intensity: f32,
  size: f32,
  time: f32,
  luminanceAware: f32,
};

@group(0) @binding(0) var<uniform> u: GrainUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

fn hash22(p: vec2<f32>) -> vec2<f32> {
  var q = p;
  q = vec2<f32>(dot(q, vec2<f32>(127.1, 311.7)), dot(q, vec2<f32>(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn noise2D(uv: vec2<f32>) -> f32 {
  let i = floor(uv);
  let f = fract(uv);
  let a = hash22(i).x;
  let b = hash22(i + vec2<f32>(1.0, 0.0)).x;
  let c = hash22(i + vec2<f32>(0.0, 1.0)).x;
  let d = hash22(i + vec2<f32>(1.0, 1.0)).x;
  let t = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

@fragment
fn grain_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let color = textureSample(colorTex, texSampler, uv).rgb;
  let noiseUV = uv * u.size + u.time * 0.7;
  let n = noise2D(noiseUV) - 0.5;

  var grain = n * u.intensity;

  if (u.luminanceAware > 0.5) {
    let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
    grain *= 1.0 - luma * 0.5;
  }

  return vec4<f32>(color + grain, 1.0);
}
`;

export interface GrainSettings {
  intensity: number;
  size: number;
  luminanceAware: boolean;
}

export const DEFAULT_GRAIN_SETTINGS: GrainSettings = {
  intensity: 0.05,
  size: 2.5,
  luminanceAware: true,
};

export class GrainPass extends RenderPass {
  name = "grain";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: GrainSettings;
  private time = 0;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  private _backend: RenderBackend | null = null;
  private _bgPipeline: BackendRenderPipeline | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgSampler: BackendSampler | null = null;
  private _bgLayout: BackendBindGroupLayout | null = null;

  constructor(device: GPUDevice, settings: Partial<GrainSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_GRAIN_SETTINGS, ...settings };
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
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const fsModule = this.device.createShaderModule({ code: GRAIN_FS });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: fsModule,
        entryPoint: "grain_fs",
        targets: [{ format: "rgba16float" }],
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
    this._bgUniformBuffer = backend.createBuffer({ label: "grain-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const vsModule = backend.createShaderModule(wgslShader(FULLSCREEN_VS, "fullscreen-vs"), "wgsl");
    const fsModule = backend.createShaderModule(wgslShader(GRAIN_FS, "grain-fs"), "wgsl");
    const layout = backend.createPipelineLayout({ label: "grain-layout", bindGroupLayouts: [this._bgLayout] });
    this._bgPipeline = backend.createRenderPipeline({
      label: "grain-pipeline",
      layout,
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: fsModule, entryPoint: "grain_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<GrainSettings>): void {
    Object.assign(this.settings, settings);
  }

  update(dt: number): void {
    this.time += dt;
  }

  private writeUniforms(): Float32Array {
    const data = new Float32Array(4);
    data[0] = this.settings.intensity;
    data[1] = this.settings.size;
    data[2] = this.time;
    data[3] = this.settings.luminanceAware ? 1.0 : 0.0;
    if (this._backend && this._bgUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgUniformBuffer, 0, data as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
    }
    return data;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.outputHandle) return;
    this.writeUniforms();

    if (ctx.backend && this._bgPipeline) {
      this.executeBackend(ctx);
      return;
    }
    if (!this.pipeline || !ctx.device) return;

    const colorView = ctx.getView(this.colorHandle);
    const outputView = ctx.getView(this.outputHandle);

    const bindGroup = ctx.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: this.sampler! },
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
    const outputView = ctx.getBackendView(this.outputHandle!);

    const bindGroup = backend.createBindGroup({
      layout: this._bgLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
        { binding: 1, resource: { textureView: colorView } },
        { binding: 2, resource: { sampler: this._bgSampler! } },
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
