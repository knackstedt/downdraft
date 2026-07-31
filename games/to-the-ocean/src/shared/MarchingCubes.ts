// ============================================================================
// MarchingCubes — game-specific mesh extraction using core MC algorithm
// Terrain coloring and cloud coloring are game-specific; the core algorithm
// (extractMeshFromField) lives in @downdraft/core.
// ============================================================================

import { extractMeshFromField, type MeshColorFn } from "@downdraft/core";
import { TERRAIN_CONFIG } from "./TerrainConfig";
import type { ExtractedMesh, VoxelField } from "./TerrainTypes";
import { TerrainType } from "./TerrainTypes";

// Get terrain type at a surface point based on height and gradient
function getTerrainType(
  y: number,          // world-space y (unit space relative to island)
  gradientMag: number,// density gradient magnitude
  cliffNoise: number, // cliff placement noise value
): TerrainType {
  const cfg = TERRAIN_CONFIG;
  if (y < -cfg.depthHeight * 0.5) return TerrainType.DeepUnderwater;
  if (y < -cfg.depthHeight * 0.15) return TerrainType.ShallowUnderwater;
  if (y < 0) return TerrainType.Shoreline;
  if (y < cfg.beachThreshold) return TerrainType.Sand;
  // Cliff check: steep gradient or cliff noise zone
  if (gradientMag > cfg.cliffGradientThreshold || cliffNoise > cfg.cliffNoiseThreshold) {
    return TerrainType.Stone;
  }
  if (y < cfg.peakHeight * 0.4) return TerrainType.Grass;
  if (y < cfg.peakHeight * 0.7) return TerrainType.Forest;
  return TerrainType.Rock;
}

function terrainColor(type: TerrainType): [number, number, number] {
  const c = TERRAIN_CONFIG;
  switch (type) {
    case TerrainType.DeepUnderwater: return c.deepUnderwaterColor;
    case TerrainType.ShallowUnderwater: return c.shallowUnderwaterColor;
    case TerrainType.Shoreline: return c.shorelineColor;
    case TerrainType.Sand: return c.beachSandColor;
    case TerrainType.Grass: return c.grassColor;
    case TerrainType.Forest: return c.forestColor;
    case TerrainType.Stone: return c.cliffColor;
    case TerrainType.Rock: return c.rockColor;
    default: return c.grassColor;
  }
}

// Compute density gradient magnitude at a voxel position (for terrain type classification)
function gradientMagAt(field: VoxelField, gx: number, gy: number, gz: number): number {
  const dimYDimZ = field.dimY * field.dimZ;
  const dimZ = field.dimZ;
  let dxVal: number, dxP: number;
  if (gx - 1 < 0 || gx - 1 >= field.dimX) dxVal = -1.0;
  else dxVal = field.data[(gx - 1) * dimYDimZ + gy * dimZ + gz];
  if (gx + 1 < 0 || gx + 1 >= field.dimX) dxP = -1.0;
  else dxP = field.data[(gx + 1) * dimYDimZ + gy * dimZ + gz];
  const dx = (dxP - dxVal) * 0.5;
  let dyM: number, dyP: number;
  if (gy - 1 < 0 || gy - 1 >= field.dimY) dyM = -1.0;
  else dyM = field.data[gx * dimYDimZ + (gy - 1) * dimZ + gz];
  if (gy + 1 < 0 || gy + 1 >= field.dimY) dyP = -1.0;
  else dyP = field.data[gx * dimYDimZ + (gy + 1) * dimZ + gz];
  const dy = (dyP - dyM) * 0.5;
  let dzM: number, dzP: number;
  if (gz - 1 < 0 || gz - 1 >= field.dimZ) dzM = -1.0;
  else dzM = field.data[gx * dimYDimZ + gy * dimZ + (gz - 1)];
  if (gz + 1 < 0 || gz + 1 >= field.dimZ) dzP = -1.0;
  else dzP = field.data[gx * dimYDimZ + gy * dimZ + (gz + 1)];
  const dz = (dzP - dzM) * 0.5;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Build a terrain color callback for the core MC algorithm
function makeTerrainColorFn(
  cliffNoiseFn?: (x: number, y: number, z: number) => number,
): MeshColorFn {
  return (cx, cy, cz, _nx, _ny, _nz, field) => {
    const vs = field.voxelSize;
    const ox = field.originX, oy = field.originY, oz = field.originZ;
    const unitY = cy / field.radius;
    const gx = Math.round((cx - ox) / vs);
    const gy = Math.round((cy - oy) / vs);
    const gz = Math.round((cz - oz) / vs);
    const gradMag = gradientMagAt(field, gx, gy, gz);
    const cliffN = cliffNoiseFn ? cliffNoiseFn((cx - ox) / vs, (cy - oy) / vs, (cz - oz) / vs) : 0;
    const tType = getTerrainType(unitY, gradMag, cliffN);
    return terrainColor(tType);
  };
}

export function extractMesh(
  field: VoxelField,
  cliffNoiseFn?: (x: number, y: number, z: number) => number,
): ExtractedMesh {
  return extractMeshFromField(field, {
    colorFn: makeTerrainColorFn(cliffNoiseFn),
  });
}

// Extract cloud mesh from a voxel field — same MC algorithm as extractMesh
// but with cloud-specific coloring (no terrain types, no gradient/cliff noise).
// Vertex format is identical: pos(3) + normal(3) + color(3) = 9 floats per vertex.
export function extractCloudMesh(
  field: VoxelField,
  colorFn?: (ny: number, density: number) => [number, number, number],
): ExtractedMesh {
  const iso = field.isoLevel;
  const dimYDimZ = field.dimY * field.dimZ;
  const dimZ = field.dimZ;
  const cloudColorFn: MeshColorFn = (cx, cy, cz, _nx, ny, _nz, f) => {
    const vs = f.voxelSize;
    const ox = f.originX, oy = f.originY, oz = f.originZ;
    const gx = Math.round((cx - ox) / vs);
    const gy = Math.round((cy - oy) / vs);
    const gz = Math.round((cz - oz) / vs);
    const density = (gx >= 0 && gx < f.dimX && gy >= 0 && gy < f.dimY && gz >= 0 && gz < f.dimZ)
      ? f.data[gx * dimYDimZ + gy * dimZ + gz] : iso;
    return colorFn ? colorFn(ny, density) : [1, 1, 1];
  };
  return extractMeshFromField(field, {
    colorFn: cloudColorFn,
    flipDownNormals: false,
  });
}

// Extract mesh from a sub-region of a voxel field (for chunked streaming).
// Processes voxels from (x0,y0,z0) to (x1,y1,z1) inclusive.
// Vertex positions are in world space relative to the full field origin.
export function extractMeshSubRegion(
  field: VoxelField,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  cliffNoiseFn?: (x: number, y: number, z: number) => number,
): ExtractedMesh {
  return extractMeshFromField(field, {
    x0, y0, z0, x1, y1, z1,
    colorFn: makeTerrainColorFn(cliffNoiseFn),
  });
}
