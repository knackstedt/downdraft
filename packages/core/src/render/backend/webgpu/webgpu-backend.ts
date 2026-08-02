// ============================================================================
// WebGPUBackend — implements RenderBackend by wrapping native WebGPU.
// All resource creation delegates to GPUDevice; returned objects are wrapped
// in the WebGPU* wrapper classes.
// ============================================================================

import { createLogger } from "../../../util/logger.ts";
import type { BackendCapabilities } from "../capabilities.ts";
import { createWebGPUCapabilities } from "../capabilities.ts";
import { fromWebGPUFormat, toWebGPUFormat } from "../format-mapping.ts";
import type { RenderBackend, SurfaceConfiguration } from "../render-backend.ts";
import type { ShaderLanguage, ShaderSource } from "../shader-source.ts";
import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    BackendCommandEncoder,
    BackendPipelineLayout,
    BackendQueue,
    BackendRenderPipeline,
    BackendSampler,
    BackendShaderModule,
    BackendTexture,
    BackendTextureView,
    BindGroupDescriptor,
    BindGroupEntry,
    BindGroupLayoutDescriptor,
    BindGroupLayoutEntry,
    BlendState,
    BufferDescriptor,
    ColorTargetState,
    DepthStencilState,
    PipelineLayoutDescriptor,
    RenderPipelineDescriptor,
    SamplerDescriptor,
    TextureDescriptor,
    TextureFormat,
    TextureViewDescriptor,
    VertexAttribute,
    VertexBufferLayout
} from "../types.ts";
import { WebGPUCommandEncoder } from "./webgpu-encoders.ts";
import { WebGPUQueue } from "./webgpu-queue.ts";
import {
    WebGPUBindGroup,
    WebGPUBindGroupLayout,
    WebGPUBuffer,
    WebGPUPipelineLayout,
    WebGPURenderPipeline,
    WebGPUSampler,
    WebGPUShaderModule,
    WebGPUTexture,
} from "./webgpu-resources.ts";

const log = createLogger();

export interface WebGPUBackendInitOptions {
  powerPreference?: "high-performance" | "low-power";
  requiredFeatures?: string[];
}

export class WebGPUBackend implements RenderBackend {
  readonly type = "webgpu" as const;

  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private context: GPUCanvasContext | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private surfaceConfig: SurfaceConfiguration | null = null;
  private _capabilities: BackendCapabilities | null = null;
  private _queue: WebGPUQueue | null = null;
  private lostHandlers: Array<(info: { reason: string; message: string }) => void> = [];

  get capabilities(): BackendCapabilities {
    if (!this._capabilities) {
      throw new Error("WebGPUBackend not initialized — call init() first");
    }
    return this._capabilities;
  }

  get queue(): BackendQueue {
    if (!this._queue) {
      throw new Error("WebGPUBackend not initialized — call init() first");
    }
    return this._queue;
  }

  async init(options: WebGPUBackendInitOptions = {}): Promise<boolean> {
    if (!navigator.gpu) {
      log.error("DownDraft", "WebGPU not available");
      return false;
    }

    this.adapter = await navigator.gpu.requestAdapter({
      powerPreference: options.powerPreference ?? "high-performance",
    });

    if (!this.adapter) {
      log.error("DownDraft", "No suitable GPU adapter found");
      return false;
    }

    const requiredFeatures: GPUFeatureName[] = [];
    if (options.requiredFeatures) {
      for (const f of options.requiredFeatures) {
        if (this.adapter.features.has(f as GPUFeatureName)) {
          requiredFeatures.push(f as GPUFeatureName);
        }
      }
    }

    this.device = await this.adapter.requestDevice({ requiredFeatures });

    if (!this.device) {
      log.error("DownDraft", "Failed to create GPU device");
      return false;
    }

    this.device.lost.then((info: GPUDeviceLostInfo) => {
      for (const handler of this.lostHandlers) {
        handler({ reason: info.reason, message: info.message });
      }
    });

    this._capabilities = createWebGPUCapabilities(this.device, this.adapter);
    this._queue = new WebGPUQueue(this.device.queue);

    return true;
  }

  // ─── Surface ─────────────────────────────────────────────────────────────

  configureSurface(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    config: Partial<SurfaceConfiguration> = {},
  ): void {
    if (!this.device) {
      log.error("DownDraft", "Cannot configure surface — device not initialized");
      return;
    }

    this.canvas = canvas;
    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    if (!this.context) {
      log.error("DownDraft", "Failed to get WebGPU context from canvas");
      return;
    }

    const format = config.format ?? (navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm");
    const sc = {
      format,
      width: config.width ?? canvas.width,
      height: config.height ?? canvas.height,
      usage: config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: config.alphaMode ?? "opaque",
      viewFormats: config.viewFormats ?? [],
    };
    this.surfaceConfig = sc;

    this.context.configure({
      device: this.device,
      format: sc.format as GPUTextureFormat,
      usage: sc.usage,
      alphaMode: sc.alphaMode,
      viewFormats: sc.viewFormats as GPUTextureFormat[],
    });
  }

  getCurrentSurfaceTexture(): BackendTexture | null {
    if (!this.context || !this.surfaceConfig) return null;
    const tex = this.context.getCurrentTexture();
    return new WebGPUTexture(
      tex,
      tex.width,
      tex.height,
      1,
      fromWebGPUFormat(tex.format),
      GPUTextureUsage.RENDER_ATTACHMENT,
      1,
      1,
      "surface",
    );
  }

  getSurfaceFormat(): TextureFormat {
    return (this.surfaceConfig?.format as TextureFormat) ?? "bgra8unorm";
  }

  reconfigureSurface(width: number, height: number): void {
    if (!this.context || !this.surfaceConfig || !this.canvas || !this.device) return;
    this.surfaceConfig.width = width;
    this.surfaceConfig.height = height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.surfaceConfig.format as GPUTextureFormat,
      usage: this.surfaceConfig.usage,
      alphaMode: this.surfaceConfig.alphaMode,
      viewFormats: this.surfaceConfig.viewFormats as GPUTextureFormat[],
    });
  }

  // ─── Resource Creation ───────────────────────────────────────────────────

  createBuffer(descriptor: BufferDescriptor): BackendBuffer {
    if (!this.device) throw new Error("Device not initialized");
    const buf = this.device.createBuffer({
      label: descriptor.label,
      size: descriptor.size,
      usage: descriptor.usage as GPUBufferUsageFlags,
      mappedAtCreation: descriptor.mappedAtCreation,
    });
    return new WebGPUBuffer(buf, descriptor.size, descriptor.usage, descriptor.label);
  }

  createTexture(descriptor: TextureDescriptor): BackendTexture {
    if (!this.device) throw new Error("Device not initialized");
    const tex = this.device.createTexture({
      label: descriptor.label,
      size: descriptor.size as GPUExtent3D,
      format: toWebGPUFormat(descriptor.format),
      usage: descriptor.usage as GPUTextureUsageFlags,
      sampleCount: descriptor.sampleCount ?? 1,
      mipLevelCount: descriptor.mipLevelCount ?? 1,
      dimension: descriptor.dimension ?? "2d",
    });
    const size = descriptor.size;
    const w = typeof size === "number" ? size : size[0];
    const h = typeof size === "number" ? 1 : (size[1] ?? 1);
    const d = typeof size === "number" ? 1 : (size[2] ?? 1);
    return new WebGPUTexture(
      tex,
      w,
      h,
      d,
      descriptor.format,
      descriptor.usage,
      descriptor.sampleCount ?? 1,
      descriptor.mipLevelCount ?? 1,
      descriptor.label,
    );
  }

  createSampler(descriptor: SamplerDescriptor): BackendSampler {
    if (!this.device) throw new Error("Device not initialized");
    const sampler = this.device.createSampler({
      label: descriptor.label,
      addressModeU: descriptor.addressModeU,
      addressModeV: descriptor.addressModeV,
      addressModeW: descriptor.addressModeW,
      magFilter: descriptor.magFilter,
      minFilter: descriptor.minFilter,
      mipmapFilter: descriptor.mipmapFilter,
      lodMinClamp: descriptor.lodMinClamp,
      lodMaxClamp: descriptor.lodMaxClamp,
      compare: descriptor.compare,
      maxAnisotropy: descriptor.maxAnisotropy,
    });
    return new WebGPUSampler(sampler, descriptor.label);
  }

  createShaderModule(source: ShaderSource, language: ShaderLanguage): BackendShaderModule {
    if (!this.device) throw new Error("Device not initialized");
    if (language !== "wgsl" || !source.wgsl) {
      throw new Error("WebGPUBackend only supports WGSL shaders");
    }
    const mod = this.device.createShaderModule({
      label: source.label,
      code: source.wgsl,
    });
    return new WebGPUShaderModule(mod, source.label);
  }

  createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BackendBindGroupLayout {
    if (!this.device) throw new Error("Device not initialized");
    const layout = this.device.createBindGroupLayout({
      label: descriptor.label,
      entries: descriptor.entries.map(this.mapBindGroupLayoutEntry),
    });
    return new WebGPUBindGroupLayout(layout, descriptor.label);
  }

  createPipelineLayout(descriptor: PipelineLayoutDescriptor): BackendPipelineLayout {
    if (!this.device) throw new Error("Device not initialized");
    const layout = this.device.createPipelineLayout({
      label: descriptor.label,
      bindGroupLayouts: descriptor.bindGroupLayouts.map(
        (l) => (l as unknown as { gpuLayout: GPUBindGroupLayout }).gpuLayout,
      ),
    });
    return new WebGPUPipelineLayout(layout, descriptor.label);
  }

  createBindGroup(descriptor: BindGroupDescriptor): BackendBindGroup {
    if (!this.device) throw new Error("Device not initialized");
    const group = this.device.createBindGroup({
      label: descriptor.label,
      layout: (descriptor.layout as unknown as { gpuLayout: GPUBindGroupLayout }).gpuLayout,
      entries: descriptor.entries.map(this.mapBindGroupEntry),
    });
    return new WebGPUBindGroup(group, descriptor.label);
  }

  createRenderPipeline(descriptor: RenderPipelineDescriptor): BackendRenderPipeline {
    if (!this.device) throw new Error("Device not initialized");
    const pipeline = this.device.createRenderPipeline({
      label: descriptor.label,
      vertex: {
        module: (descriptor.vertex.module as unknown as { gpuModule: GPUShaderModule }).gpuModule,
        entryPoint: descriptor.vertex.entryPoint,
        buffers: descriptor.vertex.buffers?.map(this.mapVertexBufferLayout),
      },
      fragment: descriptor.fragment
        ? {
            module: (descriptor.fragment.module as unknown as { gpuModule: GPUShaderModule }).gpuModule,
            entryPoint: descriptor.fragment.entryPoint,
            targets: descriptor.fragment.targets.map(this.mapColorTargetState),
          }
        : undefined,
      primitive: descriptor.primitive
        ? {
            topology: descriptor.primitive.topology,
            stripIndexFormat: descriptor.primitive.stripIndexFormat,
            frontFace: descriptor.primitive.frontFace,
            cullMode: descriptor.primitive.cullMode,
          }
        : undefined,
      depthStencil: descriptor.depthStencil
        ? this.mapDepthStencilState(descriptor.depthStencil)
        : undefined,
      multisample: descriptor.multisample,
      layout: descriptor.layout === "auto"
        ? "auto"
        : descriptor.layout
          ? (descriptor.layout as unknown as { gpuLayout: GPUPipelineLayout }).gpuLayout
          : "auto",
    });
    return new WebGPURenderPipeline(pipeline, descriptor.label);
  }

  // ─── Command Recording ───────────────────────────────────────────────────

  createCommandEncoder(label?: string): BackendCommandEncoder {
    if (!this.device) throw new Error("Device not initialized");
    return new WebGPUCommandEncoder(this.device.createCommandEncoder({ label }));
  }

  // ─── Texture View ────────────────────────────────────────────────────────

  createTextureView(texture: BackendTexture, descriptor?: TextureViewDescriptor): BackendTextureView {
    return texture.createView(descriptor);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  destroy(): void {
    this.device?.destroy();
    this.device = null;
    this.adapter = null;
    this.context = null;
    this.canvas = null;
    this._capabilities = null;
    this._queue = null;
  }

  onDeviceLost(handler: (info: { reason: string; message: string }) => void): void {
    this.lostHandlers.push(handler);
  }

  getNativeDevice(): unknown {
    return this.device;
  }

  // ─── Mapping helpers ─────────────────────────────────────────────────────

  private mapBindGroupLayoutEntry = (entry: BindGroupLayoutEntry): GPUBindGroupLayoutEntry => {
    const gpuEntry: GPUBindGroupLayoutEntry = {
      binding: entry.binding,
      visibility: entry.visibility,
    };
    if (entry.buffer) {
      gpuEntry.buffer = {
        type: entry.buffer.type,
        hasDynamicOffset: entry.buffer.hasDynamicOffset,
        minBindingSize: entry.buffer.minBindingSize,
      };
    }
    if (entry.sampler) {
      gpuEntry.sampler = { type: entry.sampler.type };
    }
    if (entry.texture) {
      gpuEntry.texture = {
        sampleType: entry.texture.sampleType,
        viewDimension: entry.texture.viewDimension,
        multisampled: entry.texture.multisampled,
      };
    }
    if (entry.storageTexture) {
      gpuEntry.storageTexture = {
        access: entry.storageTexture.access,
        format: toWebGPUFormat(entry.storageTexture.format),
        viewDimension: entry.storageTexture.viewDimension,
      };
    }
    return gpuEntry;
  };

  private mapBindGroupEntry = (entry: BindGroupEntry): GPUBindGroupEntry => {
    if ("buffer" in entry.resource) {
      return {
        binding: entry.binding,
        resource: {
          buffer: (entry.resource.buffer as unknown as WebGPUBuffer).gpuBuffer,
          offset: entry.resource.offset,
          size: entry.resource.size,
        },
      };
    }
    if ("sampler" in entry.resource) {
      return {
        binding: entry.binding,
        resource: (entry.resource.sampler as unknown as { gpuSampler: GPUSampler }).gpuSampler,
      };
    }
    if ("textureView" in entry.resource) {
      return {
        binding: entry.binding,
        resource: (entry.resource.textureView as unknown as { gpuView: GPUTextureView }).gpuView,
      };
    }
    throw new Error("Unsupported bind group entry resource type");
  };

  private mapVertexBufferLayout = (layout: VertexBufferLayout): GPUVertexBufferLayout => ({
    arrayStride: layout.arrayStride,
    stepMode: layout.stepMode,
    attributes: layout.attributes.map(this.mapVertexAttribute),
  });

  private mapVertexAttribute = (attr: VertexAttribute): GPUVertexAttribute => ({
    format: attr.format as GPUVertexFormat,
    offset: attr.offset,
    shaderLocation: attr.shaderLocation,
  });

  private mapColorTargetState = (target: ColorTargetState): GPUColorTargetState => ({
    format: toWebGPUFormat(target.format),
    blend: target.blend ? this.mapBlendState(target.blend) : undefined,
    writeMask: target.writeMask ?? 0xF,
  });

  private mapBlendState = (blend: BlendState): GPUBlendState => ({
    color: {
      operation: blend.color.operation,
      srcFactor: blend.color.srcFactor,
      dstFactor: blend.color.dstFactor,
    },
    alpha: {
      operation: blend.alpha.operation,
      srcFactor: blend.alpha.srcFactor,
      dstFactor: blend.alpha.dstFactor,
    },
  });

  private mapDepthStencilState = (ds: DepthStencilState): GPUDepthStencilState => ({
    format: toWebGPUFormat(ds.format),
    depthWriteEnabled: ds.depthWriteEnabled,
    depthCompare: ds.depthCompare,
    stencilFront: ds.stencilFront,
    stencilBack: ds.stencilBack,
    stencilReadMask: ds.stencilReadMask,
    stencilWriteMask: ds.stencilWriteMask,
    depthBias: ds.depthBias,
    depthBiasSlopeScale: ds.depthBiasSlopeScale,
    depthBiasClamp: ds.depthBiasClamp,
  });
}
