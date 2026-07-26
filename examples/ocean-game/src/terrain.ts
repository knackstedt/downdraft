// ─── Voxel terrain generation + marching cubes mesh extraction ──

import { BIOME_COLORS, BiomeType, TERRAIN_CONFIG, TerrainType } from "./constants.ts";
import { mulberry32, PerlinNoise, PerlinNoise3D } from "./noise.ts";

// ─── Voxel Field Type ─────────────────────────────────────

export interface VoxelField {
  data: Float32Array;
  dimX: number; dimY: number; dimZ: number;
  voxelSize: number;
  originX: number; originY: number; originZ: number;
  isoLevel: number;
  radius: number;
}

// ─── Smooth Union (for blobular terrain) ──────────────────

function smoothUnion(d1: number, d2: number, k: number): number {
  const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
  return Math.max(d1, d2) + h * h * k * 0.25;
}

// ─── Voxel Field Generation (ported from to-the-ocean TerrainGenerator.ts) ──

interface BlobCenter { x: number; z: number; radius: number; strength: number; heightMul: number; }

export function generateVoxelField(
  chunkX: number, chunkZ: number, radius: number, biome: number,
): VoxelField {
  const cfg = TERRAIN_CONFIG;
  const seed = chunkX * 92837111 + chunkZ * 72635341;
  const rng = mulberry32(seed);
  const heightNoise = new PerlinNoise(seed ^ 0xABCDEF01);
  const cliffNoise2D = new PerlinNoise(seed ^ 0x56781234);
  const caveNoise = new PerlinNoise3D(seed ^ 0xDEADBEEF);

  // Generate blob centers for blobular island shape
  const blobs: BlobCenter[] = [];
  const blobCount = cfg.blobCount;
  const islandHeightMul = 0.4 + rng() * 0.6;
  const peakCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < blobCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng() * cfg.blobSpread;
    const isPeak = i < peakCount;
    blobs.push({
      x: Math.cos(angle) * dist, z: Math.sin(angle) * dist,
      radius: isPeak ? cfg.blobMinRadius * 0.5 + rng() * 0.15 : cfg.blobMinRadius + rng() * (cfg.blobMaxRadius - cfg.blobMinRadius),
      strength: cfg.blobMinStrength + rng() * (cfg.blobMaxStrength - cfg.blobMinStrength),
      heightMul: isPeak ? islandHeightMul * (0.8 + rng() * 0.2) : rng() * 0.08,
    });
  }
  blobs.push({ x: 0, z: 0, radius: 0.8, strength: 1.0, heightMul: 0 });
  const panhandleCount = Math.floor(rng() * 3);
  for (let i = 0; i < panhandleCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = 0.7 + rng() * 0.2;
    blobs.push({
      x: Math.cos(angle) * dist, z: Math.sin(angle) * dist,
      radius: 0.2 + rng() * 0.15, strength: 0.5 + rng() * 0.2, heightMul: rng() * 0.05,
    });
  }

  const cliffAngle = rng() * Math.PI * 2;
  const cliffDirX = Math.cos(cliffAngle);
  const cliffDirZ = Math.sin(cliffAngle);

  const unitExtent = 2.0;
  const xzWorldExtent = unitExtent * radius;
  const yWorldExtent = (cfg.peakHeight + cfg.depthHeight) * radius * cfg.yExtentMultiplier;
  const vs = cfg.voxelSize;
  let dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  let dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  let dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  // Clamp to memory limit
  let totalVoxels = dimX * dimY * dimZ;
  if (totalVoxels * 4 > cfg.maxVoxelMemory) {
    const scale = Math.cbrt(cfg.maxVoxelMemory / (totalVoxels * 4));
    const newVs = vs / scale;
    dimX = Math.ceil((xzWorldExtent * 2) / newVs) + 1;
    dimZ = Math.ceil((xzWorldExtent * 2) / newVs) + 1;
    dimY = Math.ceil((yWorldExtent * 2) / newVs) + 1;
    totalVoxels = dimX * dimY * dimZ;
  }

  const data = new Float32Array(totalVoxels);
  const originX = -xzWorldExtent;
  const originY = -yWorldExtent;
  const originZ = -xzWorldExtent;
  const invR = 1 / radius;
  const numBlobs = blobs.length;
  const dimYDimZ = dimY * dimZ;
  const caveMaxHeight = cfg.peakHeight * (1 - cfg.caveMinDepth);

  // Precompute per-column data
  const colHeightNoise = new Float32Array(dimX * dimZ);
  const colCliffStrength = new Float32Array(dimX * dimZ);
  const colBlobHeightAtPoint = new Float32Array(dimX * dimZ * numBlobs);
  const colBlobSkip = new Uint8Array(dimX * dimZ * numBlobs);
  const colBeachBoost = new Float32Array(dimX * dimZ);

  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR, uz = wz * invR;
      colHeightNoise[colIdx] = heightNoise.fbm(ux * cfg.heightNoiseScale, uz * cfg.heightNoiseScale, cfg.heightNoiseOctaves, 0.5, 2.0);
      const cliffN = cliffNoise2D.fbm(ux * cfg.cliffNoiseScale, uz * cfg.cliffNoiseScale, 3, 0.5, 2.0);
      colCliffStrength[colIdx] = cliffN > cfg.cliffNoiseThreshold ? (cliffN - cfg.cliffNoiseThreshold) * 1.5 : 0;

      for (let b = 0; b < numBlobs; b++) {
        const blob = blobs[b];
        const dx = ux - blob.x, dz = uz - blob.z;
        const distSq = dx * dx + dz * dz;
        const proj = dx * cliffDirX + dz * cliffDirZ;
        const sideScale = proj > 0 ? cfg.gentleSideRadius : cfg.cliffSideRadius;
        const r = blob.radius * sideScale;
        const extR = r + cfg.blobEdgeExtend;
        const extRsq = extR * extR;
        const blobOffset = colIdx * numBlobs + b;
        if (distSq > extRsq) { colBlobSkip[blobOffset] = 1; continue; }
        colBlobSkip[blobOffset] = 0;
        const t = 1 - distSq / extRsq;
        const falloff = t > 0 ? Math.min(1, Math.pow(t, cfg.plateauSharpness) * 1.8) : 0;
        const depthFactor = proj > 0 ? 1.0 : cfg.cliffDepthFactor;
        const baseDepth = cfg.depthHeight * depthFactor;
        colBlobHeightAtPoint[blobOffset] = falloff * (baseDepth + cfg.peakHeight * blob.heightMul) - baseDepth;
      }

      let beachDensityAtZero = -1.0;
      for (let b = 0; b < numBlobs; b++) {
        const blobOffset = colIdx * numBlobs + b;
        if (colBlobSkip[blobOffset]) continue;
        const blob = blobs[b];
        if (blob.heightMul > 0.1) continue;
        const blobDensity = colBlobHeightAtPoint[blobOffset] * blob.strength;
        beachDensityAtZero = smoothUnion(beachDensityAtZero, blobDensity, cfg.blobSmoothUnionK);
      }
      colBeachBoost[colIdx] = beachDensityAtZero > 0 ? beachDensityAtZero : 0;
    }
  }

  // Main voxel loop
  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR, uz = wz * invR;
      const heightNoiseVal = colHeightNoise[colIdx];
      const heightMod = (heightNoiseVal - 0.5) * cfg.heightNoiseAmplitude;
      const cliffStrength = colCliffStrength[colIdx];
      const colBase = vx * dimYDimZ + vz;

      for (let vy = 0; vy < dimY; vy++) {
        const wy = vy * vs + originY;
        const uy = wy * invR;

        let baseDensity = -1.0;
        for (let b = 0; b < numBlobs; b++) {
          const blobOffset = colIdx * numBlobs + b;
          if (colBlobSkip[blobOffset]) continue;
          const blob = blobs[b];
          const blobDensity = (colBlobHeightAtPoint[blobOffset] - uy) * blob.strength;
          baseDensity = smoothUnion(baseDensity, blobDensity, cfg.blobSmoothUnionK);
        }
        baseDensity -= colBeachBoost[colIdx];

        let density = baseDensity + heightMod * Math.max(0, baseDensity + 0.5);

        if (uy > -cfg.beachThreshold && uy < cfg.beachThreshold && density > -0.3) {
          const beachFactor = 1 - Math.abs(uy) / cfg.beachThreshold;
          density = density * (1 - beachFactor * cfg.beachGradientScale) + beachFactor * 0.01;
        }

        if (cliffStrength > 0 && uy > 0 && density > -0.2) {
          density += cliffStrength * Math.max(0, 1 - Math.abs(uy / cfg.peakHeight));
        }

        if (cfg.caveEnabled && density > cfg.caveThreshold && uy < caveMaxHeight) {
          const caveN = caveNoise.fbm3D(ux * cfg.caveNoiseScale, uy * cfg.caveNoiseScale, uz * cfg.caveNoiseScale, cfg.caveNoiseOctaves, 0.5, 2.0);
          if (caveN > cfg.caveThreshold) {
            const carveStrength = (caveN - cfg.caveThreshold) / (1 - cfg.caveThreshold);
            density -= carveStrength * 2;
          }
        }

        if (uy > cfg.peakHeight) {
          density = Math.min(density, -(uy - cfg.peakHeight));
        }

        // Boundary fade: smoothly reduce density near field edges to prevent
        // hard cliff faces that cause broken meshes at the island boundary.
        const edgeFadeX = Math.min(vx / (dimX - 1), 1 - vx / (dimX - 1)) * 2; // 0 at edge, 1+ in interior
        const edgeFadeZ = Math.min(vz / (dimZ - 1), 1 - vz / (dimZ - 1)) * 2;
        const edgeFade = Math.min(edgeFadeX, edgeFadeZ);
        const fadeStart = 0.15; // start fading when within 15% of boundary
        if (edgeFade < fadeStart) {
          const fadeFactor = edgeFade / fadeStart; // 0 at edge, 1 at fadeStart
          density = density * fadeFactor - (1 - fadeFactor);
        }

        data[colBase + vy * dimZ] = density;
      }
    }
  }

  return { data, dimX, dimY, dimZ, voxelSize: vs, originX, originY, originZ, isoLevel: cfg.isoLevel, radius };
}

// ─── Terrain Height Sampling (from voxel field) ───────────

export function voxelFieldHeightAt(field: VoxelField, worldX: number, worldZ: number): number {
  const vs = field.voxelSize;
  const vx = Math.floor((worldX - field.originX) / vs);
  const vz = Math.floor((worldZ - field.originZ) / vs);
  if (vx < 0 || vx >= field.dimX || vz < 0 || vz >= field.dimZ) return -1;

  // Scan Y column to find surface (density crosses isoLevel)
  const dimZ = field.dimZ;
  let bestY = -1;
  let bestDensity = -2;
  for (let vy = 0; vy < field.dimY; vy++) {
    const d = field.data[vx * field.dimY * dimZ + vy * dimZ + vz];
    if (d >= field.isoLevel) {
      bestY = vy;
      bestDensity = d;
    } else if (bestY >= 0) {
      // We've passed the surface — interpolate exact height
      const prevD = field.data[vx * field.dimY * dimZ + (vy - 1) * dimZ + vz];
      const t = (field.isoLevel - prevD) / (d - prevD);
      return (bestY + t) * vs + field.originY;
    }
  }
  if (bestY >= 0) return bestY * vs + field.originY;
  return -1;
}

// ─── Terrain Type Classification ──────────────────────────

export function classifyTerrainTypeByUnitY(uy: number, biome: number): TerrainType {
  const cfg = TERRAIN_CONFIG;

  if (uy < -cfg.beachThreshold * 2) return TerrainType.DeepUnderwater;
  if (uy < -cfg.beachThreshold * 0.5) return TerrainType.ShallowUnderwater;
  if (uy < cfg.beachThreshold * 0.5) return TerrainType.Shoreline;
  if (uy < cfg.beachThreshold) return TerrainType.Sand;

  if (biome === BiomeType.Arctic && uy > cfg.peakHeight * 0.6) return TerrainType.Snow;
  if (biome === BiomeType.Volcanic && uy > cfg.peakHeight * 0.5) return TerrainType.Ash;
  if (biome === BiomeType.Desert) return TerrainType.Sand;

  if (uy > cfg.peakHeight * 0.7) return TerrainType.Rock;
  if (uy > cfg.peakHeight * 0.4) return TerrainType.Stone;
  if (uy > cfg.peakHeight * 0.2) return TerrainType.Forest;
  return TerrainType.Grass;
}

export function classifyTerrainType(
  field: VoxelField, vx: number, vy: number, vz: number, biome: number,
): TerrainType {
  const cfg = TERRAIN_CONFIG;
  const wy = vy * field.voxelSize + field.originY;
  const uy = wy / field.radius;

  if (uy < -cfg.beachThreshold * 2) return TerrainType.DeepUnderwater;
  if (uy < -cfg.beachThreshold * 0.5) return TerrainType.ShallowUnderwater;
  if (uy < cfg.beachThreshold * 0.5) return TerrainType.Shoreline;
  if (uy < cfg.beachThreshold) return TerrainType.Sand;

  if (biome === BiomeType.Arctic && uy > cfg.peakHeight * 0.6) return TerrainType.Snow;
  if (biome === BiomeType.Volcanic && uy > cfg.peakHeight * 0.5) return TerrainType.Ash;
  if (biome === BiomeType.Desert) return TerrainType.Sand;

  if (uy > cfg.peakHeight * 0.7) return TerrainType.Rock;
  if (uy > cfg.peakHeight * 0.4) return TerrainType.Stone;

  // Check gradient for cliff vs grass
  const colIdx = vx * field.dimZ + vz;
  const cliffN = 0; // Simplified — use height as proxy
  if (uy > cfg.peakHeight * 0.2) return TerrainType.Forest;
  return TerrainType.Grass;
}

export function terrainTypeColor(type: TerrainType, biome: number): [number, number, number] {
  const colors = BIOME_COLORS[biome] ?? BIOME_COLORS[BiomeType.Tropical];
  switch (type) {
    case TerrainType.DeepUnderwater: return colors.deepUnderwater;
    case TerrainType.ShallowUnderwater: return colors.shallowUnderwater;
    case TerrainType.Shoreline: return colors.shoreline;
    case TerrainType.Sand: return colors.sand;
    case TerrainType.Grass: return colors.grass;
    case TerrainType.Forest: return colors.forest;
    case TerrainType.Stone: return colors.rock;
    case TerrainType.Rock: return colors.peak;
    case TerrainType.Snow: return [0.9, 0.92, 0.95];
    case TerrainType.Ash: return [0.2, 0.15, 0.12];
    default: return colors.grass;
  }
}

// ─── Marching Cubes Mesh Extraction ───────────────────────

const MC_EDGE_TABLE = new Uint32Array([
  0x000,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
  0x190,0x099,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
  0x230,0x339,0x033,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
  0x3a0,0x2a9,0x1a3,0x0aa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
  0x460,0x569,0x663,0x76a,0x066,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
  0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0x0ff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
  0x650,0x759,0x453,0x55a,0x256,0x35f,0x055,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
  0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0x0cc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
  0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0x0cc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
  0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x055,0x35f,0x256,0x55a,0x453,0x759,0x650,
  0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0x0ff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
  0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x066,0x76a,0x663,0x569,0x460,
  0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0x0aa,0x1a3,0x2a9,0x3a0,
  0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x033,0x339,0x230,
  0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x099,0x190,
  0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x000,
]);

const MC_TRI_TABLE = new Int8Array([
-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,8,3,9,8,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,1,2,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,2,10,0,2,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,8,3,2,10,8,10,9,8,-1,-1,-1,-1,-1,-1,-1,
3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,11,2,8,11,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,9,0,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,11,2,1,9,11,9,8,11,-1,-1,-1,-1,-1,-1,-1,
3,10,1,11,10,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,10,1,0,8,10,8,11,10,-1,-1,-1,-1,-1,-1,-1,
3,9,0,3,11,9,11,10,9,-1,-1,-1,-1,-1,-1,-1,
9,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,3,0,7,3,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,1,9,4,7,1,7,3,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,8,4,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,4,7,3,0,4,1,2,10,-1,-1,-1,-1,-1,-1,-1,
9,2,10,9,0,2,8,4,7,-1,-1,-1,-1,-1,-1,-1,
2,10,9,2,9,7,2,7,3,7,9,4,-1,-1,-1,-1,
8,4,7,3,11,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,4,7,11,2,4,2,0,4,-1,-1,-1,-1,-1,-1,-1,
9,0,1,8,4,7,2,3,11,-1,-1,-1,-1,-1,-1,-1,
4,7,11,9,4,11,9,11,2,9,2,1,-1,-1,-1,-1,
3,10,1,3,11,10,7,8,4,-1,-1,-1,-1,-1,-1,-1,
1,11,10,1,4,11,1,0,4,7,11,4,-1,-1,-1,-1,
4,7,8,9,0,11,9,11,10,11,0,3,-1,-1,-1,-1,
4,7,11,4,11,9,9,11,10,-1,-1,-1,-1,-1,-1,-1,
9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,5,4,0,8,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,5,4,1,5,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,5,4,8,3,5,3,1,5,-1,-1,-1,-1,-1,-1,-1,
1,2,10,9,5,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,8,1,2,10,4,9,5,-1,-1,-1,-1,-1,-1,-1,
5,2,10,5,4,2,4,0,2,-1,-1,-1,-1,-1,-1,-1,
2,10,5,3,2,5,3,5,4,3,4,8,-1,-1,-1,-1,
9,5,4,2,3,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,11,2,0,8,11,4,9,5,-1,-1,-1,-1,-1,-1,-1,
0,5,4,0,1,5,2,3,11,-1,-1,-1,-1,-1,-1,-1,
2,1,5,2,5,8,2,8,11,4,8,5,-1,-1,-1,-1,
10,3,11,10,1,3,9,5,4,-1,-1,-1,-1,-1,-1,-1,
4,9,5,0,8,1,8,10,1,8,11,10,-1,-1,-1,-1,
5,4,0,5,0,11,5,11,10,11,0,3,-1,-1,-1,-1,
5,4,8,5,8,10,10,8,11,-1,-1,-1,-1,-1,-1,-1,
9,7,8,5,7,9,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,3,0,9,5,3,5,7,3,-1,-1,-1,-1,-1,-1,-1,
0,7,8,0,1,7,1,5,7,-1,-1,-1,-1,-1,-1,-1,
1,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,7,8,9,5,7,10,1,2,-1,-1,-1,-1,-1,-1,-1,
10,1,2,9,5,0,5,3,0,5,7,3,-1,-1,-1,-1,
8,0,2,8,2,5,8,5,7,10,5,2,-1,-1,-1,-1,
2,10,5,2,5,3,3,5,7,-1,-1,-1,-1,-1,-1,-1,
7,9,5,7,8,9,3,11,2,-1,-1,-1,-1,-1,-1,-1,
9,5,7,9,7,2,9,2,0,2,7,11,-1,-1,-1,-1,
2,3,11,0,1,8,1,7,8,1,5,7,-1,-1,-1,-1,
11,2,1,11,1,7,7,1,5,-1,-1,-1,-1,-1,-1,-1,
9,5,8,8,5,7,10,1,3,10,3,11,-1,-1,-1,-1,
5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1,
11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1,
11,10,5,7,11,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,0,1,5,10,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,8,3,1,9,8,5,10,6,-1,-1,-1,-1,-1,-1,-1,
1,6,5,2,6,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,6,5,1,2,6,3,0,8,-1,-1,-1,-1,-1,-1,-1,
9,6,5,9,0,6,0,2,6,-1,-1,-1,-1,-1,-1,-1,
5,9,8,5,8,2,5,2,6,3,2,8,-1,-1,-1,-1,
2,3,11,10,6,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,0,8,11,2,0,10,6,5,-1,-1,-1,-1,-1,-1,-1,
0,1,9,2,3,11,5,10,6,-1,-1,-1,-1,-1,-1,-1,
5,10,6,1,9,2,9,11,2,9,8,11,-1,-1,-1,-1,
6,3,11,6,5,3,5,1,3,-1,-1,-1,-1,-1,-1,-1,
0,8,11,0,11,5,0,5,1,5,11,6,-1,-1,-1,-1,
3,11,6,0,3,6,0,6,5,0,5,9,-1,-1,-1,-1,
6,5,9,6,9,11,11,9,8,-1,-1,-1,-1,-1,-1,-1,
5,10,6,4,7,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,3,0,4,7,3,6,5,10,-1,-1,-1,-1,-1,-1,-1,
1,9,0,5,10,6,8,4,7,-1,-1,-1,-1,-1,-1,-1,
10,6,5,1,9,7,1,7,3,7,9,4,-1,-1,-1,-1,
6,1,2,6,5,1,4,7,8,-1,-1,-1,-1,-1,-1,-1,
1,2,5,5,2,6,3,0,4,3,4,7,-1,-1,-1,-1,
8,4,7,9,0,5,0,6,5,0,2,6,-1,-1,-1,-1,
7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1,
3,11,2,7,8,4,10,6,5,-1,-1,-1,-1,-1,-1,-1,
5,10,6,4,7,2,4,2,0,2,7,11,-1,-1,-1,-1,
0,1,9,4,7,8,2,3,11,5,10,6,-1,-1,-1,-1,
9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1,
8,4,7,3,11,5,3,5,1,5,11,6,-1,-1,-1,-1,
5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1,
0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1,
6,5,9,6,9,11,4,7,9,7,11,9,-1,-1,-1,-1,
10,4,9,6,4,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,10,6,4,9,10,0,8,3,-1,-1,-1,-1,-1,-1,-1,
10,0,1,10,6,0,6,4,0,-1,-1,-1,-1,-1,-1,-1,
8,3,1,8,1,6,8,6,4,6,1,10,-1,-1,-1,-1,
1,4,9,1,2,4,2,6,4,-1,-1,-1,-1,-1,-1,-1,
3,0,8,1,2,9,2,4,9,2,6,4,-1,-1,-1,-1,
0,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,3,2,8,2,4,4,2,6,-1,-1,-1,-1,-1,-1,-1,
10,4,9,10,6,4,11,2,3,-1,-1,-1,-1,-1,-1,-1,
0,8,2,2,8,11,4,9,10,4,10,6,-1,-1,-1,-1,
3,11,2,0,1,6,0,6,4,6,1,10,-1,-1,-1,-1,
6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1,
9,6,4,9,3,6,9,1,3,11,6,3,-1,-1,-1,-1,
8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1,
3,11,6,3,6,0,0,6,4,-1,-1,-1,-1,-1,-1,-1,
6,4,8,11,6,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,10,6,7,8,10,8,9,10,-1,-1,-1,-1,-1,-1,-1,
0,7,3,0,10,7,0,9,10,6,7,10,-1,-1,-1,-1,
10,6,7,1,10,7,1,7,8,1,8,0,-1,-1,-1,-1,
10,6,7,10,7,1,1,7,3,-1,-1,-1,-1,-1,-1,-1,
1,2,6,1,6,8,1,8,9,8,6,7,-1,-1,-1,-1,
2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1,
7,8,0,7,0,6,6,0,2,-1,-1,-1,-1,-1,-1,-1,
7,3,2,6,7,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,11,10,6,8,10,8,9,8,6,7,-1,-1,-1,-1,
2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1,
1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1,
11,2,1,11,1,7,10,6,1,6,7,1,-1,-1,-1,-1,
8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1,
0,9,1,11,6,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,8,0,7,0,6,3,11,0,11,6,0,-1,-1,-1,-1,
7,11,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,8,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,1,9,11,7,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,1,9,8,3,1,11,7,6,-1,-1,-1,-1,-1,-1,-1,
10,1,2,6,11,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,3,0,8,6,11,7,-1,-1,-1,-1,-1,-1,-1,
2,9,0,2,10,9,6,11,7,-1,-1,-1,-1,-1,-1,-1,
6,11,7,2,10,3,10,8,3,10,9,8,-1,-1,-1,-1,
7,2,3,6,2,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
7,0,8,7,6,0,6,2,0,-1,-1,-1,-1,-1,-1,-1,
2,7,6,2,3,7,0,1,9,-1,-1,-1,-1,-1,-1,-1,
1,6,2,1,8,6,1,9,8,8,7,6,-1,-1,-1,-1,
10,7,6,10,1,7,1,3,7,-1,-1,-1,-1,-1,-1,-1,
10,7,6,1,7,10,1,8,7,1,0,8,-1,-1,-1,-1,
0,3,7,0,7,10,0,10,9,6,10,7,-1,-1,-1,-1,
7,6,10,7,10,8,8,10,9,-1,-1,-1,-1,-1,-1,-1,
6,8,4,11,8,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,6,11,3,0,6,0,4,6,-1,-1,-1,-1,-1,-1,-1,
8,6,11,8,4,6,9,0,1,-1,-1,-1,-1,-1,-1,-1,
9,4,6,9,6,3,9,3,1,11,3,6,-1,-1,-1,-1,
6,8,4,6,11,8,2,10,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,3,0,11,0,6,11,0,4,6,-1,-1,-1,-1,
4,11,8,4,6,11,0,2,9,2,10,9,-1,-1,-1,-1,
10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1,
8,2,3,8,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,
0,4,2,4,6,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,9,0,2,3,4,2,4,6,4,3,8,-1,-1,-1,-1,
1,9,4,1,4,2,2,4,6,-1,-1,-1,-1,-1,-1,-1,
8,1,3,8,6,1,8,4,6,6,10,1,-1,-1,-1,-1,
10,1,0,10,0,6,6,0,4,-1,-1,-1,-1,-1,-1,-1,
4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1,
10,9,4,6,10,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,9,5,7,6,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,4,9,5,11,7,6,-1,-1,-1,-1,-1,-1,-1,
5,0,1,5,4,0,7,6,11,-1,-1,-1,-1,-1,-1,-1,
11,7,6,8,3,4,3,5,4,3,1,5,-1,-1,-1,-1,
9,5,4,10,1,2,7,6,11,-1,-1,-1,-1,-1,-1,-1,
6,11,7,1,2,10,0,8,3,4,9,5,-1,-1,-1,-1,
7,6,11,5,4,10,4,2,10,4,0,2,-1,-1,-1,-1,
3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1,
7,2,3,7,6,2,5,4,9,-1,-1,-1,-1,-1,-1,-1,
9,5,4,0,8,6,0,6,2,6,8,7,-1,-1,-1,-1,
3,6,2,3,7,6,1,5,0,5,4,0,-1,-1,-1,-1,
6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1,
9,5,4,10,1,6,1,7,6,1,3,7,-1,-1,-1,-1,
1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1,
4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1,
7,6,10,7,10,8,5,4,10,4,8,10,-1,-1,-1,-1,
6,9,5,6,11,9,11,8,9,-1,-1,-1,-1,-1,-1,-1,
3,6,11,0,6,3,0,5,6,0,9,5,-1,-1,-1,-1,
0,11,8,0,5,11,0,1,5,5,6,11,-1,-1,-1,-1,
6,11,3,6,3,5,5,3,1,-1,-1,-1,-1,-1,-1,-1,
1,2,10,9,5,11,9,11,8,11,5,6,-1,-1,-1,-1,
0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1,
11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1,
6,11,3,6,3,5,2,10,3,10,5,3,-1,-1,-1,-1,
5,8,9,5,2,8,5,6,2,3,8,2,-1,-1,-1,-1,
9,5,6,9,6,0,0,6,2,-1,-1,-1,-1,-1,-1,-1,
1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1,
1,5,6,2,1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1,
10,1,0,10,0,6,9,5,0,5,6,0,-1,-1,-1,-1,
0,3,8,5,6,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
10,5,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,5,10,7,5,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
11,5,10,11,7,5,8,3,0,-1,-1,-1,-1,-1,-1,-1,
5,11,7,5,10,11,1,9,0,-1,-1,-1,-1,-1,-1,-1,
10,7,5,10,11,7,9,8,1,8,3,1,-1,-1,-1,-1,
11,1,2,11,7,1,7,5,1,-1,-1,-1,-1,-1,-1,-1,
0,8,3,1,2,7,1,7,5,7,2,11,-1,-1,-1,-1,
9,7,5,9,2,7,9,0,2,2,11,7,-1,-1,-1,-1,
7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1,
2,5,10,2,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,
8,2,0,8,5,2,8,7,5,10,2,5,-1,-1,-1,-1,
9,0,1,5,10,3,5,3,7,3,10,2,-1,-1,-1,-1,
9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1,
1,3,5,3,7,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,8,7,0,7,1,1,7,5,-1,-1,-1,-1,-1,-1,-1,
9,0,3,9,3,5,5,3,7,-1,-1,-1,-1,-1,-1,-1,
9,8,7,5,9,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
5,8,4,5,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,
5,0,4,5,11,0,5,10,11,11,3,0,-1,-1,-1,-1,
0,1,9,8,4,10,8,10,11,10,4,5,-1,-1,-1,-1,
10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1,
2,5,1,2,8,5,2,11,8,4,5,8,-1,-1,-1,-1,
0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1,
0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1,
9,4,5,2,11,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,5,10,3,5,2,3,4,5,3,8,4,-1,-1,-1,-1,
5,10,2,5,2,4,4,2,0,-1,-1,-1,-1,-1,-1,-1,
3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1,
5,10,2,5,2,4,1,9,2,9,4,2,-1,-1,-1,-1,
8,4,5,8,5,3,3,5,1,-1,-1,-1,-1,-1,-1,-1,
0,4,5,1,0,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
8,4,5,8,5,3,9,0,5,0,3,5,-1,-1,-1,-1,
9,4,5,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,11,7,4,9,11,9,10,11,-1,-1,-1,-1,-1,-1,-1,
0,8,3,4,9,7,9,11,7,9,10,11,-1,-1,-1,-1,
1,10,11,1,11,4,1,4,0,7,4,11,-1,-1,-1,-1,
3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1,
4,11,7,9,11,4,9,2,11,9,1,2,-1,-1,-1,-1,
9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1,
11,7,4,11,4,2,2,4,0,-1,-1,-1,-1,-1,-1,-1,
11,7,4,11,4,2,8,3,4,3,2,4,-1,-1,-1,-1,
2,9,10,2,7,9,2,3,7,7,4,9,-1,-1,-1,-1,
9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1,
3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1,
1,10,2,8,7,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,9,1,4,1,7,7,1,3,-1,-1,-1,-1,-1,-1,-1,
4,9,1,4,1,7,0,8,1,8,7,1,-1,-1,-1,-1,
4,0,3,7,4,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
4,8,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
9,10,8,10,11,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,0,9,3,9,11,11,9,10,-1,-1,-1,-1,-1,-1,-1,
0,1,10,0,10,8,8,10,11,-1,-1,-1,-1,-1,-1,-1,
3,1,10,11,3,10,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,2,11,1,11,9,9,11,8,-1,-1,-1,-1,-1,-1,-1,
3,0,9,3,9,11,1,2,9,2,11,9,-1,-1,-1,-1,
0,2,11,8,0,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
3,2,11,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,8,2,8,10,10,8,9,-1,-1,-1,-1,-1,-1,-1,
9,10,2,0,9,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
2,3,8,2,8,10,0,1,8,1,10,8,-1,-1,-1,-1,
1,10,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
1,3,8,9,1,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,9,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
0,3,8,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
]);

// Edge-to-corner offsets (12 edges, each connects two corners)
const MC_EDGE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0,1],[1,2],[2,3],[3,0],
  [4,5],[5,6],[6,7],[7,4],
  [0,4],[1,5],[2,6],[3,7],
];

// Corner offsets within a voxel cube
const MC_CORNER_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0,0,0],[1,0,0],[1,0,1],[0,0,1],
  [0,1,0],[1,1,0],[1,1,1],[0,1,1],
];

// Maps each of the 12 cube edges to (grid-point, axis) for vertex sharing.
// axis: 0=X, 1=Y, 2=Z. The grid point is the corner with the lower coordinate on that axis.
const MC_EDGE_AXIS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0,0,0,0],[1,0,0,2],[0,0,1,0],[0,0,0,2], // edges 0-3 (bottom face)
  [0,1,0,0],[1,1,0,2],[0,1,1,0],[0,1,0,2], // edges 4-7 (top face)
  [0,0,0,1],[1,0,0,1],[1,0,1,1],[0,0,1,1], // edges 8-11 (vertical)
];

export function extractMeshFromField(
  field: VoxelField,
  biome: number,
  maxVerts: number = 500000,
  step: number = 1,
): { verts: Float32Array; indices: Uint16Array | Uint32Array; vertexCount: number; indexCount: number } {
  const vs = field.voxelSize;
  const { dimX, dimY, dimZ, data, isoLevel } = field;
  const dimYZ = dimY * dimZ;

  function getDensity(x: number, y: number, z: number): number {
    if (x < 0 || x >= dimX || y < 0 || y >= dimY || z < 0 || z >= dimZ) return -1.0;
    return data[x * dimYZ + y * dimZ + z];
  }

  // ─── LOD path (step > 1): unique vertices per triangle, per-face normal + color ───
  // No edge cache → each triangle gets 3 own vertices with the same face normal and
  // a solid color from the face centroid height. This gives crisp low-poly facets
  // with no blending across terrain boundaries.
  if (step > 1) {
    const verts: number[] = [];
    const indexList: number[] = [];
    let vertIdx = 0;

    for (let x = 0; x < dimX - step; x += step) {
      for (let y = 0; y < dimY - step; y += step) {
        for (let z = 0; z < dimZ - step; z += step) {
          const d: number[] = new Array(8);
          let cubeIndex = 0;
          for (let i = 0; i < 8; i++) {
            const [ox, oy, oz] = MC_CORNER_OFFSETS[i];
            d[i] = getDensity(x + ox * step, y + oy * step, z + oz * step);
            if (d[i] < isoLevel) cubeIndex |= (1 << i);
          }
          if (cubeIndex === 0 || cubeIndex === 255) continue;

          const edges = MC_EDGE_TABLE[cubeIndex];
          if (edges === 0) continue;

          const triBase = cubeIndex * 16;
          for (let t = 0; t < 15; t += 3) {
            const e0 = MC_TRI_TABLE[triBase + t];
            if (e0 < 0) break;
            const e1 = MC_TRI_TABLE[triBase + t + 1];
            const e2 = MC_TRI_TABLE[triBase + t + 2];

            // Compute 3 edge vertex positions (no sharing)
            const triVerts: [number, number, number][] = [];
            for (const e of [e0, e1, e2]) {
              const [c0, c1] = MC_EDGE_CORNERS[e];
              const [ox0, oy0, oz0] = MC_CORNER_OFFSETS[c0];
              const [ox1, oy1, oz1] = MC_CORNER_OFFSETS[c1];
              const d0 = d[c0], d1 = d[c1];
              const p0x = (x + ox0 * step) * vs + field.originX;
              const p0y = (y + oy0 * step) * vs + field.originY;
              const p0z = (z + oz0 * step) * vs + field.originZ;
              const p1x = (x + ox1 * step) * vs + field.originX;
              const p1y = (y + oy1 * step) * vs + field.originY;
              const p1z = (z + oz1 * step) * vs + field.originZ;
              let ex: number, ey: number, ez: number;
              if (Math.abs(isoLevel - d0) < 1e-10) { ex = p0x; ey = p0y; ez = p0z; }
              else if (Math.abs(isoLevel - d1) < 1e-10) { ex = p1x; ey = p1y; ez = p1z; }
              else if (Math.abs(d0 - d1) < 1e-10) { ex = p0x; ey = p0y; ez = p0z; }
              else {
                const tt = (isoLevel - d0) / (d1 - d0);
                ex = p0x + tt * (p1x - p0x);
                ey = p0y + tt * (p1y - p0y);
                ez = p0z + tt * (p1z - p0z);
              }
              triVerts.push([ex, ey, ez]);
            }

            const [v0, v1, v2] = triVerts;
            // Face normal
            const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
            const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
            else { nx = 0; ny = 1; nz = 0; }

            // Per-face color from centroid height
            const cy = (v0[1] + v1[1] + v2[1]) / 3;
            const unitY = cy / field.radius;
            const tType = classifyTerrainTypeByUnitY(unitY, biome);
            const [r, g, b] = terrainTypeColor(tType, biome);

            // Emit 3 unique vertices with same normal + color
            for (const v of triVerts) {
              verts.push(v[0], v[1], v[2], nx, ny, nz, r, g, b);
            }
            indexList.push(vertIdx, vertIdx + 1, vertIdx + 2);
            vertIdx += 3;

            if (vertIdx >= maxVerts) break;
          }
          if (vertIdx >= maxVerts) break;
        }
        if (vertIdx >= maxVerts) break;
      }
      if (vertIdx >= maxVerts) break;
    }

    const vertexCount = vertIdx;
    if (vertexCount >= maxVerts) {
      console.warn(`[terrain] extractMeshFromField (LOD step=${step}) hit maxVerts limit (${maxVerts}) — mesh is truncated!`);
    }
    const indices = indexList.length > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList);
    return { verts: new Float32Array(verts), indices, vertexCount, indexCount: indexList.length };
  }

  // ─── Full-detail path (step == 1): shared vertices via edge cache, smooth normals ───
  const edgeCache = new Map<number, number>();
  const positions: number[] = []; // x,y,z per vertex
  const indexList: number[] = [];

  function getEdgeVertex(x: number, y: number, z: number, edgeIdx: number, d: number[]): number {
    const [ox, oy, oz, axis] = MC_EDGE_AXIS[edgeIdx];
    const gx = x + ox, gy = y + oy, gz = z + oz;
    const key = ((gx * dimY + gy) * dimZ + gz) * 3 + axis;
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;

    const [c0, c1] = MC_EDGE_CORNERS[edgeIdx];
    const [ox0, oy0, oz0] = MC_CORNER_OFFSETS[c0];
    const [ox1, oy1, oz1] = MC_CORNER_OFFSETS[c1];
    const d0 = d[c0], d1 = d[c1];

    const p0x = (x + ox0) * vs + field.originX;
    const p0y = (y + oy0) * vs + field.originY;
    const p0z = (z + oz0) * vs + field.originZ;
    const p1x = (x + ox1) * vs + field.originX;
    const p1y = (y + oy1) * vs + field.originY;
    const p1z = (z + oz1) * vs + field.originZ;

    let ex: number, ey: number, ez: number;
    if (Math.abs(isoLevel - d0) < 1e-10) {
      ex = p0x; ey = p0y; ez = p0z;
    } else if (Math.abs(isoLevel - d1) < 1e-10) {
      ex = p1x; ey = p1y; ez = p1z;
    } else if (Math.abs(d0 - d1) < 1e-10) {
      ex = p0x; ey = p0y; ez = p0z;
    } else {
      const t = (isoLevel - d0) / (d1 - d0);
      ex = p0x + t * (p1x - p0x);
      ey = p0y + t * (p1y - p0y);
      ez = p0z + t * (p1z - p0z);
    }

    const idx = positions.length / 3;
    positions.push(ex, ey, ez);
    edgeCache.set(key, idx);
    return idx;
  }

  for (let x = 0; x < dimX - 1; x++) {
    for (let y = 0; y < dimY - 1; y++) {
      for (let z = 0; z < dimZ - 1; z++) {
        const d: number[] = new Array(8);
        let cubeIndex = 0;
        for (let i = 0; i < 8; i++) {
          const [ox, oy, oz] = MC_CORNER_OFFSETS[i];
          d[i] = getDensity(x + ox, y + oy, z + oz);
          if (d[i] < isoLevel) cubeIndex |= (1 << i);
        }

        if (cubeIndex === 0 || cubeIndex === 255) continue;

        const edges = MC_EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        const triBase = cubeIndex * 16;
        for (let t = 0; t < 15; t += 3) {
          const e0 = MC_TRI_TABLE[triBase + t];
          if (e0 < 0) break;
          const e1 = MC_TRI_TABLE[triBase + t + 1];
          const e2 = MC_TRI_TABLE[triBase + t + 2];

          const i0 = getEdgeVertex(x, y, z, e0, d);
          const i1 = getEdgeVertex(x, y, z, e1, d);
          const i2 = getEdgeVertex(x, y, z, e2, d);
          indexList.push(i0, i1, i2);
        }
        if (positions.length / 3 >= maxVerts) break;
      }
      if (positions.length / 3 >= maxVerts) break;
    }
    if (positions.length / 3 >= maxVerts) break;
  }

  const vertexCount = positions.length / 3;
  if (vertexCount >= maxVerts) {
    console.warn(`[terrain] extractMeshFromField hit maxVerts limit (${maxVerts}) — mesh is truncated!`);
  }

  // Compute per-vertex normals by averaging face normals.
  const vertHeights = new Float32Array(vertexCount);
  const vertTriCount = new Uint16Array(vertexCount);
  const vertNormals = new Float32Array(vertexCount * 3);

  for (let i = 0; i < indexList.length; i += 3) {
    const i0 = indexList[i], i1 = indexList[i + 1], i2 = indexList[i + 2];
    const v0y = positions[i0 * 3 + 1];
    const v1y = positions[i1 * 3 + 1];
    const v2y = positions[i2 * 3 + 1];
    const cy = (v0y + v1y + v2y) / 3;
    vertHeights[i0] += cy; vertHeights[i1] += cy; vertHeights[i2] += cy;
    vertTriCount[i0]++; vertTriCount[i1]++; vertTriCount[i2]++;

    // Face normal
    const ax = positions[i1 * 3] - positions[i0 * 3];
    const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3];
    const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    vertNormals[i0 * 3] += nx; vertNormals[i0 * 3 + 1] += ny; vertNormals[i0 * 3 + 2] += nz;
    vertNormals[i1 * 3] += nx; vertNormals[i1 * 3 + 1] += ny; vertNormals[i1 * 3 + 2] += nz;
    vertNormals[i2 * 3] += nx; vertNormals[i2 * 3 + 1] += ny; vertNormals[i2 * 3 + 2] += nz;
  }

  // Build final vertex buffer: pos3 + normal3 + color3 = 9 floats
  const vertsOut = new Float32Array(vertexCount * 9);
  for (let i = 0; i < vertexCount; i++) {
    const avgY = vertTriCount[i] > 0 ? vertHeights[i] / vertTriCount[i] : 0;
    const unitY = avgY / field.radius;
    const tType = classifyTerrainTypeByUnitY(unitY, biome);
    const [r, g, b] = terrainTypeColor(tType, biome);

    // Normalize accumulated normals
    let nx = vertNormals[i * 3];
    let ny = vertNormals[i * 3 + 1];
    let nz = vertNormals[i * 3 + 2];
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
    else { nx = 0; ny = 1; nz = 0; }

    const o = i * 9;
    vertsOut[o] = positions[i * 3];
    vertsOut[o + 1] = positions[i * 3 + 1];
    vertsOut[o + 2] = positions[i * 3 + 2];
    vertsOut[o + 3] = nx; vertsOut[o + 4] = ny; vertsOut[o + 5] = nz;
    vertsOut[o + 6] = r; vertsOut[o + 7] = g; vertsOut[o + 8] = b;
  }

  const indices = indexList.length > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList);
  return { verts: vertsOut, indices, vertexCount, indexCount: indexList.length };
}
