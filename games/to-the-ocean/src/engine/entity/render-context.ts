import type { BindlessMaterialManager, BindlessTextureRegistry } from "@downdraft/core";
import type { EntityType } from "@shared/types";

/** Shared mutable state passed to sub-renderers. */
export interface EntityRenderContext {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;

  // Uniform buffer + bind group (shared across all entity draw calls)
  uniformBuffer: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  bindGroupLayout: GPUBindGroupLayout | null;

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
  lightBindGroup: GPUBindGroup | null;
  pbrBindGroup: GPUBindGroup | null;

  // Bindless material binding model (optional — set when the host provides
  // BindlessTextureRegistry + BindlessMaterialManager). Sub-renderers that use
  // textured materials (e.g. PlayerMeshRenderer) register textures/materials
  // here and sample via @group(3).
  bindlessRegistry: BindlessTextureRegistry | null;
  bindlessMaterialManager: BindlessMaterialManager | null;
  bindlessBindGroup: GPUBindGroup | null;

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
