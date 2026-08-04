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
  private gpuTextureFormat: GPUTextureFormat | null = null;
  private receiverRegistered = false;

  constructor(device: GPUDevice, rendererId: string, width: number, height: number, pixelFormat: OSRSharedTexturePixelFormat) {
    this.device = device;
    this.rendererId = rendererId;
    this.width = width;
    this.height = height;
    this.pixelFormat = pixelFormat;
  }

  init(): void {
    // Don't create GPU texture yet — wait for first frame with actual dimensions
    this.registerReceiver();
  }

  private get gpuFormat(): GPUTextureFormat {
    return this.pixelFormat === "bgra" ? "bgra8unorm" : "rgba8unorm";
  }

  private videoFrameFormatToGPUFormat(vfFormat: string): GPUTextureFormat {
    if (vfFormat === "BGRA" || vfFormat === "BGRX") return "bgra8unorm";
    return "rgba8unorm";
  }

  private createGpuTexture(format?: GPUTextureFormat): void {
    // Destroy previous texture immediately
    if (this.gpuTexture) {
      this.gpuTexture.destroy();
    }
    this.gpuTextureView = null;

    const texFormat = format ?? this.gpuFormat;
    this.gpuTextureFormat = texFormat;
    this.gpuTexture = this.device.createTexture({
      size: { width: this.width, height: this.height },
      format: texFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.gpuTextureView = this.gpuTexture.createView();
  }

  private registerReceiver(): void {
    const downdraft = (window as any).downdraft;
    let registered = false;
    let sharedTextureOk = false;

    // Try shared texture receiver first (GPU zero-copy path)
    if (downdraft?.osr?.registerSharedTextureReceiver) {
      // Register the receiver in the preload — this sets up a postMessage
      // bridge that transfers VideoFrames from the preload's isolated world
      // to the renderer's main world (VideoFrames can't be proxied through
      // contextBridge)
      sharedTextureOk = downdraft.osr.registerSharedTextureReceiver();
      if (sharedTextureOk) {
        let frameCount = 0;
        // Listen for VideoFrames transferred via postMessage
        window.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.type !== "__osr_video_frame") return;
          const videoFrame = event.data.videoFrame;
          if (!videoFrame) return;
          try {
            // Use displayWidth/Height (visible area) — codedWidth/Height may
            // include padding that would exceed the texture size
            const w = videoFrame.displayWidth || videoFrame.codedWidth;
            const h = videoFrame.displayHeight || videoFrame.codedHeight;
            if (frameCount === 0) {
              console.log(`[OSR] First VideoFrame for '${this.rendererId}': ${w}x${h}, format=${videoFrame.format}, codedSize=${videoFrame.codedWidth}x${videoFrame.codedHeight}, visibleRect=${JSON.stringify(videoFrame.codedRect)}`);
            }
            if (w <= 0 || h <= 0) {
              console.warn(`[OSR] Invalid VideoFrame dimensions ${w}x${h} for '${this.rendererId}'`);
              return;
            }
            const texFormat = this.videoFrameFormatToGPUFormat(videoFrame.format || "");
            if (w !== this.width || h !== this.height || !this.gpuTexture || this.gpuTextureFormat !== texFormat) {
              this.width = w;
              this.height = h;
              this.createGpuTexture(texFormat);
            }
            if (!this.gpuTexture) {
              console.error(`[OSR] gpuTexture is null after createGpuTexture for '${this.rendererId}'`);
              return;
            }
            this.device.queue.copyExternalImageToTexture(
              { source: videoFrame, flipY: false },
              { texture: this.gpuTexture, premultipliedAlpha: false },
              { width: this.width, height: this.height },
            );
            if (frameCount === 0) {
              console.log(`[OSR] Texture copy succeeded for '${this.rendererId}': ${this.width}x${this.height} format=${texFormat}`);
            }
            frameCount++;
          } catch (err) {
            console.error(`[OSR] Texture copy failed for '${this.rendererId}':`, err);
          } finally {
            videoFrame.close();
          }
        });
        registered = true;
      }
    }

    // Also register NativeImage paint fallback (CPU path)
    if (downdraft?.osr?.onPaintImage) {
      downdraft.osr.onPaintImage((rendererId: string, image: any) => {
        if (rendererId !== this.rendererId) return;
        try {
          const size = image.getSize();
          const w = size.width;
          const h = size.height;
          if (w === 0 || h === 0) return;
          if (w !== this.width || h !== this.height || !this.gpuTexture || this.gpuTextureFormat !== "rgba8unorm") {
            this.width = w;
            this.height = h;
            this.createGpuTexture("rgba8unorm");
          }
          // NativeImage.toBitmap() returns BGRA on Linux — swap R and B for RGBA
          const rawBitmap = image.toBitmap();
          const rgba = new Uint8ClampedArray(rawBitmap.length);
          for (let i = 0; i < rawBitmap.length; i += 4) {
            rgba[i] = rawBitmap[i + 2];     // R = B
            rgba[i + 1] = rawBitmap[i + 1]; // G = G
            rgba[i + 2] = rawBitmap[i];     // B = R
            rgba[i + 3] = rawBitmap[i + 3]; // A = A
          }
          const imageData = new ImageData(rgba, w, h);
          this.device.queue.copyExternalImageToTexture(
            { source: imageData, flipY: true },
            { texture: this.gpuTexture! },
            { width: w, height: h },
          );
        } catch (err) {
          console.error(`[OSR] NativeImage copy failed for '${this.rendererId}':`, err);
        }
      });
      if (!registered) registered = true;
    }

    this.receiverRegistered = registered;
    if (!registered) {
      console.warn(`[OSR] No texture receiver available for '${this.rendererId}'`);
    } else {
      console.log(`[OSR] Texture receiver registered for '${this.rendererId}' (sharedTexture: ${sharedTextureOk}, CPU fallback: ${!!downdraft?.osr?.onPaintImage})`);
    }
  }

  getTextureView(): GPUTextureView | null {
    return this.gpuTextureView;
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  destroy(): void {
    if (this.gpuTexture) {
      this.gpuTexture.destroy();
      this.gpuTexture = null;
      this.gpuTextureView = null;
    }
    this.receiverRegistered = false;
  }
}
