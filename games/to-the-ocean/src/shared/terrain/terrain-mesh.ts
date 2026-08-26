// Extracted from TerrainGenerator.ts — part of terrain decomposition

import { PerlinNoise3D } from "@downdraft/core";
import { ChunkedVoxelField, VoxelField } from "@downdraft/library-marching-cubes";
import { extractMesh, extractMeshSubRegion } from "../marching-cubes";
import { TERRAIN_CONFIG } from "../terrain-config";
import { PerlinNoise } from "../world/perlin-noise";
import { ChunkedFieldContext, computeDensityAt } from "./terrain-chunked";
import { BlobCenter, mulberry32, smoothUnion } from "./terrain-voxel-field";

// no need to generate chunks). Returns Y in unit space.
export function sampleTerrainHeightChunked(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  ux: number, uz: number,
): number {
  const cfg = TERRAIN_CONFIG;
  const vs = field.voxelSize;
  const r = field.radius;
  const vx = Math.floor((ux * r - field.originX) / vs);
  const vz = Math.floor((uz * r - field.originZ) / vs);
  if (vx < 0 || vx >= field.dimX || vz < 0 || vz >= field.dimZ) return -cfg.depthHeight;
  for (let vy = field.dimY - 1; vy >= 0; vy--) {
    const density = computeDensityAt(field, ctx, vx, vy, vz);
    if (density >= field.isoLevel) return (vy * vs + field.originY) / r;
  }
  return -cfg.depthHeight;
}

// Sample terrain surface height at a unit-space (x, z) position.
// Returns the Y value of the topmost solid voxel, or -depthHeight if no terrain.
// Used as a replacement for the old islandHeight() function.
export function sampleTerrainHeight(field: VoxelField, ux: number, uz: number): number {
  const cfg = TERRAIN_CONFIG;
  const vs = field.voxelSize;
  const r = field.radius;

  // Convert unit-space to voxel indices
  const vx = Math.floor((ux * r - field.originX) / vs);
  const vz = Math.floor((uz * r - field.originZ) / vs);

  if (vx < 0 || vx >= field.dimX || vz < 0 || vz >= field.dimZ) {
    return -cfg.depthHeight;
  }

  // Scan from top to bottom to find the highest solid voxel
  for (let vy = field.dimY - 1; vy >= 0; vy--) {
    const density = field.data[vx * field.dimY * field.dimZ + vy * field.dimZ + vz];
    if (density >= field.isoLevel) {
      // Convert voxel Y back to unit space
      return (vy * vs + field.originY) / r;
    }
  }

  return -cfg.depthHeight;
}

// Generate a heightfield for Rapier physics from a voxel field.
// Samples the topmost solid voxel per XZ column at the given grid resolution.
// Returns heights in unit space (scaled by island radius at the physics layer).
export function generateTerrainHeightfield(
  field: VoxelField,
  gridSize: number = 16,
): Float32Array {
  const n = gridSize + 1;
  const heights = new Float32Array(n * n);
  const vs = field.voxelSize;
  const r = field.radius;

  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      // Map heightfield grid to unit space (-1..1)
      const ux = (gx / gridSize) * 2 - 1;
      const uz = (gz / gridSize) * 2 - 1;

      // Convert to voxel indices
      const vx = Math.floor((ux * r - field.originX) / vs);
      const vz = Math.floor((uz * r - field.originZ) / vs);

      let height = -TERRAIN_CONFIG.depthHeight;
      if (vx >= 0 && vx < field.dimX && vz >= 0 && vz < field.dimZ) {
        for (let vy = field.dimY - 1; vy >= 0; vy--) {
          const density = field.data[vx * field.dimY * field.dimZ + vy * field.dimZ + vz];
          if (density >= field.isoLevel) {
            height = (vy * vs + field.originY) / r;
            break;
          }
        }
      }
      // Rapier heightfield is row-major: heights[row * n + col]
      heights[gz * n + gx] = height;
    }
  }

  return heights;
}

// Generate a culled trimesh for ship collision from a voxel field.
// Uses marching cubes extraction, then filters out fully underwater triangles.
// Returns positions in unit space (caller scales by radius).
export function generateTerrainTrimesh(
  field: VoxelField,
  chunkX: number,
  chunkZ: number,
  includeUnderwater: boolean = false,
): { positions: Float32Array; indices: Uint32Array } {
  // Create cliff noise function for consistent terrain type
  const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
  const cliffNoiseFn = (x: number, y: number, z: number) => {
    return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
  };

  const extracted = extractMesh(field, cliffNoiseFn);
  const r = field.radius;

  // Convert positions to unit space and filter triangles
  const verts = extracted.verts;
  const srcIdx = extracted.indices;
  const numTris = srcIdx.length / 3;

  const positions: number[] = [];
  const indices: number[] = [];

  // Build position array (unit space) and index array, filtering underwater
  const vertMap = new Map<number, number>(); // old index → new index
  let nextVertIdx = 0;

  for (let t = 0; t < numTris; t++) {
    const i0 = srcIdx[t * 3];
    const i1 = srcIdx[t * 3 + 1];
    const i2 = srcIdx[t * 3 + 2];

    // Get vertex Y values (already in world space from extractMesh)
    const y0 = verts[i0 * 9 + 1] / r;
    const y1 = verts[i1 * 9 + 1] / r;
    const y2 = verts[i2 * 9 + 1] / r;

    // Skip fully underwater triangles unless includeUnderwater is true
    if (!includeUnderwater && y0 < 0 && y1 < 0 && y2 < 0) continue;

    // Add vertices (deduplicated)
    for (const oldIdx of [i0, i1, i2]) {
      if (!vertMap.has(oldIdx)) {
        vertMap.set(oldIdx, nextVertIdx);
        positions.push(
          verts[oldIdx * 9] / r,       // x
          verts[oldIdx * 9 + 1] / r,   // y
          verts[oldIdx * 9 + 2] / r,   // z
        );
        nextVertIdx++;
      }
    }

    indices.push(vertMap.get(i0)!, vertMap.get(i1)!, vertMap.get(i2)!);
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

// Generate a culled trimesh from a sub-region of a voxel field.
// Only processes voxels in [x0,x1] x [y0,y1] x [z0,z1] — much cheaper than full extraction.
// Returns positions in unit space (caller scales by radius).
export function generateTerrainTrimeshSubRegion(
  field: VoxelField,
  chunkX: number,
  chunkZ: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  includeUnderwater: boolean = false,
): { positions: Float32Array; indices: Uint32Array } {
  const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
  const cliffNoiseFn = (x: number, y: number, z: number) => {
    return cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);
  };

  const extracted = extractMeshSubRegion(field, x0, y0, z0, x1, y1, z1, cliffNoiseFn);
  const r = field.radius;

  const verts = extracted.verts;
  const srcIdx = extracted.indices;
  const numTris = srcIdx.length / 3;

  const positions: number[] = [];
  const indices: number[] = [];

  const vertMap = new Map<number, number>();
  let nextVertIdx = 0;

  for (let t = 0; t < numTris; t++) {
    const i0 = srcIdx[t * 3];
    const i1 = srcIdx[t * 3 + 1];
    const i2 = srcIdx[t * 3 + 2];

    const y0v = verts[i0 * 9 + 1] / r;
    const y1v = verts[i1 * 9 + 1] / r;
    const y2v = verts[i2 * 9 + 1] / r;

    if (!includeUnderwater && y0v < 0 && y1v < 0 && y2v < 0) continue;

    for (const oldIdx of [i0, i1, i2]) {
      if (!vertMap.has(oldIdx)) {
        vertMap.set(oldIdx, nextVertIdx);
        positions.push(
          verts[oldIdx * 9] / r,
          verts[oldIdx * 9 + 1] / r,
          verts[oldIdx * 9 + 2] / r,
        );
        nextVertIdx++;
      }
    }
    indices.push(vertMap.get(i0)!, vertMap.get(i1)!, vertMap.get(i2)!);
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}
// Simplified version of generateVoxelField with:
// - Flat plateau top (minimal peak height, large overlapping blobs)
// - Wide beach transition zone for smooth shoreline
// - Underwater shelf
// - Optional cave carving for secret tunnels beneath the dock
// ============================================================================

export function generatePortVoxelField(
  chunkX: number,
  chunkZ: number,
  radius: number,
  biome: number,
): VoxelField {
  const cfg = TERRAIN_CONFIG;
  const seed = chunkX * 83492791 + chunkZ * 26515163;
  const rng = mulberry32(seed);

  const heightNoise = new PerlinNoise(seed ^ 0xABCDEF01);
  const caveNoise = new PerlinNoise3D(seed ^ 0xDEADBEEF);

  // Generate blob centers — fewer, larger, more circular than islands
  const blobs: BlobCenter[] = [];
  const blobCount = cfg.portBlobCount;
  for (let i = 0; i < blobCount; i++) {
    const angle = (i / blobCount) * Math.PI * 2 + rng() * 0.5;
    const dist = rng() * cfg.portBlobSpread;
    blobs.push({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius: cfg.portBlobMinRadius + rng() * (cfg.portBlobMaxRadius - cfg.portBlobMinRadius),
      strength: cfg.portBlobMinStrength + rng() * (cfg.portBlobMaxStrength - cfg.portBlobMinStrength),
      heightMul: rng() * 0.02, // nearly flat — minimal height variation
    });
  }
  // Central blob for solid core
  blobs.push({ x: 0, z: 0, radius: 0.85, strength: 1.0, heightMul: 0 });

  // Compute voxel grid dimensions
  const unitExtent = 1.8;
  const xzWorldExtent = unitExtent * radius;
  const yWorldExtent = (cfg.portPeakHeight + cfg.portDepthHeight) * radius * 2.0;

  const vs = cfg.portVoxelSize;
  const dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  const totalVoxels = dimX * dimY * dimZ;
  const memBytes = totalVoxels * 4;
  if (memBytes > cfg.maxVoxelMemory) {
    const scale = Math.cbrt(cfg.maxVoxelMemory / memBytes);
    return generatePortVoxelFieldCore(radius, vs / scale, blobs, heightNoise, caveNoise);
  }

  return generatePortVoxelFieldCore(radius, vs, blobs, heightNoise, caveNoise);
}

function generatePortVoxelFieldCore(
  radius: number,
  vs: number,
  blobs: BlobCenter[],
  heightNoise: PerlinNoise,
  caveNoise: PerlinNoise3D,
): VoxelField {
  const cfg = TERRAIN_CONFIG;
  const unitExtent = 1.8;
  const xzWorldExtent = unitExtent * radius;
  const yWorldExtent = (cfg.portPeakHeight + cfg.portDepthHeight) * radius * 2.0;

  const dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  const totalVoxels = dimX * dimY * dimZ;
  const data = new Float32Array(totalVoxels);

  const originX = -xzWorldExtent;
  const originY = -yWorldExtent;
  const originZ = -xzWorldExtent;

  const numBlobs = blobs.length;
  const invR = 1 / radius;

  // Precompute per-column data
  const colBlobHeightAtPoint = new Float32Array(dimX * dimZ * numBlobs);
  const colBlobSkip = new Uint8Array(dimX * dimZ * numBlobs);
  const colHeightNoise = new Float32Array(dimX * dimZ);
  const colBeachBoost = new Float32Array(dimX * dimZ);

  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR;
      const uz = wz * invR;

      colHeightNoise[colIdx] = heightNoise.fbm(ux * 2.0, uz * 2.0, 2, 0.5, 2.0);

      for (let b = 0; b < numBlobs; b++) {
        const blob = blobs[b];
        const dx = ux - blob.x;
        const dz = uz - blob.z;
        const distSq = dx * dx + dz * dz;
        const r = blob.radius * 1.25; // gentle side radius (no cliff asymmetry for ports)
        const extR = r + 0.25;
        const extRsq = extR * extR;
        const blobOffset = colIdx * numBlobs + b;

        if (distSq > extRsq) {
          colBlobSkip[blobOffset] = 1;
          continue;
        }
        colBlobSkip[blobOffset] = 0;
        const t = 1 - distSq / extRsq;
        const falloff = t > 0 ? Math.min(1, Math.pow(t, 0.6) * 1.8) : 0;
        const baseDepth = cfg.portDepthHeight;
        colBlobHeightAtPoint[blobOffset] = falloff * (baseDepth + cfg.portPeakHeight * blob.heightMul) - baseDepth;
      }

      // Beach union boost (same logic as islands)
      let beachDensityAtZero = -1.0;
      for (let b = 0; b < numBlobs; b++) {
        const blobOffset = colIdx * numBlobs + b;
        if (colBlobSkip[blobOffset]) continue;
        const blob = blobs[b];
        if (blob.heightMul > 0.1) continue;
        const blobDensity = colBlobHeightAtPoint[blobOffset] * blob.strength;
        beachDensityAtZero = smoothUnion(beachDensityAtZero, blobDensity, cfg.portBlobSmoothUnionK);
      }
      colBeachBoost[colIdx] = beachDensityAtZero > 0 ? beachDensityAtZero : 0;
    }
  }

  // Main voxel loop
  const dimYDimZ = dimY * dimZ;
  const caveMaxHeight = cfg.portPeakHeight * (1 - cfg.portCaveMinDepth);

  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR;
      const uz = wz * invR;

      const heightNoiseVal = colHeightNoise[colIdx];
      const heightMod = (heightNoiseVal - 0.5) * 0.02;
      const colBase = vx * dimYDimZ + vz;

      for (let vy = 0; vy < dimY; vy++) {
        const wy = vy * vs + originY;
        const uy = wy * invR;

        // Layer 1: Flat plateau base
        let baseDensity = -1.0;
        for (let b = 0; b < numBlobs; b++) {
          const blobOffset = colIdx * numBlobs + b;
          if (colBlobSkip[blobOffset]) continue;
          const blob = blobs[b];
          const blobDensity = (colBlobHeightAtPoint[blobOffset] - uy) * blob.strength;
          baseDensity = smoothUnion(baseDensity, blobDensity, cfg.portBlobSmoothUnionK);
        }
        baseDensity -= colBeachBoost[colIdx];

        // Layer 2: Height modulation (subtle)
        let density = baseDensity + heightMod * Math.max(0, baseDensity + 0.5);

        // Layer 3: Beach flattening (wider zone for ports)
        if (uy > -cfg.portBeachThreshold && uy < cfg.portBeachThreshold && density > -0.3) {
          const beachFactor = 1 - Math.abs(uy) / cfg.portBeachThreshold;
          density = density * (1 - beachFactor * cfg.portBeachGradientScale) + beachFactor * 0.01;
        }

        // Layer 4: Cave carving (secret tunnels under port)
        if (cfg.portCaveEnabled && density > cfg.portCaveThreshold && uy < caveMaxHeight) {
          const caveN = caveNoise.fbm3D(
            ux * cfg.portCaveNoiseScale, uy * cfg.portCaveNoiseScale, uz * cfg.portCaveNoiseScale,
            3, 0.5, 2.0,
          );
          if (caveN > cfg.portCaveThreshold) {
            const carveStrength = (caveN - cfg.portCaveThreshold) / (1 - cfg.portCaveThreshold);
            density -= carveStrength * 2;
          }
        }

        // Layer 5: Hard ceiling at portPeakHeight
        if (uy > cfg.portPeakHeight) {
          density = Math.min(density, -(uy - cfg.portPeakHeight));
        }

        data[colBase + vy * dimZ] = density;
      }
    }
  }

  return {
    data,
    dimX, dimY, dimZ,
    voxelSize: vs,
    originX, originY, originZ,
    isoLevel: cfg.isoLevel,
    radius,
  };
}
