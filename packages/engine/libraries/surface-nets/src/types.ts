// Re-export algorithm-agnostic shared types from the marching cubes plugin.
// VoxelField and ExtractedMesh are identical regardless of extraction algorithm.
export type { ExtractedMesh, VoxelField } from "@downdraft/engine/libraries/marching-cubes";

// MeshColorFn and ExtractMeshOptions mirror the MC plugin interfaces exactly
// so the game layer can swap algorithms without changing call sites.
export type MeshColorFn = (
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
  field: import("@downdraft/engine/libraries/marching-cubes").VoxelField,
) => [number, number, number];

export interface ExtractMeshOptions {
  x0?: number; y0?: number; z0?: number;
  x1?: number; y1?: number; z1?: number;
  colorFn?: MeshColorFn;
  flipDownNormals?: boolean;
  /** When false, vertices snap to voxel grid centers for a low-poly/blocky look. Default: true */
  smooth?: boolean;
}

// Re-export density field type for deformation utilities
export type DensityField = (x: number, y: number, z: number) => number;
