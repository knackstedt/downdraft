// ============================================================================
// TerrainGenerator — layered volumetric island generation
// 1. Blobular base shape (overlapping radial falloffs)
// 2. Height modulation (fBm noise)
// 3. Beach flattening near water level
// 4. Cliff bands (steep gradient zones)
// 5. Cave carving (3D noise tunnels)
//
// Also includes generatePortVoxelField() — a simplified flat plateau terrain
// for port entities, with beach transition, underwater shelf, and optional
// caves/secret tunnels beneath the dock.
// ============================================================================

import { extractMesh, extractMeshSubRegion } from "./MarchingCubes";
import { PerlinNoise3D } from "./PerlinNoise3D";
import { TERRAIN_CONFIG } from "./TerrainConfig";
import { ChunkedVoxelField, getChunkedVoxel, VoxelField } from "./TerrainTypes";
import { PerlinNoise } from "./world/PerlinNoise";

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
function mulberry32(seed: number): () => number {
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
function smoothUnion(d1: number, d2: number, k: number): number {
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
export interface ChunkedFieldContext {
  blobs: BlobCenter[];
  caveNoise: PerlinNoise3D;
  // Pre-computed per-column data (dimX * dimZ)
  colHeightNoise: Float32Array;
  colCliffStrength: Float32Array;
  colBlobHeightAtPoint: Float32Array;  // dimX * dimZ * numBlobs
  colBlobSkip: Uint8Array;             // dimX * dimZ * numBlobs
  colBeachBoost: Float32Array;         // dimX * dimZ
  numBlobs: number;
  invR: number;
}

// Evaluate density at a single voxel without storing it.
// Used for border voxels in mesh extraction, raycasting, and height sampling.
function computeDensityAt(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  vx: number, vy: number, vz: number,
): number {
  if (vx < 0 || vx >= field.dimX || vy < 0 || vy >= field.dimY || vz < 0 || vz >= field.dimZ) return -1.0;
  const cfg = TERRAIN_CONFIG;
  const vs = field.voxelSize;
  const dimZ = field.dimZ;
  const originX = field.originX;
  const originY = field.originY;
  const originZ = field.originZ;

  const colIdx = vx * dimZ + vz;
  const wx = vx * vs + originX;
  const wz = vz * vs + originZ;
  const ux = wx * ctx.invR;
  const uz = wz * ctx.invR;
  const wy = vy * vs + originY;
  const uy = wy * ctx.invR;

  const heightNoiseVal = ctx.colHeightNoise[colIdx];
  const heightMod = (heightNoiseVal - 0.5) * cfg.heightNoiseAmplitude;
  const cliffStrength = ctx.colCliffStrength[colIdx];

  // Layer 1: Asymmetric shield volcano base
  let baseDensity = -1.0;
  for (let b = 0; b < ctx.numBlobs; b++) {
    const blobOffset = colIdx * ctx.numBlobs + b;
    if (ctx.colBlobSkip[blobOffset]) continue;
    const blob = ctx.blobs[b];
    const blobDensity = (ctx.colBlobHeightAtPoint[blobOffset] - uy) * blob.strength;
    baseDensity = smoothUnion(baseDensity, blobDensity, cfg.blobSmoothUnionK);
  }
  baseDensity -= ctx.colBeachBoost[colIdx];

  // Layer 2: Height modulation
  let density = baseDensity + heightMod * Math.max(0, baseDensity + 0.5);

  // Layer 3: Beach flattening
  if (uy > -cfg.beachThreshold && uy < cfg.beachThreshold && density > -0.3) {
    const beachFactor = 1 - Math.abs(uy) / cfg.beachThreshold;
    density = density * (1 - beachFactor * cfg.beachGradientScale) + beachFactor * 0.01;
  }

  // Layer 4: Cliff bands
  if (cliffStrength > 0 && uy > 0 && density > -0.2) {
    density += cliffStrength * Math.max(0, 1 - Math.abs(uy / cfg.peakHeight));
  }

  // Layer 5: Cave carving
  const caveMaxHeight = cfg.peakHeight * (1 - cfg.caveMinDepth);
  if (cfg.caveEnabled && density > cfg.caveThreshold && uy < caveMaxHeight) {
    const caveN = ctx.caveNoise.fbm3D(
      ux * cfg.caveNoiseScale, uy * cfg.caveNoiseScale, uz * cfg.caveNoiseScale,
      cfg.caveNoiseOctaves, 0.5, 2.0,
    );
    if (caveN > cfg.caveThreshold) {
      const carveStrength = (caveN - cfg.caveThreshold) / (1 - cfg.caveThreshold);
      density -= carveStrength * 2;
    }
  }

  // Layer 6: Hard ceiling at peakHeight
  if (uy > cfg.peakHeight) {
    density = Math.min(density, -(uy - cfg.peakHeight));
  }

  return density;
}

// Create a ChunkedVoxelField for an island, with pre-computed column data.
// Returns the field (for storage/IPC) and context (for chunk generation, kept on generation side).
export function createChunkedVoxelField(
  chunkX: number,
  chunkZ: number,
  radius: number,
  biome: number,
  islandSize: number,
  voxelSizeOverride?: number,
): { field: ChunkedVoxelField; ctx: ChunkedFieldContext } {
  const cfg = TERRAIN_CONFIG;
  const seed = chunkX * 92837111 + chunkZ * 72635341;
  const rng = mulberry32(seed);

  const heightNoise = new PerlinNoise(seed ^ 0xABCDEF01);
  const cliffNoise2D = new PerlinNoise(seed ^ 0x56781234);
  const caveNoise = new PerlinNoise3D(seed ^ 0xDEADBEEF);

  // Generate blob centers (same sequence as generateVoxelField)
  const blobs: BlobCenter[] = [];
  const blobCount = cfg.blobCount;
  const islandHeightMul = 0.4 + rng() * 0.6;
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
  blobs.push({ x: 0, z: 0, radius: 0.8, strength: 1.0, heightMul: 0 });

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

  const cliffAngle = rng() * Math.PI * 2;
  const cliffDirX = Math.cos(cliffAngle);
  const cliffDirZ = Math.sin(cliffAngle);

  // Compute grid dimensions
  const unitExtent = 2.0;
  const xzWorldExtent = unitExtent * radius;
  const yWorldExtent = (cfg.peakHeight + cfg.depthHeight) * radius * cfg.yExtentMultiplier;

  const vs = voxelSizeOverride ?? cfg.voxelSize;
  const dimX = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimZ = Math.ceil((xzWorldExtent * 2) / vs) + 1;
  const dimY = Math.ceil((yWorldExtent * 2) / vs) + 1;

  const originX = -xzWorldExtent;
  const originY = -yWorldExtent;
  const originZ = -xzWorldExtent;

  const numBlobs = blobs.length;
  const invR = 1 / radius;

  // Pre-compute per-column data (same logic as generateVoxelFieldCore)
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
      const ux = wx * invR;
      const uz = wz * invR;

      colHeightNoise[colIdx] = heightNoise.fbm(ux * cfg.heightNoiseScale, uz * cfg.heightNoiseScale, cfg.heightNoiseOctaves, 0.5, 2.0);
      const cliffN = cliffNoise2D.fbm(ux * cfg.cliffNoiseScale, uz * cfg.cliffNoiseScale, 3, 0.5, 2.0);
      colCliffStrength[colIdx] = cliffN > cfg.cliffNoiseThreshold ? (cliffN - cfg.cliffNoiseThreshold) * 1.5 : 0;

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

  const ctx: ChunkedFieldContext = {
    blobs, caveNoise,
    colHeightNoise, colCliffStrength, colBlobHeightAtPoint, colBlobSkip, colBeachBoost,
    numBlobs, invR,
  };

  // Determine chunk layout
  const chunkSize = cfg.chunkSize;
  const chunkBits = cfg.chunkBits;
  const chunkMask = cfg.chunkMask;
  const voxelsPerChunk = chunkSize * chunkSize * chunkSize;
  const chunkDimX = Math.ceil(dimX / chunkSize);
  const chunkDimY = Math.ceil(dimY / chunkSize);
  const chunkDimZ = Math.ceil(dimZ / chunkSize);
  const totalChunks = chunkDimX * chunkDimY * chunkDimZ;

  // Compute Y bounds for terrain surface (with margin for smooth union)
  const yMinUnit = -cfg.depthHeight * 1.3;
  const yMaxUnit = cfg.peakHeight * 2.0;
  const vyTerrainMin = Math.floor((yMinUnit * radius - originY) / vs);
  const vyTerrainMax = Math.ceil((yMaxUnit * radius - originY) / vs);
  const cyMin = Math.max(0, Math.floor(vyTerrainMin / chunkSize));
  const cyMax = Math.min(chunkDimY, Math.ceil(vyTerrainMax / chunkSize));

  // Determine which chunks are non-empty:
  // A chunk is non-empty if it has any non-skipped column in its XZ extent
  // AND its Y range overlaps the terrain surface bounds.
  const chunkOffsets = new Int32Array(totalChunks).fill(-1);
  let nonEmptyCount = 0;

  for (let cx = 0; cx < chunkDimX; cx++) {
    for (let cz = 0; cz < chunkDimZ; cz++) {
      const x0 = cx * chunkSize;
      const z0 = cz * chunkSize;
      const x1 = Math.min(x0 + chunkSize, dimX);
      const z1 = Math.min(z0 + chunkSize, dimZ);
      let hasNonSkipped = false;
      for (let vx = x0; vx < x1 && !hasNonSkipped; vx++) {
        for (let vz = z0; vz < z1; vz++) {
          const colIdx = vx * dimZ + vz;
          for (let b = 0; b < numBlobs; b++) {
            if (!colBlobSkip[colIdx * numBlobs + b]) {
              hasNonSkipped = true;
              break;
            }
          }
          if (hasNonSkipped) break;
        }
      }
      if (hasNonSkipped) {
        for (let cy = cyMin; cy < cyMax; cy++) {
          const chunkIdx = cx * chunkDimY * chunkDimZ + cy * chunkDimZ + cz;
          chunkOffsets[chunkIdx] = 0; // mark non-empty (offset assigned below)
          nonEmptyCount++;
        }
      }
    }
  }

  // Assign buffer offsets to non-empty chunks
  let nextOffset = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (chunkOffsets[i] === 0) {
      chunkOffsets[i] = nextOffset;
      nextOffset += voxelsPerChunk;
    }
  }

  const totalFloats = nonEmptyCount * voxelsPerChunk;
  const buffer = new ArrayBuffer(totalFloats * 4);
  const view = new Float32Array(buffer);
  const chunkGenerated = new Uint8Array(totalChunks);

  const field: ChunkedVoxelField = {
    dimX, dimY, dimZ,
    voxelSize: vs,
    originX, originY, originZ,
    isoLevel: cfg.isoLevel,
    radius,
    chunkSize, chunkBits, chunkMask,
    chunkDimX, chunkDimY, chunkDimZ,
    voxelsPerChunk,
    buffer, view, chunkOffsets, chunkGenerated,
    totalChunkSlots: nonEmptyCount,
    nextChunkOffset: totalFloats,
    chunkX, chunkZ,
    isPort: false,
  };

  return { field, ctx };
}

// Generate voxel data for a single chunk and write it into the field's buffer.
function generateChunkData(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  cx: number, cy: number, cz: number,
): void {
  const cs = field.chunkSize;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  const offset = field.chunkOffsets[chunkIdx];

  const gx0 = cx * cs;
  const gy0 = cy * cs;
  const gz0 = cz * cs;
  const gx1 = Math.min(gx0 + cs, field.dimX);
  const gy1 = Math.min(gy0 + cs, field.dimY);
  const gz1 = Math.min(gz0 + cs, field.dimZ);

  for (let vx = gx0; vx < gx1; vx++) {
    for (let vy = gy0; vy < gy1; vy++) {
      for (let vz = gz0; vz < gz1; vz++) {
        const density = computeDensityAt(field, ctx, vx, vy, vz);
        const lx = vx - gx0;
        const ly = vy - gy0;
        const lz = vz - gz0;
        field.view[offset + lx * cs * cs + ly * cs + lz] = density;
      }
    }
  }
}

// Ensure a chunk's data has been generated. No-op if already generated or empty.
export function ensureChunkGenerated(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  cx: number, cy: number, cz: number,
): void {
  if (cx < 0 || cx >= field.chunkDimX || cy < 0 || cy >= field.chunkDimY || cz < 0 || cz >= field.chunkDimZ) return;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  if (field.chunkGenerated[chunkIdx]) return;
  field.chunkGenerated[chunkIdx] = 1;
  if (field.chunkOffsets[chunkIdx] < 0) return; // empty chunk
  generateChunkData(field, ctx, cx, cy, cz);
}

// Materialize a chunk + 1-voxel border into a temporary VoxelField for mesh extraction.
// Border voxels are read from generated neighbor chunks, or evaluated directly if not generated.
// Returns null if the chunk is empty (no data to mesh).
export function materializeChunkForMesh(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  cx: number, cy: number, cz: number,
): VoxelField | null {
  const cs = field.chunkSize;
  const vs = field.voxelSize;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  if (field.chunkOffsets[chunkIdx] < 0) return null; // empty chunk

  // Ensure the chunk itself is generated
  ensureChunkGenerated(field, ctx, cx, cy, cz);

  // Chunk voxel range (global coordinates)
  const gx0 = cx * cs;
  const gy0 = cy * cs;
  const gz0 = cz * cs;
  const gx1 = Math.min(gx0 + cs, field.dimX);
  const gy1 = Math.min(gy0 + cs, field.dimY);
  const gz1 = Math.min(gz0 + cs, field.dimZ);

  // Materialized field includes 1-voxel border on each side
  const mx0 = Math.max(0, gx0 - 1);
  const my0 = Math.max(0, gy0 - 1);
  const mz0 = Math.max(0, gz0 - 1);
  const mx1 = Math.min(field.dimX, gx1 + 1);
  const my1 = Math.min(field.dimY, gy1 + 1);
  const mz1 = Math.min(field.dimZ, gz1 + 1);

  const mDimX = mx1 - mx0;
  const mDimY = my1 - my0;
  const mDimZ = mz1 - mz0;
  const mData = new Float32Array(mDimX * mDimY * mDimZ);

  for (let vx = mx0; vx < mx1; vx++) {
    for (let vy = my0; vy < my1; vy++) {
      for (let vz = mz0; vz < mz1; vz++) {
        const localIdx = (vx - mx0) * mDimY * mDimZ + (vy - my0) * mDimZ + (vz - mz0);
        const ncx = vx >>> field.chunkBits;
        const ncy = vy >>> field.chunkBits;
        const ncz = vz >>> field.chunkBits;
        const nChunkIdx = ncx * field.chunkDimY * field.chunkDimZ + ncy * field.chunkDimZ + ncz;
        if (field.chunkOffsets[nChunkIdx] >= 0 && field.chunkGenerated[nChunkIdx]) {
          mData[localIdx] = getChunkedVoxel(field, vx, vy, vz);
        } else {
          mData[localIdx] = computeDensityAt(field, ctx, vx, vy, vz);
        }
      }
    }
  }

  return {
    data: mData,
    dimX: mDimX, dimY: mDimY, dimZ: mDimZ,
    voxelSize: vs,
    originX: mx0 * vs + field.originX,
    originY: my0 * vs + field.originY,
    originZ: mz0 * vs + field.originZ,
    isoLevel: field.isoLevel,
    radius: field.radius,
  };
}

// Get the local sub-region bounds for extractMeshSubRegion when using a materialized chunk.
// Returns { x0, y0, z0, x1, y1, z1 } in the materialized field's local coordinates.
export function getChunkMeshSubRegion(
  field: ChunkedVoxelField,
  cx: number, cy: number, cz: number,
): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } {
  const cs = field.chunkSize;
  const gx0 = cx * cs;
  const gy0 = cy * cs;
  const gz0 = cz * cs;
  const gx1 = Math.min(gx0 + cs, field.dimX);
  const gy1 = Math.min(gy0 + cs, field.dimY);
  const gz1 = Math.min(gz0 + cs, field.dimZ);
  const mx0 = Math.max(0, gx0 - 1);
  const my0 = Math.max(0, gy0 - 1);
  const mz0 = Math.max(0, gz0 - 1);
  return {
    x0: gx0 - mx0,
    y0: gy0 - my0,
    z0: gz0 - mz0,
    x1: gx1 - mx0,
    y1: gy1 - my0,
    z1: gz1 - mz0,
  };
}

// Sample terrain surface height using a ChunkedVoxelField (evaluates density directly,
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
