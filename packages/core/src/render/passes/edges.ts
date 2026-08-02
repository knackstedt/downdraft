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

const EDGES_FS = /* wgsl */ `
struct EdgesUniforms {
  threshold: f32,
  texelSizeX: f32,
  texelSizeY: f32,
  opacity: f32,
  edgeColor: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: EdgesUniforms;
@group(0) @binding(1) var normalTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

fn decodeNormal(rgb: vec3<f32>) -> vec3<f32> {
  return normalize(rgb * 2.0 - 1.0);
}

@fragment
fn edges_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let texel = vec2<f32>(u.texelSizeX, u.texelSizeY);

  let nCenter = decodeNormal(textureSample(normalTex, texSampler, uv).rgb);
  let nRight  = decodeNormal(textureSample(normalTex, texSampler, uv + vec2<f32>( 1.0, 0.0) * texel).rgb);
  let nUp     = decodeNormal(textureSample(normalTex, texSampler, uv + vec2<f32>( 0.0, 1.0) * texel).rgb);

  let dCenter = textureSample(depthTex, texSampler, uv).r;
  let dRight  = textureSample(depthTex, texSampler, uv + vec2<f32>( 1.0, 0.0) * texel).r;
  let dUp     = textureSample(depthTex, texSampler, uv + vec2<f32>( 0.0, 1.0) * texel).r;

  let normalEdge = max(
    1.0 - dot(nCenter, nRight),
    1.0 - dot(nCenter, nUp),
  );

  let depthEdge = max(
    abs(dCenter - dRight),
    abs(dCenter - dUp),
  );

  let edge = clamp(max(normalEdge, depthEdge * 100.0) / u.threshold, 0.0, 1.0);
  let edgeColor = u.edgeColor * edge * u.opacity;
  return vec4<f32>(edgeColor, edge * u.opacity);
}
`;

export interface EdgesSettings {
  threshold: number;
  opacity: number;
  edgeColor: [number, number, number];
}

export const DEFAULT_EDGES_SETTINGS: EdgesSettings = {
  threshold: 0.4,
  opacity: 1.0,
  edgeColor: [1.0, 1.0, 1.0],
};

export class EdgesPass extends RenderPass {
  name = "edges";
  passType = PassType.Custom;
  normalHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: EdgesSettings;
  private width = 0;
  private height = 0;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  private _backend: RenderBackend | null = null;
  private _bgPipeline: BackendRenderPipeline | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgSampler: BackendSampler | null = null;
  private _bgLayout: BackendBindGroupLayout | null = null;

  constructor(device: GPUDevice, settings: Partial<EdgesSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_EDGES_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice, backend?: RenderBackend | null): void {
    if (backend) {
      this.prepareBackend(backend);
      return;
    }
    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const fsModule = this.device.createShaderModule({ code: EDGES_FS });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: fsModule,
        entryPoint: "edges_fs",
        targets: [{ format: "rgba16float", blend: {
          alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        } }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private prepareBackend(backend: RenderBackend): void {
    this._backend = backend;
    this._bgSampler = backend.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this._bgUniformBuffer = backend.createBuffer({ label: "edges-uniforms", size: 32, usage: 0x40 | 0x08 });
    this._bgLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const vsModule = backend.createShaderModule(wgslShader(FULLSCREEN_VS, "fullscreen-vs"), "wgsl");
    const fsModule = backend.createShaderModule(wgslShader(EDGES_FS, "edges-fs"), "wgsl");
    const layout = backend.createPipelineLayout({ label: "edges-layout", bindGroupLayouts: [this._bgLayout] });
    this._bgPipeline = backend.createRenderPipeline({
      label: "edges-pipeline",
      layout,
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: fsModule, entryPoint: "edges_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<EdgesSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  private writeUniforms(): void {
    const data = new Float32Array(8);
    data[0] = this.settings.threshold;
    data[1] = this.width > 0 ? 1.0 / this.width : 0.0;
    data[2] = this.height > 0 ? 1.0 / this.height : 0.0;
    data[3] = this.settings.opacity;
    data[4] = this.settings.edgeColor[0];
    data[5] = this.settings.edgeColor[1];
    data[6] = this.settings.edgeColor[2];
    data[7] = 0.0;
    if (this._backend && this._bgUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgUniformBuffer, 0, data as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
    }
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.normalHandle) builder.read(this.normalHandle);
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.normalHandle || !this.depthHandle || !this.outputHandle) return;
    if (this.width === 0) { this.width = ctx.width; this.height = ctx.height; }
    this.writeUniforms();

    if (ctx.backend && this._bgPipeline) {
      this.executeBackend(ctx);
      return;
    }
    if (!this.pipeline || !ctx.device) return;

    const normalView = ctx.getView(this.normalHandle);
    const depthView = ctx.getView(this.depthHandle);
    const outputView = ctx.getView(this.outputHandle);

    const bindGroup = ctx.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: normalView },
        { binding: 2, resource: depthView },
        { binding: 3, resource: this.sampler! },
      ],
    });

    const encoder = ctx.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
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
    const normalView = ctx.getBackendView(this.normalHandle!);
    const depthView = ctx.getBackendView(this.depthHandle!);
    const outputView = ctx.getBackendView(this.outputHandle!);

    const bindGroup = backend.createBindGroup({
      layout: this._bgLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
        { binding: 1, resource: { textureView: normalView } },
        { binding: 2, resource: { textureView: depthView } },
        { binding: 3, resource: { sampler: this._bgSampler! } },
      ],
    });

    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
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
