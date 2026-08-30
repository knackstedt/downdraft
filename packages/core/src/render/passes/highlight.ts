import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, wgsl } from "@downdraft/shader-graph";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { createUniformBuffer } from "../gpu-utils";
import { RenderPass } from "../render-pass";

const BlurUniforms: WgslStruct = wgsl.struct("BlurUniforms", {
  texelSizeX: f32,
  texelSizeY: f32,
  directionX: f32,
  directionY: f32,
  blurRadius: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
});

const CompositeUniforms: WgslStruct = wgsl.struct("CompositeUniforms", {
  intensity: f32,
  innerOpacity: f32,
  _pad0: f32,
  _pad1: f32,
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

const HIGHLIGHT_BLUR_FS = /* wgsl */ `
${BlurUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn highlight_blur_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);
  let dir = vec2<f32>(u.directionX, u.directionY) * u.blurRadius;

  var color = textureSample(maskTex, texSampler, uv) * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = dir * offsets[i];
    color += textureSample(maskTex, texSampler, uv + offset) * weights[i];
    color += textureSample(maskTex, texSampler, uv - offset) * weights[i];
  }
  return color;
}
`;

const HIGHLIGHT_COMPOSITE_FS = /* wgsl */ `
${CompositeUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var blurTex: texture_2d<f32>;
@group(0) @binding(3) var maskTex: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

@fragment
fn highlight_composite_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let color = textureSample(colorTex, texSampler, uv).rgb;
  let blurred = textureSample(blurTex, texSampler, uv).rgb;
  let mask = textureSample(maskTex, texSampler, uv).rgb;

  // Outer glow (blurred halo minus inner area)
  let outerGlow = blurred * u.intensity;

  // Inner fill (semi-transparent overlay on highlighted meshes)
  let inner = mask * u.innerOpacity;

  return vec4<f32>(color + outerGlow + inner, 1.0);
}
`;

const HIGHLIGHT_MASK_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4<f32>;
@fragment
fn highlight_mask_fs() -> @location(0) vec4<f32> {
  return u;
}
`;

export interface HighlightSettings {
  intensity: number;
  innerOpacity: number;
  blurRadius: number;
}

export const DEFAULT_HIGHLIGHT_SETTINGS: HighlightSettings = {
  intensity: 0.8,
  innerOpacity: 0.3,
  blurRadius: 3.0,
};

export interface HighlightTarget {
  color: [number, number, number, number];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

export class HighlightPass extends RenderPass {
  name = "highlight";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: HighlightSettings;
  private width = 0;
  private height = 0;
  private targets: HighlightTarget[] = [];

  private blurPipeline: GPURenderPipeline | null = null;
  private compositePipeline: GPURenderPipeline | null = null;
  private maskPipeline: GPURenderPipeline | null = null;
  private blurUniformBuffer: GPUBuffer | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;
  private maskUniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private _blurView: StructView | null = null;
  private _blurBuf: Float32Array | null = null;
  private _compositeView: StructView | null = null;
  private _compositeBuf: Float32Array | null = null;

  private maskTexture: GPUTexture | null = null;
  private maskView: GPUTextureView | null = null;
  private blurTempTexture: GPUTexture | null = null;
  private blurTempView: GPUTextureView | null = null;
  private blurTempTexture2: GPUTexture | null = null;
  private blurTempView2: GPUTextureView | null = null;


  constructor(device: GPUDevice, settings: Partial<HighlightSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_HIGHLIGHT_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.blurUniformBuffer = createUniformBuffer(this.device, 32);
    this.compositeUniformBuffer = createUniformBuffer(this.device, 16);
    this.maskUniformBuffer = createUniformBuffer(this.device, 16);
    this._blurBuf = new Float32Array(BlurUniforms.floatCount);
    this._blurView = BlurUniforms.view(this._blurBuf);
    this._compositeBuf = new Float32Array(CompositeUniforms.floatCount);
    this._compositeView = CompositeUniforms.view(this._compositeBuf);

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const blurFsModule = this.device.createShaderModule({ code: HIGHLIGHT_BLUR_FS });
    const compositeFsModule = this.device.createShaderModule({ code: HIGHLIGHT_COMPOSITE_FS });
    const maskFsModule = this.device.createShaderModule({ code: HIGHLIGHT_MASK_FS });

    this.blurPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: blurFsModule, entryPoint: "highlight_blur_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });

    this.compositePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: compositeFsModule, entryPoint: "highlight_composite_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });

    this.maskPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: `
struct MaskVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
};
@group(0) @binding(0) var<uniform> modelMatrix: mat4x4<f32>;
@vertex
fn mask_vs(@location(0) position: vec3<f32>) -> MaskVertexOutput {
  var output: MaskVertexOutput;
  output.clipPosition = modelMatrix * vec4<f32>(position, 1.0);
  return output;
}
` }),
        entryPoint: "mask_vs",
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
      },
      fragment: { module: maskFsModule, entryPoint: "highlight_mask_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<HighlightSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  setTargets(targets: HighlightTarget[]): void {
    this.targets = targets;
  }

  private ensureTextures(w: number, h: number): void {
    if (this.maskTexture && this.maskTexture.width === w && this.maskTexture.height === h) return;
    this.maskTexture?.destroy();
    this.blurTempTexture?.destroy();
    this.blurTempTexture2?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.maskTexture = this.device.createTexture({ label: "highlight-mask", size: [w, h], format: "rgba16float", usage });
    this.maskView = this.maskTexture.createView();
    this.blurTempTexture = this.device.createTexture({ label: "highlight-blur-h", size: [w, h], format: "rgba16float", usage });
    this.blurTempView = this.blurTempTexture.createView();
    this.blurTempTexture2 = this.device.createTexture({ label: "highlight-blur-v", size: [w, h], format: "rgba16float", usage });
    this.blurTempView2 = this.blurTempTexture2.createView();
  }

  private writeBlurUniforms(dirX: number, dirY: number): void {
    const view = this._blurView!;
    view.set("texelSizeX", this.width > 0 ? 1.0 / this.width : 0.0);
    view.set("texelSizeY", this.height > 0 ? 1.0 / this.height : 0.0);
    view.set("directionX", dirX);
    view.set("directionY", dirY);
    view.set("blurRadius", this.settings.blurRadius);
    view.set("_pad0", 0);
    view.set("_pad1", 0);
    view.set("_pad2", 0);
    this.device.queue.writeBuffer(this.blurUniformBuffer!, 0, this._blurBuf as unknown as BufferSource);
  }

  private writeCompositeUniforms(): void {
    const view = this._compositeView!;
    view.set("intensity", this.settings.intensity);
    view.set("innerOpacity", this.settings.innerOpacity);
    view.set("_pad0", 0);
    view.set("_pad1", 0);
    this.device.queue.writeBuffer(this.compositeUniformBuffer!, 0, this._compositeBuf as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.outputHandle) return;
    if (this.width === 0) { this.width = ctx.width; this.height = ctx.height; }
    if (this.targets.length === 0) return;

    this.ensureTextures(this.width, this.height);
    this.writeCompositeUniforms();

    if (!this.blurPipeline || !this.compositePipeline || !this.maskPipeline || !ctx.device) return;

    const maskUniformData = new Float32Array(4);
    // DEVIATION: This pass creates its own command encoder and submits directly
    // instead of using the frame graph's shared encoder. Highlight uses multiple
    // internal render passes (mask → blur H → blur V → composite) with
    // privately-owned intermediate textures; refactoring to the frame graph is
    // tracked as a future task.
    const encoder = ctx.device.createCommandEncoder();

    // Pass 1: Render highlight mask
    const maskPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.maskView!,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    maskPass.setPipeline(this.maskPipeline);
    for (const target of this.targets) {
      maskUniformData[0] = target.color[0];
      maskUniformData[1] = target.color[1];
      maskUniformData[2] = target.color[2];
      maskUniformData[3] = target.color[3];
      ctx.device.queue.writeBuffer(this.maskUniformBuffer!, 0, maskUniformData as unknown as BufferSource);
      const bg = ctx.device.createBindGroup({
        layout: this.maskPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.maskUniformBuffer! } }],
      });
      maskPass.setBindGroup(0, bg);
      maskPass.setVertexBuffer(0, target.vertexBuffer);
      maskPass.setIndexBuffer(target.indexBuffer, "uint16");
      maskPass.drawIndexed(target.indexCount);
    }
    maskPass.end();

    // Pass 2: Horizontal blur
    this.writeBlurUniforms(1.0, 0.0);
    const blurHBg = ctx.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blurUniformBuffer! } },
        { binding: 1, resource: this.maskView! },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const blurHPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.blurTempView!,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    blurHPass.setPipeline(this.blurPipeline);
    blurHPass.setBindGroup(0, blurHBg);
    blurHPass.draw(6);
    blurHPass.end();

    // Pass 3: Vertical blur
    this.writeBlurUniforms(0.0, 1.0);
    const blurVBg = ctx.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blurUniformBuffer! } },
        { binding: 1, resource: this.blurTempView! },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const blurVPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.blurTempView2!,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    blurVPass.setPipeline(this.blurPipeline);
    blurVPass.setBindGroup(0, blurVBg);
    blurVPass.draw(6);
    blurVPass.end();

    // Pass 4: Composite onto color
    const colorView = ctx.getView(this.colorHandle);
    const outputView = ctx.getView(this.outputHandle);
    const compositeBg = ctx.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.compositeUniformBuffer! } },
        { binding: 1, resource: colorView },
        { binding: 2, resource: this.blurTempView2! },
        { binding: 3, resource: this.maskView! },
        { binding: 4, resource: this.sampler! },
      ],
    });
    const compositePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    compositePass.setPipeline(this.compositePipeline);
    compositePass.setBindGroup(0, compositeBg);
    compositePass.draw(6);
    compositePass.end();

    ctx.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.blurUniformBuffer?.destroy();
    this.compositeUniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    this.maskTexture?.destroy();
    this.blurTempTexture?.destroy();
    this.blurTempTexture2?.destroy();
    this._blurView = null;
    this._blurBuf = null;
    this._compositeView = null;
    this._compositeBuf = null;
  }
}
