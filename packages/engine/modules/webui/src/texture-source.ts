// ============================================================================
// WebUiTextureSource — GPUTexture sink for one dd_webui_* view
//
// Same pull pipeline as NativeOsrTextureSource: the bridge's pullFrame
// hands back a dirty pixel buffer which is uploaded via queue.writeTexture,
// partial-uploading just the dirty union when frameRect reports one.
//
// The difference: browsers produce BGRA8 natively, so the texture format
// comes from the view's pixelFormat() instead of hardcoding rgba8unorm —
// bgra8unorm is a first-class wgpu texture format (sampling swizzles to
// RGBA automatically) and avoids a per-frame CPU byte-swap.
// ============================================================================

import type { WebUiHostBridge, WebUiPixelFormat } from "@downdraft/engine/libraries/webui/types";

const FORMAT: Record<WebUiPixelFormat, GPUTextureFormat> = {
  rgba: "rgba8unorm",
  bgra: "bgra8unorm",
};

export class WebUiTextureSource {
  readonly viewId: string;
  /** Physical px (device pixels the browser rasterizes at). */
  width: number;
  height: number;
  private device: GPUDevice;
  private texture: GPUTexture;
  private view: GPUTextureView;
  private format: WebUiPixelFormat;
  /** Reusable staging buffer for unaligned-strided partial uploads. */
  private scratch = new Uint8Array(0);

  constructor(device: GPUDevice, viewId: string, width: number, height: number, pixelFormat: WebUiPixelFormat = "bgra") {
    this.device = device;
    this.viewId = viewId;
    this.format = pixelFormat;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.texture = this.makeTexture();
    this.view = this.texture.createView();
  }

  private makeTexture(): GPUTexture {
    return this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: FORMAT[this.format],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  getTextureView(): GPUTextureView {
    return this.view;
  }

  /** The backing texture — compositor bind groups need the texture
   *  (a GPUTextureView doesn't expose its source texture). */
  getTexture(): GPUTexture {
    return this.texture;
  }

  /** View format for compositor bind groups — srgb reinterpret of the
   *  texture (browsers output srgb pixels; html-ui compositors treat panel
   *  textures the same way). */
  get srgbFormat(): GPUTextureFormat {
    return this.format === "bgra" ? "bgra8unorm-srgb" : "rgba8unorm-srgb";
  }

  /** Recreate the texture at a new physical size (view resize). */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.texture.destroy();
    this.texture = this.makeTexture();
    this.view = this.texture.createView();
    return true;
  }

  /** Pull + upload a dirty frame.
   *  Returns 0 = nothing new, 1 = pixels written, 2 = pixels written AND the
   *  texture was recreated (callers must refresh bind groups). */
  update(bridge: WebUiHostBridge): 0 | 1 | 2 {
    const pixels = bridge.pullFrame(this.viewId);
    if (!pixels || pixels.length === 0) return 0;
    let recreated = false;
    // A resize can land between pulls — the frame dims are authoritative.
    if (pixels.length !== this.width * this.height * 4) {
      const d = bridge.getDimensions(this.viewId);
      if (d && d.w * d.h * 4 === pixels.length) {
        this.resize(d.w, d.h);
        recreated = true;
      } else {
        return 0;
      }
    }
    const rect = bridge.frameRect(this.viewId)
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
      return recreated ? 2 : 1;
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
    return recreated ? 2 : 1;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
