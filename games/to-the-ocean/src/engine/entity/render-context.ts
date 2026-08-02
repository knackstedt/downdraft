import type { RenderBackend } from "@downdraft/core/render/backend/render-backend";
import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    TextureFormat,
} from "@downdraft/core/render/backend/types";
import type { EntityType } from "@shared/types";

/** Shared mutable state passed to sub-renderers. */
export interface EntityRenderContext {
  /** WebGPU device (null when running on backend-only path, e.g. WebGL2). */
  readonly device: GPUDevice | null;
  /** Backend-agnostic render backend (null when running on native WebGPU). */
  readonly backend: RenderBackend | null;
  /** Surface format — works for both GPUTextureFormat and backend TextureFormat. */
  readonly format: GPUTextureFormat | TextureFormat;

  // Uniform buffer + bind group (shared across all entity draw calls)
  uniformBuffer: GPUBuffer | BackendBuffer | null;
  bindGroup: GPUBindGroup | BackendBindGroup | null;
  bindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null;

  // Per-frame camera state (updated in beginFrame)
  viewProjCache: Float32Array | null;
  cameraPosCache: [number, number, number];

  // Per-frame lighting state
  lightingParamsCache: {
    sunDir: [number, number, number];
    sunIntensity: number;
    ambient: number;
    fogColor: [number, number, number];
    wetness: number;
  };

  // External bind groups (set from WebGPURenderer)
  lightBindGroup: GPUBindGroup | BackendBindGroup | null;
  pbrBindGroup: GPUBindGroup | BackendBindGroup | null;

  // Reusable uniform arrays (avoids per-frame allocation)
  reusableUniforms: Float32Array;  // 64 floats
  reusableHbUniforms: Float32Array; // 64 floats

  // Viewport dimensions
  viewportWidth: number;
  viewportHeight: number;

  // Draw entity arrays (written by writeEntityUniforms, read by render)
  drawEntityTypes: EntityType[];
  drawEntityBoatSlots: number[];
  drawEntityScales: number[];
  drawEntityPortSizes: number[];
  drawEntityChunkX: number[];
  drawEntityChunkZ: number[];
  drawEntityBiome: number[];
  drawEntityIslandSize: number[];
  drawEntityPosX: number[];
  drawEntityPosY: number[];
  drawEntityPosZ: number[];
  drawEntityCount: number;
}
