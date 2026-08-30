import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, vec3f, wgsl } from "@downdraft/shader-graph";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const EdgesUniforms: WgslStruct = wgsl.struct("EdgesUniforms", {
  threshold: f32,
  texelSizeX: f32,
  texelSizeY: f32,
  opacity: f32,
  edgeColor: vec3f,
  _pad0: f32,
});

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
${EdgesUniforms.wgsl}

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
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;


  constructor(device: GPUDevice, settings: Partial<EdgesSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_EDGES_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
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
    this._uniformBuf = new Float32Array(EdgesUniforms.floatCount);
    this._uniformView = EdgesUniforms.view(this._uniformBuf);

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

  setSettings(settings: Partial<EdgesSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  private writeUniforms(): void {
    const view = this._uniformView!;
    view.set("threshold", this.settings.threshold);
    view.set("texelSizeX", this.width > 0 ? 1.0 / this.width : 0.0);
    view.set("texelSizeY", this.height > 0 ? 1.0 / this.height : 0.0);
    view.set("opacity", this.settings.opacity);
    view.set("edgeColor", this.settings.edgeColor);
    view.set("_pad0", 0.0);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this._uniformBuf as unknown as BufferSource);
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

  destroy(): void {
    this.uniformBuffer?.destroy();
    this._uniformView = null;
    this._uniformBuf = null;
  }
}
