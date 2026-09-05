// ============================================================================
// MipmapHelper — generates mip levels for standalone GPUTextures.
//
// Used by the sandbox renderer for the ground paint texture and per-prop
// paint textures (which are not in the bindless registry). The bindless
// registry has its own generateMipmaps() for model textures.
//
// Uses a simple 2×2 box-filter downsample pipeline, run once per mip level.
// ============================================================================

const MIP_BLIT_SHADER = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcTex, 0));
  let uv = (pos.xy + 0.5) / dim;
  let texel = 1.0 / dim;
  let c00 = textureSample(srcTex, srcSampler, uv + vec2f(-0.5, -0.5) * texel);
  let c10 = textureSample(srcTex, srcSampler, uv + vec2f( 0.5, -0.5) * texel);
  let c01 = textureSample(srcTex, srcSampler, uv + vec2f(-0.5,  0.5) * texel);
  let c11 = textureSample(srcTex, srcSampler, uv + vec2f( 0.5,  0.5) * texel);
  return (c00 + c10 + c01 + c11) * 0.25;
}
`;

export class MipmapHelper {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensurePipeline(format: GPUTextureFormat): GPURenderPipeline | null {
    if (this.pipeline) return this.pipeline;
    if (format.startsWith("depth")) return null;
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const shader = this.device.createShaderModule({ label: "mip-blit", code: MIP_BLIT_SHADER });
    this.pipeline = this.device.createRenderPipeline({
      label: "mip-blit",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    return this.pipeline;
  }

  /** Compute the full mip chain count for a texture of the given dimensions. */
  static mipLevelCount(w: number, h: number): number {
    return Math.floor(Math.log2(Math.max(w, h))) + 1;
  }

  /**
   * Generate mip levels 1..N for a texture by successively downsampling
   * mip N-1 → mip N. The texture must have been created with mipLevelCount > 1
   * and RENDER_ATTACHMENT usage.
   */
  generateMipmaps(texture: GPUTexture, format: GPUTextureFormat, width: number, height: number): void {
    const pipeline = this.ensurePipeline(format);
    if (!pipeline || !this.bindGroupLayout || !this.sampler) return;
    const mipCount = texture.mipLevelCount;
    if (mipCount <= 1) return;

    const encoder = this.device.createCommandEncoder();
    for (let mip = 1; mip < mipCount; mip++) {
      const srcView = texture.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: mip, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.sampler },
        ],
      });
      const mw = Math.max(1, width >> mip);
      const mh = Math.max(1, height >> mip);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: dstView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.setViewport(0, 0, mw, mh, 0, 1);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.sampler = null;
  }
}
