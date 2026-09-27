// ============================================================================
// NativeOsrTextureSource — GPUTexture sink for one Blitz OSR renderer
//
// Replaces Electron's OSRTextureReceiver (shared-texture + SAB + decompress
// worker pipeline) with a plain in-process pull: the bridge's `pullFrame`
// hands back a dirty RGBA8 buffer which is uploaded via queue.writeTexture.
// When the source also exposes `frameRect` only the changed region is copied
// and uploaded.
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "./types";

export interface NativeOsrFrameSource {
  pullFrame(rendererId: string): Uint8Array | null;
  /** Pixel-space dirty rect of the frame pullFrame just produced. */
  frameRect?(rendererId: string): { x: number; y: number; w: number; h: number } | null;
}

export class NativeOsrTextureSource {
  readonly rendererId: string;
  width: number;
  height: number;
  private device: GPUDevice;
  private texture: GPUTexture;
  private view: GPUTextureView;
  /** Reusable staging buffer for unaligned-strided partial uploads. */
  private scratch = new Uint8Array(0);

  constructor(device: GPUDevice, rendererId: string, width: number, height: number, _pixelFormat: OSRSharedTexturePixelFormat) {
    this.device = device;
    this.rendererId = rendererId;
    this.width = width;
    this.height = height;
    // Blitz rasterizes RGBA8; the Electron pixelFormat flag is ignored —
    // wgpu textures are always rgba8unorm here (no bgra swapchain semantics).
    this.texture = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
  }

  getTextureView(): GPUTextureView {
    return this.view;
  }

  /** Pull + upload a dirty frame. Returns true when new pixels were written. */
  update(source: NativeOsrFrameSource): boolean {
    const pixels = source.pullFrame(this.rendererId);
    if (!pixels || pixels.length === 0) return false;
    if (pixels.length !== this.width * this.height * 4) return false;
    const rect = source.frameRect?.(this.rendererId)
      ?? { x: 0, y: 0, w: this.width, h: this.height };
    const rowBytes = this.width * 4;
    if (rowBytes % 256 === 0) {
      // Frame rows already satisfy wgpu's 256-byte stride — upload the dirty
      // region straight out of the source buffer, no copies.
      this.device.queue.writeTexture(
        { texture: this.texture, origin: [rect.x, rect.y, 0] },
        pixels as unknown as GPUAllowSharedBufferSource,
        { offset: (rect.y * this.width + rect.x) * 4, bytesPerRow: rowBytes, rowsPerImage: rect.h },
        { width: rect.w, height: rect.h, depthOrArrayLayers: 1 },
      );
      return true;
    }
    // Unaligned stride — repack the dirty rows into a 256-aligned scratch.
    const stride = Math.ceil(rect.w * 4 / 256) * 256;
    const need = stride * rect.h;
    if (this.scratch.length < need) this.scratch = new Uint8Array(need);
    for (let r = 0; r < rect.h; r++) {
      const src = ((rect.y + r) * this.width + rect.x) * 4;
      this.scratch.set(pixels.subarray(src, src + rect.w * 4), r * stride);
    }
    this.device.queue.writeTexture(
      { texture: this.texture, origin: [rect.x, rect.y, 0] },
      this.scratch as unknown as GPUAllowSharedBufferSource,
      { bytesPerRow: stride, rowsPerImage: rect.h },
      { width: rect.w, height: rect.h, depthOrArrayLayers: 1 },
    );
    return true;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
