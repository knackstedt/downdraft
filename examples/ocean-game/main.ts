import {
  Camera,
  Component,
  createFireEmitter,
  createSmokeEmitter,
  GameWorld,
  MeshBuilder,
  ParticleSystem,
  query,
  Scene,
  Stage,
  system,
  TelemetryCollector,
  World,
  type Entity,
  type RenderData,
  type RenderEntityData,
} from "@downdraft/core";

// IPC mesh data format for the Rust renderer (matches shared-memory.ts MeshData)
interface IPCMeshData {
  vertexCount: number;
  indexCount: number;
  posX: number;
  posZ: number;
  verts: Float32Array;
  indices: Uint32Array;
}

// ─── Constants (parity with to-the-ocean constants.ts) ─────

const SIM_TICK_DT = 1 / 60;

// ─── Input Key Codes (ported from to-the-ocean input-buffer.ts) ──
// Maps to bit positions in a 256-bit key bitmask (8 × u32 words)

export const KEY = {
  W: 87, A: 65, S: 83, D: 68,
  Q: 81, E: 69, R: 82, F: 70,
  SHIFT: 16, CTRL: 17, ALT: 18, TAB: 9,
  SPACE: 32, ENTER: 13, ESC: 27,
  ONE: 49, TWO: 50, THREE: 51, FOUR: 52,
  FIVE: 53, SIX: 54, SEVEN: 55, EIGHT: 56,
  NINE: 57, ZERO: 48,
  I: 73, B: 66, C: 67, M: 77, P: 80,
  T: 84, V: 86, Z: 90, X: 88,
  Y: 89, G: 71, H: 72, J: 74,
  UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
  F5: 116,
  BRACKET_LEFT: 219,
  BRACKET_RIGHT: 221,
} as const;

// Camera modes (parity with to-the-ocean CameraMode enum)
enum CameraMode {
  FirstPerson = 0,
  ThirdPerson = 1,
  FreeCam = 2,
}

// Biome types for terrain variation
enum BiomeType {
  Tropical = 0,
  Temperate = 1,
  Arctic = 2,
  Desert = 3,
  Volcanic = 4,
}

// Terrain material type (determines vertex color)
enum TerrainType {
  DeepUnderwater = 0,
  ShallowUnderwater = 1,
  Shoreline = 2,
  Sand = 3,
  Grass = 4,
  Forest = 5,
  Stone = 6,
  Rock = 7,
  Snow = 8,
  Ash = 9,
}

// ─── Terrain Config (ported from to-the-ocean TerrainConfig.ts) ──

const TERRAIN_CONFIG = {
  voxelSize: 2.5,
  isoLevel: 0.0,
  maxVoxelMemory: 80_000_000,

  blobCount: 5,
  blobMinRadius: 0.35,
  blobMaxRadius: 0.55,
  blobMinStrength: 0.6,
  blobMaxStrength: 0.9,
  blobSmoothUnionK: 0.8,
  blobEdgeExtend: 0.25,
  blobSpread: 0.4,

  cliffSideRadius: 0.5,
  gentleSideRadius: 1.25,
  cliffDepthFactor: 0.25,
  plateauSharpness: 0.6,

  heightNoiseScale: 2.0,
  heightNoiseOctaves: 2,
  heightNoiseAmplitude: 0.03,
  peakHeight: 0.08,
  depthHeight: 0.15,
  yExtentMultiplier: 2.0,

  beachThreshold: 0.03,
  beachGradientScale: 0.4,

  cliffGradientThreshold: 1.2,
  cliffNoiseScale: 5.0,
  cliffNoiseThreshold: 0.55,

  caveEnabled: true,
  caveNoiseScale: 4.0,
  caveNoiseOctaves: 3,
  caveThreshold: 0.15,
  caveMinDepth: 0.02,

  chunkSize: 32,
  chunkBits: 5,
  chunkMask: 31,
} as const;

// Biome-specific terrain colors
const BIOME_COLORS: Record<number, {
  grass: [number, number, number];
  forest: [number, number, number];
  rock: [number, number, number];
  sand: [number, number, number];
  shoreline: [number, number, number];
  deepUnderwater: [number, number, number];
  shallowUnderwater: [number, number, number];
  peak: [number, number, number];
}> = {
  [BiomeType.Tropical]: {
    grass: [0.3, 0.55, 0.2], forest: [0.18, 0.42, 0.12],
    rock: [0.4, 0.38, 0.35], sand: [0.76, 0.70, 0.50],
    shoreline: [0.35, 0.32, 0.25], deepUnderwater: [0.08, 0.07, 0.06],
    shallowUnderwater: [0.16, 0.14, 0.11], peak: [0.5, 0.45, 0.4],
  },
  [BiomeType.Temperate]: {
    grass: [0.25, 0.45, 0.18], forest: [0.15, 0.35, 0.10],
    rock: [0.38, 0.36, 0.33], sand: [0.72, 0.68, 0.48],
    shoreline: [0.32, 0.30, 0.23], deepUnderwater: [0.07, 0.06, 0.05],
    shallowUnderwater: [0.14, 0.12, 0.10], peak: [0.48, 0.43, 0.38],
  },
  [BiomeType.Arctic]: {
    grass: [0.7, 0.75, 0.72], forest: [0.5, 0.6, 0.55],
    rock: [0.55, 0.55, 0.58], sand: [0.8, 0.8, 0.78],
    shoreline: [0.6, 0.62, 0.65], deepUnderwater: [0.05, 0.08, 0.12],
    shallowUnderwater: [0.12, 0.18, 0.25], peak: [0.9, 0.92, 0.95],
  },
  [BiomeType.Desert]: {
    grass: [0.65, 0.58, 0.35], forest: [0.5, 0.45, 0.28],
    rock: [0.5, 0.42, 0.30], sand: [0.85, 0.75, 0.50],
    shoreline: [0.55, 0.48, 0.32], deepUnderwater: [0.08, 0.07, 0.05],
    shallowUnderwater: [0.15, 0.13, 0.10], peak: [0.55, 0.48, 0.38],
  },
  [BiomeType.Volcanic]: {
    grass: [0.25, 0.20, 0.15], forest: [0.15, 0.12, 0.08],
    rock: [0.30, 0.22, 0.18], sand: [0.35, 0.25, 0.20],
    shoreline: [0.25, 0.20, 0.15], deepUnderwater: [0.05, 0.03, 0.02],
    shallowUnderwater: [0.10, 0.06, 0.04], peak: [0.2, 0.15, 0.12],
  },
};

// ─── Perlin Noise (ported from to-the-ocean) ───────────────

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

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number): number { return a + t * (b - a); }

const GRAD3 = [
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1],
];

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 11;
  const g = GRAD3[h];
  return g[0] * x + g[1] * y + g[2] * z;
}

function grad2(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
}

class PerlinNoise {
  private perm: Uint8Array;
  constructor(seed: number) {
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  noise2D(x: number, y: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = this.perm[this.perm[X] + Y];
    const ab = this.perm[this.perm[X] + Y + 1];
    const ba = this.perm[this.perm[X + 1] + Y];
    const bb = this.perm[this.perm[X + 1] + Y + 1];
    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }
  fbm(x: number, y: number, octaves: number, persistence: number, lacunarity: number): number {
    let total = 0, frequency = 1, amplitude = 1, maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.noise2D(x * frequency, y * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}

class PerlinNoise3D {
  private perm: Uint8Array;
  constructor(seed: number) {
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  noise3D(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y), zf = z - Math.floor(z);
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const A = this.perm[X] + Y, AA = this.perm[A] + Z, AB = this.perm[A + 1] + Z;
    const B = this.perm[X + 1] + Y, BA = this.perm[B] + Z, BB = this.perm[B + 1] + Z;
    const x1 = lerp(grad3(this.perm[AA], xf, yf, zf), grad3(this.perm[BA], xf-1, yf, zf), u);
    const x2 = lerp(grad3(this.perm[AB], xf, yf-1, zf), grad3(this.perm[BB], xf-1, yf-1, zf), u);
    const y1 = lerp(x1, x2, v);
    const x3 = lerp(grad3(this.perm[AA+1], xf, yf, zf-1), grad3(this.perm[BA+1], xf-1, yf, zf-1), u);
    const x4 = lerp(grad3(this.perm[AB+1], xf, yf-1, zf-1), grad3(this.perm[BB+1], xf-1, yf-1, zf-1), u);
    const y2 = lerp(x3, x4, v);
    return lerp(y1, y2, w);
  }
  fbm3D(x: number, y: number, z: number, octaves: number, persistence: number, lacunarity: number): number {
    let total = 0, frequency = 1, amplitude = 1, maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}

// ─── Voxel Field Type ─────────────────────────────────────

interface VoxelField {
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

function generateVoxelField(
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

        data[colBase + vy * dimZ] = density;
      }
    }
  }

  return { data, dimX, dimY, dimZ, voxelSize: vs, originX, originY, originZ, isoLevel: cfg.isoLevel, radius };
}

// ─── Terrain Height Sampling (from voxel field) ───────────

function voxelFieldHeightAt(field: VoxelField, worldX: number, worldZ: number): number {
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

function classifyTerrainType(
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

function terrainTypeColor(type: TerrainType, biome: number): [number, number, number] {
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

// ─── Marching Cubes Mesh Extraction (simplified) ──────────
// Extracts a triangle mesh from the voxel density field.
// Uses edge interpolation for smooth surfaces.

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

function extractMeshFromField(
  field: VoxelField,
  biome: number,
  maxVerts: number = 50000,
): { verts: Float32Array; indices: Uint16Array | Uint32Array; vertexCount: number; indexCount: number } {
  const vs = field.voxelSize;
  const { dimX, dimY, dimZ, data, isoLevel } = field;
  const dimYZ = dimY * dimZ;

  const vertList: number[] = [];
  const indexList: number[] = [];

  function getDensity(x: number, y: number, z: number): number {
    if (x < 0 || x >= dimX || y < 0 || y >= dimY || z < 0 || z >= dimZ) return -1.0;
    return data[x * dimYZ + y * dimZ + z];
  }

  function interpVertex(edge: number, x: number, y: number, z: number, d0: number, d1: number): [number, number, number] {
    const t = (isoLevel - d0) / (d1 - d0);
    const [c0, c1] = MC_EDGE_CORNERS[edge];
    const [ox0, oy0, oz0] = MC_CORNER_OFFSETS[c0];
    const [ox1, oy1, oz1] = MC_CORNER_OFFSETS[c1];
    const wx = (x + ox0 + t * (ox1 - ox0)) * vs + field.originX;
    const wy = (y + oy0 + t * (oy1 - oy0)) * vs + field.originY;
    const wz = (z + oz0 + t * (oz1 - oz0)) * vs + field.originZ;
    return [wx, wy, wz];
  }

  for (let x = 0; x < dimX - 1; x++) {
    for (let y = 0; y < dimY - 1; y++) {
      for (let z = 0; z < dimZ - 1; z++) {
        // Sample 8 corners
        const d: number[] = new Array(8);
        let cubeIndex = 0;
        for (let i = 0; i < 8; i++) {
          const [ox, oy, oz] = MC_CORNER_OFFSETS[i];
          d[i] = getDensity(x + ox, y + oy, z + oz);
          if (d[i] >= isoLevel) cubeIndex |= (1 << i);
        }

        if (cubeIndex === 0 || cubeIndex === 255) continue;

        const edges = MC_EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        // Interpolate edge vertices
        const edgeVerts: (number | null)[] = new Array(12).fill(null);
        for (let e = 0; e < 12; e++) {
          if (edges & (1 << e)) {
            const [c0, c1] = MC_EDGE_CORNERS[e];
            const [ox0, oy0, oz0] = MC_CORNER_OFFSETS[c0];
            const [ox1, oy1, oz1] = MC_CORNER_OFFSETS[c1];
            const d0 = getDensity(x + ox0, y + oy0, z + oz0);
            const d1 = getDensity(x + ox1, y + oy1, z + oz1);
            const [wx, wy, wz] = interpVertex(e, x, y, z, d0, d1);

            // Determine terrain type at this vertex
            const midY = y + 0.5;
            const tType = classifyTerrainType(field, x, Math.floor(midY), z, biome);
            const [r, g, b] = terrainTypeColor(tType, biome);

            const idx = vertList.length / 9;
            vertList.push(wx, wy, wz, 0, 1, 0, r, g, b);
            edgeVerts[e] = idx;

            if (vertList.length / 9 >= maxVerts) {
              // Safety cap
              const verts = new Float32Array(vertList);
              const indices = indexList.length > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList);
              return { verts, indices, vertexCount: vertList.length / 9, indexCount: indexList.length };
            }
          }
        }

        // Generate triangles using triTable — simplified: use edge pairs
        // We generate triangles by walking the edge table bits
        const triEdges: number[] = [];
        for (let e = 0; e < 12; e++) {
          if (edges & (1 << e)) triEdges.push(e);
        }
        // Generate triangles (fan triangulation for simplicity)
        if (triEdges.length >= 3) {
          for (let i = 1; i < triEdges.length - 1; i++) {
            const v0 = edgeVerts[triEdges[0]];
            const v1 = edgeVerts[triEdges[i]];
            const v2 = edgeVerts[triEdges[i + 1]];
            if (v0 !== null && v1 !== null && v2 !== null) {
              indexList.push(v0, v1, v2);
            }
          }
        }
      }
    }
  }

  const verts = new Float32Array(vertList);
  const indices = indexList.length > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList);
  return { verts, indices, vertexCount: vertList.length / 9, indexCount: indexList.length };
}

// ─── Input State (enhanced with mouse-look, gamepad, camera) ──

interface InputState {
  keys: Set<string>;
  pressed: Set<string>;
  // Enhanced input from to-the-ocean InputBufferReader
  keyBits: Uint8Array;        // 256-bit key bitmask (32 bytes)
  mouseDX: number;            // mouse delta X for look
  mouseDY: number;            // mouse delta Y for look
  mouseBtn: number;           // mouse button bitmask
  wheel: number;              // scroll wheel delta
  cameraZoom: number;         // third-person camera distance
  lookHeading: number;        // renderer-side heading (radians)
  lookPitch: number;          // renderer-side pitch (radians)
  gamepadAxes: Float32Array;  // 8 axes: lx, ly, rx, ry, lt, rt, dpadX, dpadY
  gamepadBtn: number;         // gamepad button bitmask
  hotbarSlot: number;         // selected hotbar slot (0-9)
  builderCellType: number;    // selected builder cell type
  builderRotation: number;    // builder rotation steps (0-3)
}

function createInputState(): InputState {
  return {
    keys: new Set<string>(),
    pressed: new Set<string>(),
    keyBits: new Uint8Array(32),
    mouseDX: 0, mouseDY: 0, mouseBtn: 0, wheel: 0,
    cameraZoom: 15,
    lookHeading: 0, lookPitch: 0.3,
    gamepadAxes: new Float32Array(8),
    gamepadBtn: 0,
    hotbarSlot: 0,
    builderCellType: 0, builderRotation: 0,
  };
}

function isKeyDown(input: InputState, keyCode: number): boolean {
  const wordIdx = Math.floor(keyCode / 8);
  const bitIdx = keyCode % 8;
  return (input.keyBits[wordIdx] & (1 << bitIdx)) !== 0;
}

function setKey(input: InputState, keyCode: number, pressed: boolean) {
  const wordIdx = Math.floor(keyCode / 8);
  const bitIdx = keyCode % 8;
  if (pressed) {
    input.keyBits[wordIdx] |= (1 << bitIdx);
  } else {
    input.keyBits[wordIdx] &= ~(1 << bitIdx);
  }
}

function consumeWheel(input: InputState): number {
  const w = input.wheel;
  input.wheel = 0;
  return w;
}

function consumeMouseDelta(input: InputState): { dx: number; dy: number } {
  const dx = input.mouseDX;
  const dy = input.mouseDY;
  input.mouseDX = 0;
  input.mouseDY = 0;
  return { dx, dy };
}
const PLAYER_MAX_HEALTH = 100;
const PLAYER_MAX_HUNGER = 100;
const PLAYER_MAX_THIRST = 100;
const PLAYER_MAX_OXYGEN = 100;
const PLAYER_TEMP_MIN = 34;
const PLAYER_TEMP_MAX = 42;
const PLAYER_TEMP_NORM = 37;
const HUNGER_DECAY_RATE = 0.15;
const THIRST_DECAY_RATE = 0.2;
const OXYGEN_DRAIN_RATE = 2.5;
const OXYGEN_REGEN_RATE = 10;
const TEMP_DAMAGE_THRESHOLD_LOW = 35;
const TEMP_DAMAGE_THRESHOLD_HIGH = 39;
const TEMP_DAMAGE_RATE = 3;
const HUNGER_DAMAGE_RATE = 2;
const THIRST_DAMAGE_RATE = 3;
const HEALTH_REGEN_RATE = 0.5;
const PLAYER_WALK_SPEED = 4.5;
const PLAYER_RUN_SPEED = 8.0;
const PLAYER_SWIM_SPEED = 3.0;
const PLAYER_DIVE_SPEED = 4.0;
const PLAYER_JUMP_VELOCITY = 6.0;
const PLAYER_GRAVITY = 9.8;
const PLAYER_NOCLIP_SPEED = 15.0;
const PLAYER_CLIMB_SPEED = 3.0;
const PLAYER_FALL_DAMAGE_THRESHOLD = 8;
const PLAYER_FALL_DAMAGE_RATE = 5;
const PLAYER_WATER_BUOYANCY = 3.0;
const PLAYER_WATER_DAMPING = 0.8;
const PLAYER_GROUND_FRICTION = 0.85;
const PLAYER_AIR_FRICTION = 0.98;
const MOUSE_LOOK_SENSITIVITY = 0.0025;
const CAMERA_MIN_DISTANCE = 2;
const CAMERA_MAX_DISTANCE = 50;
const CAMERA_FIRST_PERSON_OFFSET = 0.0;
const CAMERA_THIRD_PERSON_DEFAULT = 15;
const CAMERA_FREECAM_SPEED = 20;
const HOTBAR_SLOTS = 10;
const SHIP_MAX_SPEED = 12;
const SHIP_ACCEL = 2.0;
const SHIP_TURN_RATE = 0.8;
const SHIP_DRAG = 0.5;
const BUOYANCY_FORCE = 9.8;
const WATER_LEVEL = 0;
const WILDLIFE_SPAWN_RADIUS = 80;
const WILDLIFE_MAX_COUNT = 15;
const WILDLIFE_DESPAWN_RADIUS = 150;
const SHARK_SPEED = 4;
const SHARK_ATTACK_RANGE = 2;
const SHARK_ATTACK_DAMAGE = 20;
const SHARK_ATTACK_COOLDOWN = 3;
const SHARK_HUNT_RANGE = 15;
const SHARK_DESPAWN_RANGE = 30;
const FISH_SPEED = 1.5;
const WEATHER_TRANSITION_INTERVAL = 120;
const DAY_DURATION = 600;
const NIGHT_START_FRAC = 0.75;
const NIGHT_END_FRAC = 0.25;

// Fishing
const FISHING_CAST_RANGE = 15;
const FISHING_MIN_WAIT = 2;
const FISHING_MAX_WAIT = 8;
const FISHING_CATCH_CHANCE = 0.7;

// Crafting
const CRAFT_PLANK_COST = 1; // 1 wood -> 2 planks
const CRAFT_CAMPFIRE_COST = 3; // 3 planks -> 1 campfire
const CRAFT_SAIL_COST = 5; // 5 planks -> 1 sail
const CRAFT_RAFT_COST = 8; // 8 planks -> raft upgrade
const COOK_FISH_TIME = 5;

// Islands
const ISLAND_COUNT = 6;
const ISLAND_MIN_RADIUS = 8;
const ISLAND_MAX_RADIUS = 25;
const ISLAND_MIN_HEIGHT = 2;
const ISLAND_MAX_HEIGHT = 8;
const ISLAND_SPAWN_RANGE = 120;
const ISLAND_BEACH_LEVEL = 0.5;

// Inventory
const INV_MAX_SLOTS = 20;
const SPOILAGE_RATE = 0.01; // per game hour

// Ship boarding
const BOARD_RANGE = 3;
const REPAIR_RATE = 10; // integrity per second
const REPAIR_WOOD_COST = 1; // wood per repair tick

// Pirates
const PIRATE_SPAWN_INTERVAL = 30; // seconds between spawn checks
const PIRATE_SPAWN_CHANCE = 0.3;
const PIRATE_SPAWN_MIN_DIST = 60;
const PIRATE_SPAWN_MAX_DIST = 120;
const PIRATE_SPEED = 4;
const PIRATE_CHASE_RANGE = 50;
const PIRATE_ATTACK_RANGE = 10;
const PIRATE_ATTACK_DAMAGE = 5;
const PIRATE_ATTACK_COOLDOWN = 2;
const PIRATE_HEALTH = 60;
const PIRATE_LOOT_DROP = 3;

// Ports & Market
const PORT_TRADE_RANGE = 15;
const MARKET_PRICE_RECOVERY = 0.01; // per tick
const MARKET_PRICE_MAX_MOD = 2.0;
const PORT_COUNT = 2; // ports on random islands

// Animals (livestock)
const ANIMAL_GROWTH_TIME = 120; // seconds per growth stage
const ANIMAL_PRODUCT_TIME = 120; // seconds between products
const ANIMAL_HUNGER_DECAY = 0.5;
const ANIMAL_COUNT_PER_ISLAND = 2;

// Plants (crops)
const PLANT_STAGE_DURATIONS = [30, 60, 120, 300]; // seed, sprout, growing, mature
const PLANT_WATER_DECAY = 0.3;
const PLANT_COUNT_PER_ISLAND = 3;

// Pets
const PET_FOLLOW_SPEED = 2.5;
const PET_FOLLOW_RANGE = 5;
const PET_HUNGER_DECAY = 0.3;

// Tools
const TOOL_AXE_COOLDOWN = 1;
const TOOL_AXE_RANGE = 3;
const TOOL_SHOVEL_COOLDOWN = 2;
const TOOL_SHOVEL_RANGE = 3;
const TOOL_GUN_COOLDOWN = 0.5;
const TOOL_GUN_RANGE = 50;
const TOOL_GUN_DAMAGE = 25;

// Progression
const XP_PER_LEVEL = 100;
const XP_KILL_PIRATE = 50;
const XP_CATCH_FISH = 5;
const XP_CRAFT = 10;
const XP_HARVEST = 15;
const XP_MAX_LEVEL = 20;

// Game mode
const GAME_DIFFICULTY_EASY = 0;
const GAME_DIFFICULTY_NORMAL = 1;
const GAME_DIFFICULTY_HARD = 2;

enum WeatherType {
  Clear = 0,
  Cloudy = 1,
  Rain = 2,
  Storm = 3,
  Fog = 4,
}

enum WildlifeState {
  Patrol = 0,
  Hunt = 1,
  Flee = 2,
}

enum PirateState {
  Patrol = 0,
  Chase = 1,
  Attack = 2,
  Flee = 3,
}

enum PlantStage {
  Seed = 0,
  Sprout = 1,
  Growing = 2,
  Mature = 3,
  Overripe = 4,
}

enum AnimalStage {
  Baby = 0,
  Juvenile = 1,
  Adult = 2,
}

enum PetType {
  Cat = 0,
  Dog = 1,
  Parrot = 2,
  Shark = 3,
}

enum ToolType {
  None = 0,
  Axe = 1,
  Shovel = 2,
  Gun = 3,
  FishingRod = 4,
}

// ─── Game Components ───────────────────────────────────────

const Health = Component.register("Health", {
  current: PLAYER_MAX_HEALTH,
  max: PLAYER_MAX_HEALTH,
  regenRate: HEALTH_REGEN_RATE,
});

const Hunger = Component.register("Hunger", {
  current: PLAYER_MAX_HUNGER,
  max: PLAYER_MAX_HUNGER,
  decayRate: HUNGER_DECAY_RATE,
});

const Thirst = Component.register("Thirst", {
  current: PLAYER_MAX_THIRST,
  max: PLAYER_MAX_THIRST,
  decayRate: THIRST_DECAY_RATE,
});

const Oxygen = Component.register("Oxygen", {
  current: PLAYER_MAX_OXYGEN,
  max: PLAYER_MAX_OXYGEN,
});

const Temperature = Component.register("Temperature", {
  current: PLAYER_TEMP_NORM,
});

const Player = Component.register("Player", {
  x: 0, y: 1, z: 0,
  vx: 0, vy: 0, vz: 0,
  heading: 0, pitch: 0,
  onShip: false,
  isUnderwater: false,
  isSwimming: false,
  isSleeping: false,
  isDead: false,
  isNoclip: false,
  isRunning: false,
  isGrounded: true,
  isClimbing: false,
  isDiving: false,
  bodyHeading: 0,
  cameraMode: CameraMode.ThirdPerson,
  hotbarSlot: 0,
  fallStartY: 0,
});

const Ship = Component.register("Ship", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  heading: 0,
  throttle: 0,
  steering: 0,
  speed: 0,
  integrity: 100,
  maxIntegrity: 100,
  anchorX: NaN,
  anchorZ: NaN,
});

const Wildlife = Component.register("Wildlife", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  type: "shark" as string,
  state: WildlifeState.Patrol,
  speed: SHARK_SPEED,
  attackCooldown: 0,
  health: 50,
});

const Debris = Component.register("Debris", {
  type: "wood" as string,
  x: 0, y: 0, z: 0,
  collected: false,
});

const Inventory = Component.register("Inventory", {
  slots: [] as { item: string; count: number; spoil: number }[],
});

const Island = Component.register("Island", {
  x: 0, z: 0,
  radius: 10,
  height: 5,
  hasTrees: true,
  hasRocks: true,
  visited: false,
  biome: BiomeType.Tropical,
  chunkX: 0,
  chunkZ: 0,
  voxelField: null as VoxelField | null,
  meshData: null as { verts: Float32Array; indices: Uint16Array | Uint32Array; vertexCount: number; indexCount: number } | null,
});

const Buildable = Component.register("Buildable", {
  type: "campfire" as string,
  x: 0, y: 0, z: 0,
  health: 100,
});

const FishingLine = Component.register("FishingLine", {
  cast: false,
  timer: 0,
  waitTime: 0,
  hooked: false,
});

const Pirate = Component.register("Pirate", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  heading: 0,
  state: PirateState.Patrol,
  health: PIRATE_HEALTH,
  maxHealth: PIRATE_HEALTH,
  attackCooldown: 0,
  difficulty: 1,
  targetEntity: 0,
  stateTimer: 0,
});

const Port = Component.register("Port", {
  x: 0, z: 0,
  islandEntity: 0,
  name: "Port" as string,
  listings: [] as { item: string; buyPrice: number; sellPrice: number; supply: number; priceModifier: number }[],
});

const Plant = Component.register("Plant", {
  x: 0, y: 0, z: 0,
  species: "kelp" as string,
  stage: PlantStage.Seed,
  growthTimer: 0,
  waterLevel: 100,
  yield: 1,
  islandEntity: 0,
});

const Animal = Component.register("Animal", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  species: "chicken" as string,
  stage: AnimalStage.Baby,
  age: 0,
  hunger: 100,
  productTimer: ANIMAL_PRODUCT_TIME,
  productType: "egg" as string,
  islandEntity: 0,
});

const Pet = Component.register("Pet", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  type: PetType.Cat,
  ownerId: 0,
  happiness: 50,
  hunger: 100,
  cooldown: 0,
});

const Progression = Component.register("Progression", {
  level: 1,
  xp: 0,
  craftingTier: 0,
  hullTier: 0,
  unlockedRecipes: [] as string[],
});

// ─── Queries ───────────────────────────────────────────────

const playerQuery = query(Player.id, Health.id, Hunger.id, Thirst.id, Oxygen.id, Temperature.id);
const playerInvQuery = query(Player.id, Inventory.id);
const playerProgQuery = query(Player.id, Progression.id);
const shipQuery = query(Ship.id);
const wildlifeQuery = query(Wildlife.id);
const debrisQuery = query(Debris.id);
const islandQuery = query(Island.id);
const buildableQuery = query(Buildable.id);
const fishingQuery = query(FishingLine.id);
const pirateQuery = query(Pirate.id);
const portQuery = query(Port.id);
const plantQuery = query(Plant.id);
const animalQuery = query(Animal.id);
const petQuery = query(Pet.id);

// ─── XP / Progression helpers ───────────────────────────────

function addXP(world: World, entity: Entity, amount: number) {
  const prog = world.getComponent<typeof Progression.defaults>(entity, Progression.id);
  if (!prog) return;
  prog.xp += amount;
  while (prog.xp >= XP_PER_LEVEL * prog.level && prog.level < XP_MAX_LEVEL) {
    prog.xp -= XP_PER_LEVEL * prog.level;
    prog.level++;
    prog.craftingTier = Math.floor(prog.level / 5);
    console.log(`[progression] Level up! Now level ${prog.level} (crafting tier ${prog.craftingTier})`);
  }
}

// ─── Inventory helpers ──────────────────────────────────────

function invAdd(inv: { item: string; count: number; spoil: number }[], item: string, count: number): boolean {
  for (const s of inv) {
    if (s.item === item && s.count > 0) {
      s.count += count;
      return true;
    }
  }
  if (inv.length < INV_MAX_SLOTS) {
    inv.push({ item, count, spoil: 1.0 });
    return true;
  }
  return false;
}

function invRemove(inv: { item: string; count: number; spoil: number }[], item: string, count: number): boolean {
  for (const s of inv) {
    if (s.item === item && s.count >= count) {
      s.count -= count;
      if (s.count <= 0) {
        const idx = inv.indexOf(s);
        if (idx >= 0) inv.splice(idx, 1);
      }
      return true;
    }
  }
  return false;
}

function invCount(inv: { item: string; count: number; spoil: number }[], item: string): number {
  for (const s of inv) {
    if (s.item === item) return s.count;
  }
  return 0;
}

// ─── Island helpers ─────────────────────────────────────────

function islandHeightAt(island: { x: number; z: number; radius: number; height: number; voxelField?: VoxelField | null }, px: number, pz: number): number {
  // Use voxel field for accurate height if available
  if (island.voxelField) {
    const localX = px - island.x;
    const localZ = pz - island.z;
    const h = voxelFieldHeightAt(island.voxelField, localX, localZ);
    if (h >= 0) return h;
    return -1;
  }
  // Fallback: smooth dome
  const dx = px - island.x;
  const dz = pz - island.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > island.radius) return -1;
  const t = dist / island.radius;
  const h = island.height * Math.max(0, 1 - t * t);
  return Math.max(0, h);
}

function isOnIsland(px: number, pz: number): { onLand: boolean; groundY: number; islandBiome: number } {
  let bestY = -1;
  let bestBiome = BiomeType.Tropical;
  islandQuery.iterate(frameCount, (_e, [island]) => {
    const isl = island as typeof Island.defaults;
    const h = islandHeightAt(isl, px, pz);
    if (h > bestY) {
      bestY = h;
      bestBiome = isl.biome;
    }
  });
  if (bestY < 0) return { onLand: false, groundY: -1, islandBiome: BiomeType.Tropical };
  return { onLand: true, groundY: bestY, islandBiome: bestBiome };
}

// ─── Game Systems (tick order matches to-the-ocean Simulation.tick) ──

// 1. WeatherSystem — weather transitions, wind, visibility, temperature
const weatherState = {
  type: WeatherType.Clear,
  intensity: 0,
  windSpeed: 3,
  windDirX: 1,
  windDirZ: 0,
  visibility: 1.0,
  ambientTemp: 22,
  transitionTimer: 0,
};

const weatherSystem = system("weather", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  weatherState.transitionTimer += dt;
  if (weatherState.transitionTimer >= WEATHER_TRANSITION_INTERVAL) {
    weatherState.transitionTimer = 0;
    const r = Math.random();
    if (r < 0.4) weatherState.type = WeatherType.Clear;
    else if (r < 0.7) weatherState.type = WeatherType.Cloudy;
    else if (r < 0.85) weatherState.type = WeatherType.Rain;
    else if (r < 0.95) weatherState.type = WeatherType.Storm;
    else weatherState.type = WeatherType.Fog;
  }

  const targetWind = weatherState.type === WeatherType.Storm ? 25 :
    weatherState.type === WeatherType.Rain ? 12 :
    weatherState.type === WeatherType.Cloudy ? 6 : 3;
  weatherState.windSpeed += (targetWind - weatherState.windSpeed) * 0.01;

  const targetVis = weatherState.type === WeatherType.Fog ? 0.3 :
    weatherState.type === WeatherType.Storm ? 0.5 :
    weatherState.type === WeatherType.Rain ? 0.7 : 1.0;
  weatherState.visibility += (targetVis - weatherState.visibility) * 0.02;

  const targetTemp = weatherState.type === WeatherType.Storm ? 15 :
    weatherState.type === WeatherType.Rain ? 18 :
    weatherState.type === WeatherType.Clear ? 26 : 22;
  weatherState.ambientTemp += (targetTemp - weatherState.ambientTemp) * 0.005;

  const windAngle = ctx.tick * 0.001;
  weatherState.windDirX = Math.cos(windAngle);
  weatherState.windDirZ = Math.sin(windAngle);
}, { queries: [] });

// 2. PlayerMovementSystem — heading-based movement with mouse-look, swimming, diving, jumping, noclip
const playerMovementSystem = system("player-movement", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<InputState>("inputState");
  playerQuery.iterate(ctx.tick, (entity, [playerRaw]) => {
    const player = playerRaw as typeof Player.defaults;
    if (player.isDead) return;

    // If on ship, follow ship position
    if (player.onShip) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        player.x = ship.x;
        player.z = ship.z;
        player.y = ship.y + 1;
        player.heading = ship.heading;
      });
    }

    // ─── Mouse-look: update heading and pitch from mouse delta ───
    if (input) {
      const { dx, dy } = consumeMouseDelta(input);
      if (dx !== 0 || dy !== 0) {
        player.heading -= dx * MOUSE_LOOK_SENSITIVITY;
        player.pitch -= dy * MOUSE_LOOK_SENSITIVITY;
        player.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, player.pitch));
      }

      // Camera zoom (scroll wheel)
      const wheel = consumeWheel(input);
      if (wheel !== 0) {
        input.cameraZoom = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, input.cameraZoom - wheel * 0.01));
      }

      // Camera mode toggle (M key)
      if (input.pressed.has("m")) {
        player.cameraMode = (player.cameraMode + 1) % 3;
        const modeName = player.cameraMode === CameraMode.FirstPerson ? "FirstPerson" :
          player.cameraMode === CameraMode.ThirdPerson ? "ThirdPerson" : "FreeCam";
        console.log(`[camera] mode: ${modeName}`);
      }

      // Noclip toggle (F5)
      if (input.pressed.has("f5")) {
        player.isNoclip = !player.isNoclip;
        console.log(`[player] noclip: ${player.isNoclip ? "ON" : "OFF"}`);
      }

      // Hotbar selection (1-9, 0)
      for (let i = 0; i < HOTBAR_SLOTS; i++) {
        const keyName = i < 9 ? String(i + 1) : "0";
        if (input.pressed.has(keyName)) {
          player.hotbarSlot = i;
          input.hotbarSlot = i;
        }
      }
    }

    const island = isOnIsland(player.x, player.z);
    const onLand = island.onLand && island.groundY > ISLAND_BEACH_LEVEL;
    const inWater = !onLand && player.y < WATER_LEVEL + 0.5;
    const isUnderwater = player.y < WATER_LEVEL - 0.5;

    // ─── Noclip mode: free flight ───
    if (player.isNoclip) {
      let mx = 0, my = 0, mz = 0;
      if (input) {
        if (isKeyDown(input, KEY.W)) mz -= 1;
        if (isKeyDown(input, KEY.S)) mz += 1;
        if (isKeyDown(input, KEY.A)) mx -= 1;
        if (isKeyDown(input, KEY.D)) mx += 1;
        if (isKeyDown(input, KEY.SPACE)) my += 1;
        if (isKeyDown(input, KEY.SHIFT)) my -= 1;
      }
      const len = Math.sqrt(mx * mx + mz * mz + my * my);
      if (len > 0) { mx /= len; mz /= len; my /= len; }
      const cosH = Math.cos(player.heading), sinH = Math.sin(player.heading);
      const speed = PLAYER_NOCLIP_SPEED;
      player.vx = (mx * cosH - mz * sinH) * speed;
      player.vz = (mx * sinH + mz * cosH) * speed;
      player.vy = my * speed;
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.z += player.vz * dt;
      player.isSwimming = false;
      player.isUnderwater = false;
      player.isGrounded = false;
      return;
    }

    // ─── Normal movement ───
    let mx = 0, mz = 0;
    if (input) {
      if (isKeyDown(input, KEY.W)) mz -= 1;
      if (isKeyDown(input, KEY.S)) mz += 1;
      if (isKeyDown(input, KEY.A)) mx -= 1;
      if (isKeyDown(input, KEY.D)) mx += 1;
    }

    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) { mx /= len; mz /= len; }

    // Heading-based movement: rotate input by player heading
    const cosH = Math.cos(player.heading), sinH = Math.sin(player.heading);
    const worldMx = mx * cosH - mz * sinH;
    const worldMz = mx * sinH + mz * cosH;

    // Speed determination
    player.isRunning = input ? isKeyDown(input, KEY.SHIFT) : false;
    let speed: number;
    if (onLand) {
      speed = player.isRunning ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED;
    } else if (inWater) {
      speed = PLAYER_SWIM_SPEED;
    } else {
      speed = PLAYER_WALK_SPEED;
    }

    // Gamepad analog movement
    if (input && (input.gamepadAxes[0] !== 0 || input.gamepadAxes[1] !== 0)) {
      const gpx = input.gamepadAxes[0];
      const gpz = input.gamepadAxes[1];
      const gpLen = Math.sqrt(gpx * gpx + gpz * gpz);
      if (gpLen > 0.1) {
        const gpWorldMx = gpx * cosH - gpz * sinH;
        const gpWorldMz = gpx * sinH + gpz * cosH;
        player.vx = gpWorldMx * speed * Math.min(1, gpLen);
        player.vz = gpWorldMz * speed * Math.min(1, gpLen);
      } else {
        player.vx = worldMx * speed;
        player.vz = worldMz * speed;
      }
    } else {
      player.vx = worldMx * speed;
      player.vz = worldMz * speed;
    }

    // ─── Jumping ───
    if (input && isKeyDown(input, KEY.SPACE) && onLand && player.isGrounded) {
      player.vy = PLAYER_JUMP_VELOCITY;
      player.isGrounded = false;
      player.fallStartY = player.y;
    }

    // ─── Diving (Ctrl + Space in water) ───
    if (input && isKeyDown(input, KEY.CTRL) && isKeyDown(input, KEY.SPACE) && inWater) {
      player.isDiving = true;
      player.vy = -PLAYER_DIVE_SPEED;
    } else if (inWater && input && !isKeyDown(input, KEY.CTRL)) {
      player.isDiving = false;
    }

    const newX = player.x + player.vx * dt;
    const newZ = player.z + player.vz * dt;

    // Check island collision at new position
    const newIsland = isOnIsland(newX, newZ);
    if (newIsland.onLand && newIsland.groundY > ISLAND_BEACH_LEVEL) {
      player.x = newX;
      player.z = newZ;
      player.y = newIsland.groundY;
    } else if (!onLand) {
      player.x = newX;
      player.z = newZ;
    } else {
      player.x = newX;
      player.z = newZ;
    }

    if (mx !== 0 || mz !== 0) {
      player.bodyHeading = Math.atan2(worldMx, -worldMz);
    }

    player.isSwimming = inWater;
    player.isUnderwater = isUnderwater;

    // ─── Vertical movement ───
    if (onLand) {
      if (!player.isGrounded) {
        player.vy -= PLAYER_GRAVITY * dt;
        player.y += player.vy * dt;
        const groundY = island.groundY;
        if (player.y <= groundY) {
          const fallDist = player.fallStartY - player.y;
          if (fallDist > PLAYER_FALL_DAMAGE_THRESHOLD) {
            const damage = (fallDist - PLAYER_FALL_DAMAGE_THRESHOLD) * PLAYER_FALL_DAMAGE_RATE;
            playerQuery.iterate(ctx.tick, (_pe, [, health]) => {
              const h = health as typeof Health.defaults;
              h.current = Math.max(0, h.current - damage);
              console.log(`[fall] took ${damage.toFixed(1)} fall damage (fell ${fallDist.toFixed(1)}m)`);
            });
          }
          player.y = groundY;
          player.vy = 0;
          player.isGrounded = true;
        }
      } else {
        player.vy = 0;
        player.y = island.groundY;
      }
    } else if (inWater) {
      if (player.isDiving) {
        player.vy -= PLAYER_GRAVITY * 0.3 * dt;
        player.y += player.vy * dt;
      } else {
        player.vy = PLAYER_WATER_BUOYANCY * 0.3;
        player.y += player.vy * dt;
        if (player.y > WATER_LEVEL + 0.5) player.y = WATER_LEVEL + 0.5;
      }
      player.vx *= PLAYER_WATER_DAMPING;
      player.vz *= PLAYER_WATER_DAMPING;
    } else {
      player.vy -= PLAYER_GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y < WATER_LEVEL) player.y = WATER_LEVEL;
      player.isGrounded = false;
    }
  });
}, { queries: [playerQuery] });

// 3. ShipControlSystem — throttle, steering, drag (parity with BoatSystem.controlTick)
const shipControlSystem = system("ship-control", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string> }>("input");
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (input?.keys.has("shift")) ship.throttle = Math.min(1, ship.throttle + dt * 0.5);
    else ship.throttle = Math.max(0, ship.throttle - dt * 0.3);

    if (input?.keys.has("arrowleft")) ship.steering = -1;
    else if (input?.keys.has("arrowright")) ship.steering = 1;
    else ship.steering *= 0.8;

    const targetSpeed = ship.throttle * SHIP_MAX_SPEED;
    ship.speed += (targetSpeed - ship.speed) * SHIP_ACCEL * dt;
    ship.speed *= (1 - SHIP_DRAG * dt);

    ship.heading += ship.steering * SHIP_TURN_RATE * dt * (ship.speed / SHIP_MAX_SPEED);

    ship.vx = Math.sin(ship.heading) * ship.speed;
    ship.vz = Math.cos(ship.heading) * ship.speed;
    ship.x += ship.vx * dt;
    ship.z += ship.vz * dt;

    if (!isNaN(ship.anchorX)) {
      const adx = ship.anchorX - ship.x;
      const adz = ship.anchorZ - ship.z;
      ship.x += adx * 0.5 * dt;
      ship.z += adz * 0.5 * dt;
    }
  });
}, { queries: [shipQuery] });

// 4. BuoyancySystem — ship buoyancy + gravity (parity with BuoyancySystem.tick)
const buoyancySystem = system("buoyancy", Stage.Physics, (ctx) => {
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    ship.y = WATER_LEVEL + Math.sin(ctx.tick * 0.05) * 0.2;
  });
}, { queries: [shipQuery] });

// 5. SurvivalSystem — hunger, thirst, oxygen, temperature, damage (parity with SurvivalSystem.tick)
const survivalSystem = system("survival", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  playerQuery.iterate(ctx.tick, (entity, [player, health, hunger, thirst, oxygen, temp]) => {
    if (player.isDead) return;

    hunger.current = Math.max(0, hunger.current - hunger.decayRate * dt);
    thirst.current = Math.max(0, thirst.current - thirst.decayRate * dt);

    if (player.isUnderwater) {
      oxygen.current = Math.max(0, oxygen.current - OXYGEN_DRAIN_RATE * dt);
    } else {
      oxygen.current = Math.min(oxygen.max, oxygen.current + OXYGEN_REGEN_RATE * dt);
    }

    const targetTemp = weatherState.ambientTemp + (player.isSwimming ? -2 : 0);
    temp.current += (targetTemp - temp.current) * 0.01 * dt;
    temp.current = Math.max(PLAYER_TEMP_MIN, Math.min(PLAYER_TEMP_MAX, temp.current));

    let damage = 0;
    if (hunger.current <= 0) damage += HUNGER_DAMAGE_RATE * dt;
    if (thirst.current <= 0) damage += THIRST_DAMAGE_RATE * dt;
    if (oxygen.current <= 0) damage += 10 * dt;
    if (temp.current < TEMP_DAMAGE_THRESHOLD_LOW) damage += TEMP_DAMAGE_RATE * dt;
    if (temp.current > TEMP_DAMAGE_THRESHOLD_HIGH) damage += TEMP_DAMAGE_RATE * dt;

    if (damage > 0) {
      health.current = Math.max(0, health.current - damage);
    } else if (hunger.current > 30 && thirst.current > 30 && !player.isUnderwater) {
      health.current = Math.min(health.max, health.current + health.regenRate * dt);
    }

    if (health.current <= 0 && !player.isDead) {
      player.isDead = true;
      const cause = oxygen.current <= 0 ? "drowning" :
        hunger.current <= 0 ? "starvation" :
        thirst.current <= 0 ? "dehydration" :
        temp.current < TEMP_DAMAGE_THRESHOLD_LOW ? "hypothermia" :
        temp.current > TEMP_DAMAGE_THRESHOLD_HIGH ? "hyperthermia" : "unknown";
      console.log(`[survival] player died from ${cause}`);
    }
  });
}, { queries: [playerQuery] });

// 6. WildlifeAISystem — shark/fish AI (parity with WildlifeManager.tick)
const wildlifeAISystem = system("wildlife-ai", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  let playerX = 0, playerZ = 0, playerAlive = false;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    playerX = player.x; playerZ = player.z; playerAlive = !player.isDead;
  });

  wildlifeQuery.iterate(ctx.tick, (entity, [wl]) => {
    wl.attackCooldown = Math.max(0, wl.attackCooldown - dt);

    const dx = playerX - wl.x;
    const dz = playerZ - wl.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (wl.type === "shark") {
      if (playerAlive && dist < SHARK_HUNT_RANGE && wl.state === WildlifeState.Patrol) {
        wl.state = WildlifeState.Hunt;
      } else if (dist > SHARK_DESPAWN_RANGE && wl.state === WildlifeState.Hunt) {
        wl.state = WildlifeState.Patrol;
      }

      if (wl.state === WildlifeState.Hunt && playerAlive) {
        const angle = Math.atan2(dx, dz);
        wl.vx = Math.sin(angle) * wl.speed;
        wl.vz = Math.cos(angle) * wl.speed;
        wl.x += wl.vx * dt;
        wl.z += wl.vz * dt;

        if (dist < SHARK_ATTACK_RANGE && wl.attackCooldown <= 0) {
          wl.attackCooldown = SHARK_ATTACK_COOLDOWN;
          playerQuery.iterate(ctx.tick, (pe, [player, health]) => {
            if (!player.isDead) {
              health.current = Math.max(0, health.current - SHARK_ATTACK_DAMAGE);
              console.log(`[shark] attacked player! Health: ${health.current.toFixed(0)}`);
            }
          });
        }
      } else {
        wl.vx *= 0.95;
        wl.vz *= 0.95;
        wl.x += wl.vx * dt;
        wl.z += wl.vz * dt;
      }
    } else if (wl.type === "fish") {
      wl.vx = Math.sin(ctx.tick * 0.02 + wl.x) * FISH_SPEED;
      wl.vz = Math.cos(ctx.tick * 0.02 + wl.z) * FISH_SPEED;
      wl.x += wl.vx * dt;
      wl.z += wl.vz * dt;
    }

    wl.y = WATER_LEVEL - 1 + Math.sin(ctx.tick * 0.03 + wl.x) * 0.3;
  });
}, { queries: [wildlifeQuery, playerQuery] });

// 7. DebrisCollectionSystem — collect floating debris
const debrisCollectionSystem = system("debris-collection", Stage.Update, (ctx) => {
  let playerX = 0, playerZ = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    playerX = player.x; playerZ = player.z;
  });

  debrisQuery.iterate(ctx.tick, (entity, [debris]) => {
    if (debris.collected) return;
    const dx = debris.x - playerX;
    const dz = debris.z - playerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 2) {
      debris.collected = true;
      console.log(`[debris] collected ${debris.type}`);

      // Add to player inventory
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        if (debris.type === "food") {
          invAdd(inv.slots, "food", 1);
        } else if (debris.type === "water") {
          // Water is consumed immediately
          playerQuery.iterate(ctx.tick, (_pe, [, , , thirst]) => {
            thirst.current = Math.min(thirst.max, thirst.current + 30);
          });
        } else if (debris.type === "wood") {
          invAdd(inv.slots, "wood", 1);
        }
      });
    }
  });
}, { queries: [debrisQuery, playerQuery] });

// 8. ShipIntegritySystem — ship degradation (parity with structureIntegrity)
const shipIntegritySystem = system("ship-integrity", Stage.PostUpdate, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (weatherState.type === WeatherType.Storm) {
      ship.integrity = Math.max(0, ship.integrity - 0.5 * dt);
    } else {
      ship.integrity = Math.max(0, ship.integrity - 0.05 * dt);
    }

    if (ship.integrity < 30 && ctx.tick % 300 === 0) {
      console.log(`[ship] integrity low: ${ship.integrity.toFixed(0)}%`);
    }
    if (ship.integrity <= 0) {
      console.log("[ship] destroyed — game over!");
    }
  });
}, { queries: [shipQuery] });

// 9. ShipBoardingSystem — board/leave ship, anchor, repair
const shipBoardingSystem = system("ship-boarding", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    shipQuery.iterate(ctx.tick, (_se, [ship]) => {
      // Board/leave ship with E
      if (input.pressed.has("e")) {
        if (!player.onShip) {
          const dx = ship.x - player.x;
          const dz = ship.z - player.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < BOARD_RANGE) {
            player.onShip = true;
            console.log("[ship] boarded ship — WASD to steer, Shift to throttle");
          }
        } else {
          player.onShip = false;
          player.x = ship.x + 2;
          player.z = ship.z + 2;
          console.log("[ship] left ship");
        }
      }

      // Anchor with Q
      if (input.pressed.has("q") && player.onShip) {
        if (isNaN(ship.anchorX)) {
          ship.anchorX = ship.x;
          ship.anchorZ = ship.z;
          console.log("[ship] anchor dropped");
        } else {
          ship.anchorX = NaN;
          ship.anchorZ = NaN;
          console.log("[ship] anchor raised");
        }
      }

      // Repair with R
      if (input.keys.has("r") && player.onShip && ship.integrity < ship.maxIntegrity) {
        if (invRemove(inv.slots, "wood", 1)) {
          ship.integrity = Math.min(ship.maxIntegrity, ship.integrity + REPAIR_RATE * dt);
          if (ctx.tick % 60 === 0) {
            console.log(`[ship] repaired to ${ship.integrity.toFixed(0)}%`);
          }
        }
      }
    });
  });
}, { queries: [playerInvQuery, shipQuery] });

// 10. FishingSystem — cast line, wait, catch fish
const fishingSystem = system("fishing", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    fishingQuery.iterate(ctx.tick, (_fe, [line]) => {
      // Cast/reel with F
      if (input.pressed.has("f")) {
        if (!line.cast) {
          // Cast line — must be in water or on ship
          const inWater = player.y < WATER_LEVEL + 1 || player.onShip;
          if (inWater) {
            line.cast = true;
            line.hooked = false;
            line.timer = 0;
            line.waitTime = FISHING_MIN_WAIT + Math.random() * (FISHING_MAX_WAIT - FISHING_MIN_WAIT);
            console.log("[fishing] line cast...");
          }
        } else {
          // Reel in
          if (line.hooked) {
            if (Math.random() < FISHING_CATCH_CHANCE) {
              invAdd(inv.slots, "raw_fish", 1);
              console.log("[fishing] caught a fish!");
              playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CATCH_FISH));
            } else {
              console.log("[fishing] the fish got away...");
            }
          } else {
            console.log("[fishing] reeled in empty");
          }
          line.cast = false;
          line.hooked = false;
        }
      }

      // Update fishing timer
      if (line.cast && !line.hooked) {
        line.timer += dt;
        if (line.timer >= line.waitTime) {
          line.hooked = true;
          console.log("[fishing] something hooked! Press F to reel in");
        }
      }
    });
  });
}, { queries: [playerInvQuery, fishingQuery, playerProgQuery] });

// 11. CraftingSystem — craft items from resources
const craftingSystem = system("crafting", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    // C = craft menu (cycles through recipes)
    if (input.pressed.has("c")) {
      const craftState = ctx.world.getResource<{ lastRecipe: number }>("craftState") ?? { lastRecipe: 0 };
      const recipes = [
        { name: "planks", input: { wood: CRAFT_PLANK_COST }, output: { item: "planks", count: 2 } },
        { name: "campfire", input: { planks: CRAFT_CAMPFIRE_COST }, output: { item: "campfire", count: 1 } },
        { name: "sail", input: { planks: CRAFT_SAIL_COST }, output: { item: "sail", count: 1 } },
        { name: "cooked_fish", input: { raw_fish: 1 }, output: { item: "cooked_fish", count: 1 }, needsFire: true },
        { name: "raft_upgrade", input: { planks: CRAFT_RAFT_COST }, output: { item: "raft_upgrade", count: 1 } },
      ];
      const recipe = recipes[craftState.lastRecipe % recipes.length];
      craftState.lastRecipe = (craftState.lastRecipe + 1) % recipes.length;
      ctx.world.setResource("craftState", craftState);

      // Check if near campfire for cooking
      let nearFire = false;
      if (recipe.needsFire) {
        buildableQuery.iterate(ctx.tick, (_be, [b]) => {
          const dx = b.x - player.x;
          const dz = b.z - player.z;
          if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
        });
      }

      // Check ingredients
      let canCraft = true;
      for (const [item, count] of Object.entries(recipe.input)) {
        if (invCount(inv.slots, item) < count) canCraft = false;
      }
      if (recipe.needsFire && !nearFire) canCraft = false;

      if (canCraft) {
        for (const [item, count] of Object.entries(recipe.input)) {
          invRemove(inv.slots, item, count);
        }
        invAdd(inv.slots, recipe.output.item, recipe.output.count);
        console.log(`[craft] crafted ${recipe.output.count}x ${recipe.output.item}`);
        playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CRAFT));

        // Place campfire in world
        if (recipe.output.item === "campfire") {
          const comps = new Map<number, unknown>();
          comps.set(Buildable.id, Buildable.create({
            type: "campfire",
            x: player.x + 1,
            y: player.y,
            z: player.z + 1,
            health: 100,
          }));
          ecsWorld.spawn(comps);
          console.log("[craft] campfire placed near player");
        }
      } else {
        console.log(`[craft] cannot craft ${recipe.name} — missing resources${recipe.needsFire && !nearFire ? " or need campfire nearby" : ""}`);
      }
    }

    // Place raft upgrade (improves ship speed)
    if (input.pressed.has("b") && invCount(inv.slots, "raft_upgrade") > 0) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        const dx = ship.x - player.x;
        const dz = ship.z - player.z;
        if (Math.sqrt(dx * dx + dz * dz) < BOARD_RANGE + 2) {
          invRemove(inv.slots, "raft_upgrade", 1);
          ship.maxIntegrity += 50;
          ship.integrity = ship.maxIntegrity;
          console.log(`[craft] raft upgraded! Ship integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
        }
      });
    }

    // Eat food
    if (input.pressed.has("t")) {
      if (invRemove(inv.slots, "cooked_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 35);
        });
        console.log("[food] ate cooked fish (+35 hunger)");
      } else if (invRemove(inv.slots, "raw_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 15);
        });
        console.log("[food] ate raw fish (+15 hunger)");
      } else if (invRemove(inv.slots, "food", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 25);
        });
        console.log("[food] ate food (+25 hunger)");
      }
    }
  });
}, { queries: [playerInvQuery, playerProgQuery, shipQuery] });

// 12. InventorySpoilageSystem — food spoils over time
const spoilageSystem = system("spoilage", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const gameHoursPerSecond = 24 / DAY_DURATION;
  const spoilThisTick = SPOILAGE_RATE * gameHoursPerSecond * dt;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    for (let i = inv.slots.length - 1; i >= 0; i--) {
      const s = inv.slots[i];
      if (s.item === "raw_fish" || s.item === "food" || s.item === "cooked_fish") {
        s.spoil -= spoilThisTick;
        if (s.spoil <= 0) {
          console.log(`[spoilage] ${s.item} spoiled!`);
          inv.slots.splice(i, 1);
        }
      }
    }
  });
}, { queries: [playerInvQuery] });

// 13. ShipIslandCollisionSystem — prevent ship from sailing through islands
const shipIslandCollisionSystem = system("ship-island-collision", Stage.Update, (ctx) => {
  shipQuery.iterate(ctx.tick, (_e, [ship]) => {
    const island = isOnIsland(ship.x, ship.z);
    if (island.onLand && island.groundY > ISLAND_BEACH_LEVEL) {
      // Push ship away from island center
      let pushX = 0, pushZ = 0;
      islandQuery.iterate(ctx.tick, (_ie, [islRaw]) => {
        const isl = islRaw as typeof Island.defaults;
        const dx = ship.x - isl.x;
        const dz = ship.z - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < isl.radius && islandHeightAt(isl, ship.x, ship.z) > ISLAND_BEACH_LEVEL) {
          const push = (isl.radius - dist) / isl.radius;
          pushX += (dx / dist) * push * 2;
          pushZ += (dz / dist) * push * 2;
        }
      });
      ship.x += pushX;
      ship.z += pushZ;
      ship.speed *= 0.3;
    }
  });
}, { queries: [shipQuery] });

// 14. DebrisDriftSystem — debris floats with wind/current
const debrisDriftSystem = system("debris-drift", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  debrisQuery.iterate(ctx.tick, (_e, [debris]) => {
    if (debris.collected) return;
    debris.x += weatherState.windDirX * weatherState.windSpeed * 0.02 * dt;
    debris.z += weatherState.windDirZ * weatherState.windSpeed * 0.02 * dt;
    debris.y = WATER_LEVEL + Math.sin(ctx.tick * 0.05 + debris.x) * 0.15;
  });
}, { queries: [debrisQuery] });

// 15. PirateSystem — enemy ships spawn, chase, attack, drop loot
const pirateSystem = system("pirates", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  const spawnTimer = ctx.world.getResource<number>("pirateSpawnTimer") ?? 0;
  const newTimer = spawnTimer + dt;
  ctx.world.setResource("pirateSpawnTimer", newTimer);

  // Spawn check
  if (newTimer > PIRATE_SPAWN_INTERVAL) {
    ctx.world.setResource("pirateSpawnTimer", 0);
    if (Math.random() < PIRATE_SPAWN_CHANCE) {
      playerQuery.iterate(ctx.tick, (pe, [player]) => {
        const angle = Math.random() * Math.PI * 2;
        const dist = PIRATE_SPAWN_MIN_DIST + Math.random() * (PIRATE_SPAWN_MAX_DIST - PIRATE_SPAWN_MIN_DIST);
        const px = player.x + Math.cos(angle) * dist;
        const pz = player.z + Math.sin(angle) * dist;
        const diff = 1 + Math.random();
        const comps = new Map<number, unknown>();
        comps.set(Pirate.id, Pirate.create({
          x: px, y: 0, z: pz,
          heading: Math.atan2(player.z - pz, player.x - px),
          state: PirateState.Patrol,
          health: PIRATE_HEALTH * diff,
          maxHealth: PIRATE_HEALTH * diff,
          difficulty: diff,
        }));
        spawnEntity(ctx.world, comps);
        console.log(`[pirate] spawned at (${px.toFixed(0)}, ${pz.toFixed(0)}) difficulty ${diff.toFixed(1)}`);
      });
    }
  }

  // Update pirate AI
  let playerX = 0, playerZ = 0, shipX = 0, shipZ = 0;
  playerQuery.iterate(ctx.tick, (_e, [p]) => { playerX = p.x; playerZ = p.z; });
  shipQuery.iterate(ctx.tick, (_e, [s]) => { shipX = s.x; shipZ = s.z; });

  pirateQuery.iterate(ctx.tick, (entity, [pirate]) => {
    if (pirate.health <= 0) return;
    pirate.stateTimer += dt;
    if (pirate.attackCooldown > 0) pirate.attackCooldown -= dt;

    const dx = shipX - pirate.x;
    const dz = shipZ - pirate.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // State machine
    if (dist < PIRATE_ATTACK_RANGE) {
      pirate.state = PirateState.Attack;
    } else if (dist < PIRATE_CHASE_RANGE) {
      pirate.state = PirateState.Chase;
    } else {
      pirate.state = PirateState.Patrol;
    }

    if (pirate.state === PirateState.Chase || pirate.state === PirateState.Attack) {
      pirate.heading = Math.atan2(dz, dx);
      pirate.vx = Math.cos(pirate.heading) * PIRATE_SPEED;
      pirate.vz = Math.sin(pirate.heading) * PIRATE_SPEED;
    } else {
      // Patrol — wander
      if (pirate.stateTimer > 5) {
        pirate.stateTimer = 0;
        pirate.heading = Math.random() * Math.PI * 2;
      }
      pirate.vx = Math.cos(pirate.heading) * PIRATE_SPEED * 0.3;
      pirate.vz = Math.sin(pirate.heading) * PIRATE_SPEED * 0.3;
    }

    pirate.x += pirate.vx * dt;
    pirate.z += pirate.vz * dt;

    // Attack ship
    if (pirate.state === PirateState.Attack && pirate.attackCooldown <= 0) {
      pirate.attackCooldown = PIRATE_ATTACK_COOLDOWN;
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        ship.integrity = Math.max(0, ship.integrity - PIRATE_ATTACK_DAMAGE * pirate.difficulty);
        console.log(`[pirate] attacked ship! integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
      });
    }

    // Flee if low health
    if (pirate.health < pirate.maxHealth * 0.2) {
      pirate.state = PirateState.Flee;
      pirate.vx = -Math.cos(pirate.heading) * PIRATE_SPEED;
      pirate.vz = -Math.sin(pirate.heading) * PIRATE_SPEED;
    }

    // Gun — press G to shoot nearest pirate
    if (input?.pressed.has("g")) {
      const pdx = pirate.x - playerX;
      const pdz = pirate.z - playerZ;
      const pdist = Math.sqrt(pdx * pdx + pdz * pdz);
      if (pdist < TOOL_GUN_RANGE) {
        pirate.health -= TOOL_GUN_DAMAGE;
        console.log(`[gun] hit pirate for ${TOOL_GUN_DAMAGE} (health: ${pirate.health.toFixed(0)})`);
        if (pirate.health <= 0) {
          console.log("[pirate] defeated! Dropping loot...");
          playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
            for (let i = 0; i < PIRATE_LOOT_DROP; i++) {
              const loot = ["wood", "food", "planks"][Math.floor(Math.random() * 3)];
              invAdd(inv.slots, loot, 1);
            }
          });
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => {
            addXP(ctx.world, pe, XP_KILL_PIRATE);
          });
          pirate.health = 0;
        }
      }
    }
  });

  // Remove dead pirates (set health to -1 to mark for removal — simplified)
  // In a real ECS we'd despawn, but for this example we just leave them at 0
}, { queries: [pirateQuery, playerQuery, shipQuery, playerInvQuery, playerProgQuery] });

// 16. PortMarketSystem — ports on islands, trade goods, dynamic prices
const portMarketSystem = system("port-market", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  // Price recovery
  portQuery.iterate(ctx.tick, (_e, [port]) => {
    for (const listing of port.listings) {
      if (listing.priceModifier < 1.0) {
        listing.priceModifier = Math.min(1.0, listing.priceModifier + MARKET_PRICE_RECOVERY * dt);
      } else if (listing.priceModifier > 1.0) {
        listing.priceModifier = Math.max(1.0, listing.priceModifier - MARKET_PRICE_RECOVERY * dt);
      }
    }
  });

  // Trade — press T near port to buy/sell (T is eat, so use Y for trade)
  if (input?.pressed.has("y")) {
    let playerX = 0, playerZ = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { playerX = p.x; playerZ = p.z; });

    portQuery.iterate(ctx.tick, (_e, [port]) => {
      const dx = port.x - playerX;
      const dz = port.z - playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < PORT_TRADE_RANGE) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          // Sell raw_fish
          const fishCount = invCount(inv.slots, "raw_fish");
          if (fishCount > 0) {
            invRemove(inv.slots, "raw_fish", fishCount);
            const price = Math.floor(5 * (port.listings.find(l => l.item === "raw_fish")?.priceModifier ?? 1));
            console.log(`[port] Sold ${fishCount} raw_fish for ${price * fishCount} coins`);
            invAdd(inv.slots, "coin", price * fishCount);
          }
          // Buy wood
          const coins = invCount(inv.slots, "coin");
          const woodPrice = Math.floor(3 * (port.listings.find(l => l.item === "wood")?.priceModifier ?? 1));
          if (coins >= woodPrice) {
            invRemove(inv.slots, "coin", woodPrice);
            invAdd(inv.slots, "wood", 1);
            console.log(`[port] Bought 1 wood for ${woodPrice} coins`);
          }
        });
      }
    });
  }
}, { queries: [portQuery, playerQuery, playerInvQuery] });

// 17. AnimalSystem — livestock on islands, growth, products
const animalSystem = system("animals", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  animalQuery.iterate(ctx.tick, (entity, [animal]) => {
    animal.age += dt;
    if (animal.stage < AnimalStage.Adult && animal.age > (animal.stage + 1) * ANIMAL_GROWTH_TIME) {
      animal.stage++;
      console.log(`[animal] ${animal.species} grew to stage ${animal.stage}`);
    }
    animal.hunger = Math.max(0, animal.hunger - ANIMAL_HUNGER_DECAY * dt);

    // Wander on island
    if (Math.random() < 0.01) {
      animal.vx = (Math.random() - 0.5) * 2;
      animal.vz = (Math.random() - 0.5) * 2;
    }
    animal.x += animal.vx * dt;
    animal.z += animal.vz * dt;
    animal.vx *= 0.95;
    animal.vz *= 0.95;

    // Product timer (adults only)
    if (animal.stage >= AnimalStage.Adult && animal.hunger > 20) {
      animal.productTimer -= dt;
      if (animal.productTimer <= 0) {
        animal.productTimer = ANIMAL_PRODUCT_TIME;
        console.log(`[animal] ${animal.species} produced ${animal.productType}`);
      }
    }

    // Harvest — press H near animal
    if (input?.pressed.has("h") && animal.stage >= AnimalStage.Adult && animal.productTimer < ANIMAL_PRODUCT_TIME - 5) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((animal.x - px) ** 2 + (animal.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.slots, animal.productType, 1);
          animal.productTimer = ANIMAL_PRODUCT_TIME;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          console.log(`[animal] harvested ${animal.productType}`);
        });
      }
    }
  });
}, { queries: [animalQuery, playerQuery, playerInvQuery, playerProgQuery] });

// 18. PlantSystem — crop growth and harvest
const plantSystem = system("plants", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  plantQuery.iterate(ctx.tick, (entity, [plant]) => {
    plant.waterLevel = Math.max(0, plant.waterLevel - PLANT_WATER_DECAY * dt);

    if (plant.waterLevel > 10 && plant.stage < PlantStage.Overripe) {
      plant.growthTimer += dt;
      const duration = PLANT_STAGE_DURATIONS[plant.stage] ?? 300;
      if (plant.growthTimer >= duration) {
        plant.stage++;
        plant.growthTimer = 0;
        console.log(`[plant] ${plant.species} grew to stage ${plant.stage}`);
      }
    }

    // Harvest — press H near mature plant
    if (input?.pressed.has("h") && plant.stage >= PlantStage.Mature) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((plant.x - px) ** 2 + (plant.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.slots, plant.species, plant.yield);
          plant.stage = PlantStage.Seed;
          plant.growthTimer = 0;
          plant.waterLevel = 100;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          console.log(`[plant] harvested ${plant.yield} ${plant.species}`);
        });
      }
    }

    // Water plant — press J near plant
    if (input?.pressed.has("j")) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((plant.x - px) ** 2 + (plant.z - pz) ** 2);
      if (d < 3) {
        plant.waterLevel = 100;
        console.log(`[plant] watered ${plant.species}`);
      }
    }
  });
}, { queries: [plantQuery, playerQuery, playerInvQuery, playerProgQuery] });

// 19. PetSystem — companion follows player
const petSystem = system("pets", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  petQuery.iterate(ctx.tick, (entity, [pet]) => {
    pet.hunger = Math.max(0, pet.hunger - PET_HUNGER_DECAY * dt);
    if (pet.cooldown > 0) pet.cooldown -= dt;

    let px = 0, py = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; py = p.y; pz = p.z; });

    const dx = px - pet.x;
    const dz = pz - pet.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > PET_FOLLOW_RANGE) {
      pet.vx = (dx / dist) * PET_FOLLOW_SPEED;
      pet.vz = (dz / dist) * PET_FOLLOW_SPEED;
    } else {
      pet.vx *= 0.8;
      pet.vz *= 0.8;
      pet.happiness = Math.min(100, pet.happiness + 0.5 * dt);
    }

    pet.x += pet.vx * dt;
    pet.z += pet.vz * dt;

    // Set y based on terrain
    const island = isOnIsland(pet.x, pet.z);
    pet.y = island.onLand ? island.groundY : WATER_LEVEL;

    // Feed pet — press P near pet
    if (input?.pressed.has("p")) {
      const pd = Math.sqrt((pet.x - px) ** 2 + (pet.z - pz) ** 2);
      if (pd < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          if (invRemove(inv.slots, "food", 1) || invRemove(inv.slots, "raw_fish", 1)) {
            pet.hunger = Math.min(100, pet.hunger + 30);
            pet.happiness = Math.min(100, pet.happiness + 10);
            console.log(`[pet] fed pet (hunger: ${pet.hunger.toFixed(0)}, happiness: ${pet.happiness.toFixed(0)})`);
          }
        });
      }
    }
  });
}, { queries: [petQuery, playerQuery, playerInvQuery] });

// 20. ToolSystem — axe to chop trees on islands, shovel to dig
const toolSystem = system("tools", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  // Axe — press X to chop tree (get wood on islands)
  if (input.pressed.has("x")) {
    let px = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
    const island = isOnIsland(px, pz);
    if (island.onLand) {
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        const wood = 1 + Math.floor(Math.random() * 2);
        invAdd(inv.slots, "wood", wood);
        playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
        console.log(`[axe] chopped tree, got ${wood} wood`);
      });
    } else {
      console.log("[axe] no trees here — need to be on an island");
    }
  }

  // Shovel — press V to dig for items on islands
  if (input.pressed.has("v")) {
    let px = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
    const island = isOnIsland(px, pz);
    if (island.onLand) {
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        const find = Math.random();
        if (find < 0.3) {
          invAdd(inv.slots, "coin", 1 + Math.floor(Math.random() * 3));
          console.log("[shovel] dug up coins!");
        } else if (find < 0.5) {
          invAdd(inv.slots, "wood", 1);
          console.log("[shovel] dug up buried wood");
        } else if (find < 0.6) {
          invAdd(inv.slots, "food", 1);
          console.log("[shovel] dug up food");
        } else {
          console.log("[shovel] nothing here...");
        }
      });
    }
  }
}, { queries: [playerQuery, playerInvQuery, playerProgQuery] });

// 21. ProgressionSystem — tick-based progression tracking
const progressionSystem = system("progression", Stage.Update, (ctx) => {
  // Ensure all players have progression data
  playerProgQuery.iterate(ctx.tick, (_e, [_player, prog]) => {
    if (prog.level === 1 && prog.xp === 0 && prog.unlockedRecipes.length === 0) {
      prog.unlockedRecipes = ["planks", "campfire", "cooked_fish"];
      if (prog.craftingTier >= 1) prog.unlockedRecipes.push("sail", "raft_upgrade");
    }
  });
}, { queries: [playerProgQuery] });

let ecsWorld: World;
let gameWorld: GameWorld;
let camera: Camera;
let particles: ParticleSystem;
let telemetry: TelemetryCollector;
let playerEntity: Entity;
let frameCount = 0;
let timeOfDay = 0.3;
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

// ─── Helper: spawn entity with multiple components ─────────

function spawnEntity(world: World, components: Map<number, unknown>) {
  return world.spawn(components);
}

// ─── Lifecycle: init ───────────────────────────────────────

export function init(ctx: any) {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Ocean Survival — DownDraft Engine          ║");
  console.log("║   (parity with to-the-ocean game systems)    ║");
  console.log("╚══════════════════════════════════════════════╝");

  ecsWorld = new World();
  const scene = new Scene("ocean-survival", ecsWorld);
  gameWorld = new GameWorld(scene);

  // Camera — third-person view following player
  camera = new Camera();
  camera.setAspect(16, 9);
  camera.distance = 15;
  camera.orbit(0, 0.4);
  camera.setTarget(0, 1, 0);
  ecsWorld.setResource("camera", camera);

  // Meshes for rendering
  const shipMesh = MeshBuilder.cube(2);
  ecsWorld.setResource("shipMesh", shipMesh);

  const sharkMesh = MeshBuilder.sphere(0.8, 12, 8);
  ecsWorld.setResource("sharkMesh", sharkMesh);

  const fishMesh = MeshBuilder.sphere(0.3, 8, 6);
  ecsWorld.setResource("fishMesh", fishMesh);

  const debrisMesh = MeshBuilder.cube(0.4);
  ecsWorld.setResource("debrisMesh", debrisMesh);

  const waterMesh = MeshBuilder.plane(200, 200, 1);
  ecsWorld.setResource("waterMesh", waterMesh);

  // Input + game resources (enhanced with InputState)
  const inputState = createInputState();
  ecsWorld.setResource("inputState", inputState);
  // Keep legacy input resource for backward compat with systems that haven't been migrated
  ecsWorld.setResource("input", { keys: inputState.keys, pressed: inputState.pressed });
  ecsWorld.setResource("raft", { wood: 5 });
  ecsWorld.setResource("time", 0);
  ecsWorld.setResource("craftState", { lastRecipe: 0 });
  ecsWorld.setResource("pirateSpawnTimer", 0);
  ecsWorld.setResource("gameMode", { difficulty: GAME_DIFFICULTY_NORMAL, dayDuration: DAY_DURATION, pvp: false });

  // Spawn player
  const playerComps = new Map<number, unknown>();
  playerComps.set(Player.id, Player.create({ x: 0, y: 1, z: 0 }));
  playerComps.set(Health.id, Health.create({ current: PLAYER_MAX_HEALTH, max: PLAYER_MAX_HEALTH }));
  playerComps.set(Hunger.id, Hunger.create({ current: PLAYER_MAX_HUNGER, max: PLAYER_MAX_HUNGER }));
  playerComps.set(Thirst.id, Thirst.create({ current: PLAYER_MAX_THIRST, max: PLAYER_MAX_THIRST }));
  playerComps.set(Oxygen.id, Oxygen.create({ current: PLAYER_MAX_OXYGEN, max: PLAYER_MAX_OXYGEN }));
  playerComps.set(Temperature.id, Temperature.create({ current: PLAYER_TEMP_NORM }));
  playerComps.set(Inventory.id, Inventory.create({ slots: [] }));
  playerComps.set(Progression.id, Progression.create({ level: 1, xp: 0, craftingTier: 0, hullTier: 0, unlockedRecipes: ["planks", "campfire", "cooked_fish"] }));
  playerEntity = spawnEntity(ecsWorld, playerComps);

  // Spawn fishing line entity (singleton)
  const fishingComps = new Map<number, unknown>();
  fishingComps.set(FishingLine.id, FishingLine.create({ cast: false, timer: 0, waitTime: 0, hooked: false }));
  spawnEntity(ecsWorld, fishingComps);

  // Spawn ship
  const shipComps = new Map<number, unknown>();
  shipComps.set(Ship.id, Ship.create({ x: 0, y: 0, z: 0, integrity: 100, maxIntegrity: 100 }));
  spawnEntity(ecsWorld, shipComps);

  // Spawn sharks
  for (let i = 0; i < 2; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 30;
    const wlComps = new Map<number, unknown>();
    wlComps.set(Wildlife.id, Wildlife.create({
      type: "shark",
      state: WildlifeState.Patrol,
      speed: SHARK_SPEED + Math.random() * 2,
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      y: WATER_LEVEL - 1,
      attackCooldown: 0,
      health: 50,
    }));
    spawnEntity(ecsWorld, wlComps);
  }

  // Spawn fish
  for (let i = 0; i < 5; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 40;
    const wlComps = new Map<number, unknown>();
    wlComps.set(Wildlife.id, Wildlife.create({
      type: "fish",
      state: WildlifeState.Patrol,
      speed: FISH_SPEED,
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      y: WATER_LEVEL - 1,
      attackCooldown: 0,
      health: 10,
    }));
    spawnEntity(ecsWorld, wlComps);
  }

  // Spawn islands
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const angle = (i / ISLAND_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 40 + Math.random() * ISLAND_SPAWN_RANGE;
    const radius = ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS);
    const height = ISLAND_MIN_HEIGHT + Math.random() * (ISLAND_MAX_HEIGHT - ISLAND_MIN_HEIGHT);
    // Pick a biome for this island
    const biomeRoll = Math.random();
    const biome = biomeRoll < 0.35 ? BiomeType.Tropical :
      biomeRoll < 0.60 ? BiomeType.Temperate :
      biomeRoll < 0.75 ? BiomeType.Arctic :
      biomeRoll < 0.90 ? BiomeType.Desert : BiomeType.Volcanic;
    const chunkX = Math.floor(Math.cos(angle) * dist);
    const chunkZ = Math.floor(Math.sin(angle) * dist);

    // Generate volumetric voxel field for this island
    console.log(`  [terrain] generating voxel field for island ${i + 1} (biome: ${BiomeType[biome]}, radius: ${radius.toFixed(0)})...`);
    const voxelField = generateVoxelField(chunkX, chunkZ, radius, biome);

    // Extract mesh from voxel field using marching cubes
    const meshData = extractMeshFromField(voxelField, biome, 30000);
    console.log(`  [terrain] island ${i + 1} mesh: ${meshData.vertexCount} verts, ${meshData.indexCount} indices`);

    const islandComps = new Map<number, unknown>();
    islandComps.set(Island.id, Island.create({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius,
      height,
      hasTrees: Math.random() > 0.3,
      hasRocks: Math.random() > 0.5,
      visited: false,
      biome,
      chunkX,
      chunkZ,
      voxelField,
      meshData,
    }));
    const islandEntity = spawnEntity(ecsWorld, islandComps);

    // Spawn port on first PORT_COUNT islands
    if (i < PORT_COUNT) {
      const portComps = new Map<number, unknown>();
      portComps.set(Port.id, Port.create({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        islandEntity,
        name: `Port-${i + 1}`,
        listings: [
          { item: "wood", buyPrice: 3, sellPrice: 2, supply: 100, priceModifier: 1.0 },
          { item: "raw_fish", buyPrice: 5, sellPrice: 4, supply: 50, priceModifier: 1.0 },
          { item: "planks", buyPrice: 8, sellPrice: 6, supply: 80, priceModifier: 1.0 },
          { item: "food", buyPrice: 4, sellPrice: 3, supply: 60, priceModifier: 1.0 },
        ],
      }));
      spawnEntity(ecsWorld, portComps);
    }

    // Spawn animals on islands
    for (let a = 0; a < ANIMAL_COUNT_PER_ISLAND; a++) {
      const aAngle = Math.random() * Math.PI * 2;
      const aDist = Math.random() * radius * 0.7;
      const ax = Math.cos(angle) * dist + Math.cos(aAngle) * aDist;
      const az = Math.sin(angle) * dist + Math.sin(aAngle) * aDist;
      const species = ["chicken", "goat", "sheep"][Math.floor(Math.random() * 3)];
      const productType = species === "chicken" ? "egg" : species === "goat" ? "milk" : "wool";
      const animalComps = new Map<number, unknown>();
      animalComps.set(Animal.id, Animal.create({
        x: ax, y: islandHeightAt({ x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, radius, height, voxelField }, ax, az),
        z: az,
        species,
        productType,
        islandEntity,
      }));
      spawnEntity(ecsWorld, animalComps);
    }

    // Spawn plants on islands
    for (let p = 0; p < PLANT_COUNT_PER_ISLAND; p++) {
      const pAngle = Math.random() * Math.PI * 2;
      const pDist = Math.random() * radius * 0.7;
      const px = Math.cos(angle) * dist + Math.cos(pAngle) * pDist;
      const pz = Math.sin(angle) * dist + Math.sin(pAngle) * pDist;
      const species = ["kelp", "tomato", "rice"][Math.floor(Math.random() * 3)];
      const plantComps = new Map<number, unknown>();
      plantComps.set(Plant.id, Plant.create({
        x: px, y: islandHeightAt({ x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, radius, height, voxelField }, px, pz),
        z: pz,
        species,
        islandEntity,
      }));
      spawnEntity(ecsWorld, plantComps);
    }
  }

  // Spawn a pet companion near player
  const petComps = new Map<number, unknown>();
  petComps.set(Pet.id, Pet.create({
    x: 2, y: 1, z: 2,
    type: PetType.Cat,
    ownerId: 0,
  }));
  spawnEntity(ecsWorld, petComps);

  // Spawn debris
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 20;
    const r = Math.random();
    const type = r < 0.4 ? "wood" : r < 0.7 ? "food" : "water";
    const debrisComps = new Map<number, unknown>();
    debrisComps.set(Debris.id, Debris.create({
      type,
      x: Math.cos(angle) * dist,
      y: WATER_LEVEL,
      z: Math.sin(angle) * dist,
      collected: false,
    }));
    spawnEntity(ecsWorld, debrisComps);
  }

  // Register systems in tick order (matching to-the-ocean Simulation.tick)
  ecsWorld.schedule.addSystem(weatherSystem);
  ecsWorld.schedule.addSystem(playerMovementSystem);
  ecsWorld.schedule.addSystem(shipControlSystem);
  ecsWorld.schedule.addSystem(buoyancySystem);
  ecsWorld.schedule.addSystem(survivalSystem);
  ecsWorld.schedule.addSystem(wildlifeAISystem);
  ecsWorld.schedule.addSystem(debrisCollectionSystem);
  ecsWorld.schedule.addSystem(shipIntegritySystem);
  ecsWorld.schedule.addSystem(shipBoardingSystem);
  ecsWorld.schedule.addSystem(fishingSystem);
  ecsWorld.schedule.addSystem(craftingSystem);
  ecsWorld.schedule.addSystem(spoilageSystem);
  ecsWorld.schedule.addSystem(shipIslandCollisionSystem);
  ecsWorld.schedule.addSystem(debrisDriftSystem);
  ecsWorld.schedule.addSystem(pirateSystem);
  ecsWorld.schedule.addSystem(portMarketSystem);
  ecsWorld.schedule.addSystem(animalSystem);
  ecsWorld.schedule.addSystem(plantSystem);
  ecsWorld.schedule.addSystem(petSystem);
  ecsWorld.schedule.addSystem(toolSystem);
  ecsWorld.schedule.addSystem(progressionSystem);

  // Update query archetypes now that systems are registered
  ecsWorld.schedule.updateQueryArchetypes(ecsWorld.allArchetypes);

  // Particles
  particles = new ParticleSystem({ maxParticlesPerEmitter: 2000 });
  particles.registerEmitter(createFireEmitter({ position: [0, 1.5, 0], emissionRate: 30 }));
  particles.registerEmitter(createSmokeEmitter({ position: [0, 2.5, 0], emissionRate: 10 }));

  // Telemetry
  telemetry = new TelemetryCollector(true);

  console.log("  Player spawned at origin with full survival stats");
  console.log("  Ship created (integrity: 100%)");
  console.log("  2 sharks + 5 fish spawned");
  console.log("  10 debris items scattered (wood/food/water)");
  console.log(`  ${ISLAND_COUNT} islands generated in the surrounding ocean`);
  console.log(`  ${PORT_COUNT} ports with dynamic market prices`);
  console.log(`  ${ISLAND_COUNT * ANIMAL_COUNT_PER_ISLAND} animals (chickens, goats, sheep) on islands`);
  console.log(`  ${ISLAND_COUNT * PLANT_COUNT_PER_ISLAND} plants (kelp, tomato, rice) on islands`);
  console.log("  1 pet companion (cat) spawned near player");
  console.log("  Pirates may spawn and attack your ship!");
  console.log("  Fire + smoke particle emitters active");
  console.log("  Weather: Clear, wind: 3 m/s");
  console.log("");
  console.log("  Controls:");
  console.log("    WASD = move (heading-based) | Mouse = look | Shift = run/throttle");
  console.log("    Space = jump | Ctrl+Space = dive underwater | Arrows = steer ship");
  console.log("    E = board/leave ship | Q = anchor | R = repair (needs wood)");
  console.log("    F = fish | C = craft (cycles recipes) | B = apply raft upgrade");
  console.log("    T = eat food | Y = trade at port");
  console.log("    G = gun (shoot pirates) | X = axe (chop trees on islands)");
  console.log("    V = shovel (dig for treasure) | H = harvest (animals/plants)");
  console.log("    J = water plant | P = feed pet");
  console.log("    M = toggle camera (1st/3rd/freecam) | F5 = noclip");
  console.log("    1-9,0 = hotbar slots | Scroll = zoom camera");
  console.log("  Terrain: volumetric voxel fields with marching cubes mesh extraction");
  console.log("  Biomes: Tropical, Temperate, Arctic, Desert, Volcanic");
  console.log("  Survival: manage hunger, thirst, oxygen, temperature");
  console.log("  Crafting: wood->planks->campfire->cook fish->raft upgrade");
  console.log("  Economy: sell fish at ports for coins, buy wood/supplies");
  console.log("  Progression: gain XP from fishing, crafting, harvesting, killing pirates");
}

// ─── Lifecycle: tick ───────────────────────────────────────

export function tick(ctx: any, dt: number) {
  frameCount++;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 1) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsAccum = 0;
  }

  // Apply keyboard input from renderer
  if (ctx?.input) {
    const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
    if (inputRes) {
      inputRes.keys = ctx.input.keys;
      // Merge pressed keys (don't overwrite — might have been set by previous tick)
      for (const k of ctx.input.pressed) inputRes.pressed.add(k);
    }
    // Sync enhanced input state
    const inpState = ecsWorld.getResource<InputState>("inputState");
    if (inpState) {
      inpState.keys = ctx.input.keys;
      for (const k of ctx.input.pressed) inpState.pressed.add(k);
      // Sync key bitmask from key set
      if (ctx.input.keys) {
        for (const keyName of ctx.input.keys) {
          const keyCode = (KEY as Record<string, number>)[keyName] ?? (KEY as Record<string, number>)[keyName.toUpperCase()];
          if (keyCode !== undefined) setKey(inpState, keyCode, true);
        }
      }
      // Sync pressed keys to bitmask (one-shot)
      if (ctx.input.pressed) {
        for (const keyName of ctx.input.pressed) {
          const keyCode = (KEY as Record<string, number>)[keyName] ?? (KEY as Record<string, number>)[keyName.toUpperCase()];
          if (keyCode !== undefined) setKey(inpState, keyCode, true);
        }
      }
      // Mouse-look delta
      if (ctx.input.mouseDX !== undefined) inpState.mouseDX += ctx.input.mouseDX;
      if (ctx.input.mouseDY !== undefined) inpState.mouseDY += ctx.input.mouseDY;
      if (ctx.input.wheel !== undefined) inpState.wheel += ctx.input.wheel;
      // Gamepad axes
      if (ctx.input.gamepadAxes) {
        for (let i = 0; i < 8; i++) {
          if (ctx.input.gamepadAxes[i] !== undefined) inpState.gamepadAxes[i] = ctx.input.gamepadAxes[i];
        }
      }
      // Look heading/pitch from renderer
      if (ctx.input.lookHeading !== undefined) inpState.lookHeading = ctx.input.lookHeading;
      if (ctx.input.lookPitch !== undefined) inpState.lookPitch = ctx.input.lookPitch;
    }
  }

  // Update time of day
  timeOfDay += dt / DAY_DURATION;
  if (timeOfDay >= 1) timeOfDay -= 1;

  const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
  ecsWorld.setResource("isNight", isNight);
  ecsWorld.setResource("timeOfDay", timeOfDay);

  // Step the ECS world (runs all registered systems)
  gameWorld.step(dt);

  // Clear pressed keys after tick (one-shot inputs)
  const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (inputRes) inputRes.pressed.clear();
  const inpState = ecsWorld.getResource<InputState>("inputState");
  if (inpState) {
    inpState.pressed.clear();
    // Clear key bitmask for one-shot keys
    inpState.keyBits.fill(0);
  }

  // Update particles (only with a real GPU device)
  if (ctx?.device && typeof ctx.device === "object") {
    particles.update(dt);
  }

  // Update time resource
  const timeRes = ecsWorld.getResource<number>("time") ?? 0;
  ecsWorld.setResource("time", timeRes + dt);

  // Follow player with camera (mode-aware)
  const playerData = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
  if (playerData) {
    const camMode = playerData.cameraMode;
    const camZoom = inpState?.cameraZoom ?? CAMERA_THIRD_PERSON_DEFAULT;

    if (camMode === CameraMode.FirstPerson) {
      // First person: camera at player eye level
      const eyeY = playerData.y + 1.6;
      const dirX = Math.sin(playerData.heading) * Math.cos(playerData.pitch);
      const dirY = Math.sin(playerData.pitch);
      const dirZ = -Math.cos(playerData.heading) * Math.cos(playerData.pitch);
      camera.setTarget(playerData.x + dirX * 0.1, eyeY + dirY * 0.1, playerData.z + dirZ * 0.1);
      camera.position = [playerData.x - dirX * 0.1, eyeY - dirY * 0.1, playerData.z - dirZ * 0.1];
    } else if (camMode === CameraMode.FreeCam) {
      // FreeCam: camera doesn't follow player, controlled by input
      if (inpState) {
        const speed = CAMERA_FREECAM_SPEED * dt;
        const cosH = Math.cos(playerData.heading), sinH = Math.sin(playerData.heading);
        if (isKeyDown(inpState, KEY.W)) {
          camera.position[0] += sinH * speed;
          camera.position[2] -= cosH * speed;
        }
        if (isKeyDown(inpState, KEY.S)) {
          camera.position[0] -= sinH * speed;
          camera.position[2] += cosH * speed;
        }
        if (isKeyDown(inpState, KEY.A)) {
          camera.position[0] -= cosH * speed;
          camera.position[2] -= sinH * speed;
        }
        if (isKeyDown(inpState, KEY.D)) {
          camera.position[0] += cosH * speed;
          camera.position[2] += sinH * speed;
        }
        if (isKeyDown(inpState, KEY.SPACE)) camera.position[1] += speed;
        if (isKeyDown(inpState, KEY.SHIFT)) camera.position[1] -= speed;
        camera.setTarget(
          camera.position[0] + Math.sin(playerData.heading) * Math.cos(playerData.pitch),
          camera.position[1] + Math.sin(playerData.pitch),
          camera.position[2] - Math.cos(playerData.heading) * Math.cos(playerData.pitch),
        );
      }
    } else {
      // Third person: camera behind and above player
      const eyeY = playerData.y + 1.6;
      const dirX = Math.sin(playerData.heading) * Math.cos(playerData.pitch);
      const dirY = Math.sin(playerData.pitch);
      const dirZ = -Math.cos(playerData.heading) * Math.cos(playerData.pitch);
      camera.setTarget(playerData.x + dirX * 2, eyeY + dirY * 2, playerData.z + dirZ * 2);
      camera.position = [
        playerData.x - dirX * camZoom,
        eyeY - dirY * camZoom + camZoom * 0.3,
        playerData.z - dirZ * camZoom,
      ];
    }
  }

  // Periodic status log
  if (frameCount % 300 === 0) {
    const ph = ecsWorld.getComponent<typeof Health.defaults>(playerEntity, Health.id);
    const hu = ecsWorld.getComponent<typeof Hunger.defaults>(playerEntity, Hunger.id);
    const th = ecsWorld.getComponent<typeof Thirst.defaults>(playerEntity, Thirst.id);
    const ox = ecsWorld.getComponent<typeof Oxygen.defaults>(playerEntity, Oxygen.id);
    const tp = ecsWorld.getComponent<typeof Temperature.defaults>(playerEntity, Temperature.id);
    const inv = ecsWorld.getComponent<typeof Inventory.defaults>(playerEntity, Inventory.id);
    const ship = ecsWorld.getComponent<typeof Ship.defaults>(ecsWorld.allArchetypes[0]?.entities?.[0] ?? 0, Ship.id);

    if (ph && hu && th && ox && tp) {
      console.log(
        `[frame ${frameCount}] FPS:${fps} | HP:${ph.current.toFixed(0)}/${ph.max} | Hunger:${hu.current.toFixed(0)} | Thirst:${th.current.toFixed(0)} | O2:${ox.current.toFixed(0)} | Temp:${tp.current.toFixed(1)}C`
      );
      console.log(
        `  Weather:${WeatherType[weatherState.type]} Wind:${weatherState.windSpeed.toFixed(1)}m/s Vis:${weatherState.visibility.toFixed(2)} Time:${(timeOfDay * 24).toFixed(1)}h`
      );
      if (inv) {
        const invStr = inv.slots.map((s: any) => `${s.item}x${s.count}`).join(", ") || "empty";
        console.log(`  Inventory: ${invStr}`);
      }

      const prog = ecsWorld.getComponent<typeof Progression.defaults>(playerEntity, Progression.id);
      if (prog) {
        console.log(`  Level: ${prog.level} | XP: ${prog.xp}/${XP_PER_LEVEL * prog.level} | Crafting Tier: ${prog.craftingTier}`);
      }

      if (ph.current <= 0) {
        console.log("[game] Player died — game over!");
      }
    }
  }
}

// ─── Lifecycle: dispose ────────────────────────────────────

export function dispose(ctx: any) {
  particles.destroy();
  console.log("[ocean-survival] disposed");
}

// ─── Lifecycle: getMeshData ─────────────────────────────────
// Exports island mesh data (marching cubes geometry) for the Rust renderer
// to upload as GPU buffers. Called once after init by src/bun/index.ts.

export function getMeshData(): IPCMeshData[] {
  const meshes: IPCMeshData[] = [];

  // Update archetypes manually — islandQuery is not attached to any system
  islandQuery.updateArchetypes(ecsWorld.allArchetypes);

  islandQuery.iterate(frameCount, (_e, [islandRaw]) => {
    const island = islandRaw as typeof Island.defaults;
    if (!island.meshData || !island.meshData.verts) return;

    // Convert indices to Uint32Array regardless of source format
    const indices = island.meshData.indices instanceof Uint32Array
      ? island.meshData.indices
      : new Uint32Array(island.meshData.indices);

    meshes.push({
      vertexCount: island.meshData.vertexCount,
      indexCount: island.meshData.indexCount,
      posX: island.x,
      posZ: island.z,
      verts: island.meshData.verts,
      indices,
    });
  });

  return meshes;
}

// ─── Lifecycle: getRenderData ──────────────────────────────

export function getRenderData(): RenderData {
  const entities: RenderEntityData[] = [];

  // Player entity
  playerQuery.iterate(frameCount, (_e, [player]) => {
    if (!player.isDead) {
      entities.push({
        type: 0, // Player
        x: player.x, y: player.y, z: player.z,
        r: 0.2, g: 0.8, b: 0.2,
      });
    }
  });

  // Ship entities
  shipQuery.iterate(frameCount, (_e, [ship]) => {
    entities.push({
      type: 1, // Ship
      x: ship.x, y: ship.y, z: ship.z,
      r: 0.6, g: 0.4, b: 0.2,
    });
  });

  // Wildlife entities
  wildlifeQuery.iterate(frameCount, (_e, [wl]) => {
    if (wl.type === "shark") {
      entities.push({
        type: 2, // Shark
        x: wl.x, y: wl.y, z: wl.z,
        r: 0.3, g: 0.3, b: 0.5,
      });
    } else {
      entities.push({
        type: 3, // Fish
        x: wl.x, y: wl.y, z: wl.z,
        r: 0.8, g: 0.6, b: 0.2,
      });
    }
  });

  // Debris entities
  debrisQuery.iterate(frameCount, (_e, [debris]) => {
    if (!debris.collected) {
      entities.push({
        type: 4, // Debris
        x: debris.x, y: debris.y, z: debris.z,
        r: debris.type === "wood" ? 0.5 : debris.type === "food" ? 0.9 : 0.3,
        g: debris.type === "wood" ? 0.3 : debris.type === "food" ? 0.7 : 0.5,
        b: debris.type === "wood" ? 0.1 : debris.type === "food" ? 0.2 : 0.9,
      });
    }
  });

  // Island entities are NOT pushed here — they are rendered as custom
  // marching cubes meshes loaded into the Rust renderer via getMeshData().

  // Buildable entities — campfires, etc.
  buildableQuery.iterate(frameCount, (_e, [b]) => {
    entities.push({
      type: 7, // Buildable
      x: b.x, y: b.y, z: b.z,
      r: b.type === "campfire" ? 0.9 : 0.5,
      g: b.type === "campfire" ? 0.5 : 0.4,
      b: b.type === "campfire" ? 0.1 : 0.3,
    });
  });

  // Pirate entities — red/black hostile ships
  pirateQuery.iterate(frameCount, (_e, [pirate]) => {
    if (pirate.health > 0) {
      entities.push({
        type: 8, // Pirate
        x: pirate.x, y: pirate.y, z: pirate.z,
        r: 0.8, g: 0.1, b: 0.1,
      });
    }
  });

  // Port entities — yellow/gold markers
  portQuery.iterate(frameCount, (_e, [port]) => {
    entities.push({
      type: 9, // Port
      x: port.x, y: 2, z: port.z,
      r: 0.9, g: 0.8, b: 0.1,
    });
  });

  // Animal entities — brown/white
  animalQuery.iterate(frameCount, (_e, [animal]) => {
    entities.push({
      type: 10, // Animal
      x: animal.x, y: animal.y, z: animal.z,
      r: animal.species === "chicken" ? 0.9 : 0.6,
      g: animal.species === "chicken" ? 0.7 : 0.5,
      b: animal.species === "chicken" ? 0.2 : 0.3,
    });
  });

  // Plant entities — green, brightness by growth stage
  plantQuery.iterate(frameCount, (_e, [plant]) => {
    const brightness = 0.3 + (plant.stage / PlantStage.Overripe) * 0.5;
    entities.push({
      type: 11, // Plant
      x: plant.x, y: plant.y, z: plant.z,
      r: 0.2, g: brightness, b: 0.1,
    });
  });

  // Pet entities — orange (cat)
  petQuery.iterate(frameCount, (_e, [pet]) => {
    entities.push({
      type: 12, // Pet
      x: pet.x, y: pet.y, z: pet.z,
      r: 0.9, g: 0.5, b: 0.2,
    });
  });

  return {
    cameraPos: camera.position,
    cameraTarget: camera.target,
    entities,
  };
}

// ─── Self-executing entry point (for `bun run examples/ocean-game/main.ts`) ─

if (import.meta.main) {
  init({});

  let lastTime = performance.now();
  let running = true;

  const onSignal = () => { running = false; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  (async () => {
    while (running) {
      const now = performance.now();
      let dt = (now - lastTime) / 1000;
      if (dt < SIM_TICK_DT) {
        await Bun.sleep(SIM_TICK_DT * 1000 - dt * 1000);
        dt = SIM_TICK_DT;
      }
      dt = Math.min(SIM_TICK_DT, dt);
      lastTime = performance.now();

      tick({}, dt);

      const ph = ecsWorld.getComponent<typeof Health.defaults>(playerEntity, Health.id);
      if (ph && ph.current <= 0) {
        console.log("\n  Game over! Player died.");
        running = false;
      }
    }
    dispose({});
  })();
}
