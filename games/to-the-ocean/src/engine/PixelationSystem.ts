// ============================================================================
// Pixelation System — low-res render target + depth edge detection postprocess
// Based on the Three.js webgpu_postprocessing_pixel example:
//   - Renders the scene at reduced resolution (canvas / pixelSize)
//   - Nearest-neighbor upscaling gives the blocky pixel look
//   - Depth edge detection darkens edges where depth discontinuities occur
// ============================================================================

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

import { DEPTH_FORMAT } from "./graphicsConfig";

const PIXELATION_WGSL = /* wgsl */ `
struct PostProcessUniforms {
  texelSize: vec2<f32>,
  depthEdgeStrength: f32,
  normalEdgeStrength: f32,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> uniforms: PostProcessUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.clipPos = vec4(p[vi], 0.0, 1.0);
  output.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(colorTex, samp, input.uv);
  let depth = textureSample(depthTex, samp, input.uv);

  // Depth edge detection — sample 4 neighbours
  let depthR = textureSample(depthTex, samp, input.uv + vec2(uniforms.texelSize.x, 0.0));
  let depthL = textureSample(depthTex, samp, input.uv - vec2(uniforms.texelSize.x, 0.0));
  let depthU = textureSample(depthTex, samp, input.uv + vec2(0.0, uniforms.texelSize.y));
  let depthD = textureSample(depthTex, samp, input.uv - vec2(0.0, uniforms.texelSize.y));

  var diff = 0.0;
  diff += clamp(depthR - depth, 0.0, 1.0);
  diff += clamp(depthL - depth, 0.0, 1.0);
  diff += clamp(depthU - depth, 0.0, 1.0);
  diff += clamp(depthD - depth, 0.0, 1.0);

  let dei = floor(smoothstep(0.01, 0.02, diff) * 2.0) / 2.0;

  let strength = select(1.0, 1.0 - dei * uniforms.depthEdgeStrength, dei > 0.0);

  return vec4(texel.rgb * strength, texel.a);
}
`;

export class PixelationSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private offscreenColor: GPUTexture | null = null;
  private offscreenDepth: GPUTexture | null = null;
  private lowResWidth = 0;
  private lowResHeight = 0;

  private pixelSize = 6;
  private depthEdgeStrength = 0.4;
  private normalEdgeStrength = 0.3;
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shaderModule = this.device.createShaderModule({ code: PIXELATION_WGSL });

    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setPixelSize(size: number): void {
    this.pixelSize = Math.max(1, Math.floor(size));
  }

  setDepthEdgeStrength(s: number): void {
    this.depthEdgeStrength = s;
  }

  setNormalEdgeStrength(s: number): void {
    this.normalEdgeStrength = s;
  }

  getPixelSize(): number {
    return this.pixelSize;
  }

  ensureTargets(canvasWidth: number, canvasHeight: number): void {
    const w = Math.max(1, Math.floor(canvasWidth / this.pixelSize));
    const h = Math.max(1, Math.floor(canvasHeight / this.pixelSize));

    if (w === this.lowResWidth && h === this.lowResHeight && this.offscreenColor && this.offscreenDepth) {
      return;
    }

    this.offscreenColor?.destroy();
    this.offscreenDepth?.destroy();

    this.offscreenColor = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.offscreenDepth = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.lowResWidth = w;
    this.lowResHeight = h;

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: this.offscreenColor.createView() },
        { binding: 1, resource: this.offscreenDepth.createView() },
        { binding: 2, resource: this.sampler! },
        { binding: 3, resource: { buffer: this.uniformBuffer! } },
      ],
    });
  }

  getOffscreenColorView(): GPUTextureView {
    if (!this.offscreenColor) throw new Error("Offscreen color texture not created");
    return this.offscreenColor.createView();
  }

  getOffscreenDepthView(): GPUTextureView {
    if (!this.offscreenDepth) throw new Error("Offscreen depth texture not created");
    return this.offscreenDepth.createView();
  }

  scaleViewport(vp: ViewportRect): ViewportRect {
    return {
      x: Math.floor(vp.x / this.pixelSize),
      y: Math.floor(vp.y / this.pixelSize),
      w: Math.floor(vp.w / this.pixelSize),
      h: Math.floor(vp.h / this.pixelSize),
    };
  }

  applyPostprocess(
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    canvasWidth: number,
    canvasHeight: number,
  ): void {
    const uniforms = new Float32Array(4);
    uniforms[0] = 1.0 / this.lowResWidth;
    uniforms[1] = 1.0 / this.lowResHeight;
    uniforms[2] = this.depthEdgeStrength;
    uniforms[3] = this.normalEdgeStrength;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniforms);

    const passEncoder = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
    });

    passEncoder.setViewport(0, 0, canvasWidth, canvasHeight, 0, 1);
    passEncoder.setScissorRect(0, 0, canvasWidth, canvasHeight);
    passEncoder.setPipeline(this.pipeline!);
    passEncoder.setBindGroup(0, this.bindGroup!);
    passEncoder.draw(3);

    passEncoder.end();
  }

  destroy(): void {
    this.offscreenColor?.destroy();
    this.offscreenDepth?.destroy();
    this.offscreenColor = null;
    this.offscreenDepth = null;
    this.uniformBuffer?.destroy();
  }
}
