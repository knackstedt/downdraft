import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, vec3f, wgsl } from "@downdraft/shader-graph";
import { PassType, type FrameGraphBuilder, type GraphRenderContext, type TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const OutlineUniforms: WgslStruct = wgsl.struct("OutlineUniforms", {
  texelSizeX: f32,
  texelSizeY: f32,
  outlineWidth: f32,
  opacity: f32,
  outlineColor: vec3f,
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

const OUTLINE_DETECT_FS = /* wgsl */ `
${OutlineUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: OutlineUniforms;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn outline_detect_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let texel = vec2<f32>(u.texelSizeX, u.texelSizeY);
  let w = u.outlineWidth;

  // Sample 8 neighbors to detect mask boundary
  let center = textureSample(maskTex, texSampler, uv).r;
  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  0.0), vec2<f32>( 1.0,  0.0),
    vec2<f32>( 0.0, -1.0), vec2<f32>( 0.0,  1.0),
  );

  var edge = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let sampleUV = uv + offsets[i] * texel * w;
    let s = textureSample(maskTex, texSampler, sampleUV).r;
    edge = max(edge, abs(center - s));
  }

  // Only draw outline where center is outside the mask (edge ring)
  let outline = edge * (1.0 - center) * u.opacity;
  return vec4<f32>(u.outlineColor * outline, outline);
}
`;

const OUTLINE_MASK_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4<f32>;
@fragment
fn outline_mask_fs() -> @location(0) vec4<f32> {
  return u;
}
`;

export interface OutlineSettings {
  outlineColor: [number, number, number];
  outlineWidth: number;
  opacity: number;
}

export const DEFAULT_OUTLINE_SETTINGS: OutlineSettings = {
  outlineColor: [1.0, 0.8, 0.2],
  outlineWidth: 2.0,
  opacity: 1.0,
};

export interface OutlineTarget {
  color: [number, number, number, number];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  modelMatrix: Float32Array;
}

export class OutlinePass extends RenderPass {
  name = "outline";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: OutlineSettings;
  private width = 0;
  private height = 0;
  private targets: OutlineTarget[] = [];

  private detectPipeline: GPURenderPipeline | null = null;
  private maskPipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private maskUniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;

  private maskTexture: GPUTexture | null = null;
  private maskView: GPUTextureView | null = null;


  constructor(device: GPUDevice, settings: Partial<OutlineSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_OUTLINE_SETTINGS, ...settings };
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
    this._uniformBuf = new Float32Array(OutlineUniforms.floatCount);
    this._uniformView = OutlineUniforms.view(this._uniformBuf);
    this.maskUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const detectFsModule = this.device.createShaderModule({ code: OUTLINE_DETECT_FS });
    const maskFsModule = this.device.createShaderModule({ code: OUTLINE_MASK_FS });

    this.detectPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: {
        module: detectFsModule,
        entryPoint: "outline_detect_fs",
        targets: [{ format: "rgba16float", blend: {
          alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        } }],
      },
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
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: {
        module: maskFsModule,
        entryPoint: "outline_mask_fs",
        targets: [{ format: "r16float" }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "front",
      },
      depthStencil: {
        depthWriteEnabled: false,
        depthCompare: "always",
        format: "depth32float",
      },
    });
  }

  setSettings(settings: Partial<OutlineSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  setTargets(targets: OutlineTarget[]): void {
    this.targets = targets;
  }

  private ensureMaskTexture(w: number, h: number): void {
    if (this.maskTexture && this.maskTexture.width === w && this.maskTexture.height === h) return;
    this.maskTexture?.destroy();
    this.maskTexture = this.device.createTexture({
      label: "outline-mask",
      size: [w, h],
      format: "r16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.maskView = this.maskTexture.createView();
  }

  private writeUniforms(): void {
    const view = this._uniformView!;
    view.set("texelSizeX", this.width > 0 ? 1.0 / this.width : 0.0);
    view.set("texelSizeY", this.height > 0 ? 1.0 / this.height : 0.0);
    view.set("outlineWidth", this.settings.outlineWidth);
    view.set("opacity", this.settings.opacity);
    view.set("outlineColor", this.settings.outlineColor);
    view.set("_pad0", 0.0);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this._uniformBuf as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.colorHandle) builder.read(this.colorHandle);
    if (this.outputHandle) builder.write(this.outputHandle);
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.colorHandle || !this.outputHandle) return;
    if (this.width === 0) { this.width = ctx.width; this.height = ctx.height; }
    if (this.targets.length === 0) return;

    this.ensureMaskTexture(this.width, this.height);
    this.writeUniforms();

    if (!this.detectPipeline || !this.maskPipeline || !ctx.device) return;

    // Pass 1: Render mask — draw each target's mesh with front-face culling (back faces only, expanded outline)
    const maskUniformData = new Float32Array(4);
    const encoder = ctx.device.createCommandEncoder();

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

      const maskBg = ctx.device.createBindGroup({
        layout: this.maskPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.maskUniformBuffer! } }],
      });
      maskPass.setBindGroup(0, maskBg);
      maskPass.setVertexBuffer(0, target.vertexBuffer);
      maskPass.setIndexBuffer(target.indexBuffer, "uint16");
      maskPass.drawIndexed(target.indexCount);
    }
    maskPass.end();

    // Pass 2: Edge detection + composite onto color buffer
    const colorView = ctx.getView(this.colorHandle);
    const outputView = ctx.getView(this.outputHandle);

    const detectBg = ctx.device.createBindGroup({
      layout: this.detectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this.maskView! },
        { binding: 2, resource: this.sampler! },
      ],
    });

    const detectPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    detectPass.setPipeline(this.detectPipeline);
    detectPass.setBindGroup(0, detectBg);
    detectPass.draw(6);
    detectPass.end();

    ctx.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    this.maskTexture?.destroy();
    this._uniformView = null;
    this._uniformBuf = null;
  }
}
