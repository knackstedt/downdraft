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

const SSR_FS = /* wgsl */ `
struct SSRUniforms {
  projection: mat4x4<f32>,
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  maxSteps: f32,
  rayStep: f32,
  thickness: f32,
  maxDistance: f32,
  resolutionScale: f32,
  fadeStart: f32,
  fadeEnd: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: SSRUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_2d<f32>;
@group(0) @binding(3) var normalTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

fn reconstructViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let viewPos = u.invProjection * clip;
  return viewPos.xyz / viewPos.w;
}

fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  let clip = u.projection * vec4<f32>(viewPos, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3<f32>(ndc.xy * 0.5 + 0.5, ndc.z);
}

@fragment
fn ssr_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let depth = textureSample(depthTex, texSampler, uv).r;
  if (depth >= 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

  let viewPos = reconstructViewPos(uv, depth);
  let worldNormal = textureSample(normalTex, texSampler, uv).xyz * 2.0 - 1.0;
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);

  let viewDir = normalize(-viewPos);
  let reflectDir = reflect(-viewDir, N);

  if (reflectDir.z >= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

  let startPos = viewPos;
  let endPos = viewPos + reflectDir * u.maxDistance;

  let startScreen = projectToScreen(startPos);
  let endScreen = projectToScreen(endPos);

  var stepCount = u32(u.maxSteps);
  var hitColor = vec3<f32>(0.0);
  var hitAlpha = 0.0;

  for (var i = 1u; i < 128u; i++) {
    if (i >= stepCount) { break; }
    let t = f32(i) / f32(stepCount);
    let samplePos = mix(startPos, endPos, t);
    let sampleScreen = projectToScreen(samplePos);

    if (sampleScreen.x < 0.0 || sampleScreen.x > 1.0 || sampleScreen.y < 0.0 || sampleScreen.y > 1.0) { break; }

    let sampleDepth = textureSample(depthTex, texSampler, sampleScreen.xy).r;
    let sampleViewPos = reconstructViewPos(sampleScreen.xy, sampleDepth);

    let depthDiff = samplePos.z - sampleViewPos.z;
    if (depthDiff > 0.0 && depthDiff < u.thickness) {
      hitColor = textureSample(colorTex, texSampler, sampleScreen.xy).rgb;
      let dist = length(samplePos - viewPos);
      let fade = 1.0 - smoothstep(u.fadeStart, u.fadeEnd, dist);
      let edgeFade = smoothstep(0.0, 0.1, sampleScreen.x) * smoothstep(0.0, 0.1, 1.0 - sampleScreen.x) *
                     smoothstep(0.0, 0.1, sampleScreen.y) * smoothstep(0.0, 0.1, 1.0 - sampleScreen.y);
      hitAlpha = fade * edgeFade;
      break;
    }
  }

  return vec4<f32>(hitColor, hitAlpha);
}
`;

export interface SSRSettings {
  maxSteps: number;
  rayStep: number;
  thickness: number;
  maxDistance: number;
  resolutionScale: number;
  fadeStart: number;
  fadeEnd: number;
}

export const DEFAULT_SSR_SETTINGS: SSRSettings = {
  maxSteps: 64,
  rayStep: 0.1,
  thickness: 0.05,
  maxDistance: 100.0,
  resolutionScale: 0.5,
  fadeStart: 10.0,
  fadeEnd: 50.0,
};

export class SSRPass extends RenderPass {
  name = "ssr";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  normalHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: SSRSettings;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  // Cached bind group — invalidated when input texture views change (e.g., canvas resize).
  private cachedBindGroup: GPUBindGroup | null = null;
  private cachedColorView: GPUTextureView | null = null;
  private cachedDepthView: GPUTextureView | null = null;
  private cachedNormalView: GPUTextureView | null = null;


  constructor(device: GPUDevice, settings: Partial<SSRSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_SSR_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 220,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: FULLSCREEN_VS }),
        entryPoint: "vs_main",
      },
      fragment: {
        module: this.device.createShaderModule({ code: SSR_FS }),
        entryPoint: "ssr_fs",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setProjectionMatrices(proj: Float32Array, invProj: Float32Array, view: Float32Array): void {
    const data = new Float32Array(55);
    data.set(proj, 0);
    data.set(invProj, 16);
    data.set(view, 32);
    data[48] = this.settings.maxSteps;
    data[49] = this.settings.rayStep;
    data[50] = this.settings.thickness;
    data[51] = this.settings.maxDistance;
    data[52] = this.settings.resolutionScale;
    data[53] = this.settings.fadeStart;
    data[54] = this.settings.fadeEnd;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.normalHandle) builder.read(this.normalHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.depthHandle || !this.outputHandle) return;
    if (!this.pipeline || !ctx.device) return;
    const colorView = ctx.getView(this.colorHandle);
    const depthView = ctx.getView(this.depthHandle);
    const normalView = this.normalHandle ? ctx.getView(this.normalHandle) : depthView;
    const outputView = ctx.getView(this.outputHandle);

    // Reuse cached bind group when input texture views haven't changed (avoids
    // per-frame createBindGroup allocation — the views are stable across frames
    // unless the canvas/render targets are resized).
    if (!this.cachedBindGroup || this.cachedColorView !== colorView || this.cachedDepthView !== depthView || this.cachedNormalView !== normalView) {
      this.cachedBindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: colorView },
          { binding: 2, resource: depthView },
          { binding: 3, resource: normalView },
          { binding: 4, resource: this.sampler! },
        ],
      });
      this.cachedColorView = colorView;
      this.cachedDepthView = depthView;
      this.cachedNormalView = normalView;
    }
    const bindGroup = this.cachedBindGroup;

    // DEVIATION: This pass creates its own command encoder and submits directly
    // instead of using the frame graph's shared encoder. SSR needs a dedicated
    // render pass with its own output texture that is not declared as a graph
    // attachment; refactoring to the frame graph is tracked as a future task.
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
  }
}
