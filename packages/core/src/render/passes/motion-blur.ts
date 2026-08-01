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

const MOTION_BLUR_FS = /* wgsl */ `
struct MotionBlurUniforms {
  intensity: f32,
  maxSamples: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: MotionBlurUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var velocityTex: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

@fragment
fn motion_blur_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let velocity = textureSample(velocityTex, texSampler, uv).xy;
  let speed = length(velocity);

  if (speed < 0.001) {
    return textureSample(colorTex, texSampler, uv);
  }

  let depth = textureSample(depthTex, texSampler, uv).r;
  let maxSamples = u32(u.maxSamples);
  let clampedVelocity = velocity * u.intensity;

  var color = vec3<f32>(0.0);
  var totalWeight = 0.0;

  for (var i = 0u; i < 32u; i++) {
    if (i >= maxSamples) { break; }
    let t = (f32(i) + 0.5) / f32(maxSamples) - 0.5;
    let sampleUV = uv + clampedVelocity * t;
    let sampleDepth = textureSample(depthTex, texSampler, sampleUV).r;
    let weight = select(0.1, 1.0, abs(sampleDepth - depth) < 0.1);
    color += textureSample(colorTex, texSampler, sampleUV).rgb * weight;
    totalWeight += weight;
  }

  return vec4<f32>(color / max(totalWeight, 1.0), 1.0);
}
`;

export interface MotionBlurSettings {
  intensity: number;
  maxSamples: number;
}

export const DEFAULT_MOTION_BLUR_SETTINGS: MotionBlurSettings = {
  intensity: 1.0,
  maxSamples: 16,
};

export class MotionBlurPass extends RenderPass {
  name = "motion-blur";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  velocityHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: MotionBlurSettings;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  constructor(device: GPUDevice, settings: Partial<MotionBlurSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_MOTION_BLUR_SETTINGS, ...settings };
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

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: FULLSCREEN_VS }),
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.device.createShaderModule({ code: MOTION_BLUR_FS }),
        entryPoint: "motion_blur_fs",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.velocityHandle) builder.read(this.velocityHandle);
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.outputHandle || !this.pipeline) return;
    const colorView = ctx.getView(this.colorHandle);
    const velocityView = this.velocityHandle ? ctx.getView(this.velocityHandle) : colorView;
    const depthView = this.depthHandle ? ctx.getView(this.depthHandle) : colorView;
    const outputView = ctx.getView(this.outputHandle);

    const uniformData = new Float32Array([this.settings.intensity, this.settings.maxSamples, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData as unknown as BufferSource);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: velocityView },
        { binding: 3, resource: depthView },
        { binding: 4, resource: this.sampler! },
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
