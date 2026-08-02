// ============================================================================
// WebGL2Backend — stub implementation. Full implementation in Phase 4.
// This stub allows the dynamic import in render-backend.ts to resolve
// and provides a clear error if WebGL2 is attempted before implementation.
// ============================================================================

import { createLogger } from "../../../util/logger.ts";
import type { RenderBackend, SurfaceConfiguration } from "../render-backend.ts";
import type { BackendCapabilities } from "../capabilities.ts";
import type { ShaderSource, ShaderLanguage } from "../shader-source.ts";
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
  BackendCommandEncoder,
  BackendQueue,
  BindGroupDescriptor,
  BindGroupLayoutDescriptor,
  BufferDescriptor,
  PipelineLayoutDescriptor,
  RenderPipelineDescriptor,
  SamplerDescriptor,
  TextureDescriptor,
  TextureFormat,
  TextureViewDescriptor,
} from "../types.ts";

const log = createLogger();

export interface WebGL2BackendInitOptions {
  /** Reserved for future use. */
  [key: string]: unknown;
}

export class WebGL2Backend implements RenderBackend {
  readonly type = "webgl2" as const;

  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private _capabilities: BackendCapabilities | null = null;
  private _surfaceFormat: TextureFormat = "rgba8unorm";

  get capabilities(): BackendCapabilities {
    if (!this._capabilities) {
      throw new Error("WebGL2Backend not initialized — call init() first");
    }
    return this._capabilities;
  }

  get queue(): BackendQueue {
    throw new Error("WebGL2Backend.queue not yet implemented — Phase 4");
  }

  async init(_options: WebGL2BackendInitOptions = {}): Promise<boolean> {
    log.warn("DownDraft", "WebGL2Backend is not yet implemented (Phase 4)");
    return false;
  }

  configureSurface(
    _canvas: HTMLCanvasElement | OffscreenCanvas,
    _config: Partial<SurfaceConfiguration> = {},
  ): void {
    throw new Error("Not yet implemented — Phase 4");
  }

  getCurrentSurfaceTexture(): BackendTexture | null {
    throw new Error("Not yet implemented — Phase 4");
  }

  getSurfaceFormat(): TextureFormat {
    return this._surfaceFormat;
  }

  reconfigureSurface(_width: number, _height: number): void {
    throw new Error("Not yet implemented — Phase 4");
  }

  createBuffer(_descriptor: BufferDescriptor): BackendBuffer {
    throw new Error("Not yet implemented — Phase 4");
  }

  createTexture(_descriptor: TextureDescriptor): BackendTexture {
    throw new Error("Not yet implemented — Phase 4");
  }

  createSampler(_descriptor: SamplerDescriptor): BackendSampler {
    throw new Error("Not yet implemented — Phase 4");
  }

  createShaderModule(_source: ShaderSource, _language: ShaderLanguage): BackendShaderModule {
    throw new Error("Not yet implemented — Phase 4");
  }

  createBindGroupLayout(_descriptor: BindGroupLayoutDescriptor): BackendBindGroupLayout {
    throw new Error("Not yet implemented — Phase 4");
  }

  createPipelineLayout(_descriptor: PipelineLayoutDescriptor): BackendPipelineLayout {
    throw new Error("Not yet implemented — Phase 4");
  }

  createBindGroup(_descriptor: BindGroupDescriptor): BackendBindGroup {
    throw new Error("Not yet implemented — Phase 4");
  }

  createRenderPipeline(_descriptor: RenderPipelineDescriptor): BackendRenderPipeline {
    throw new Error("Not yet implemented — Phase 4");
  }

  createCommandEncoder(_label?: string): BackendCommandEncoder {
    throw new Error("Not yet implemented — Phase 4");
  }

  createTextureView(_texture: BackendTexture, _descriptor?: TextureViewDescriptor): BackendTextureView {
    throw new Error("Not yet implemented — Phase 4");
  }

  destroy(): void {
    this.gl = null;
    this.canvas = null;
    this._capabilities = null;
  }

  onDeviceLost(_handler: (info: { reason: string; message: string }) => void): void {
    // WebGL2 doesn't have device-lost in the same way; context loss is handled via events
  }

  getNativeDevice(): unknown {
    return this.gl;
  }
}
