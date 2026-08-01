// Extracted from TerrainGenerator.ts — part of terrain decomposition

import { TERRAIN_CONFIG } from "../TerrainConfig";
import { ChunkedVoxelField } from "../TerrainTypes";
import { ChunkedFieldContext, computeDensityAt } from "./TerrainChunked";

// Get the appropriate voxel size for a given distance from the player.
// Returns 0 for "use base voxelSize" (closest LOD level).
export function getLODVoxelSize(distance: number): number {
  const lod = TERRAIN_CONFIG.terrainLOD;
  for (let i = 0; i < lod.length; i++) {
    if (distance <= lod[i].maxDistance) {
      return lod[i].voxelSize;
    }
  }
  return lod[lod.length - 1].voxelSize;
}

// Quick check if a chunk is likely empty (all air or all solid) by sampling
// density at the 8 corners of the chunk's bounding box.
// Returns true if the chunk can be skipped (no surface triangles).
export function isChunkEmpty(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  cx: number, cy: number, cz: number,
): boolean {
  const cs = field.chunkSize;
  const gx0 = cx * cs;
  const gy0 = cy * cs;
  const gz0 = cz * cs;
  const gx1 = Math.min(gx0 + cs, field.dimX);
  const gy1 = Math.min(gy0 + cs, field.dimY);
  const gz1 = Math.min(gz0 + cs, field.dimZ);

  // Sample 8 corners
  const corners = [
    [gx0, gy0, gz0], [gx1 - 1, gy0, gz0],
    [gx0, gy1 - 1, gz0], [gx1 - 1, gy1 - 1, gz0],
    [gx0, gy0, gz1 - 1], [gx1 - 1, gy0, gz1 - 1],
    [gx0, gy1 - 1, gz1 - 1], [gx1 - 1, gy1 - 1, gz1 - 1],
  ];

  let allNegative = true;  // all air (below isoLevel)
  let allPositive = true;  // all solid (above isoLevel)

  for (let i = 0; i < 8; i++) {
    const c = corners[i];
    const d = computeDensityAt(field, ctx, c[0], c[1], c[2]);
    if (d >= field.isoLevel) allNegative = false;
    if (d < field.isoLevel) allPositive = false;
  }

  // Skip if all air or all solid (no surface crossing)
  return allNegative || allPositive;
}

// Simple seeded PRNG
