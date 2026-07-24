export interface SurfaceConfig {
  format: GPUTextureFormat;
  width: number;
  height: number;
  usage: GPUTextureUsageFlags;
  alphaMode: GPUCanvasAlphaMode;
  viewFormats: GPUTextureFormat[];
}

export class SurfaceManager {
  private device: GPUDevice;
  private context: GPUCanvasContext | null = null;
  private config: SurfaceConfig | null = null;
  private currentTexture: GPUTexture | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  configure(canvas: HTMLCanvasElement | OffscreenCanvas, config: Partial<SurfaceConfig> = {}): void {
    this.canvas = canvas;
    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    if (!this.context) {
      console.error("[DownDraft] Failed to get WebGPU context from canvas");
      return;
    }

    const format = config.format ?? (navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm");
    this.config = {
      format,
      width: config.width ?? canvas.width,
      height: config.height ?? canvas.height,
      usage: config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: config.alphaMode ?? "opaque",
      viewFormats: config.viewFormats ?? [],
    };

    this.context.configure({
      device: this.device,
      format: this.config.format,
      usage: this.config.usage,
      alphaMode: this.config.alphaMode,
      viewFormats: this.config.viewFormats,
    });
  }

  getCurrentTexture(): GPUTexture | null {
    if (!this.context) return null;
    this.currentTexture = this.context.getCurrentTexture();
    return this.currentTexture;
  }

  reconfigure(width: number, height: number): void {
    if (!this.context || !this.config || !this.canvas) return;
    this.config.width = width;
    this.config.height = height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.config.format,
      usage: this.config.usage,
      alphaMode: this.config.alphaMode,
      viewFormats: this.config.viewFormats,
    });
  }

  getFormat(): GPUTextureFormat | null {
    return this.config?.format ?? null;
  }

  getConfig(): SurfaceConfig | null {
    return this.config;
  }
}
