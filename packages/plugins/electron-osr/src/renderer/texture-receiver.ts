// ============================================================================
// OSR Texture Receiver — Receives shared GPU textures from Electron OSR
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "../types.ts";

export class OSRTextureReceiver {
  readonly rendererId: string;
  private device: GPUDevice;
  private width: number;
  private height: number;
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
    // Access the Electron sharedTexture API from the renderer process
    const sharedTexture = (window as any).__electronSharedTexture;
    if (!sharedTexture) {
      console.warn(`[OSR] sharedTexture API not available for receiver '${this.rendererId}'`);
      return;
    }

    this.receiverRegistered = true;
    sharedTexture.setSharedTextureReceiver(async (receivedData: any, ..._args: any[]) => {
      const imported = receivedData.importedSharedTexture;
      try {
        const videoFrame = imported.subtle.getVideoFrame();
        const codedWidth = videoFrame.codedWidth;
        const codedHeight = videoFrame.codedHeight;

        // Resize texture if dimensions changed
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

        videoFrame.close();
      } catch (err) {
        console.error(`[OSR] Texture copy failed for '${this.rendererId}':`, err);
      } finally {
        imported.subtle.release();
      }
    });
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
