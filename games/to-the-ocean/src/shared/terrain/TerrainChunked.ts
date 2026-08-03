// Extracted from TerrainGenerator.ts — part of terrain decomposition

import { PerlinNoise3D } from "../PerlinNoise3D";
import { TERRAIN_CONFIG } from "../TerrainConfig";
import { CHUNK_EMPTY, CHUNK_FULL, CHUNK_SOLID, ChunkedVoxelField, getChunkedVoxel, promoteChunk, VoxelField } from "../TerrainTypes";
import { PerlinNoise } from "../world/PerlinNoise";
import { BlobCenter, mulberry32, smoothUnion } from "./TerrainVoxelField";

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
export function computeDensityAt(
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

  // Determine which chunks are non-empty and classify them.
  // A chunk is non-empty if it has any non-skipped column in its XZ extent
  // AND its Y range overlaps the terrain surface bounds.
  // Classification: FullSolid (all above iso), FullEmpty (all below iso), Full (mixed).
  // Only Full chunks get buffer space — saves memory on solid interior and empty exterior.
  const chunkOffsets = new Int32Array(totalChunks).fill(-1);
  const chunkClass = new Uint8Array(totalChunks); // default 0 = FullEmpty
  let fullChunkCount = 0;

  // Partial field for density sampling (computeDensityAt only reads dims/origin/voxelSize)
  const partialField = {
    dimX, dimY, dimZ, voxelSize: vs, originX, originY, originZ,
    isoLevel: cfg.isoLevel, radius,
  } as ChunkedVoxelField;

  const sampleStride = cfg.sparseSampleStride;
  const solidMargin = cfg.sparseSolidMargin;
  const sparseEnabled = cfg.sparseEnabled;

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

          if (sparseEnabled) {
            // Sample density at coarse grid to classify chunk
            const gx0 = cx * chunkSize;
            const gy0 = cy * chunkSize;
            const gz0 = cz * chunkSize;
            let allSolid = true;
            let allEmpty = true;
            for (let sx = 0; sx < chunkSize; sx += sampleStride) {
              for (let sy = 0; sy < chunkSize; sy += sampleStride) {
                for (let sz = 0; sz < chunkSize; sz += sampleStride) {
                  const vx = Math.min(gx0 + sx, dimX - 1);
                  const vy = Math.min(gy0 + sy, dimY - 1);
                  const vz = Math.min(gz0 + sz, dimZ - 1);
                  const d = computeDensityAt(partialField, ctx, vx, vy, vz);
                  if (d < cfg.isoLevel + solidMargin) allSolid = false;
                  if (d > cfg.isoLevel - solidMargin) allEmpty = false;
                }
              }
            }
            if (allSolid) {
              chunkClass[chunkIdx] = CHUNK_SOLID;
            } else if (allEmpty) {
              chunkClass[chunkIdx] = CHUNK_EMPTY;
            } else {
              chunkClass[chunkIdx] = CHUNK_FULL;
              chunkOffsets[chunkIdx] = 0; // mark for allocation
              fullChunkCount++;
            }
          } else {
            // Sparse disabled: allocate all non-empty chunks (original behavior)
            chunkClass[chunkIdx] = CHUNK_FULL;
            chunkOffsets[chunkIdx] = 0;
            fullChunkCount++;
          }
        }
      }
    }
  }

  // Assign buffer offsets to Full chunks only
  let nextOffset = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (chunkOffsets[i] === 0) {
      chunkOffsets[i] = nextOffset;
      nextOffset += voxelsPerChunk;
    }
  }

  const totalFloats = fullChunkCount * voxelsPerChunk;
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
    buffer, view, chunkOffsets, chunkGenerated, chunkClass,
    totalChunkSlots: fullChunkCount,
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
  if (field.chunkOffsets[chunkIdx] < 0) return; // FullSolid or FullEmpty — no data to generate
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

  // Materialized field includes 2-voxel border on each side.
  // The extra border ensures that +1 border vertices (used for seam-closing
  // quads) have valid corner data — surface nets vertex at cell (x,y,z) samples
  // corners at (x+1, y+1, z+1), so a 2-voxel border is needed for the +1
  // border vertex to have all 8 corners in-bounds.
  const mx0 = Math.max(0, gx0 - 2);
  const my0 = Math.max(0, gy0 - 2);
  const mz0 = Math.max(0, gz0 - 2);
  const mx1 = Math.min(field.dimX, gx1 + 2);
  const my1 = Math.min(field.dimY, gy1 + 2);
  const mz1 = Math.min(field.dimZ, gz1 + 2);

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
        if (field.chunkGenerated[nChunkIdx] && field.chunkClass[nChunkIdx] === CHUNK_FULL) {
          // Only use buffer data for Full chunks; Solid/Empty sentinels would create
          // flat density at borders, distorting normals. Recompute density for smooth gradients.
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
  const mx0 = Math.max(0, gx0 - 2);
  const my0 = Math.max(0, gy0 - 2);
  const mz0 = Math.max(0, gz0 - 2);
  return {
    x0: gx0 - mx0,
    y0: gy0 - my0,
    z0: gz0 - mz0,
    x1: gx1 - mx0,
    y1: gy1 - my0,
    z1: gz1 - mz0,
  };
}

// Promote a FullSolid or FullEmpty chunk to Full with real density data for deformation.
// Allocates buffer space and fills with actual density values from computeDensityAt.
export function promoteChunkWithData(
  field: ChunkedVoxelField,
  ctx: ChunkedFieldContext,
  chunkIdx: number,
): void {
  const cls = field.chunkClass[chunkIdx];
  if (cls === CHUNK_FULL && field.chunkOffsets[chunkIdx] >= 0) return; // already full

  const offset = promoteChunk(field, chunkIdx);
  if (offset < 0) return;

  // Regenerate real density values for the chunk
  const cs = field.chunkSize;
  const cy = chunkIdx % (field.chunkDimY * field.chunkDimZ);
  const cx = Math.floor(chunkIdx / (field.chunkDimY * field.chunkDimZ));
  const cz = cy % field.chunkDimZ;
  const cyy = Math.floor(cy / field.chunkDimZ);

  const gx0 = cx * cs;
  const gy0 = cyy * cs;
  const gz0 = cz * cs;
  const gx1 = Math.min(gx0 + cs, field.dimX);
  const gy1 = Math.min(gy0 + cs, field.dimY);
  const gz1 = Math.min(gz0 + cs, field.dimZ);

  for (let vx = gx0; vx < gx1; vx++) {
    for (let vy = gy0; vy < gy1; vy++) {
      for (let vz = gz0; vz < gz1; vz++) {
        const lx = vx - gx0;
        const ly = vy - gy0;
        const lz = vz - gz0;
        field.view[offset + lx * cs * cs + ly * cs + lz] = computeDensityAt(field, ctx, vx, vy, vz);
      }
    }
  }
}

// Sample terrain surface height using a ChunkedVoxelField (evaluates density directly,
// no need to generate chunks). Returns Y in unit space.
