// ============================================================================
// composite.ts — draws panel textures over the frame inside AppRenderer's
// end-of-frame surface pass. Panels sampled through an -srgb view resolve in
// LINEAR space and the shader re-encodes on write (the swapchain is
// gamma-space *8unorm); unorm views return already-encoded bytes and pass
// through (flags.x selects — required on STORAGE_BINDING textures, where
// wgpu rejects srgb view formats). Premultiplied-alpha blend.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/engine/render/shader-validator";

const BLIT_WGSL = `
struct Uniforms {
  dstRect: vec4<f32>,     // x, y, w, h in surface px
  srcUV: vec4<f32>,       // u0, v0, u1, v1 — texture subregion (GPU scroll)
  surfaceSize: vec2<f32>,
  flags: vec2<f32>,       // x: 1 = -srgb view (linear samples, re-encode); 0 = unorm view (encoded passthrough)
  modulate: vec4<f32>,    // premul color/alpha multiplier (caret tint+blink)
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
  o.uv = u.srcUV.xy + c * (u.srcUV.zw - u.srcUV.xy);
  return o;
}

fn srgb_encode(l: f32) -> f32 {
  if (l <= 0.0031308) { return l * 12.92; }
  return 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  var c = textureSample(uiTex, samp, input.uv);
  if (u.flags.x > 0.5) { // -srgb view → linear premul → re-encode
    c = vec4<f32>(srgb_encode(c.r), srgb_encode(c.g), srgb_encode(c.b), c.a);
  }
  return c * u.modulate;
}
`;

/** A panel ready to draw — bindGroup + uniform state owned by the host. */
export interface CompositePanel {
  /** Persistent uniform buffer (dstRect + surfaceSize written per frame). */
  ubo: GPUBuffer;
  /** Bind group for this panel's texture (recreated on texture rebuild). */
  bindGroup: GPUBindGroup;
  rect: { x: number; y: number; w: number; h: number };
  /** Normalized texture subregion [u0, v0, u1, v1] — defaults to [0,0,1,1].
   *  Lets a panel display a window into a taller texture (scroll views that
   *  scroll without a doc repaint). */
  src?: [number, number, number, number];
  /** Premultiplied color/alpha multiplier — defaults to [1,1,1,1]. Overlay
   *  quads (the animated caret) drive color + blink alpha through this. */
  modulate?: [number, number, number, number];
  /** True when bindGroup's texture view is an -srgb reinterpret — samples
   *  decode to linear so the shader re-encodes on write. Leave unset for
   *  unorm views — required on STORAGE_BINDING textures, where wgpu
   *  rejects srgb view formats outright. */
  srgbView?: boolean;
}

export class PanelBlitPass {
  private pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;

  constructor(private device: GPUDevice, format: GPUTextureFormat) {
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
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

  /** Allocate the per-panel uniform buffer (16 floats). */
  createUbo(): GPUBuffer {
    return this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Bind group for a panel texture — call when the texture is (re)created.
   *  `format` is the view format; defaults to rgba8unorm-srgb (Blitz docs).
   *  Browser-backed panels pass bgra8unorm-srgb for BGRA sources — srgb
   *  reinterprets of rgba8unorm/bgra8unorm are both legal, EXCEPT on
   *  STORAGE_BINDING textures where wgpu rejects srgb views outright:
   *  those must pass the unorm base format (and draw with srgbView unset —
   *  the stored bytes are already display-encoded). */
  createBindGroup(texture: GPUTexture, ubo: GPUBuffer, format: GPUTextureFormat = "rgba8unorm-srgb"): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: texture.createView({ format }) },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  /** Draw `panels` (paint order = array order) into an open render pass. */
  render(pass: GPURenderPassEncoder, panels: CompositePanel[], surfaceW: number, surfaceH: number): void {
    pass.setPipeline(this.pipeline);
    const uni = new Float32Array(16);
    panels.forEach((p) => {
      const s = p.src;
      const m = p.modulate;
      uni.set([p.rect.x, p.rect.y, p.rect.w, p.rect.h,
        s?.[0] ?? 0, s?.[1] ?? 0, s?.[2] ?? 1, s?.[3] ?? 1,
        surfaceW, surfaceH, p.srgbView ? 1 : 0, 0,
        m?.[0] ?? 1, m?.[1] ?? 1, m?.[2] ?? 1, m?.[3] ?? 1]);
      this.device.queue.writeBuffer(p.ubo, 0, uni);
      pass.setBindGroup(0, p.bindGroup);
      pass.draw(6, 1, 0, 0);
    });
  }

  dispose(): void {}
}
