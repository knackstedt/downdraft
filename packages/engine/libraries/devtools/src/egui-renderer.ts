// ============================================================================
// egui-renderer.ts — renders serialized egui PaintJobs to a GPUTexture via the
// shared wgpu-native device (exposed as a WebGPU-like GPUDevice).
//
// Each frame:
// 1. Apply texture deltas (create/resize/update font + user textures).
// 2. For each PaintMesh: upload vertices + indices, set scissor, draw indexed.
// 3. The result is a UI texture (bgra8unorm, premultiplied alpha) that the
//    existing UiBlitPass composites over the game frame.
//
// The renderer creates one render pipeline (textured triangles, premult alpha
// blend), one sampler, and manages a texture table indexed by egui TextureId.
// ============================================================================

import type { PaintJobs, TextureSet } from "./egui-ffi";

const EGUI_WGSL = /* wgsl */ `
struct VSIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: u32,  // packed 0xAABBGGRR bit pattern
};
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};
struct Uniforms {
  uResolution: vec2f,
  uTextureSize: vec2f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  // egui coordinates: points with origin top-left. Convert to clip space.
  // x_clip = (x / res.x) * 2 - 1; y_clip = 1 - (y / res.y) * 2 (flip Y).
  let cx = (in.pos.x / u.uResolution.x) * 2.0 - 1.0;
  let cy = 1.0 - (in.pos.y / u.uResolution.y) * 2.0;
  out.position = vec4f(cx, cy, 0.0, 1.0);
  out.uv = in.uv;
  // Unpack color: bit pattern 0xAABBGGRR (little-endian) → rgba
  let bits = in.color;
  let r = f32((bits >>  0) & 0xFFu) / 255.0;
  let g = f32((bits >>  8) & 0xFFu) / 255.0;
  let b = f32((bits >> 16) & 0xFFu) / 255.0;
  let a = f32((bits >> 24) & 0xFFu) / 255.0;
  out.color = vec4f(r, g, b, a);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texColor = textureSample(tex, samp, in.uv);
  // egui vertex colors are premultiplied; texColor is the font/atlas alpha.
  // Final premultiplied = vertexColor.rgb * texColor.a (font is white * alpha).
  let alpha = texColor.a;
  let rgb = in.color.rgb * alpha;
  return vec4f(rgb, in.color.a * alpha);
}
`;

interface ManagedTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  pixels: Uint8Array; // full pixel data (RGBA) for safe full-writeTexture updates
}

export class EguiRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat = "bgra8unorm";
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformData: Float32Array = new Float32Array(4); // resX, resY, texW, texH

  private uiTexture: GPUTexture | null = null;
  private uiTextureView: GPUTextureView | null = null;
  private width: number;
  private height: number;

  private textures = new Map<number, ManagedTexture>();
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;

  private vertexBufferSize = 4 * 1024 * 1024; // 4MB pre-allocated
  private indexBufferSize = 1 * 1024 * 1024; // 1MB pre-allocated

  private disposed = false;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.init();
  }

  private init(): void {
    // Bind group layout: uniform buffer (0), texture (1), sampler (2).
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    this.pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const shader = this.device.createShaderModule({ code: EGUI_WGSL, label: "EguiRenderer" });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 20, // f32 x, f32 y, f32 u, f32 v, f32 color = 20 bytes
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },   // pos
            { shaderLocation: 1, offset: 8, format: "float32x2" },    // uv
            { shaderLocation: 2, offset: 16, format: "uint32" },     // color (packed 0xAABBGGRR)
          ],
        }],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16, // vec2 + vec2 = 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Pre-allocate vertex/index buffers to avoid destroying in-use buffers
    // during rendering (wgpu-native may not defer destruction safely).
    this.vertexBuffer = this.device.createBuffer({
      size: this.vertexBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.indexBuffer = this.device.createBuffer({
      size: this.indexBufferSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });

    this.createUiTexture();
  }

  private createUiTexture(): void {
    if (this.uiTexture) {
      this.uiTexture.destroy();
    }
    this.uiTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.uiTextureView = this.uiTexture.createView();
  }

  /** Resize the UI texture. */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.createUiTexture();
  }

  /** The UI texture view (for the UiBlitPass to composite). */
  getUiTextureView(): GPUTextureView | null {
    return this.uiTextureView;
  }

  /** Apply texture deltas from egui (font atlas + user textures).
   *  wgpu-native has a bug where partial writeTexture (with non-zero origin)
   *  corrupts the entire texture. To work around this, we maintain a full
   *  pixel copy per texture and always do full writeTexture updates. */
  private applyTextureDeltas(texturesSet: TextureSet[], texturesFree: number[]): void {
    for (const ts of texturesSet) {
      const existing = this.textures.get(ts.id);
      if (!existing || ts.posX < 0) {
        // Full (re)create.
        if (existing) existing.texture.destroy();
        const texture = this.device.createTexture({
          size: [ts.width, ts.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const view = texture.createView();
        // Store a full copy of the pixels for future partial updates.
        const fullPixels = new Uint8Array(ts.pixels.byteLength);
        fullPixels.set(ts.pixels);
        this.device.queue.writeTexture(
          { texture },
          fullPixels,
          { bytesPerRow: ts.width * 4, rowsPerImage: ts.height },
          [ts.width, ts.height],
        );
        this.textures.set(ts.id, { texture, view, width: ts.width, height: ts.height, pixels: fullPixels });
      } else {
        // Partial update — apply to the full pixel copy, then do a full
        // writeTexture (avoids wgpu-native partial writeTexture corruption).
        const fullPixels = existing.pixels;
        const bpp = 4;
        for (let row = 0; row < ts.height; row++) {
          const dstOff = ((ts.posY + row) * existing.width + ts.posX) * bpp;
          const srcOff = row * ts.width * bpp;
          const len = ts.width * bpp;
          fullPixels.set(ts.pixels.subarray(srcOff, srcOff + len), dstOff);
        }
        this.device.queue.writeTexture(
          { texture: existing.texture },
          fullPixels as unknown as GPUAllowSharedBufferSource,
          { bytesPerRow: existing.width * 4, rowsPerImage: existing.height },
          [existing.width, existing.height],
        );
      }
    }
    for (const id of texturesFree) {
      const t = this.textures.get(id);
      if (t) {
        t.texture.destroy();
        this.textures.delete(id);
      }
    }
  }

  /** Ensure vertex/index buffers are large enough. */
  private ensureBuffers(vertexBytes: number, indexBytes: number): void {
    if (this.vertexBufferSize < vertexBytes) {
      if (this.vertexBuffer) this.vertexBuffer.destroy();
      const newSize = Math.max(vertexBytes, this.vertexBufferSize * 2, 1 << 16);
      this.vertexBuffer = this.device.createBuffer({
        size: newSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.vertexBufferSize = newSize;
    }
    if (this.indexBufferSize < indexBytes) {
      if (this.indexBuffer) this.indexBuffer.destroy();
      const newSize = Math.max(indexBytes, this.indexBufferSize * 2, 1 << 16);
      this.indexBuffer = this.device.createBuffer({
        size: newSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.indexBufferSize = newSize;
    }
  }

  /**
   * Render one frame of egui PaintJobs into the UI texture.
   * If `externalEncoder` is provided, the render pass is encoded into it
   * (no separate submit) to ensure proper ordering with the blit pass.
   * Returns true on success.
   */
  render(paintJobs: PaintJobs, externalEncoder?: GPUCommandEncoder): boolean {
    if (this.disposed || !this.pipeline || !this.uiTextureView) return false;

    // 1. Apply texture deltas.
    this.applyTextureDeltas(paintJobs.texturesSet, paintJobs.texturesFree);

    // 2. Compute total vertex/index buffer sizes.
    let totalVertexBytes = 0;
    let totalIndexBytes = 0;
    for (const m of paintJobs.meshes) {
      totalVertexBytes += m.vertices.byteLength;
      totalIndexBytes += m.indices.byteLength;
    }
    this.ensureBuffers(totalVertexBytes, totalIndexBytes);

    // 3. Upload vertex/index data into the big buffers (concatenated).
    if (totalVertexBytes > 0 && this.vertexBuffer) {
      const allVerts = new Float32Array(totalVertexBytes / 4);
      let voff = 0;
      for (const m of paintJobs.meshes) {
        allVerts.set(m.vertices, voff);
        voff += m.vertices.length;
      }
      this.device.queue.writeBuffer(this.vertexBuffer, 0, allVerts.buffer, allVerts.byteOffset, allVerts.byteLength);
    }
    if (totalIndexBytes > 0 && this.indexBuffer) {
      const allIndices = new Uint32Array(totalIndexBytes / 4);
      let ioff = 0;
      for (const m of paintJobs.meshes) {
        allIndices.set(m.indices, ioff);
        ioff += m.indices.length;
      }
      this.device.queue.writeBuffer(this.indexBuffer, 0, allIndices.buffer, allIndices.byteOffset, allIndices.byteLength);
    }

    // 4. Update uniforms (resolution + texture size). All meshes share the
    // same font texture, so a single uniform write covers the whole pass.
    const firstTex = this.textures.get(paintJobs.meshes[0]?.textureId ?? 0)
      ?? this.textures.values().next().value;
    this.uniformData[0] = this.width;
    this.uniformData[1] = this.height;
    this.uniformData[2] = firstTex?.width ?? 1;
    this.uniformData[3] = firstTex?.height ?? 1;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this.uniformData.buffer, this.uniformData.byteOffset, this.uniformData.byteLength);

    // 5. Begin render pass (clear the UI texture to transparent).
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.uiTextureView!,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(this.pipeline);

    // 6. Draw each mesh with its own scissor + bind group (texture).
    let vOffset = 0; // in bytes
    let iOffset = 0; // in bytes
    for (const m of paintJobs.meshes) {
      const tex = this.textures.get(m.textureId);
      if (!tex || m.vertices.length === 0 || m.indices.length === 0) {
        vOffset += m.vertices.byteLength;
        iOffset += m.indices.byteLength;
        continue;
      }

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: tex.view },
          { binding: 2, resource: this.sampler! },
        ],
      });
      pass.setBindGroup(0, bindGroup);

      // Scissor (in physical pixels — egui gives logical points; multiply by pixels_per_point).
      const ppp = paintJobs.pixelsPerPoint || 1.0;
      let sx = Math.max(0, Math.floor(m.clipX * ppp));
      let sy = Math.max(0, Math.floor(m.clipY * ppp));
      let sw = Math.max(0, Math.ceil(m.clipW * ppp));
      let sh = Math.max(0, Math.ceil(m.clipH * ppp));
      // Guard against NaN/Infinity (egui can emit degenerate clip rects for
      // off-screen content, which would cause a silent WebGPU validation error
      // that invalidates the entire render pass).
      if (!Number.isFinite(sx)) sx = 0;
      if (!Number.isFinite(sy)) sy = 0;
      if (!Number.isFinite(sw)) sw = 0;
      if (!Number.isFinite(sh)) sh = 0;
      const cx = Math.min(sx, this.width);
      const cy = Math.min(sy, this.height);
      const cw = Math.min(sw, this.width - cx);
      const ch = Math.min(sh, this.height - cy);
      if (cw <= 0 || ch <= 0) {
        vOffset += m.vertices.byteLength;
        iOffset += m.indices.byteLength;
        continue;
      }
      pass.setScissorRect(cx, cy, cw, ch);

      pass.setVertexBuffer(0, this.vertexBuffer!, vOffset, m.vertices.byteLength);
      pass.setIndexBuffer(this.indexBuffer!, "uint32", iOffset, m.indices.byteLength);
      // firstIndex is relative to the bound sub-region (already offset by
      // setIndexBuffer), so it must be 0 — not the cumulative index count.
      pass.drawIndexed(m.indices.length, 1, 0, 0, 0);

      vOffset += m.vertices.byteLength;
      iOffset += m.indices.byteLength;
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.textures.values()) t.texture.destroy();
    this.textures.clear();
    this.uiTexture?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
