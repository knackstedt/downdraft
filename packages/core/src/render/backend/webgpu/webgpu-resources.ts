// ============================================================================
// WebGPU Resource Wrappers — thin wrappers around native WebGPU objects
// that implement the backend-agnostic interfaces.
// ============================================================================

import type {
  BackendBuffer,
  BackendTexture,
  BackendTextureView,
  BackendSampler,
  BackendShaderModule,
  BackendBindGroup,
  BackendBindGroupLayout,
  BackendPipelineLayout,
  BackendRenderPipeline,
  TextureViewDescriptor,
  TextureFormat,
  BufferUsageFlags,
  TextureUsageFlags,
} from "../types.ts";

// ─── Buffer ────────────────────────────────────────────────────────────────

export class WebGPUBuffer implements BackendBuffer {
  constructor(
    private _buffer: GPUBuffer,
    public readonly size: number,
    public readonly usage: BufferUsageFlags,
    public readonly label: string | undefined,
  ) {}

  destroy(): void {
    this._buffer.destroy();
  }

  getNative(): unknown {
    return this._buffer;
  }

  get gpuBuffer(): GPUBuffer {
    return this._buffer;
  }
}

// ─── Texture ───────────────────────────────────────────────────────────────

export class WebGPUTexture implements BackendTexture {
  constructor(
    private _texture: GPUTexture,
    public readonly width: number,
    public readonly height: number,
    public readonly depthOrArrayLayers: number,
    public readonly format: TextureFormat,
    public readonly usage: TextureUsageFlags,
    public readonly sampleCount: number,
    public readonly mipLevelCount: number,
    public readonly label: string | undefined,
  ) {}

  createView(descriptor?: TextureViewDescriptor): BackendTextureView {
    const view = this._texture.createView(descriptor as GPUTextureViewDescriptor | undefined);
    return new WebGPUTextureView(view, descriptor?.label);
  }

  destroy(): void {
    this._texture.destroy();
  }

  getNative(): unknown {
    return this._texture;
  }

  get gpuTexture(): GPUTexture {
    return this._texture;
  }
}

// ─── Texture View ──────────────────────────────────────────────────────────

export class WebGPUTextureView implements BackendTextureView {
  constructor(
    private _view: GPUTextureView,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._view;
  }

  get gpuView(): GPUTextureView {
    return this._view;
  }
}

// ─── Sampler ───────────────────────────────────────────────────────────────

export class WebGPUSampler implements BackendSampler {
  constructor(
    private _sampler: GPUSampler,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._sampler;
  }

  get gpuSampler(): GPUSampler {
    return this._sampler;
  }
}

// ─── Shader Module ─────────────────────────────────────────────────────────

export class WebGPUShaderModule implements BackendShaderModule {
  constructor(
    private _module: GPUShaderModule,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._module;
  }

  get gpuModule(): GPUShaderModule {
    return this._module;
  }
}

// ─── Bind Group Layout ─────────────────────────────────────────────────────

export class WebGPUBindGroupLayout implements BackendBindGroupLayout {
  constructor(
    private _layout: GPUBindGroupLayout,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._layout;
  }

  get gpuLayout(): GPUBindGroupLayout {
    return this._layout;
  }
}

// ─── Pipeline Layout ───────────────────────────────────────────────────────

export class WebGPUPipelineLayout implements BackendPipelineLayout {
  constructor(
    private _layout: GPUPipelineLayout,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._layout;
  }

  get gpuLayout(): GPUPipelineLayout {
    return this._layout;
  }
}

// ─── Bind Group ────────────────────────────────────────────────────────────

export class WebGPUBindGroup implements BackendBindGroup {
  constructor(
    private _group: GPUBindGroup,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._group;
  }

  get gpuGroup(): GPUBindGroup {
    return this._group;
  }
}

// ─── Render Pipeline ───────────────────────────────────────────────────────

export class WebGPURenderPipeline implements BackendRenderPipeline {
  constructor(
    private _pipeline: GPURenderPipeline,
    public readonly label: string | undefined,
  ) {}

  getNative(): unknown {
    return this._pipeline;
  }

  get gpuPipeline(): GPURenderPipeline {
    return this._pipeline;
  }
}
