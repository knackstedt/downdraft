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

const GLOW_BLUR_FS = /* wgsl */ `
struct GlowBlurUniforms {
  texelSizeX: f32,
  texelSizeY: f32,
  directionX: f32,
  directionY: f32,
  blurRadius: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: GlowBlurUniforms;
@group(0) @binding(1) var glowTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn glow_blur_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let offsets = array<f32, 5>(0.0, 1.3846154, 3.2307692, 5.176923, 7.1076923);
  let dir = vec2<f32>(u.directionX, u.directionY) * u.blurRadius;

  var color = textureSample(glowTex, texSampler, uv) * weights[0];
  for (var i = 1u; i < 5u; i = i + 1u) {
    let offset = dir * offsets[i];
    color += textureSample(glowTex, texSampler, uv + offset) * weights[i];
    color += textureSample(glowTex, texSampler, uv - offset) * weights[i];
  }
  return color;
}
`;

const GLOW_COMPOSITE_FS = /* wgsl */ `
struct GlowCompositeUniforms {
  intensity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: GlowCompositeUniforms;
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var glowTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn glow_composite_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let color = textureSample(colorTex, texSampler, uv).rgb;
  let glow = textureSample(glowTex, texSampler, uv).rgb;
  return vec4<f32>(color + glow * u.intensity, 1.0);
}
`;

const GLOW_RENDER_FS = /* wgsl */ `
struct GlowRenderUniforms {
  emissiveColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: GlowRenderUniforms;

@fragment
fn glow_render_fs() -> @location(0) vec4<f32> {
  return u.emissiveColor;
}
`;

export interface GlowSettings {
  intensity: number;
  blurRadius: number;
}

export const DEFAULT_GLOW_SETTINGS: GlowSettings = {
  intensity: 1.0,
  blurRadius: 4.0,
};

export interface GlowTarget {
  emissiveColor: [number, number, number, number];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  modelMatrix: Float32Array;
}

export class GlowPass extends RenderPass {
  name = "glow";
  passType = PassType.Custom;
  colorHandle: TextureHandle | null = null;
  outputHandle: TextureHandle | null = null;

  private device: GPUDevice;
  private settings: GlowSettings;
  private width = 0;
  private height = 0;
  private targets: GlowTarget[] = [];

  private blurPipeline: GPURenderPipeline | null = null;
  private compositePipeline: GPURenderPipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private blurUniformBuffer: GPUBuffer | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;
  private renderUniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  private glowTexture: GPUTexture | null = null;
  private glowView: GPUTextureView | null = null;
  private blurHTexture: GPUTexture | null = null;
  private blurHView: GPUTextureView | null = null;
  private blurVTexture: GPUTexture | null = null;
  private blurVView: GPUTextureView | null = null;


  constructor(device: GPUDevice, settings: Partial<GlowSettings> = {}) {
    super();
    this.device = device;
    this.settings = { ...DEFAULT_GLOW_SETTINGS, ...settings };
  }

  prepare(_device: GPUDevice): void {
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.blurUniformBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compositeUniformBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.renderUniformBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const vsModule = this.device.createShaderModule({ code: FULLSCREEN_VS });
    const blurFsModule = this.device.createShaderModule({ code: GLOW_BLUR_FS });
    const compositeFsModule = this.device.createShaderModule({ code: GLOW_COMPOSITE_FS });
    const renderFsModule = this.device.createShaderModule({ code: GLOW_RENDER_FS });

    this.blurPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: blurFsModule, entryPoint: "glow_blur_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });

    this.compositePipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: compositeFsModule, entryPoint: "glow_composite_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: `
struct GlowVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
};
@group(0) @binding(1) var<uniform> modelMatrix: mat4x4<f32>;
@vertex
fn glow_vs(@location(0) position: vec3<f32>) -> GlowVertexOutput {
  var output: GlowVertexOutput;
  output.clipPosition = modelMatrix * vec4<f32>(position, 1.0);
  return output;
}
` }),
        entryPoint: "glow_vs",
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
      },
      fragment: { module: renderFsModule, entryPoint: "glow_render_fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
  }

  setSettings(settings: Partial<GlowSettings>): void {
    Object.assign(this.settings, settings);
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  setTargets(targets: GlowTarget[]): void {
    this.targets = targets;
  }

  private ensureTextures(w: number, h: number): void {
    if (this.glowTexture && this.glowTexture.width === w && this.glowTexture.height === h) return;
    this.glowTexture?.destroy();
    this.blurHTexture?.destroy();
    this.blurVTexture?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.glowTexture = this.device.createTexture({ label: "glow-source", size: [w, h], format: "rgba16float", usage });
    this.glowView = this.glowTexture.createView();
    this.blurHTexture = this.device.createTexture({ label: "glow-blur-h", size: [w, h], format: "rgba16float", usage });
    this.blurHView = this.blurHTexture.createView();
    this.blurVTexture = this.device.createTexture({ label: "glow-blur-v", size: [w, h], format: "rgba16float", usage });
    this.blurVView = this.blurVTexture.createView();
  }

  private writeBlurUniforms(dirX: number, dirY: number): void {
    const data = new Float32Array(8);
    data[0] = this.width > 0 ? 1.0 / this.width : 0.0;
    data[1] = this.height > 0 ? 1.0 / this.height : 0.0;
    data[2] = dirX;
    data[3] = dirY;
    data[4] = this.settings.blurRadius;
    data[5] = 0; data[6] = 0; data[7] = 0;
    this.device.queue.writeBuffer(this.blurUniformBuffer!, 0, data as unknown as BufferSource);
  }

  private writeCompositeUniforms(): void {
    const data = new Float32Array(4);
    data[0] = this.settings.intensity;
    data[1] = 0; data[2] = 0; data[3] = 0;
    this.device.queue.writeBuffer(this.compositeUniformBuffer!, 0, data as unknown as BufferSource);
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

    if (!this.blurPipeline || !this.compositePipeline || !this.renderPipeline || !ctx.device) return;

    const renderUniformData = new Float32Array(4);
    // DEVIATION: This pass creates its own command encoder and submits directly
    // instead of using the frame graph's shared encoder. Glow uses multiple
    // internal render passes (render → blur H → blur V → composite) with
    // privately-owned intermediate textures; refactoring to the frame graph is
    // tracked as a future task.
    const encoder = ctx.device.createCommandEncoder();

    // Pass 1: Render emissive meshes to glow texture
    const glowPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.glowView!,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    glowPass.setPipeline(this.renderPipeline);
    for (const target of this.targets) {
      renderUniformData[0] = target.emissiveColor[0];
      renderUniformData[1] = target.emissiveColor[1];
      renderUniformData[2] = target.emissiveColor[2];
      renderUniformData[3] = target.emissiveColor[3];
      ctx.device.queue.writeBuffer(this.renderUniformBuffer!, 0, renderUniformData as unknown as BufferSource);
      const bg = ctx.device.createBindGroup({
        layout: this.renderPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.renderUniformBuffer! } },
          { binding: 1, resource: { buffer: this.renderUniformBuffer! } },
        ],
      });
      glowPass.setBindGroup(0, bg);
      glowPass.setVertexBuffer(0, target.vertexBuffer);
      glowPass.setIndexBuffer(target.indexBuffer, "uint16");
      glowPass.drawIndexed(target.indexCount);
    }
    glowPass.end();

    // Pass 2: Horizontal blur
    this.writeBlurUniforms(1.0, 0.0);
    const blurHBg = ctx.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.blurUniformBuffer! } },
        { binding: 1, resource: this.glowView! },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const blurHPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.blurHView!,
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
        { binding: 1, resource: this.blurHView! },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const blurVPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.blurVView!,
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
        { binding: 2, resource: this.blurVView! },
        { binding: 3, resource: this.sampler! },
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
    this.renderUniformBuffer?.destroy();
    this.glowTexture?.destroy();
    this.blurHTexture?.destroy();
    this.blurVTexture?.destroy();
  }
}
