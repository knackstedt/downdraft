// ============================================================================
// OSR Texture Receiver — Receives shared GPU textures from Electron OSR
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "../types";

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
  private pendingVideoFrame: VideoFrame | null = null;

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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
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
        let copyFailCount = 0;

        // Watchdog: if no VideoFrame arrives within 5s, log a warning
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
        const startWatchdog = () => {
          if (watchdogTimer) clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => {
            if (frameCount === 0) {
              console.warn(`[OSR] VideoFrame watchdog: no frames received within 5s for '${this.rendererId}' — shared texture path may not be delivering frames`);
            }
          }, 5000);
        };
        startWatchdog();

        // Listen for VideoFrames transferred via postMessage
        window.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.type !== "__osr_video_frame") return;
          const videoFrame = event.data.videoFrame;
          if (!videoFrame) return;

          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }

          // Close the previous VideoFrame — the GPU has already executed the copy
          if (this.pendingVideoFrame) {
            try { this.pendingVideoFrame.close(); } catch {}
          }

          const w = videoFrame.displayWidth || videoFrame.codedWidth;
          const h = videoFrame.displayHeight || videoFrame.codedHeight;
          if (frameCount === 0) {
            console.log(`[OSR] First VideoFrame for '${this.rendererId}': ${w}x${h}, format=${videoFrame.format}`);
          }
          if (w <= 0 || h <= 0) {
            this.pendingVideoFrame = videoFrame;
            return;
          }

          const texFormat = this.videoFrameFormatToGPUFormat(videoFrame.format || "");
          if (w !== this.width || h !== this.height || !this.gpuTexture || this.gpuTextureFormat !== texFormat) {
            this.width = w;
            this.height = h;
            this.createGpuTexture(texFormat);
          }
          if (!this.gpuTexture) {
            this.pendingVideoFrame = videoFrame;
            return;
          }

          try {
            this.device.queue.copyExternalImageToTexture(
              { source: videoFrame, flipY: false },
              { texture: this.gpuTexture, premultipliedAlpha: false },
              { width: this.width, height: this.height },
            );
            if (frameCount === 0) {
              console.log(`[OSR] Texture copy succeeded for '${this.rendererId}': ${this.width}x${this.height} format=${texFormat}`);
            }
            this.pendingVideoFrame = videoFrame;
            frameCount++;
          } catch (err) {
            copyFailCount++;
            if (copyFailCount <= 3) {
              console.error(`[OSR] Texture copy failed for '${this.rendererId}' (frame #${frameCount}):`, err);
            }
            try { videoFrame.close(); } catch {}
            this.pendingVideoFrame = null;
          }
        });
        registered = true;
      } else {
        console.warn(`[OSR] registerSharedTextureReceiver returned false for '${this.rendererId}' — CPU fallback only`);
      }
    } else {
      console.log(`[OSR] registerSharedTextureReceiver not available for '${this.rendererId}' — CPU fallback only`);
    }

    // Also register NativeImage paint fallback (CPU path)
    if (downdraft?.osr?.onPaintImage) {
      let nativeImageCount = 0;
      downdraft.osr.onPaintImage((rendererId: string, image: any) => {
        if (rendererId !== this.rendererId) return;
        try {
          const size = image.getSize();
          const w = size.width;
          const h = size.height;
          if (w === 0 || h === 0) return;
          if (nativeImageCount === 0) {
            console.log(`[OSR] First NativeImage for '${this.rendererId}': ${w}x${h}`);
          }
          nativeImageCount++;
          // NativeImage.toBitmap() returns BGRA on Linux — use bgra8unorm texture
          // and writeTexture directly (no per-pixel swap, no ImageData allocation)
          if (w !== this.width || h !== this.height || !this.gpuTexture || this.gpuTextureFormat !== "bgra8unorm") {
            this.width = w;
            this.height = h;
            this.createGpuTexture("bgra8unorm");
          }
          const rawBitmap = image.toBitmap();
          this.device.queue.writeTexture(
            { texture: this.gpuTexture! },
            rawBitmap,
            { bytesPerRow: w * 4, rowsPerImage: h },
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
    }
  }

  getTextureView(): GPUTextureView | null {
    return this.gpuTextureView;
  }

  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  destroy(): void {
    if (this.pendingVideoFrame) {
      try { this.pendingVideoFrame.close(); } catch {}
      this.pendingVideoFrame = null;
    }
    if (this.gpuTexture) {
      this.gpuTexture.destroy();
      this.gpuTexture = null;
      this.gpuTextureView = null;
    }
    this.receiverRegistered = false;
  }
}
