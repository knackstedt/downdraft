// ============================================================================
// OSR Texture Receiver — Receives shared GPU textures from Electron OSR
// ============================================================================

import type { OSRSharedTexturePixelFormat } from "../types";
import { createDecompressWorker } from "./osr-decompress-worker";
import { OSRSABRingBuffer } from "./osr-sab-buffer";

const SAB_SLOT_COUNT = 4;

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
  // Worker + SAB pipeline for off-main-thread decompression
  private decompressWorker: Worker | null = null;
  private sabRing: OSRSABRingBuffer | null = null;
  private sabDrainActive = false;
  private regionCount = 0;

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

    // Region-based CPU path — dirty rect + compressed data via Worker + SAB
    if (downdraft?.osr?.onPaintRegion) {
      // Allocate SAB ring buffer — slot size based on actual frame dimensions
      const slotSize = this.width * this.height * 4;
      const sab = OSRSABRingBuffer.allocate(slotSize, SAB_SLOT_COUNT);
      this.sabRing = new OSRSABRingBuffer(sab);

      // Spawn decompression worker (inline blob — no Vite URL resolution needed)
      try {
        const worker = createDecompressWorker();
        this.decompressWorker = worker;
        worker.postMessage({ type: "init", sab });
        worker.onerror = (e) => {
          console.error(`[OSR] Decompress worker error for '${this.rendererId}':`, e.message);
        };
      } catch (err) {
        console.error(`[OSR] Failed to spawn decompress worker for '${this.rendererId}':`, err, err instanceof Error ? err.message : String(err));
        this.decompressWorker = null;
        this.sabRing = null;
      }

      // Start SAB drain loop — polls for decompressed data and uploads to GPU
      if (this.sabRing && this.decompressWorker) {
        this.startSabDrain();
      }

      downdraft.osr.onPaintRegion((rendererId: string, region: {
        x: number; y: number; width: number; height: number;
        fullWidth: number; fullHeight: number;
        data: ArrayBuffer; compressed: boolean;
      }) => {
        if (rendererId !== this.rendererId) return;
        try {
          const { x, y, width: rw, height: rh, fullWidth, fullHeight, data, compressed } = region;
          if (rw === 0 || rh === 0) return;

          // Ensure GPU texture matches full frame size
          if (fullWidth !== this.width || fullHeight !== this.height ||
              !this.gpuTexture || this.gpuTextureFormat !== "bgra8unorm") {
            this.width = fullWidth;
            this.height = fullHeight;
            this.createGpuTexture("bgra8unorm");
          }

          if (this.regionCount === 0) {
            console.log(`[OSR] First region for '${this.rendererId}': ${rw}x${rh} at (${x},${y}), ${data.byteLength}B${compressed ? " (compressed)" : ""}`);
          }
          this.regionCount++;

          if (!this.decompressWorker) {
            console.warn(`[OSR] Worker not running for '${this.rendererId}' — dropping frame (CPU fallback disabled)`);
            return;
          }
          // Send compressed data to worker — transferable ArrayBuffer (zero-copy)
          this.decompressWorker.postMessage(
            { type: "decompress", data, x, y, width: rw, height: rh, compressed },
            [data],
          );
        } catch (err) {
          console.error(`[OSR] Region copy failed for '${this.rendererId}':`, err);
        }
      });
      if (!registered) registered = true;
    } else if (downdraft?.osr?.onPaintImage) {
      // Legacy fallback: full-frame NativeImage (no dirty rect optimization)
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

  private startSabDrain(): void {
    if (this.sabDrainActive) return;
    this.sabDrainActive = true;

    const drain = () => {
      if (!this.sabDrainActive || !this.sabRing) return;

      // Drain all available slots
      let uploaded = 0;
      for (;;) {
        const slot = this.sabRing.nextReadSlot();
        if (slot === null) break;
        const region = this.sabRing.readSlot(slot);
        this.sabRing.consumeSlot();
        if (!region) continue;

        try {
          if (!this.gpuTexture) continue;
          // Clamp to texture bounds — defense against bad dirty rects
          const maxX = Math.min(region.x + region.width, this.width);
          const maxY = Math.min(region.y + region.height, this.height);
          const clampedW = maxX - region.x;
          const clampedH = maxY - region.y;
          if (clampedW <= 0 || clampedH <= 0) continue;
          this.device.queue.writeTexture(
            { texture: this.gpuTexture, origin: { x: region.x, y: region.y } },
            region.data as unknown as ArrayBuffer,
            { bytesPerRow: clampedW * 4, rowsPerImage: clampedH },
            { width: clampedW, height: clampedH },
          );
          uploaded++;
        } catch (err) {
          console.error(`[OSR] SAB drain writeTexture failed for '${this.rendererId}':`, err);
        }
      }

      if (uploaded > 0 && this.regionCount <= 3) {
        console.log(`[OSR] SAB drain for '${this.rendererId}': uploaded ${uploaded} regions`);
      }

      // Continue draining — use microtask for low latency
      requestAnimationFrame(drain);
    };
    requestAnimationFrame(drain);
  }


  destroy(): void {
    // Stop SAB drain loop
    this.sabDrainActive = false;

    // Shutdown worker + SAB
    if (this.sabRing) {
      this.sabRing.shutdown();
      this.sabRing = null;
    }
    if (this.decompressWorker) {
      this.decompressWorker.terminate();
      this.decompressWorker = null;
    }

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
