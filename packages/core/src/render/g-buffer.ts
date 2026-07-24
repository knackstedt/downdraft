export const G_BUFFER_FORMATS = {
  albedo: "rgba8unorm" as GPUTextureFormat,
  normal: "rgba8unorm" as GPUTextureFormat,
  metallicEmissive: "rgba8unorm" as GPUTextureFormat,
  velocity: "rg16float" as GPUTextureFormat,
  depth: "depth32float" as GPUTextureFormat,
} as const;

export interface GBufferTextures {
  albedo: GPUTexture;
  normal: GPUTexture;
  metallicEmissive: GPUTexture;
  velocity: GPUTexture;
  depth: GPUTexture;
}

export interface GBufferViews {
  albedo: GPUTextureView;
  normal: GPUTextureView;
  metallicEmissive: GPUTextureView;
  velocity: GPUTextureView;
  depth: GPUTextureView;
}

export class GBuffer {
  private width: number;
  private height: number;
  private textures: GBufferTextures | null = null;
  private views: GBufferViews | null = null;
  private device: GPUDevice;
  private sampleCount: number = 1;

  constructor(device: GPUDevice, width: number, height: number, sampleCount: number = 1) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.sampleCount = sampleCount;
    this.create();
  }

  private create(): void {
    const makeTexture = (format: GPUTextureFormat, usage: GPUTextureUsageFlags) =>
      this.device.createTexture({
        size: [this.width, this.height],
        format,
        usage,
        sampleCount: this.sampleCount,
      });

    const rtUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const depthUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

    this.textures = {
      albedo: makeTexture(G_BUFFER_FORMATS.albedo, rtUsage),
      normal: makeTexture(G_BUFFER_FORMATS.normal, rtUsage),
      metallicEmissive: makeTexture(G_BUFFER_FORMATS.metallicEmissive, rtUsage),
      velocity: makeTexture(G_BUFFER_FORMATS.velocity, rtUsage),
      depth: makeTexture(G_BUFFER_FORMATS.depth, depthUsage),
    };

    this.views = {
      albedo: this.textures.albedo.createView(),
      normal: this.textures.normal.createView(),
      metallicEmissive: this.textures.metallicEmissive.createView(),
      velocity: this.textures.velocity.createView(),
      depth: this.textures.depth.createView(),
    };
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.destroy();
    this.width = width;
    this.height = height;
    this.create();
  }

  getViews(): GBufferViews | null {
    return this.views;
  }

  getTextures(): GBufferTextures | null {
    return this.textures;
  }

  getColorAttachments(clearValue: { r: number; g: number; b: number; a: number }): GPURenderPassColorAttachment[] {
    if (!this.views) return [];
    return [
      {
        view: this.views.albedo,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
      {
        view: this.views.normal,
        clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
      {
        view: this.views.metallicEmissive,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
      {
        view: this.views.velocity,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ];
  }

  getDepthAttachment(): GPURenderPassDepthStencilAttachment | null {
    if (!this.views) return null;
    return {
      view: this.views.depth,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    };
  }

  destroy(): void {
    if (this.textures) {
      this.textures.albedo.destroy();
      this.textures.normal.destroy();
      this.textures.metallicEmissive.destroy();
      this.textures.velocity.destroy();
      this.textures.depth.destroy();
      this.textures = null;
      this.views = null;
    }
  }

  get width_(): number { return this.width; }
  get height_(): number { return this.height; }
}
