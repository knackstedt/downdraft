import type { RenderBackend } from "../backend/render-backend.ts";
import { wgslShader } from "../backend/shader-source.ts";
import type { BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, BackendSampler, BackendTexture, BackendTextureView } from "../backend/types.ts";
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

const OUTLINE_DETECT_FS = /* wgsl */ `
struct OutlineUniforms {
  texelSizeX: f32,
  texelSizeY: f32,
  outlineWidth: f32,
  opacity: f32,
  outlineColor: vec3<f32>,
  _pad0: f32,
};

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
  vertexBuffer: GPUBuffer | BackendBuffer;
  indexBuffer: GPUBuffer | BackendBuffer;
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

  private maskTexture: GPUTexture | null = null;
  private maskView: GPUTextureView | null = null;

  private _backend: RenderBackend | null = null;
  private _bgDetectPipeline: BackendRenderPipeline | null = null;
  private _bgMaskPipeline: BackendRenderPipeline | null = null;
  private _bgUniformBuffer: BackendBuffer | null = null;
  private _bgMaskUniformBuffer: BackendBuffer | null = null;
  private _bgSampler: BackendSampler | null = null;
  private _bgLayout: BackendBindGroupLayout | null = null;
  private _bgMaskLayout: BackendBindGroupLayout | null = null;
  private _bgMaskTexture: BackendTexture | null = null;
  private _bgMaskView: BackendTextureView | null = null;

  constructor(device: GPUDevice, settings: Partial<OutlineSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_OUTLINE_SETTINGS, ...settings };
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

  private prepareBackend(backend: RenderBackend): void {
    this._backend = backend;
    this._bgSampler = backend.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this._bgUniformBuffer = backend.createBuffer({ label: "outline-uniforms", size: 32, usage: 0x40 | 0x08 });
    this._bgMaskUniformBuffer = backend.createBuffer({ label: "outline-mask-uniforms", size: 16, usage: 0x40 | 0x08 });
    this._bgLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this._bgMaskLayout = backend.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    const vsModule = backend.createShaderModule(wgslShader(FULLSCREEN_VS, "fullscreen-vs"), "wgsl");
    const detectFsModule = backend.createShaderModule(wgslShader(OUTLINE_DETECT_FS, "outline-detect-fs"), "wgsl");
    const maskFsModule = backend.createShaderModule(wgslShader(OUTLINE_MASK_FS, "outline-mask-fs"), "wgsl");

    const detectLayout = backend.createPipelineLayout({ label: "outline-detect-layout", bindGroupLayouts: [this._bgLayout] });
    this._bgDetectPipeline = backend.createRenderPipeline({
      label: "outline-detect-pipeline",
      layout: detectLayout,
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: detectFsModule, entryPoint: "outline_detect_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });

    const maskVsModule = backend.createShaderModule(wgslShader(`
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
`, "outline-mask-vs"), "wgsl");

    const maskLayout = backend.createPipelineLayout({ label: "outline-mask-layout", bindGroupLayouts: [this._bgMaskLayout] });
    this._bgMaskPipeline = backend.createRenderPipeline({
      label: "outline-mask-pipeline",
      layout: maskLayout,
      vertex: {
        module: maskVsModule,
        entryPoint: "mask_vs",
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
      },
      fragment: { module: maskFsModule, entryPoint: "outline_mask_fs", targets: [{ format: "r16float" }] },
      primitive: { topology: "triangle-list", cullMode: "front" },
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
    if (this._backend) {
      if (this._bgMaskTexture) return;
      this._bgMaskTexture = this._backend.createTexture({
        label: "outline-mask",
        format: "r16float",
        usage: 0x10 | 0x02 | 0x04,
        width: w,
        height: h,
      });
      this._bgMaskView = this._backend.createTextureView(this._bgMaskTexture);
    } else {
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
  }

  private writeUniforms(): void {
    const data = new Float32Array(8);
    data[0] = this.width > 0 ? 1.0 / this.width : 0.0;
    data[1] = this.height > 0 ? 1.0 / this.height : 0.0;
    data[2] = this.settings.outlineWidth;
    data[3] = this.settings.opacity;
    data[4] = this.settings.outlineColor[0];
    data[5] = this.settings.outlineColor[1];
    data[6] = this.settings.outlineColor[2];
    data[7] = 0.0;
    if (this._backend && this._bgUniformBuffer) {
      this._backend.queue.writeBuffer(this._bgUniformBuffer, 0, data as unknown as BufferSource);
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as BufferSource);
    }
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

    if (ctx.backend && this._bgDetectPipeline) {
      this.executeBackend(ctx);
      return;
    }
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
      maskPass.setVertexBuffer(0, target.vertexBuffer as GPUBuffer);
      maskPass.setIndexBuffer(target.indexBuffer as GPUBuffer, "uint16");
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

  private executeBackend(ctx: GraphRenderContext): void {
    const backend = ctx.backend!;
    const maskUniformData = new Float32Array(4);
    const encoder = backend.createCommandEncoder();

    // Pass 1: Render mask
    const maskPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._bgMaskView!,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    maskPass.setPipeline(this._bgMaskPipeline!);

    for (const target of this.targets) {
      maskUniformData[0] = target.color[0];
      maskUniformData[1] = target.color[1];
      maskUniformData[2] = target.color[2];
      maskUniformData[3] = target.color[3];
      backend.queue.writeBuffer(this._bgMaskUniformBuffer!, 0, maskUniformData as unknown as BufferSource);

      const maskBg = backend.createBindGroup({
        layout: this._bgMaskLayout!,
        entries: [{ binding: 0, resource: { buffer: this._bgMaskUniformBuffer! } }],
      });
      maskPass.setBindGroup(0, maskBg);
      maskPass.setVertexBuffer(0, target.vertexBuffer as BackendBuffer);
      maskPass.setIndexBuffer(target.indexBuffer as BackendBuffer, "uint16");
      maskPass.drawIndexed(target.indexCount);
    }
    maskPass.end();

    // Pass 2: Edge detection + composite
    const outputView = ctx.getBackendView(this.outputHandle!);
    const detectBg = backend.createBindGroup({
      layout: this._bgLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._bgUniformBuffer! } },
        { binding: 1, resource: { textureView: this._bgMaskView! } },
        { binding: 2, resource: { sampler: this._bgSampler! } },
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
    detectPass.setPipeline(this._bgDetectPipeline!);
    detectPass.setBindGroup(0, detectBg);
    detectPass.draw(6);
    detectPass.end();

    backend.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    this.maskTexture?.destroy();
  }
}
