// ============================================================================
// composite.ts — draws panel textures over the frame inside GameRenderer's
// end-of-frame surface pass. Sampling goes through an rgba8unorm-srgb view so
// supersampled docs resolve in LINEAR space, then re-encodes on write (the
// swapchain is gamma-space *8unorm). Premultiplied-alpha blend.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/engine";

const BLIT_WGSL = `
struct Uniforms {
  dstRect: vec4<f32>,     // x, y, w, h in surface px
  surfaceSize: vec2<f32>,
  pad: vec2<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var uiTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var corners = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let c = corners[vi];
  let px = u.dstRect.xy + c * u.dstRect.zw;
  let ndc = vec2(px.x / u.surfaceSize.x * 2.0 - 1.0,
                 1.0 - px.y / u.surfaceSize.y * 2.0);
  var o: VertexOutput;
  o.clipPos = vec4(ndc, 0.0, 1.0);
  o.uv = c;
  return o;
}

fn srgb_encode(l: f32) -> f32 {
  if (l <= 0.0031308) { return l * 12.92; }
  return 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let c = textureSample(uiTex, samp, input.uv); // -srgb view → linear premul
  return vec4<f32>(srgb_encode(c.r), srgb_encode(c.g), srgb_encode(c.b), c.a);
}
`;

/** A panel ready to draw — bindGroup + uniform state owned by the host. */
export interface CompositePanel {
  /** Persistent uniform buffer (dstRect + surfaceSize written per frame). */
  ubo: GPUBuffer;
  /** Bind group for this panel's texture (recreated on texture rebuild). */
  bindGroup: GPUBindGroup;
  rect: { x: number; y: number; w: number; h: number };
}

export class PanelBlitPass {
  private pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;

  constructor(private device: GPUDevice, format: GPUTextureFormat) {
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const shader = createValidatedShaderModule(device, { code: BLIT_WGSL, label: "PanelBlitPass" });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Allocate the per-panel uniform buffer (12 floats). */
  createUbo(): GPUBuffer {
    return this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Bind group for a panel texture — call when the texture is (re)created. */
  createBindGroup(texture: GPUTexture, ubo: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: texture.createView({ format: "rgba8unorm-srgb" }) },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  /** Draw `panels` (paint order = array order) into an open render pass. */
  render(pass: GPURenderPassEncoder, panels: CompositePanel[], surfaceW: number, surfaceH: number): void {
    pass.setPipeline(this.pipeline);
    const uni = new Float32Array(12);
    panels.forEach((p) => {
      uni.set([p.rect.x, p.rect.y, p.rect.w, p.rect.h, surfaceW, surfaceH]);
      this.device.queue.writeBuffer(p.ubo, 0, uni);
      pass.setBindGroup(0, p.bindGroup);
      pass.draw(6, 1, 0, 0);
    });
  }

  dispose(): void {}
}
