// ============================================================================
// RenderBackend — the core abstraction interface for GPU device operations.
// Each backend (WebGPU, WebGL2) implements this to provide a unified API
// for resource creation, shader compilation, and command submission.
// ============================================================================

import type { BackendCapabilities } from "./capabilities.ts";
import type { ShaderLanguage, ShaderSource } from "./shader-source.ts";
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
    BindGroupLayoutDescriptor,
    BufferDescriptor,
    PipelineLayoutDescriptor,
    RenderPipelineDescriptor,
    SamplerDescriptor,
    TextureDescriptor,
    TextureFormat,
    TextureViewDescriptor
} from "./types.ts";

export interface SurfaceConfiguration {
  format: TextureFormat | string;
  width: number;
  height: number;
  usage: number;
  alphaMode: "opaque" | "premultiplied";
  viewFormats: TextureFormat[];
}

export interface RenderBackend {
  // ─── Identification ──────────────────────────────────────────────────────

  readonly type: "webgpu" | "webgl2";
  readonly capabilities: BackendCapabilities;

  // ─── Surface / Canvas ────────────────────────────────────────────────────

  configureSurface(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    config: Partial<SurfaceConfiguration>,
  ): void;
  getCurrentSurfaceTexture(): BackendTexture | null;
  getSurfaceFormat(): TextureFormat;
  reconfigureSurface(width: number, height: number): void;

  // ─── Resource Creation ───────────────────────────────────────────────────

  createBuffer(descriptor: BufferDescriptor): BackendBuffer;
  createTexture(descriptor: TextureDescriptor): BackendTexture;
  createSampler(descriptor: SamplerDescriptor): BackendSampler;
  createShaderModule(source: ShaderSource, language: ShaderLanguage): BackendShaderModule;
  createBindGroupLayout(descriptor: BindGroupLayoutDescriptor): BackendBindGroupLayout;
  createPipelineLayout(descriptor: PipelineLayoutDescriptor): BackendPipelineLayout;
  createBindGroup(descriptor: BindGroupDescriptor): BackendBindGroup;
  createRenderPipeline(descriptor: RenderPipelineDescriptor): BackendRenderPipeline;

  // ─── Command Recording ───────────────────────────────────────────────────

  createCommandEncoder(label?: string): BackendCommandEncoder;

  // ─── Queue ───────────────────────────────────────────────────────────────

  readonly queue: BackendQueue;

  // ─── Texture View ────────────────────────────────────────────────────────

  createTextureView(texture: BackendTexture, descriptor?: TextureViewDescriptor): BackendTextureView;

  // ─── Device Lifecycle ────────────────────────────────────────────────────

  destroy(): void;
  onDeviceLost(handler: (info: { reason: string; message: string }) => void): void;

  // ─── Native Access (for gradual migration) ───────────────────────────────

  getNativeDevice(): unknown;
}

// ─── Backend Factory ───────────────────────────────────────────────────────

export type BackendCreateOptions = {
  /** Force a specific backend type (for testing). */
  forceBackend?: "webgpu" | "webgl2";
  /** Power preference for adapter selection. */
  powerPreference?: "high-performance" | "low-power";
  /** Required features (WebGPU only). */
  requiredFeatures?: string[];
};

/**
 * Detect which backend is available and create it.
 * Tries WebGPU first, falls back to WebGL2.
 */
export async function createBackend(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: BackendCreateOptions = {},
): Promise<RenderBackend | null> {
  const { forceBackend, powerPreference = "high-performance" } = options;

  if (!forceBackend || forceBackend === "webgpu") {
    if (typeof navigator !== "undefined" && navigator.gpu) {
      try {
        const { WebGPUBackend } = await import("./webgpu/webgpu-backend.ts");
        const backend = new WebGPUBackend();
        const ok = await backend.init({ powerPreference, requiredFeatures: options.requiredFeatures });
        if (ok) {
          backend.configureSurface(canvas, {});
          return backend;
        }
      } catch (e) {
        console.warn("[Backend] WebGPU initialization failed, falling back to WebGL2:", e);
      }
    }
  }

  if (!forceBackend || forceBackend === "webgl2") {
    try {
      const { WebGL2Backend } = await import("./webgl2/webgl2-backend.ts");
      const backend = new WebGL2Backend();
      const ok = await backend.init({});
      if (ok) {
        backend.configureSurface(canvas, {});
        return backend;
      }
    } catch (e) {
      console.error("[Backend] WebGL2 initialization failed:", e);
    }
  }

  return null;
}

/**
 * Check which backends are available without creating them.
 */
export function detectBackends(): { webgpu: boolean; webgl2: boolean } {
  const webgpu = typeof navigator !== "undefined" && !!navigator.gpu;
  let webgl2 = false;
  try {
    const testCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    if (testCanvas) {
      const ctx = testCanvas.getContext("webgl2");
      webgl2 = !!ctx;
    }
  } catch {
    webgl2 = false;
  }
  return { webgpu, webgl2 };
}
