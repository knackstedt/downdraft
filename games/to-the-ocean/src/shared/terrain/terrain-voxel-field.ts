// Extracted from TerrainGenerator.ts — part of terrain decomposition

import { PerlinNoise3D } from "@downdraft/core";
import { VoxelField } from "@downdraft/library-marching-cubes";
import { TERRAIN_CONFIG } from "../terrain-config";
import { PerlinNoise } from "../world/perlin-noise";

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth union of two density fields — blends overlapping blobs
export function smoothUnion(d1: number, d2: number, k: number): number {
  const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
  return Math.max(d1, d2) + h * h * k * 0.25;
}

export interface BlobCenter {
  x: number;     // unit-space offset from island center (-1..1)
  z: number;
  radius: number;  // fraction of island radius
  strength: number;
  heightMul: number; // per-blob height multiplier (0..1)
}

export interface IslandBlob {
  x: number;        // unit-space offset from island center (-1..1)
  z: number;
  radius: number;   // fraction of island radius
  heightMul: number;
}

// Cache for generateIslandBlobs — islands don't move, so blobs are deterministic per chunk
const islandBlobCache = new Map<string, IslandBlob[]>();

// Generate blob centers for an island without building the full voxel field.
// The rng sequence MUST match generateVoxelField exactly so blobs are identical.
export function generateIslandBlobs(chunkX: number, chunkZ: number): IslandBlob[] {
  const key = `${chunkX},${chunkZ}`;
  const cached = islandBlobCache.get(key);
  if (cached) return cached;
  const cfg = TERRAIN_CONFIG;
  const seed = chunkX * 92837111 + chunkZ * 72635341;
  const rng = mulberry32(seed);

  const blobs: IslandBlob[] = [];
  const blobCount = cfg.blobCount;
  const islandHeightMul = 0.4 + rng() * 0.6;
  const peakCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < blobCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng() * cfg.blobSpread;
    const isPeak = i < peakCount;
    const radius = isPeak
      ? cfg.blobMinRadius * 0.5 + rng() * 0.15
      : cfg.blobMinRadius + rng() * (cfg.blobMaxRadius - cfg.blobMinRadius);
    rng(); // skip strength — consume rng to match generateVoxelField sequence
    const heightMul = isPeak
      ? islandHeightMul * (0.8 + rng() * 0.2)
      : rng() * 0.08;
    blobs.push({ x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, radius, heightMul });
  }
  blobs.push({ x: 0, z: 0, radius: 0.8, heightMul: 0 });
  const panhandleCount = Math.floor(rng() * 3);
  for (let i = 0; i < panhandleCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = 0.7 + rng() * 0.2;
    const radius = 0.2 + rng() * 0.15;
    rng(); // skip strength
    const heightMul = rng() * 0.05;
    blobs.push({ x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, radius, heightMul });
  }
  islandBlobCache.set(key, blobs);
  return blobs;
}

export function generateVoxelField(
  chunkX: number,
  chunkZ: number,
  radius: number,    // world-space island radius
  biome: number,
  islandSize: number,
  voxelSizeOverride?: number,  // optional custom voxel size (e.g. for physics coarse LOD)
): VoxelField {
  const cfg = TERRAIN_CONFIG;
  const seed = chunkX * 92837111 + chunkZ * 72635341;
  const rng = mulberry32(seed);

  // 2D noise for height modulation and cliff placement
  const heightNoise = new PerlinNoise(seed ^ 0xABCDEF01);
  const cliffNoise2D = new PerlinNoise(seed ^ 0x56781234);
  // 3D noise for cave carving
  const caveNoise = new PerlinNoise3D(seed ^ 0xDEADBEEF);

  // Generate blob centers for blobular island shape
  const blobs: BlobCenter[] = [];
  const blobCount = cfg.blobCount;
  // Per-island peak height multiplier: peakHeight is an upper bound, not every island reaches it
  const islandHeightMul = 0.4 + rng() * 0.6;  // 0.4..1.0
  // 1-2 peak blobs rise above beach level; rest are flat (beach level)
  const peakCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < blobCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng() * cfg.blobSpread;
    const isPeak = i < peakCount;
    blobs.push({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius: isPeak
        ? cfg.blobMinRadius * 0.5 + rng() * 0.15
        : cfg.blobMinRadius + rng() * (cfg.blobMaxRadius - cfg.blobMinRadius),
      strength: cfg.blobMinStrength + rng() * (cfg.blobMaxStrength - cfg.blobMinStrength),
      heightMul: isPeak
        ? islandHeightMul * (0.8 + rng() * 0.2)
        : rng() * 0.08,
    });
  }
  // Always add a central blob for a solid core at beach level
  blobs.push({ x: 0, z: 0, radius: 0.8, strength: 1.0, heightMul: 0 });

  // Panhandle blobs: 0-2 small elongated blobs at the island edge to create
  // narrow peninsular strips extending outward from the main landmass.
  const panhandleCount = Math.floor(rng() * 3);
  for (let i = 0; i < panhandleCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = 0.7 + rng() * 0.2;
    blobs.push({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius: 0.2 + rng() * 0.15,
      strength: 0.5 + rng() * 0.2,
      heightMul: rng() * 0.05,
    });
  }

  // Per-island cliff direction — one side gentle slope, other side steep cliff
  const cliffAngle = rng() * Math.PI * 2;
  const cliffDirX = Math.cos(cliffAngle);
  const cliffDirZ = Math.sin(cliffAngle);

  // Compute voxel grid dimensions
  // XZ: cover max blob extent (offset + radius*gentleSideRadius + edgeExtend) with margin
  // Y: cover peak + depth + margin
  const unitExtent = 2.0;  // unit-space half-extent (blobs can reach 0.5+1.0*1.25+0.25=2.0)
  const xzWorldExtent = unitExtent * radius;  // world-space half-extent
  // Y extent must account for smooth union pushing peaks higher than nominal
  // peakHeight, especially on the cliff side where depth is reduced.
  const yWorldExtent = (cfg.peakHeight + cfg.depthHeight) * radius * cfg.yExtentMultiplier;

  const vs = voxelSizeOverride ?? cfg.voxelSize;
  const dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  // Clamp to memory limit
  const totalVoxels = dimX * dimY * dimZ;
  const memBytes = totalVoxels * 4;
  if (memBytes > cfg.maxVoxelMemory) {
    // Reduce resolution to fit
    const scale = Math.cbrt(cfg.maxVoxelMemory / memBytes);
    const newVs = vs / scale;
    return generateVoxelFieldCore(radius, newVs, blobs, heightNoise, cliffNoise2D, caveNoise, cliffDirX, cliffDirZ);
  }

  return generateVoxelFieldCore(radius, vs, blobs, heightNoise, cliffNoise2D, caveNoise, cliffDirX, cliffDirZ);
}

// Shared core voxel generation with X/Z column precomputation.
// Precomputes all X/Z-dependent values (blob distances, noise, cliff projections)
// once per column, then iterates only over Y in the inner loop.
function generateVoxelFieldCore(
  radius: number,
  vs: number,
  blobs: BlobCenter[],
  heightNoise: PerlinNoise,
  cliffNoise2D: PerlinNoise,
  caveNoise: PerlinNoise3D,
  cliffDirX: number,
  cliffDirZ: number,
): VoxelField {
  const cfg = TERRAIN_CONFIG;
  const unitExtent = 2.0;
  const xzWorldExtent = unitExtent * radius;
  const yWorldExtent = (cfg.peakHeight + cfg.depthHeight) * radius * cfg.yExtentMultiplier;

  const dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  const totalVoxels = dimX * dimY * dimZ;
  const data = new Float32Array(totalVoxels);

  const originX = -xzWorldExtent;
  const originY = -yWorldExtent;
  const originZ = -xzWorldExtent;

  // Precomputed per-column data
  const numBlobs = blobs.length;
  const colHeightNoise = new Float32Array(dimX * dimZ);
  const colCliffStrength = new Float32Array(dimX * dimZ); // 0 if no cliff, positive value otherwise

  // Per-blob per-column precomputation
  const colBlobHeightAtPoint = new Float32Array(dimX * dimZ * numBlobs);
  const colBlobSkip = new Uint8Array(dimX * dimZ * numBlobs); // 1 = skip this blob for this column
  const colBeachBoost = new Float32Array(dimX * dimZ); // union boost at uy=0 from beach blobs

  const invR = 1 / radius;

  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR;
      const uz = wz * invR;

      // Precompute 2D noise values for this column
      colHeightNoise[colIdx] = heightNoise.fbm(ux * cfg.heightNoiseScale, uz * cfg.heightNoiseScale, cfg.heightNoiseOctaves, 0.5, 2.0);
      const cliffN = cliffNoise2D.fbm(ux * cfg.cliffNoiseScale, uz * cfg.cliffNoiseScale, 3, 0.5, 2.0);
      colCliffStrength[colIdx] = cliffN > cfg.cliffNoiseThreshold ? (cliffN - cfg.cliffNoiseThreshold) * 1.5 : 0;

      // Precompute per-blob data for this column
      for (let b = 0; b < numBlobs; b++) {
        const blob = blobs[b];
        const dx = ux - blob.x;
        const dz = uz - blob.z;
        const distSq = dx * dx + dz * dz;
        const proj = dx * cliffDirX + dz * cliffDirZ;
        const sideScale = proj > 0 ? cfg.gentleSideRadius : cfg.cliffSideRadius;
        const r = blob.radius * sideScale;
        const extR = r + cfg.blobEdgeExtend;
        const extRsq = extR * extR;
        const blobOffset = colIdx * numBlobs + b;

        if (distSq > extRsq) {
          colBlobSkip[blobOffset] = 1;
          continue;
        }
        colBlobSkip[blobOffset] = 0;
        const t = 1 - distSq / extRsq;
        const falloff = t > 0 ? Math.min(1, Math.pow(t, cfg.plateauSharpness) * 1.8) : 0;
        const depthFactor = proj > 0 ? 1.0 : cfg.cliffDepthFactor;
        const baseDepth = cfg.depthHeight * depthFactor;
        colBlobHeightAtPoint[blobOffset] = falloff * (baseDepth + cfg.peakHeight * blob.heightMul) - baseDepth;
      }

      // Compute the smooth-union density boost at uy=0 from beach blobs only.
      // Overlapping beach blobs (heightMul≈0) all produce density≈0 at uy=0,
      // and smoothUnion adds h²*k*0.25 for each pair, pushing the surface above water.
      // We measure this boost and subtract it later so beaches land exactly at y=0.
      let beachDensityAtZero = -1.0;
      for (let b = 0; b < numBlobs; b++) {
        const blobOffset = colIdx * numBlobs + b;
        if (colBlobSkip[blobOffset]) continue;
        const blob = blobs[b];
        if (blob.heightMul > 0.1) continue; // only beach-level blobs
        const blobDensity = colBlobHeightAtPoint[blobOffset] * blob.strength;
        beachDensityAtZero = smoothUnion(beachDensityAtZero, blobDensity, cfg.blobSmoothUnionK);
      }
      colBeachBoost[colIdx] = beachDensityAtZero > 0 ? beachDensityAtZero : 0;
    }
  }

  // Main voxel loop — inner loop only iterates over Y
  const dimYDimZ = dimY * dimZ;
  const caveMaxHeight = cfg.peakHeight * (1 - cfg.caveMinDepth);

  for (let vx = 0; vx < dimX; vx++) {
    for (let vz = 0; vz < dimZ; vz++) {
      const colIdx = vx * dimZ + vz;
      const wx = vx * vs + originX;
      const wz = vz * vs + originZ;
      const ux = wx * invR;
      const uz = wz * invR;

      const heightNoiseVal = colHeightNoise[colIdx];
      const heightMod = (heightNoiseVal - 0.5) * cfg.heightNoiseAmplitude;
      const cliffStrength = colCliffStrength[colIdx];

      const colBase = vx * dimYDimZ + vz; // base index for this column in data (will add vy * dimZ)

      for (let vy = 0; vy < dimY; vy++) {
        const wy = vy * vs + originY;
        const uy = wy * invR;

        // --- Layer 1: Asymmetric shield volcano base ---
        let baseDensity = -1.0;
        for (let b = 0; b < numBlobs; b++) {
          const blobOffset = colIdx * numBlobs + b;
          if (colBlobSkip[blobOffset]) continue;
          const blob = blobs[b];
          const blobDensity = (colBlobHeightAtPoint[blobOffset] - uy) * blob.strength;
          baseDensity = smoothUnion(baseDensity, blobDensity, cfg.blobSmoothUnionK);
        }
        // Subtract beach union boost so beach surface aligns with water level (y=0).
        // Peak blobs are unaffected: their density at uy=0 is already high, so
        // subtracting the beach boost still leaves them above the iso-surface.
        baseDensity -= colBeachBoost[colIdx];

        // --- Layer 2: Height modulation (fBm noise) ---
        let density = baseDensity + heightMod * Math.max(0, baseDensity + 0.5);

        // --- Layer 3: Beach flattening ---
        if (uy > -cfg.beachThreshold && uy < cfg.beachThreshold && density > -0.3) {
          const beachFactor = 1 - Math.abs(uy) / cfg.beachThreshold;
          density = density * (1 - beachFactor * cfg.beachGradientScale) + beachFactor * 0.01;
        }

        // --- Layer 4: Cliff bands ---
        if (cliffStrength > 0 && uy > 0 && density > -0.2) {
          density += cliffStrength * Math.max(0, 1 - Math.abs(uy / cfg.peakHeight));
        }

        // --- Layer 5: Cave carving ---
        if (cfg.caveEnabled && density > cfg.caveThreshold && uy < caveMaxHeight) {
          const caveN = caveNoise.fbm3D(
            ux * cfg.caveNoiseScale, uy * cfg.caveNoiseScale, uz * cfg.caveNoiseScale,
            cfg.caveNoiseOctaves, 0.5, 2.0,
          );
          if (caveN > cfg.caveThreshold) {
            const carveStrength = (caveN - cfg.caveThreshold) / (1 - cfg.caveThreshold);
            density -= carveStrength * 2;
          }
        }

        // --- Layer 6: Hard ceiling at peakHeight ---
        // smoothUnion of overlapping blobs pushes the effective surface above peakHeight.
        // Without an explicit clamp, the terrain gets clipped at the voxel field boundary
        // with no proper density transition, causing missing/garbled triangles at the top.
        // This linear falloff gives marching cubes clean density values above peakHeight.
        if (uy > cfg.peakHeight) {
          density = Math.min(density, -(uy - cfg.peakHeight));
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

// ============================================================================
// Chunked Voxel Field — on-demand chunk generation for high-resolution islands
// Stores voxel data in fixed-size chunks (chunkSize³) to avoid allocating
// the full dimX×dimY×dimZ array upfront. Only non-empty chunks are stored.
// ============================================================================

// Pre-computed generation context (not transferred via IPC, only on generation side)
