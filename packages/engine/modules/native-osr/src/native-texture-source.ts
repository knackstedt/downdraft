// ============================================================================
// NativeOsrTextureSource — GPUTexture sink for one Blitz OSR renderer
//
// Replaces Electron's OSRTextureReceiver (shared-texture + SAB + decompress
// worker pipeline) with a plain in-process pull: the bridge's `pullFrame`
// hands back a dirty RGBA8 buffer which is uploaded via queue.writeTexture.
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "./types";

export interface NativeOsrFrameSource {
  pullFrame(rendererId: string): Uint8Array | null;
}

export class NativeOsrTextureSource {
  readonly rendererId: string;
  width: number;
  height: number;
  private device: GPUDevice;
  private texture: GPUTexture;
  private view: GPUTextureView;

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
    this.device.queue.writeTexture(
      { texture: this.texture },
      pixels as unknown as GPUAllowSharedBufferSource,
      { bytesPerRow: this.width * 4, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
    return true;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
