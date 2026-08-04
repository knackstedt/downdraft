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

const SSAO_FS = /* wgsl */ `
struct SSAOUniforms {
  projection: mat4x4<f32>,
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  kernelSize: f32,
  radius: f32,
  bias: f32,
  noiseScale: vec2<f32>,
  screenSize: vec2<f32>,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: SSAOUniforms;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var noiseTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

fn reconstructViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let viewPos = u.invProjection * clip;
  return viewPos.xyz / viewPos.w;
}

@fragment
fn ssao_fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
  let depth = textureSample(depthTex, texSampler, uv).r;
  if (depth >= 1.0) { return 1.0; }

  let viewPos = reconstructViewPos(uv, depth);
  let worldNormal = textureSample(normalTex, texSampler, uv).xyz * 2.0 - 1.0;
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);

  let noiseVal = textureSample(noiseTex, texSampler, uv * u.noiseScale).xy;
  let rotAngle = noiseVal.x * 6.2831853;
  let rotMat = mat2x2<f32>(
    vec2<f32>(cos(rotAngle), -sin(rotAngle)),
    vec2<f32>(sin(rotAngle), cos(rotAngle)),
  );

  var occlusion = 0.0;
  let kernelSize = u32(u.kernelSize);
  let radius = u.radius;

  for (var i = 0u; i < 64u; i++) {
    if (i >= kernelSize) { break; }
    let sampleDir = vec3<f32>(
      f32(i) / kernelSize * 2.0 - 1.0,
      fract(f32(i) * 0.6180339887) * 2.0 - 1.0,
      fract(f32(i) * 0.4142135623),
    );
    let sampleDirNorm = normalize(sampleDir);
    let scaledDir = sampleDirNorm * (fract(f32(i) * 0.12345) * 0.9 + 0.1) * radius;
    let rotatedDir = vec3<f32>(rotMat * scaledDir.xy, scaledDir.z);
    let samplePos = viewPos + rotatedDir;

    let sampleClip = u.projection * vec4<f32>(samplePos, 1.0);
    let sampleNDC = sampleClip.xyz / sampleClip.w;
    let sampleUV = sampleNDC.xy * 0.5 + 0.5;
    let sampleDepth = textureSample(depthTex, texSampler, sampleUV).r;
    let sampleViewPos = reconstructViewPos(sampleUV, sampleDepth);

    if (samplePos.z - sampleViewPos.z > u.bias) {
      occlusion += 1.0;
    }
  }

  occlusion = 1.0 - occlusion / f32(kernelSize);
  return clamp(occlusion, 0.0, 1.0);
}
`;

const SSAO_BLUR_FS = /* wgsl */ `
struct BlurUniforms {
  texelSize: vec2<f32>,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var ssaoTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn blur_fs(@location(0) uv: vec2<f32>) -> @location(0) f32 {
  let centerDepth = textureSample(depthTex, texSampler, uv).r;
  var sum = 0.0;
  var weightSum = 0.0;

  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let offset = vec2<f32>(f32(x), f32(y)) * u.texelSize;
      let sampleDepth = textureSample(depthTex, texSampler, uv + offset).r;
      let weight = select(0.0, 1.0, abs(sampleDepth - centerDepth) < 0.1);
      sum += textureSample(ssaoTex, texSampler, uv + offset).r * weight;
      weightSum += weight;
    }
  }

  return sum / max(weightSum, 1.0);
}
`;

export interface SSAOSettings {
  radius: number;
  bias: number;
  kernelSize: number;
  blurEnabled: boolean;
  noiseSize: number;
}

export const DEFAULT_SSAO_SETTINGS: SSAOSettings = {
  radius: 0.5,
  bias: 0.025,
  kernelSize: 32,
  blurEnabled: true,
  noiseSize: 4,
};

export class SSAOPass extends RenderPass {
  name = "ssao";
  passType = PassType.Custom;
  depthHandle: TextureHandle | null = null;
  normalHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: SSAOSettings;
  private ssaoPipeline: GPURenderPipeline | null = null;
  private blurPipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private blurUniformBuffer: GPUBuffer | null = null;
  private noiseTexture: GPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  private ssaoTexture: GPUTexture | null = null;
  private ssaoView: GPUTextureView | null = null;


  constructor(device: GPUDevice, settings: Partial<SSAOSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_SSAO_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const noiseData = new Uint8Array(this.settings.noiseSize * this.settings.noiseSize * 4);
    for (let i = 0; i < noiseData.length; i += 4) {
      noiseData[i] = Math.floor(Math.random() * 255);
      noiseData[i + 1] = Math.floor(Math.random() * 255);
      noiseData[i + 2] = 0;
      noiseData[i + 3] = 255;
    }
    this.noiseTexture = this.device.createTexture({
      size: [this.settings.noiseSize, this.settings.noiseSize],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.noiseTexture },
      noiseData,
      { bytesPerRow: this.settings.noiseSize * 4 },
      { width: this.settings.noiseSize, height: this.settings.noiseSize },
    );

    this.uniformBuffer = this.device.createBuffer({
      size: 220,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.blurUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const fsModule = this.device.createShaderModule({ code: SSAO_FS });
    const blurFsModule = this.device.createShaderModule({ code: SSAO_BLUR_FS });

    this.ssaoPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: fsModule,
        entryPoint: "ssao_fs",
        targets: [{ format: "r8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.blurPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: blurFsModule,
        entryPoint: "blur_fs",
        targets: [{ format: "r8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setProjectionMatrices(proj: Float32Array, invProj: Float32Array, view: Float32Array, screenWidth: number, screenHeight: number): void {
    const data = new Float32Array(55);
    data.set(proj, 0);
    data.set(invProj, 16);
    data.set(view, 32);
    data[48] = this.settings.kernelSize;
    data[49] = this.settings.radius;
    data[50] = this.settings.bias;
    data[51] = this.settings.noiseSize;
    data[52] = this.settings.noiseSize;
    data[53] = screenWidth;
    data[54] = screenHeight;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.read(this.depthHandle);
    if (this.normalHandle) builder.read(this.normalHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.depthHandle || !this.outputHandle) return;
    if (!this.ssaoPipeline || !ctx.device) return;
    const depthView = ctx.getView(this.depthHandle);
    const normalView = this.normalHandle ? ctx.getView(this.normalHandle) : depthView;
    const outputView = ctx.getView(this.outputHandle);

    const bindGroup = this.device.createBindGroup({
      layout: this.ssaoPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: depthView },
        { binding: 2, resource: normalView },
        { binding: 3, resource: this.noiseTexture!.createView() },
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
    pass.setPipeline(this.ssaoPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    ctx.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.noiseTexture?.destroy();
    this.ssaoTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.blurUniformBuffer?.destroy();
  }
}
