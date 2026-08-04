import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

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

const SHARPEN_FS = /* wgsl */ `
struct SharpenUniforms {
  sharpness: f32,
  texelSizeX: f32,
  texelSizeY: f32,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: SharpenUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn sharpen_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let texel = vec2<f32>(u.texelSizeX, u.texelSizeY);
  let center = textureSample(colorTex, texSampler, uv).rgb;
  let up    = textureSample(colorTex, texSampler, uv + vec2<f32>(0.0, -1.0) * texel).rgb;
  let down  = textureSample(colorTex, texSampler, uv + vec2<f32>(0.0,  1.0) * texel).rgb;
  let left  = textureSample(colorTex, texSampler, uv + vec2<f32>(-1.0, 0.0) * texel).rgb;
  let right = textureSample(colorTex, texSampler, uv + vec2<f32>( 1.0, 0.0) * texel).rgb;

  let blurred = (up + down + left + right) * 0.25;
  let result = center + (center - blurred) * u.sharpness;
  return vec4<f32>(result, 1.0);
}
`;

export interface SharpenSettings {
  sharpness: number;
}

export const DEFAULT_SHARPEN_SETTINGS: SharpenSettings = {
  sharpness: 0.5,
};

export class SharpenPass extends RenderPass {
  name = "sharpen";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: SharpenSettings;
  private width = 0;
  private height = 0;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;


  constructor(device: GPUDevice, settings: Partial<SharpenSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_SHARPEN_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
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
    const fsModule = this.device.createShaderModule({ code: SHARPEN_FS });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: fsModule,
        entryPoint: "sharpen_fs",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<SharpenSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  private writeUniforms(): void {
    const data = new Float32Array(4);
    data[0] = this.settings.sharpness;
    data[1] = this.width > 0 ? 1.0 / this.width : 0.0;
    data[2] = this.height > 0 ? 1.0 / this.height : 0.0;
    data[3] = 0.0;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.outputHandle) return;
    if (this.width === 0) { this.width = ctx.width; this.height = ctx.height; }
    this.writeUniforms();

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

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
