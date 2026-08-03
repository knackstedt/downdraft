// ============================================================================
// OSR Texture Receiver — Receives shared GPU textures from Electron OSR
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "../types.ts";

export class OSRTextureReceiver {
  readonly rendererId: string;
  private device: GPUDevice;
  width = 0;
  height = 0;
  private pixelFormat: OSRSharedTexturePixelFormat;
  private gpuTexture: GPUTexture | null = null;
  private gpuTextureView: GPUTextureView | null = null;
  private previousTexture: GPUTexture | null = null;
  private previousTextureView: GPUTextureView | null = null;
  private receiverRegistered = false;

  constructor(device: GPUDevice, rendererId: string, width: number, height: number, pixelFormat: OSRSharedTexturePixelFormat) {
    this.device = device;
    this.rendererId = rendererId;
    this.width = width;
    this.height = height;
    this.pixelFormat = pixelFormat;
  }

  init(): void {
    this.createGpuTexture();
    this.registerReceiver();
  }

  private get gpuFormat(): GPUTextureFormat {
    return this.pixelFormat === "bgra" ? "bgra8unorm" : "rgba8unorm";
  }

  private createGpuTexture(): void {
    this.previousTexture = this.gpuTexture;
    this.previousTextureView = this.gpuTextureView;

    this.gpuTexture = this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: this.gpuFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.gpuTextureView = this.gpuTexture.createView();

    // Destroy previous texture after creating new one (double-buffering)
    if (this.previousTexture) {
      // Keep previous alive until next frame to prevent tearing
      // It will be destroyed on the next createGpuTexture call
    }
  }

  private registerReceiver(): void {
    const downdraft = (window as any).downdraft;
    let registered = false;

    // Try shared texture receiver first (GPU zero-copy path)
    if (downdraft?.osr?.registerSharedTextureReceiver) {
      registered = downdraft.osr.registerSharedTextureReceiver((videoFrame: any) => {
        console.log(`[OSR] VideoFrame received for '${this.rendererId}': ${videoFrame.codedWidth}x${videoFrame.codedHeight}`);
        try {
          const codedWidth = videoFrame.codedWidth;
          const codedHeight = videoFrame.codedHeight;
          if (codedWidth !== this.width || codedHeight !== this.height) {
            this.width = codedWidth;
            this.height = codedHeight;
            this.createGpuTexture();
          }
          this.device.queue.copyExternalImageToTexture(
            { source: videoFrame },
            { texture: this.gpuTexture! },
            { width: this.width, height: this.height },
          );
        } catch (err) {
          console.error(`[OSR] Texture copy failed for '${this.rendererId}':`, err);
        } finally {
          videoFrame.close();
        }
      });
    }

    // Also register NativeImage paint fallback (CPU path)
    if (downdraft?.osr?.onPaintImage) {
      downdraft.osr.onPaintImage(async (rendererId: string, image: any) => {
        if (rendererId !== this.rendererId) return;
        try {
          // NativeImage from Electron IPC — convert via data URL → Blob → ImageBitmap
          const dataUrl = image.toDataURL();
          const blob = await (await fetch(dataUrl)).blob();
          const bitmap = await createImageBitmap(blob);
          const w = bitmap.width;
          const h = bitmap.height;
          if (w !== this.width || h !== this.height) {
            this.width = w;
            this.height = h;
            this.createGpuTexture();
          }
          this.device.queue.copyExternalImageToTexture(
            { source: bitmap, flipY: true },
            { texture: this.gpuTexture! },
            { width: this.width, height: this.height },
          );
          bitmap.close();
        } catch (err) {
          console.error(`[OSR] NativeImage copy failed for '${this.rendererId}':`, err);
        }
      });
      registered = true;
    }

    this.receiverRegistered = registered;
    if (!registered) {
      console.warn(`[OSR] No texture receiver available for '${this.rendererId}'`);
    }
  }

  getTextureView(): GPUTextureView | null {
    return this.gpuTextureView;
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  destroy(): void {
    if (this.previousTexture) {
      this.previousTexture.destroy();
      this.previousTexture = null;
      this.previousTextureView = null;
    }
    if (this.gpuTexture) {
      this.gpuTexture.destroy();
      this.gpuTexture = null;
      this.gpuTextureView = null;
    }
    this.receiverRegistered = false;
  }
}
