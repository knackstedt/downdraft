import {
  Camera,
  Component,
  createFireEmitter,
  createLogger,
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
  type RenderEntityData
} from "@downdraft/core";
import {
  BuoyancySystem,
  collectShoreSources,
  collectWakeSources,
  MAX_SHORES,
  MAX_WAKES,
  packShoreSources,
  SHORE_FLOATS,
  WAKE_FLOATS,
  WaterBuffer,
  WaterPhysics,
  type BuoyancyEntity,
  type ShoreProvider,
  type ShoreSource,
  type WakeProvider
} from "@downdraft/plugin-water";
import {
  canCraft,
  CraftingPlugin,
  executeCraft,
  getUnlockedRecipes,
  unlockRecipesForTier
} from "./plugins/crafting-plugin.ts";
import {
  createGrid,
  getGridStateForUI,
  addItem as gridAddItem,
  countItem as gridCountItem,
  GridInventory,
  removeItemById as gridRemoveItemById,
  InventoryPlugin,
  PLAYER_INV_HEIGHT,
  PLAYER_INV_WIDTH,
  type InventoryGrid
} from "./plugins/inventory-plugin.ts";
import { getItem } from "./plugins/items.ts";
import { CRAFTING_TIER_RECIPES } from "./plugins/recipes.ts";

const log = createLogger();

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
  maxVoxelMemory: 160_000_000,

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

function classifyTerrainTypeByUnitY(uy: number, biome: number): TerrainType {
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

  // Scratch arrays for edge vertex positions (12 edges * 3 coords)
  const edgeVertPos = new Float32Array(36);

  for (let x = 0; x < dimX - 1; x++) {
    for (let y = 0; y < dimY - 1; y++) {
      for (let z = 0; z < dimZ - 1; z++) {
        // Sample 8 corners
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

        // Interpolate edge vertex positions (store in scratch array)
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const [c0, c1] = MC_EDGE_CORNERS[e];
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
          const eo = e * 3;
          edgeVertPos[eo] = ex;
          edgeVertPos[eo + 1] = ey;
          edgeVertPos[eo + 2] = ez;
        }

        // Generate triangles using the standard MC tri table
        const triBase = cubeIndex * 16;
        for (let t = 0; t < 15; t += 3) {
          const e0 = MC_TRI_TABLE[triBase + t];
          if (e0 < 0) break;
          const e1 = MC_TRI_TABLE[triBase + t + 1];
          const e2 = MC_TRI_TABLE[triBase + t + 2];

          const ev0o = e0 * 3, ev1o = e1 * 3, ev2o = e2 * 3;
          const v0x = edgeVertPos[ev0o], v0y = edgeVertPos[ev0o + 1], v0z = edgeVertPos[ev0o + 2];
          const v1x = edgeVertPos[ev1o], v1y = edgeVertPos[ev1o + 1], v1z = edgeVertPos[ev1o + 2];
          const v2x = edgeVertPos[ev2o], v2y = edgeVertPos[ev2o + 1], v2z = edgeVertPos[ev2o + 2];

          // Compute face normal via cross product
          const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
          const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
          let nx = e1y * e2z - e1z * e2y;
          let ny = e1z * e2x - e1x * e2z;
          let nz = e1x * e2y - e1y * e2x;
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
          else { nx = 0; ny = 1; nz = 0; }
          if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

          // Determine terrain type at face centroid
          const cx = (v0x + v1x + v2x) / 3;
          const cy = (v0y + v1y + v2y) / 3;
          const cz = (v0z + v1z + v2z) / 3;
          const unitY = cy / field.radius;
          const tType = classifyTerrainTypeByUnitY(unitY, biome);
          const [r, g, b] = terrainTypeColor(tType, biome);

          // Write 3 vertices (9 floats each: pos3 + normal3 + color3)
          const baseIdx = vertList.length / 9;
          vertList.push(v0x, v0y, v0z, nx, ny, nz, r, g, b);
          vertList.push(v1x, v1y, v1z, nx, ny, nz, r, g, b);
          vertList.push(v2x, v2y, v2z, nx, ny, nz, r, g, b);
          indexList.push(baseIdx, baseIdx + 1, baseIdx + 2);

          if (vertList.length / 9 >= maxVerts) {
            const verts = new Float32Array(vertList);
            const indices = indexList.length > 65535 ? new Uint32Array(indexList) : new Uint16Array(indexList);
            return { verts, indices, vertexCount: vertList.length / 9, indexCount: indexList.length };
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
const WEATHER_CLEAR_CHANCE = 0.80;
const WEATHER_FULL_CLEAR = 0.30;
const WEATHER_PARTLY_CLOUDY = 0.40;
const WEATHER_OVERCAST = 0.30;
const WEATHER_MAX_DURATION = 300;
const WEATHER_MIN_DURATION = 60;
const WEATHER_RARE_EVENT_CHANCE = 0.02;
const RAIN_COLLECTOR_CAPACITY = 50;
const RAIN_COLLECTOR_FILL_RATE = 5;
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
const ISLAND_MIN_RADIUS = 50;
const ISLAND_MAX_RADIUS = 120;
const ISLAND_MIN_HEIGHT = 2;
const ISLAND_MAX_HEIGHT = 8;
const ISLAND_SPAWN_RANGE = 600;
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
  PartlyCloudy = 1,
  Overcast = 2,
  Rain = 3,
  Storm = 4,
  Fog = 5,
  Eclipse = 6,
  FullMoon = 7,
  HellStorm = 8,
  Snow = 9,
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
  mouseSmoothingX: 0,
  mouseSmoothingY: 0,
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

// Inventory is now grid-based via the InventoryPlugin (GridInventory component)
// The flat Inventory component is kept for backward compat but no longer used for new logic

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
const playerInvQuery = query(Player.id, GridInventory.id);
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
    log.info("progression", `Level up! Now level ${prog.level} (crafting tier ${prog.craftingTier})`);
  }
}

// ─── Inventory helpers (now delegate to grid-based InventoryPlugin) ──

function invAdd(grid: InventoryGrid, item: string, count: number): boolean {
  const remaining = gridAddItem(grid, item, count);
  return remaining === 0;
}

function invRemove(grid: InventoryGrid, item: string, count: number): boolean {
  return gridRemoveItemById(grid, item, count);
}

function invCount(grid: InventoryGrid, item: string): number {
  return gridCountItem(grid, item);
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

// 1. WeatherSystem — weather transitions, wind, visibility, temperature, rain collectors
//    (parity with to-the-ocean WeatherSystem.ts)

const weatherState = {
  type: WeatherType.Clear,
  intensity: 0,
  windSpeed: 2,
  windDirX: 1,
  windDirZ: 0,
  visibility: 1.0,
  ambientTemp: 20,
  duration: 60,
  cooldown: 0,
  isRareEvent: false,
};

// Smoothly-interpolated visual state (lerps toward target over ~30s)
const weatherVisualCurrent = {
  skyColor: [0.5, 0.7, 0.85] as [number, number, number],
  waterColor: [0.08, 0.22, 0.45] as [number, number, number],
  fogColor: [0.5, 0.7, 0.85] as [number, number, number],
  fogDensity: 0.002,
  lightIntensity: 1.0,
};

// Rain collectors: entityId -> water amount
const rainCollectors = new Map<number, number>();
let weatherTargetWindSpeed = 2;
let weatherSimTime = 0;
let weatherIntensityMul = 1.0;

// ─── Water Physics State ────────────────────────────────────
// Low-poly water heightfield (256×256 grid, 4m per cell = 1024m coverage)
const waterBuffer = new WaterBuffer(4);
const waterPhysics = new WaterPhysics(waterBuffer, { waterLevel: 0 });
const buoyancySystem_ = new BuoyancySystem(waterPhysics);
const waterWakeProviders: WakeProvider[] = [];
const waterShoreProviders: ShoreProvider[] = [];
const waterShoreSources: ShoreSource[] = [];
for (let i = 0; i < MAX_SHORES; i++) {
  waterShoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
}
const waterWakeSources: WakeSource[] = [];
for (let i = 0; i < MAX_WAKES; i++) {
  waterWakeSources.push({ x: 0, z: 0, dirX: 0, dirZ: 0, speed: 0 });
}
const waterWakeData = new Float32Array(MAX_WAKES * WAKE_FLOATS);
const waterShoreData = new Float32Array(MAX_SHORES * SHORE_FLOATS);
let waterPhysicsTime = 0;

function defaultIntensityFor(type: WeatherType): number {
  switch (type) {
    case WeatherType.Clear: return 0;
    case WeatherType.PartlyCloudy: return 0.3;
    case WeatherType.Overcast: return 0.6;
    case WeatherType.Rain: return 0.6;
    case WeatherType.Storm: return 0.8;
    case WeatherType.Fog: return 0.4;
    case WeatherType.Eclipse: return 0.8;
    case WeatherType.FullMoon: return 0.3;
    case WeatherType.HellStorm: return 1.0;
    case WeatherType.Snow: return 0.5;
    default: return 0;
  }
}

function weatherIsRaining(): boolean {
  return weatherState.type === WeatherType.Rain ||
    weatherState.type === WeatherType.Storm ||
    weatherState.type === WeatherType.HellStorm;
}

function weatherIsStormy(): boolean {
  return weatherState.type === WeatherType.Storm ||
    weatherState.type === WeatherType.HellStorm;
}

function weatherIsRareEvent(): boolean {
  return weatherState.isRareEvent;
}

function weatherIsHellStorm(): boolean {
  return weatherState.type === WeatherType.HellStorm;
}

function registerRainCollector(entityId: number): void {
  rainCollectors.set(entityId, 0);
}

function unregisterRainCollector(entityId: number): void {
  rainCollectors.delete(entityId);
}

function getRainCollectorAmount(entityId: number): number {
  return rainCollectors.get(entityId) ?? 0;
}

function useRainCollectorWater(entityId: number, amount: number): number {
  const current = rainCollectors.get(entityId) ?? 0;
  const used = Math.min(current, amount);
  rainCollectors.set(entityId, current - used);
  return used;
}

function setWeatherType(type: WeatherType, intensity?: number): void {
  weatherState.type = type;
  weatherState.intensity = intensity ?? defaultIntensityFor(type);
  weatherState.isRareEvent = false;
  weatherState.duration = WEATHER_MAX_DURATION;
  weatherState.cooldown = 5;
}

function setWeatherIntensityMul(mul: number): void {
  weatherIntensityMul = mul;
}

function transitionWeather(timeOfDay: number): void {
  const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
  const roll = Math.random();

  if (roll < WEATHER_CLEAR_CHANCE) {
    const cloudRoll = Math.random();
    if (cloudRoll < WEATHER_FULL_CLEAR) {
      weatherState.type = WeatherType.Clear;
      weatherState.intensity = 0;
    } else if (cloudRoll < WEATHER_FULL_CLEAR + WEATHER_PARTLY_CLOUDY) {
      weatherState.type = WeatherType.PartlyCloudy;
      weatherState.intensity = 0.3 * weatherIntensityMul;
    } else {
      weatherState.type = WeatherType.Overcast;
      weatherState.intensity = 0.6 * weatherIntensityMul;
    }
  } else {
    const stormRoll = Math.random();
    if (stormRoll < 0.4) {
      weatherState.type = WeatherType.Rain;
      weatherState.intensity = (0.5 + Math.random() * 0.3) * weatherIntensityMul;
    } else if (stormRoll < 0.65) {
      weatherState.type = WeatherType.Storm;
      weatherState.intensity = (0.7 + Math.random() * 0.3) * weatherIntensityMul;
    } else if (stormRoll < 0.85) {
      weatherState.type = WeatherType.Fog;
      weatherState.intensity = 0.4 * weatherIntensityMul;
    } else {
      weatherState.type = WeatherType.Snow;
      weatherState.intensity = 0.5 * weatherIntensityMul;
    }
  }

  // Rare event check
  if (Math.random() < WEATHER_RARE_EVENT_CHANCE) {
    const rareRoll = Math.random();
    if (rareRoll < 0.34) {
      weatherState.type = WeatherType.Eclipse;
      weatherState.intensity = 0.8;
      weatherState.isRareEvent = true;
    } else if (rareRoll < 0.67 && isNight) {
      weatherState.type = WeatherType.FullMoon;
      weatherState.intensity = 0.3;
      weatherState.isRareEvent = true;
    } else {
      weatherState.type = WeatherType.HellStorm;
      weatherState.intensity = 1.0 * weatherIntensityMul;
      weatherState.isRareEvent = true;
    }
  } else {
    weatherState.isRareEvent = false;
  }

  // Duration
  if (weatherState.type === WeatherType.FullMoon && isNight) {
    let remainingFrac: number;
    if (timeOfDay > NIGHT_START_FRAC) {
      remainingFrac = (1.0 - timeOfDay) + NIGHT_END_FRAC;
    } else {
      remainingFrac = NIGHT_END_FRAC - timeOfDay;
    }
    weatherState.duration = Math.max(WEATHER_MIN_DURATION, remainingFrac * 1200);
  } else if (weatherState.isRareEvent) {
    weatherState.duration = WEATHER_MAX_DURATION;
  } else {
    weatherState.duration = WEATHER_MIN_DURATION + Math.random() * (WEATHER_MAX_DURATION - WEATHER_MIN_DURATION);
  }
  weatherState.cooldown = 5;

  // Wind speed target
  if (weatherState.type === WeatherType.Storm || weatherState.type === WeatherType.HellStorm) {
    weatherTargetWindSpeed = 15 + Math.random() * 10;
  } else if (weatherState.type === WeatherType.Rain) {
    weatherTargetWindSpeed = 8 + Math.random() * 4;
  } else if (weatherState.type === WeatherType.Overcast || weatherState.type === WeatherType.Snow) {
    weatherTargetWindSpeed = 5;
  } else {
    weatherTargetWindSpeed = 2;
  }
}

function updateWeatherVisualBlend(dt: number): void {
  const target = computeWeatherVisualTarget();
  const k = Math.min(1, dt / 10); // ~30s for 95% transition (tau=10s)
  const c = weatherVisualCurrent;
  c.skyColor[0] += (target.skyColor[0] - c.skyColor[0]) * k;
  c.skyColor[1] += (target.skyColor[1] - c.skyColor[1]) * k;
  c.skyColor[2] += (target.skyColor[2] - c.skyColor[2]) * k;
  c.waterColor[0] += (target.waterColor[0] - c.waterColor[0]) * k;
  c.waterColor[1] += (target.waterColor[1] - c.waterColor[1]) * k;
  c.waterColor[2] += (target.waterColor[2] - c.waterColor[2]) * k;
  c.fogColor[0] += (target.fogColor[0] - c.fogColor[0]) * k;
  c.fogColor[1] += (target.fogColor[1] - c.fogColor[1]) * k;
  c.fogColor[2] += (target.fogColor[2] - c.fogColor[2]) * k;
  c.fogDensity += (target.fogDensity - c.fogDensity) * k;
  c.lightIntensity += (target.lightIntensity - c.lightIntensity) * k;
}

function updateWeatherVisibility(dt: number): void {
  let targetVisibility = 1.0;
  switch (weatherState.type) {
    case WeatherType.Clear: targetVisibility = 1.0; break;
    case WeatherType.PartlyCloudy: targetVisibility = 0.9; break;
    case WeatherType.Overcast: targetVisibility = 0.75; break;
    case WeatherType.Rain: targetVisibility = 0.5 + (1 - weatherState.intensity) * 0.3; break;
    case WeatherType.Storm: targetVisibility = 0.3; break;
    case WeatherType.Fog: targetVisibility = 0.2; break;
    case WeatherType.Eclipse: targetVisibility = 0.4; break;
    case WeatherType.HellStorm: targetVisibility = 0.25; break;
    case WeatherType.FullMoon: targetVisibility = 0.7; break;
    case WeatherType.Snow: targetVisibility = 0.4; break;
  }
  const lerpFactor = Math.min(1, dt * 0.5);
  weatherState.visibility += (targetVisibility - weatherState.visibility) * lerpFactor;
}

function updateWeatherTemperature(dt: number, timeOfDay: number): void {
  const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
  let targetTemp = 15 + dayFactor * 10;

  switch (weatherState.type) {
    case WeatherType.Storm:
    case WeatherType.HellStorm:
      targetTemp -= 5; break;
    case WeatherType.Rain:
      targetTemp -= 3; break;
    case WeatherType.Snow:
      targetTemp -= 15; break;
    case WeatherType.Fog:
      targetTemp -= 2; break;
    case WeatherType.Eclipse:
      targetTemp -= 10; break;
  }

  const lerpFactor = Math.min(1, dt / 60);
  weatherState.ambientTemp += (targetTemp - weatherState.ambientTemp) * lerpFactor;
}

const weatherSystem = system("weather", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  weatherSimTime += dt;
  weatherState.duration -= dt;
  weatherState.cooldown -= dt;

  const timeOfDay = ctx.world.getResource<number>("timeOfDay") ?? 0;

  if (weatherState.duration <= 0 && weatherState.cooldown <= 0) {
    transitionWeather(timeOfDay);
  }

  // Wind direction slowly rotates using deterministic sim time
  const windAngle = weatherSimTime / 10000;
  weatherState.windDirX = Math.cos(windAngle);
  weatherState.windDirZ = Math.sin(windAngle);

  // Smooth toward target wind speed (~2s time constant)
  weatherState.windSpeed += (weatherTargetWindSpeed - weatherState.windSpeed) * dt * 0.5;

  // Smooth visual blend toward target weather appearance (~30s)
  updateWeatherVisualBlend(dt);

  // Visibility
  updateWeatherVisibility(dt);

  // Temperature
  updateWeatherTemperature(dt, timeOfDay);

  // Rain collectors
  if (weatherIsRaining()) {
    for (const [id, amount] of rainCollectors) {
      const newAmount = Math.min(RAIN_COLLECTOR_CAPACITY, amount + RAIN_COLLECTOR_FILL_RATE * dt * weatherState.intensity);
      rainCollectors.set(id, newAmount);
    }
  }
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
    // Subtle exponential smoothing: carry 15% of delta to next tick
    if (input) {
      const { dx, dy } = consumeMouseDelta(input);
      player.mouseSmoothingX += dx;
      player.mouseSmoothingY += dy;
      const applyX = player.mouseSmoothingX * 0.85;
      const applyY = player.mouseSmoothingY * 0.85;
      player.mouseSmoothingX -= applyX;
      player.mouseSmoothingY -= applyY;
      if (applyX !== 0 || applyY !== 0) {
        player.heading += applyX * MOUSE_LOOK_SENSITIVITY;
        player.pitch -= applyY * MOUSE_LOOK_SENSITIVITY;
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
        log.info("camera", `mode: ${modeName}`);
      }

      // Noclip toggle (F5)
      if (input.pressed.has("f5")) {
        player.isNoclip = !player.isNoclip;
        log.info("player", `noclip: ${player.isNoclip ? "ON" : "OFF"}`);
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
    // Use physics-based water height for more realistic swimming
    const waterH = waterPhysics.sampleWaterAt(player.x, player.z);
    const effectiveWaterLevel = waterH > -100 ? waterH : WATER_LEVEL;
    const inWater = !onLand && player.y < effectiveWaterLevel + 0.5;
    const isUnderwater = player.y < effectiveWaterLevel - 0.5;

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
            playerQuery.iterate(ctx.tick, (_pe, [playerRaw, health]) => {
              const player = playerRaw as typeof Player.defaults;
              if (player.isDead) return;
              const h = health as typeof Health.defaults;
              h.current = Math.max(0, h.current - damage);
              log.info("fall", `took ${damage.toFixed(1)} fall damage (fell ${fallDist.toFixed(1)}m)`);
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
        if (player.y > effectiveWaterLevel + 0.5) player.y = effectiveWaterLevel + 0.5;
      }
      player.vx *= PLAYER_WATER_DAMPING;
      player.vz *= PLAYER_WATER_DAMPING;
    } else {
      player.vy -= PLAYER_GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y < effectiveWaterLevel) player.y = effectiveWaterLevel;
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

// 4. BuoyancySystem — real water-physics-based ship buoyancy
//    Samples water height from the 256×256 heightfield at bow/stern/port/starboard
//    and applies spring forces + pitch/roll torques (parity with to-the-ocean BuoyancySystem)
const buoyancySystem = system("buoyancy", Stage.Physics, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    const ent: BuoyancyEntity = {
      x: ship.x, y: ship.y, z: ship.z,
      vx: ship.vx, vy: 0, vz: ship.vz,
      heading: ship.heading,
      pitch: 0, roll: 0,
      angularVelX: 0, angularVelZ: 0,
      speed: ship.speed,
      mass: 1000,
    };
    buoyancySystem_.applyBuoyancy(ent, dt);
    ship.y = ent.y;
    // Apply water height offset so ship sits on the water surface
    const waterH = waterPhysics.sampleWaterAt(ship.x, ship.z);
    if (waterH > -100) {
      ship.y = waterH;
    }
  });
}, { queries: [shipQuery] });

// 4a. WaveSourceSystem — collects wake sources from ships and shore sources from islands
//     Feeds them into the water physics system so entities generate waves
const waveSourceSystem = system("wave-sources", Stage.Update, (ctx) => {
  // Collect wake sources from ships (moving vessels create V-shaped wakes)
  waterWakeProviders.length = 0;
  shipQuery.iterate(ctx.tick, (_e, [ship]) => {
    if (ship.speed > 0.5) {
      waterWakeProviders.push({
        x: ship.x, z: ship.z,
        heading: ship.heading,
        speed: ship.speed,
      });
    }
  });
  // Also collect pirate ships as wake sources
  pirateQuery.iterate(ctx.tick, (_e, [pirate]) => {
    if (pirate.health > 0) {
      const pSpeed = Math.sqrt((pirate.vx || 0) ** 2 + (pirate.vz || 0) ** 2);
      if (pSpeed > 0.5) {
        waterWakeProviders.push({
          x: pirate.x, z: pirate.z,
          heading: Math.atan2(pirate.vx || 0, pirate.vz || 1),
          speed: pSpeed,
        });
      }
    }
  });

  // Collect shore sources from islands (creates shore damping + ring waves)
  waterShoreProviders.length = 0;
  islandQuery.iterate(ctx.tick, (_e, [island]) => {
    waterShoreProviders.push({
      x: island.x, z: island.z,
      radius: island.radius,
      cutoutRadius: island.radius * 0.5,
    });
  });
  // Also use ports as shore sources (smaller radius)
  portQuery.iterate(ctx.tick, (_e, [port]) => {
    waterShoreProviders.push({
      x: port.x, z: port.z,
      radius: 8,
      cutoutRadius: 0,
    });
  });

  // Pack into arrays for the water physics
  const wakeCount = collectWakeSources(waterWakeProviders, waterWakeData);
  const shoreCount = collectShoreSources(waterShoreProviders, waterShoreSources);
  packShoreSources(waterShoreSources, shoreCount, waterShoreData);

  // Populate wake sources for CPU physics
  for (let i = 0; i < wakeCount; i++) {
    const off = i * WAKE_FLOATS;
    waterWakeSources[i].x = waterWakeData[off];
    waterWakeSources[i].z = waterWakeData[off + 1];
    waterWakeSources[i].dirX = waterWakeData[off + 2];
    waterWakeSources[i].dirZ = waterWakeData[off + 3];
    waterWakeSources[i].speed = waterWakeData[off + 4];
  }

  // Update water physics with shore sources, wake sources, and weather
  waterPhysics.setShoreSources(waterShoreSources, shoreCount);
  waterPhysics.setWakeSources(waterWakeSources, wakeCount);
  waterPhysics.setConfig({
    windSpeed: weatherState.windSpeed,
    windDirX: weatherState.windDirX,
    windDirZ: weatherState.windDirZ,
  });

  // Update the water heightfield grid (centered on player, chunk-snapped)
  let px = 0, pz = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    px = player.x; pz = player.z;
  });
  waterPhysics.update(ctx.dt, px, pz);
  waterPhysicsTime += ctx.dt;
}, { queries: [shipQuery, islandQuery, portQuery, pirateQuery, playerQuery] });

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

    let targetTemp: number;
    if (player.isSwimming) {
      targetTemp = weatherState.ambientTemp - 2;
    } else {
      targetTemp = PLAYER_TEMP_NORM + (weatherState.ambientTemp - 20) * 0.1;
    }
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
      deathCause = cause;
      log.info("survival", `player died from ${cause}`);
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
              log.info("shark", `attacked player! Health: ${health.current.toFixed(0)}`);
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
      log.info("debris", `collected ${debris.type}`);

      // Add to player inventory
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        if (debris.type === "food") {
          invAdd(inv.grid, "food", 1);
        } else if (debris.type === "water") {
          // Water is consumed immediately
          playerQuery.iterate(ctx.tick, (_pe, [, , , thirst]) => {
            thirst.current = Math.min(thirst.max, thirst.current + 30);
          });
        } else if (debris.type === "wood") {
          invAdd(inv.grid, "wood", 1);
        }
      });
    }
  });
}, { queries: [debrisQuery, playerQuery] });

let shipDestroyedLogged = false;
// 8. ShipIntegritySystem — ship degradation (parity with structureIntegrity)
const shipIntegritySystem = system("ship-integrity", Stage.PostUpdate, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (weatherIsHellStorm()) {
      ship.integrity = Math.max(0, ship.integrity - 2.0 * dt);
    } else if (weatherIsStormy()) {
      ship.integrity = Math.max(0, ship.integrity - 0.5 * dt);
    } else {
      ship.integrity = Math.max(0, ship.integrity - 0.05 * dt);
    }

    if (ship.integrity < 30 && ctx.tick % 300 === 0) {
      log.info("ship", `integrity low: ${ship.integrity.toFixed(0)}%`);
    }
    if (ship.integrity <= 0 && !shipDestroyedLogged) {
      shipDestroyedLogged = true;
      log.info("ship", "destroyed — game over!");
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
            log.info("ship", "boarded ship — WASD to steer, Shift to throttle");
          }
        } else {
          player.onShip = false;
          player.x = ship.x + 2;
          player.z = ship.z + 2;
          log.info("ship", "left ship");
        }
      }

      // Anchor with Q
      if (input.pressed.has("q") && player.onShip) {
        if (isNaN(ship.anchorX)) {
          ship.anchorX = ship.x;
          ship.anchorZ = ship.z;
          log.info("ship", "anchor dropped");
        } else {
          ship.anchorX = NaN;
          ship.anchorZ = NaN;
          log.info("ship", "anchor raised");
        }
      }

      // Repair with R
      if (input.keys.has("r") && player.onShip && ship.integrity < ship.maxIntegrity) {
        if (invRemove(inv.grid, "wood", 1)) {
          ship.integrity = Math.min(ship.maxIntegrity, ship.integrity + REPAIR_RATE * dt);
          if (ctx.tick % 60 === 0) {
            log.info("ship", `repaired to ${ship.integrity.toFixed(0)}%`);
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
            log.info("fishing", "line cast...");
          }
        } else {
          // Reel in
          if (line.hooked) {
            if (Math.random() < FISHING_CATCH_CHANCE) {
              invAdd(inv.grid, "raw_fish", 1);
              log.info("fishing", "caught a fish!");
              playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CATCH_FISH));
            } else {
              log.info("fishing", "the fish got away...");
            }
          } else {
            log.info("fishing", "reeled in empty");
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
          log.info("fishing", "something hooked! Press F to reel in");
        }
      }
    });
  });
}, { queries: [playerInvQuery, fishingQuery, playerProgQuery] });

// 11. CraftingSystem — recipe-based crafting with tier unlocks and craft queue
const craftingSystem = system("crafting", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [playerRaw, invRaw]) => {
    const player = playerRaw as typeof Player.defaults;
    const inv = invRaw as typeof GridInventory.defaults;

    // Get craft state from player's Progression component
    let unlockedSet = new Set<string>();
    playerProgQuery.iterate(ctx.tick, (_pe, [_pe2, progRaw]) => {
      const prog = progRaw as typeof Progression.defaults;
      // Ensure recipes are unlocked for current tier
      unlockedSet = new Set<string>(prog.unlockedRecipes);
      unlockRecipesForTier(prog.craftingTier, unlockedSet);
      prog.unlockedRecipes = [...unlockedSet];
    });

    // C = craft (cycles through unlocked recipes)
    if (input.pressed.has("c")) {
      const craftRes = ctx.world.getResource<{ lastRecipe: number }>("craftState") ?? { lastRecipe: 0 };
      const availableRecipes = getUnlockedRecipes(unlockedSet);

      if (availableRecipes.length === 0) {
        log.info("craft", "no recipes unlocked yet");
        return;
      }

      const recipe = availableRecipes[craftRes.lastRecipe % availableRecipes.length];
      craftRes.lastRecipe = (craftRes.lastRecipe + 1) % availableRecipes.length;
      ctx.world.setResource("craftState", craftRes);

      // Check if near campfire for recipes that need fire
      let nearFire = false;
      if (recipe.needsFire) {
        buildableQuery.iterate(ctx.tick, (_be, [b]) => {
          const dx = b.x - player.x;
          const dz = b.z - player.z;
          if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
        });
      }

      // Check crafting stations (workbench_basic, etc.)
      const stations = ctx.world.getResource<Set<string>>("craftingStations") ?? new Set<string>();
      if (recipe.station && !stations.has(recipe.station)) {
        log.info("craft", `cannot craft ${recipe.name} — needs ${recipe.station}`);
        return;
      }

      // Check ingredients using grid-based inventory
      if (!canCraft(recipe, inv.grid)) {
        log.info("craft", `cannot craft ${recipe.name} — missing resources${recipe.needsFire && !nearFire ? " or need campfire nearby" : ""}`);
        return;
      }

      if (recipe.needsFire && !nearFire) {
        log.info("craft", `cannot craft ${recipe.name} — need campfire nearby`);
        return;
      }

      // Execute craft (consumes inputs, produces output)
      executeCraft(recipe, inv.grid);
      log.info("craft", `crafted ${recipe.output.quantity}x ${recipe.output.itemId}`);
      playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CRAFT));

      // Place campfire in world
      if (recipe.output.itemId === "campfire") {
        const comps = new Map<number, unknown>();
        comps.set(Buildable.id, Buildable.create({
          type: "campfire",
          x: player.x + 1,
          y: player.y,
          z: player.z + 1,
          health: 100,
        }));
        ecsWorld.spawn(comps);
        log.info("craft", "campfire placed near player");
      }

      // Place workbench in world and register as crafting station
      if (recipe.output.itemId === "workbench_basic") {
        const comps = new Map<number, unknown>();
        comps.set(Buildable.id, Buildable.create({
          type: "workbench_basic",
          x: player.x + 1,
          y: player.y,
          z: player.z + 1,
          health: 100,
        }));
        const wbEntity = ecsWorld.spawn(comps);
        const st = ctx.world.getResource<Set<string>>("craftingStations") ?? new Set<string>();
        st.add("workbench_basic");
        ctx.world.setResource("craftingStations", st);
        log.info("craft", "workbench placed near player — tier 1+ recipes unlocked");
      }
    }

    // Place raft upgrade (improves ship speed)
    if (input.pressed.has("b") && invCount(inv.grid, "raft_upgrade") > 0) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        const dx = ship.x - player.x;
        const dz = ship.z - player.z;
        if (Math.sqrt(dx * dx + dz * dz) < BOARD_RANGE + 2) {
          invRemove(inv.grid, "raft_upgrade", 1);
          ship.maxIntegrity += 50;
          ship.integrity = ship.maxIntegrity;
          log.info("craft", `raft upgraded! Ship integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
        }
      });
    }

    // Eat food
    if (input.pressed.has("t")) {
      if (invRemove(inv.grid, "cooked_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 35);
        });
        log.info("food", "ate cooked fish (+35 hunger)");
      } else if (invRemove(inv.grid, "raw_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 15);
        });
        log.info("food", "ate raw fish (+15 hunger)");
      } else if (invRemove(inv.grid, "food", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 25);
        });
        log.info("food", "ate food (+25 hunger)");
      }
    }
  });
}, { queries: [playerInvQuery, playerProgQuery, shipQuery, buildableQuery] });

// 12. InventorySpoilageSystem — now handled by the InventoryPlugin's grid-spoilage system
// The old flat-array spoilage system is replaced by the plugin's processSpoilage which
// runs automatically on GridInventory components. We keep a no-op here for system ordering.
const spoilageSystem = system("spoilage", Stage.Update, (_ctx) => {
  // Spoilage is now handled by the InventoryPlugin's grid-spoilage system
}, { queries: [] });

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
    const debrisWaterH = waterPhysics.sampleWaterAt(debris.x, debris.z);
    debris.y = (debrisWaterH > -100 ? debrisWaterH : WATER_LEVEL) + Math.sin(ctx.tick * 0.05 + debris.x) * 0.15;
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
        log.info("pirate", `spawned at (${px.toFixed(0)}, ${pz.toFixed(0)}) difficulty ${diff.toFixed(1)}`);
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
        log.info("pirate", `attacked ship! integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
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
        log.info("gun", `hit pirate for ${TOOL_GUN_DAMAGE} (health: ${pirate.health.toFixed(0)})`);
        if (pirate.health <= 0) {
          log.info("pirate", "defeated! Dropping loot...");
          playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
            for (let i = 0; i < PIRATE_LOOT_DROP; i++) {
              const loot = ["wood", "food", "planks"][Math.floor(Math.random() * 3)];
              invAdd(inv.grid, loot, 1);
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
          const fishCount = invCount(inv.grid, "raw_fish");
          if (fishCount > 0) {
            invRemove(inv.grid, "raw_fish", fishCount);
            const price = Math.floor(5 * (port.listings.find(l => l.item === "raw_fish")?.priceModifier ?? 1));
            log.info("port", `Sold ${fishCount} raw_fish for ${price * fishCount} coins`);
            invAdd(inv.grid, "coin", price * fishCount);
          }
          // Buy wood
          const coins = invCount(inv.grid, "coin");
          const woodPrice = Math.floor(3 * (port.listings.find(l => l.item === "wood")?.priceModifier ?? 1));
          if (coins >= woodPrice) {
            invRemove(inv.grid, "coin", woodPrice);
            invAdd(inv.grid, "wood", 1);
            log.info("port", `Bought 1 wood for ${woodPrice} coins`);
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
      log.info("animal", `${animal.species} grew to stage ${animal.stage}`);
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
        log.info("animal", `${animal.species} produced ${animal.productType}`);
      }
    }

    // Harvest — press H near animal
    if (input?.pressed.has("h") && animal.stage >= AnimalStage.Adult && animal.productTimer < ANIMAL_PRODUCT_TIME - 5) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((animal.x - px) ** 2 + (animal.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.grid, animal.productType, 1);
          animal.productTimer = ANIMAL_PRODUCT_TIME;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          log.info("animal", `harvested ${animal.productType}`);
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
        log.info("plant", `${plant.species} grew to stage ${plant.stage}`);
      }
    }

    // Harvest — press H near mature plant
    if (input?.pressed.has("h") && plant.stage >= PlantStage.Mature) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((plant.x - px) ** 2 + (plant.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.grid, plant.species, plant.yield);
          plant.stage = PlantStage.Seed;
          plant.growthTimer = 0;
          plant.waterLevel = 100;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          log.info("plant", `harvested ${plant.yield} ${plant.species}`);
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
        log.info("plant", `watered ${plant.species}`);
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
          if (invRemove(inv.grid, "food", 1) || invRemove(inv.grid, "raw_fish", 1)) {
            pet.hunger = Math.min(100, pet.hunger + 30);
            pet.happiness = Math.min(100, pet.happiness + 10);
            log.info("pet", `fed pet (hunger: ${pet.hunger.toFixed(0)}, happiness: ${pet.happiness.toFixed(0)})`);
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
        invAdd(inv.grid, "wood", wood);
        playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
        log.info("axe", `chopped tree, got ${wood} wood`);
      });
    } else {
      log.info("axe", "no trees here — need to be on an island");
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
          invAdd(inv.grid, "coin", 1 + Math.floor(Math.random() * 3));
          log.info("shovel", "dug up coins!");
        } else if (find < 0.5) {
          invAdd(inv.grid, "wood", 1);
          log.info("shovel", "dug up buried wood");
        } else if (find < 0.6) {
          invAdd(inv.grid, "food", 1);
          log.info("shovel", "dug up food");
        } else {
          log.info("shovel", "nothing here...");
        }
      });
    }
  }
}, { queries: [playerQuery, playerInvQuery, playerProgQuery] });

// 21. ProgressionSystem — tick-based progression tracking with crafting tier unlocks
const progressionSystem = system("progression", Stage.Update, (ctx) => {
  playerProgQuery.iterate(ctx.tick, (_e, [_player, progRaw]) => {
    const prog = progRaw as typeof Progression.defaults;
    if (prog.level === 1 && prog.xp === 0 && prog.unlockedRecipes.length === 0) {
      const unlocked = new Set<string>();
      unlockRecipesForTier(0, unlocked);
      prog.unlockedRecipes = [...unlocked];
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
let deathCause = "";
let playerSpawnX = 0, playerSpawnZ = 0;

// ─── Helper: spawn entity with multiple components ─────────

function spawnEntity(world: World, components: Map<number, unknown>) {
  return world.spawn(components);
}

// ─── Lifecycle: init ───────────────────────────────────────

export function init(ctx: any) {
  log.info("ocean-survival", "╔══════════════════════════════════════════════╗");
  log.info("ocean-survival", "║   Ocean Survival — DownDraft Engine          ║");
  log.info("ocean-survival", "║   (parity with to-the-ocean game systems)    ║");
  log.info("ocean-survival", "╚══════════════════════════════════════════════╝");

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
  playerComps.set(GridInventory.id, GridInventory.create({ grid: createGrid(PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT) }));
  playerComps.set(Progression.id, Progression.create({ level: 1, xp: 0, craftingTier: 0, hullTier: 0, unlockedRecipes: [...(CRAFTING_TIER_RECIPES[0] ?? [])] }));
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

  // Spawn islands — first island is placed near the player spawn
  playerSpawnX = 0; playerSpawnZ = 0;
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const angle = (i / ISLAND_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    const dist = i === 0 ? 0 : 150 + Math.random() * ISLAND_SPAWN_RANGE;
    const radius = i === 0
      ? ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS) * 0.5
      : ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS);
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
    log.info("terrain", `generating voxel field for island ${i + 1} (biome: ${BiomeType[biome]}, radius: ${radius.toFixed(0)})...`);
    const voxelField = generateVoxelField(chunkX, chunkZ, radius, biome);

    // Extract mesh from voxel field using marching cubes
    const meshData = extractMeshFromField(voxelField, biome, 50000);
    log.info("terrain", `island ${i + 1} mesh: ${meshData.vertexCount} verts, ${meshData.indexCount} indices`);

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

    // Place player on the shore of the first island
    if (i === 0) {
      const islandX = Math.cos(angle) * dist;
      const islandZ = Math.sin(angle) * dist;
      playerSpawnX = islandX + radius * 0.8;
      playerSpawnZ = islandZ;
    }

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

  // Move player to the shore of the first island
  const player = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
  if (player) {
    player.x = playerSpawnX;
    player.z = playerSpawnZ;
    player.y = 2;
    log.info("terrain", `player spawned near island at (${playerSpawnX.toFixed(1)}, ${playerSpawnZ.toFixed(1)})`);
  }

  // Move ship near the player
  shipQuery.iterate(0, (_e, [shipRaw]) => {
    const ship = shipRaw as typeof Ship.defaults;
    ship.x = playerSpawnX + 5;
    ship.z = playerSpawnZ + 5;
  });

  // Spawn a pet companion near player
  const petComps = new Map<number, unknown>();
  petComps.set(Pet.id, Pet.create({
    x: playerSpawnX + 2, y: 1, z: playerSpawnZ + 2,
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
      x: playerSpawnX + Math.cos(angle) * dist,
      y: WATER_LEVEL,
      z: playerSpawnZ + Math.sin(angle) * dist,
      collected: false,
    }));
    spawnEntity(ecsWorld, debrisComps);
  }

  // Register plugin systems (inventory grid spoilage, crafting queue)
  InventoryPlugin.register({
    registerSystem: (stage: number, fn: any) => ecsWorld.schedule.addSystem({ name: "grid-spoilage", stage, fn, queries: [] }),
    registerComponent: () => 0,
    registerResource: () => {},
    allocateSABChannel: () => new ArrayBuffer(0) as any,
    registerMigration: () => {},
    onDispose: () => {},
  } as any);
  CraftingPlugin.register({
    registerSystem: (stage: number, fn: any) => ecsWorld.schedule.addSystem({ name: "crafting-queue", stage, fn, queries: [] }),
    registerComponent: () => 0,
    registerResource: () => {},
    allocateSABChannel: () => new ArrayBuffer(0) as any,
    registerMigration: () => {},
    onDispose: () => {},
  } as any);

  // Register resources for crafting
  ecsWorld.setResource("craftingStations", new Set<string>());
  ecsWorld.setResource("dayDuration", DAY_DURATION);
  ecsWorld.setResource("playerInventoryGrid", null);

  // Register systems in tick order (matching to-the-ocean Simulation.tick)
  ecsWorld.schedule.addSystem(weatherSystem);
  ecsWorld.schedule.addSystem(playerMovementSystem);
  ecsWorld.schedule.addSystem(shipControlSystem);
  ecsWorld.schedule.addSystem(waveSourceSystem);
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

  log.info("ocean-survival", "Player spawned at origin with full survival stats");
  log.info("ocean-survival", "Ship created (integrity: 100%)");
  log.info("ocean-survival", "2 sharks + 5 fish spawned");
  log.info("ocean-survival", "10 debris items scattered (wood/food/water)");
  log.info("ocean-survival", `${ISLAND_COUNT} islands generated in the surrounding ocean`);
  log.info("ocean-survival", `${PORT_COUNT} ports with dynamic market prices`);
  log.info("ocean-survival", `${ISLAND_COUNT * ANIMAL_COUNT_PER_ISLAND} animals (chickens, goats, sheep) on islands`);
  log.info("ocean-survival", `${ISLAND_COUNT * PLANT_COUNT_PER_ISLAND} plants (kelp, tomato, rice) on islands`);
  log.info("ocean-survival", "1 pet companion (cat) spawned near player");
  log.info("ocean-survival", "Pirates may spawn and attack your ship!");
  log.info("ocean-survival", "Fire + smoke particle emitters active");
  log.info("ocean-survival", "Weather: Clear, wind: 3 m/s");
  log.info("ocean-survival", "Controls:");
  log.info("ocean-survival", "  WASD = move (heading-based) | Mouse = look | Shift = run/throttle");
  log.info("ocean-survival", "  Space = jump | Ctrl+Space = dive underwater | Arrows = steer ship");
  log.info("ocean-survival", "  E = board/leave ship | Q = anchor | R = repair (needs wood)");
  log.info("ocean-survival", "  F = fish | C = craft (cycles recipes) | B = apply raft upgrade");
  log.info("ocean-survival", "  T = eat food | Y = trade at port");
  log.info("ocean-survival", "  G = gun (shoot pirates) | X = axe (chop trees on islands)");
  log.info("ocean-survival", "  V = shovel (dig for treasure) | H = harvest (animals/plants)");
  log.info("ocean-survival", "  J = water plant | P = feed pet");
  log.info("ocean-survival", "  M = toggle camera (1st/3rd/freecam) | F5 = noclip");
  log.info("ocean-survival", "  I = toggle inventory | 1-9,0 = hotbar slots | Scroll = zoom camera");
  log.info("ocean-survival", "  Terrain: volumetric voxel fields with marching cubes mesh extraction");
  log.info("ocean-survival", "  Biomes: Tropical, Temperate, Arctic, Desert, Volcanic");
  log.info("ocean-survival", "  Survival: manage hunger, thirst, oxygen, temperature");
  log.info("ocean-survival", "  Crafting: wood->planks->campfire->cook fish->raft upgrade");
  log.info("ocean-survival", "  Economy: sell fish at ports for coins, buy wood/supplies");
  log.info("ocean-survival", "  Progression: gain XP from fishing, crafting, harvesting, killing pirates");
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

    // ─── Inventory toggle (I key) ───
    if (ctx.input.pressed.has("i")) {
      toggleInventory();
    }

    // ─── Numpad weather/time hotkeys (parity with to-the-ocean App.tsx) ───
    const numpadWeatherMap: Record<string, WeatherType> = {
      numpad0: WeatherType.Clear,
      numpad1: WeatherType.PartlyCloudy,
      numpad2: WeatherType.Overcast,
      numpad3: WeatherType.Rain,
      numpad4: WeatherType.Storm,
      numpad5: WeatherType.Fog,
      numpad6: WeatherType.Eclipse,
      numpad7: WeatherType.FullMoon,
      numpad8: WeatherType.HellStorm,
      numpad9: WeatherType.Snow,
    };
    const numpadTimeMap: Record<string, number> = {
      numpaddivide: 0.5,    // noon
      numpadmultiply: 0.75, // evening
      numpadsubtract: 0.0,  // midnight
    };
    for (const key of ctx.input.pressed) {
      const wt = numpadWeatherMap[key];
      if (wt !== undefined) {
        setWeatherType(wt);
        log.info("weather", `forced: ${WeatherType[wt]}`);
      }
      const tod = numpadTimeMap[key];
      if (tod !== undefined) {
        timeOfDay = tod;
        log.info("weather", `time set: ${(tod * 24).toFixed(1)}h`);
      }
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
    const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(playerEntity, GridInventory.id);
    const ship = ecsWorld.getComponent<typeof Ship.defaults>(ecsWorld.allArchetypes[0]?.entities?.[0] ?? 0, Ship.id);

    if (ph && hu && th && ox && tp) {
      log.debug("frame", `FPS:${fps} | HP:${ph.current.toFixed(0)}/${ph.max} | Hunger:${hu.current.toFixed(0)} | Thirst:${th.current.toFixed(0)} | O2:${ox.current.toFixed(0)} | Temp:${tp.current.toFixed(1)}C`);
      log.debug("frame", `Weather:${WeatherType[weatherState.type]} Wind:${weatherState.windSpeed.toFixed(1)}m/s Vis:${weatherState.visibility.toFixed(2)} Temp:${weatherState.ambientTemp.toFixed(1)}C Time:${(timeOfDay * 24).toFixed(1)}h${weatherState.isRareEvent ? " [RARE]" : ""}`);

      // Weather info overlay (devtools dump)
      const rainCollectorCount = rainCollectors.size;
      let rainCollectorTotal = 0;
      for (const amt of rainCollectors.values()) rainCollectorTotal += amt;
      log.debug("weather-overlay", [
        `╔════════════════════════════════════════════╗`,
        `║  WEATHER OVERLAY                            ║`,
        `╠════════════════════════════════════════════╣`,
        `║  Type:       ${WeatherType[weatherState.type].padEnd(30)}║`,
        `║  Intensity:  ${(weatherState.intensity.toFixed(2)).padEnd(30)}║`,
        `║  Wind:       ${(weatherState.windSpeed.toFixed(1) + "m/s " + (Math.atan2(weatherState.windDirZ, weatherState.windDirX) * 180 / Math.PI).toFixed(0) + "°").padEnd(30)}║`,
        `║  Visibility: ${(weatherState.visibility.toFixed(2) + " (" + (weatherState.visibility * 100).toFixed(0) + "%)").padEnd(30)}║`,
        `║  Ambient:    ${(weatherState.ambientTemp.toFixed(1) + "°C").padEnd(30)}║`,
        `║  Duration:   ${(weatherState.duration.toFixed(0) + "s remaining").padEnd(30)}║`,
        `║  Rare Event: ${(weatherState.isRareEvent ? "YES" : "no").padEnd(30)}║`,
        `║  Raining:    ${(weatherIsRaining() ? "yes" : "no").padEnd(30)}║`,
        `║  Stormy:     ${(weatherIsStormy() ? "yes" : "no").padEnd(30)}║`,
        `║  Time:       ${((timeOfDay * 24).toFixed(1) + "h " + (isNight ? "(night)" : "(day)")).padEnd(30)}║`,
        `║  Rain Coll.: ${(rainCollectorCount + " collectors, " + rainCollectorTotal.toFixed(1) + " water").padEnd(30)}║`,
        `╠════════════════════════════════════════════╣`,
        `║  Numpad 0-9: Force weather                  ║`,
        `║  Numpad /: Noon  *: Evening  -: Midnight    ║`,
        `╚════════════════════════════════════════════╝`,
      ].join("\n"));
      if (inv) {
        const gridState = getGridStateForUI(inv.grid);
        const invStr = gridState.map((s: any) => `${s.itemId}x${s.quantity}`).join(", ") || "empty";
        log.debug("frame", `Inventory: ${invStr}`);
      }

      const prog = ecsWorld.getComponent<typeof Progression.defaults>(playerEntity, Progression.id);
      if (prog) {
        log.debug("frame", `Level: ${prog.level} | XP: ${prog.xp}/${XP_PER_LEVEL * prog.level} | Crafting Tier: ${prog.craftingTier}`);
      }

      if (ph.current <= 0 && playerData && !playerData.isDead) {
        log.info("game", "Player died — game over!");
      }
    }
  }
}

// ─── Lifecycle: dispose ────────────────────────────────────

export function dispose(ctx: any) {
  particles.destroy();
  log.info("ocean-survival", "disposed");
}

// ─── Lifecycle: getWaterData ────────────────────────────────
// Exports the current water heightfield for the Rust renderer to upload
// as a GPU texture. Called each tick by src/bun/index.ts.

export function getWaterData(): {
  gridSize: number;
  patchSize: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
} {
  const origin = waterBuffer.getOrigin();
  return {
    gridSize: waterBuffer.getGridSize(),
    patchSize: waterBuffer.getPatchSize(),
    originX: origin.x,
    originZ: origin.z,
    heights: waterBuffer.getHeightsRef(),
  };
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

// ─── Lifecycle: getGameState ───────────────────────────────

export function getGameState(): { isDead: boolean; cause: string } {
  const player = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
  return {
    isDead: player?.isDead ?? false,
    cause: deathCause,
  };
}

// ─── Lifecycle: respawn ────────────────────────────────────

export function respawn() {
  const player = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
  if (!player) return;
  player.isDead = false;
  player.x = playerSpawnX; player.y = 2; player.z = playerSpawnZ;
  player.vx = 0; player.vy = 0; player.vz = 0;
  player.heading = 0; player.pitch = 0;
  player.onShip = false;
  player.isUnderwater = false;
  player.isSwimming = false;
  player.isSleeping = false;
  player.isNoclip = false;
  player.isRunning = false;
  player.isGrounded = true;
  player.isClimbing = false;
  player.isDiving = false;

  const health = ecsWorld.getComponent<typeof Health.defaults>(playerEntity, Health.id);
  if (health) { health.current = health.max; }

  const hunger = ecsWorld.getComponent<typeof Hunger.defaults>(playerEntity, Hunger.id);
  if (hunger) { hunger.current = hunger.max; }

  const thirst = ecsWorld.getComponent<typeof Thirst.defaults>(playerEntity, Thirst.id);
  if (thirst) { thirst.current = thirst.max; }

  const oxygen = ecsWorld.getComponent<typeof Oxygen.defaults>(playerEntity, Oxygen.id);
  if (oxygen) { oxygen.current = oxygen.max; }

  const temp = ecsWorld.getComponent<typeof Temperature.defaults>(playerEntity, Temperature.id);
  if (temp) { temp.current = PLAYER_TEMP_NORM; }

  deathCause = "";
  log.info("respawn", "player respawned");
}

// ─── Lifecycle: getInventoryState ──────────────────────────

let inventoryVisible = false;

export function getInventoryState(): string {
  const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(playerEntity, GridInventory.id);
  if (!inv) return JSON.stringify({ visible: inventoryVisible, width: 10, height: 6, slots: [], recipes: [], itemCounts: {} });

  const grid = inv.grid;
  const slots: { x: number; y: number; itemId: string; quantity: number; spoilPercent?: number; name?: string; category?: string; stackLimit?: number }[] = [];
  const itemCounts: Record<string, number> = {};
  const seen = new Set<unknown>();

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack) continue;
      if (seen.has(stack)) continue;
      seen.add(stack);

      const def = getItem(stack.itemId);
      const slot: any = {
        x, y,
        itemId: stack.itemId,
        quantity: stack.quantity,
        name: def?.name ?? stack.itemId,
        category: def?.category,
        stackLimit: def?.maxStack,
      };
      if (def?.spoilRate && def.spoilRate > 0) {
        slot.spoilPercent = stack.spoilProgress !== undefined
          ? (1 - stack.spoilProgress) * 100
          : 100;
      }
      slots.push(slot);

      itemCounts[stack.itemId] = (itemCounts[stack.itemId] ?? 0) + stack.quantity;
    }
  }

  // Get unlocked recipes
  const prog = ecsWorld.getComponent<typeof Progression.defaults>(playerEntity, Progression.id);
  const unlockedSet = new Set<string>(prog?.unlockedRecipes ?? []);
  if (prog) unlockRecipesForTier(prog.craftingTier, unlockedSet);
  const availableRecipes = getUnlockedRecipes(unlockedSet);

  const recipes = availableRecipes.map(r => ({
    id: r.id,
    name: r.name,
    inputs: r.inputs,
    output: r.output,
    needsFire: (r as any).needsFire ?? false,
  }));

  return JSON.stringify({
    visible: inventoryVisible,
    width: grid.width,
    height: grid.height,
    slots,
    recipes,
    itemCounts,
  });
}

export function toggleInventory() {
  inventoryVisible = !inventoryVisible;
}

export function craftByRecipeId(recipeId: string): void {
  const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(playerEntity, GridInventory.id);
  if (!inv) return;
  const prog = ecsWorld.getComponent<typeof Progression.defaults>(playerEntity, Progression.id);
  if (!prog) return;

  const unlockedSet = new Set<string>(prog.unlockedRecipes);
  unlockRecipesForTier(prog.craftingTier, unlockedSet);
  const availableRecipes = getUnlockedRecipes(unlockedSet);
  const recipe = availableRecipes.find(r => r.id === recipeId);
  if (!recipe) {
    log.info("craft", `unknown recipe: ${recipeId}`);
    return;
  }

  // Check if near campfire for recipes that need fire
  let nearFire = false;
  if (recipe.needsFire) {
    buildableQuery.iterate(frameCount, (_be, [bRaw]) => {
      const b = bRaw as typeof Buildable.defaults;
      const player = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
      if (!player) return;
      const dx = b.x - player.x;
      const dz = b.z - player.z;
      if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
    });
  }

  // Check crafting stations
  const stations = ecsWorld.getResource<Set<string>>("craftingStations") ?? new Set<string>();
  if (recipe.station && !stations.has(recipe.station)) {
    log.info("craft", `cannot craft ${recipe.name} — needs ${recipe.station}`);
    return;
  }

  if (!canCraft(recipe, inv.grid)) {
    log.info("craft", `cannot craft ${recipe.name} — missing resources${recipe.needsFire && !nearFire ? " or need campfire nearby" : ""}`);
    return;
  }

  if (recipe.needsFire && !nearFire) {
    log.info("craft", `cannot craft ${recipe.name} — need campfire nearby`);
    return;
  }

  executeCraft(recipe, inv.grid);
  log.info("craft", `crafted ${recipe.output.quantity}x ${recipe.output.itemId}`);
  addXP(ecsWorld, playerEntity, XP_CRAFT);

  // Place campfire in world
  if (recipe.output.itemId === "campfire") {
    const player = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
    if (player) {
      const comps = new Map<number, unknown>();
      comps.set(Buildable.id, Buildable.create({
        type: "campfire",
        x: player.x + 1,
        y: player.y,
        z: player.z + 1,
        health: 100,
      }));
      ecsWorld.spawn(comps);
      log.info("craft", "campfire placed near player");
    }
  }
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
    }
    dispose({});
  })();
}

// ─── Lifecycle: getWeatherVisual ───────────────────────────
// Computes visual parameters (sky color, water color, fog, light) from
// the current weather state and time of day. Called each tick by bun/index.ts.

function computeWeatherVisualTarget(): {
  skyColor: [number, number, number];
  waterColor: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number;
  lightIntensity: number;
  weatherType: number;
  isNight: boolean;
} {
  const timeOfDay = ecsWorld.getResource<number>("timeOfDay") ?? 0;
  const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
  const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;

  // Base sky colors by time of day
  let skyR: number, skyG: number, skyB: number;
  if (isNight) {
    skyR = 0.02; skyG = 0.03; skyB = 0.08;
  } else {
    skyR = 0.15 + dayFactor * 0.35;
    skyG = 0.35 + dayFactor * 0.35;
    skyB = 0.55 + dayFactor * 0.30;
  }

  // Base water colors
  let waterR = 0.08, waterG = 0.22, waterB = 0.45;
  if (isNight) {
    waterR = 0.02; waterG = 0.06; waterB = 0.12;
  }

  // Fog defaults to sky color, low density
  let fogR = skyR, fogG = skyG, fogB = skyB;
  let fogDensity = 0.002;
  let lightIntensity = isNight ? 0.25 : 0.6 + dayFactor * 0.4;

  // Apply weather modifications
  switch (weatherState.type) {
    case WeatherType.Clear:
      // No modification — clear sky
      break;
    case WeatherType.PartlyCloudy:
      skyR *= 0.9; skyG *= 0.9; skyB *= 0.92;
      fogR = skyR; fogG = skyG; fogB = skyB;
      lightIntensity *= 0.9;
      break;
    case WeatherType.Overcast:
      skyR *= 0.5; skyG *= 0.55; skyB *= 0.6;
      waterR *= 0.6; waterG *= 0.6; waterB *= 0.65;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.005;
      lightIntensity *= 0.6;
      break;
    case WeatherType.Rain:
      skyR *= 0.35; skyG *= 0.38; skyB *= 0.42;
      waterR *= 0.5; waterG *= 0.5; waterB *= 0.55;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.008 + weatherState.intensity * 0.005;
      lightIntensity *= 0.45;
      break;
    case WeatherType.Storm:
      skyR *= 0.2; skyG *= 0.22; skyB *= 0.25;
      waterR *= 0.35; waterG *= 0.35; waterB *= 0.4;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.015;
      lightIntensity *= 0.3;
      break;
    case WeatherType.Fog:
      skyR = 0.5; skyG = 0.55; skyB = 0.58;
      waterR = 0.3; waterG = 0.35; waterB = 0.38;
      fogR = 0.6; fogG = 0.62; fogB = 0.62;
      fogDensity = 0.04;
      lightIntensity *= 0.5;
      break;
    case WeatherType.Eclipse:
      skyR = 0.01; skyG = 0.01; skyB = 0.03;
      waterR = 0.01; waterG = 0.02; waterB = 0.04;
      fogR = 0.02; fogG = 0.02; fogB = 0.05;
      fogDensity = 0.01;
      lightIntensity = 0.1;
      break;
    case WeatherType.FullMoon:
      skyR = 0.05; skyG = 0.06; skyB = 0.12;
      waterR = 0.04; waterG = 0.08; waterB = 0.15;
      fogR = 0.08; fogG = 0.1; fogB = 0.15;
      fogDensity = 0.003;
      lightIntensity = 0.35;
      break;
    case WeatherType.HellStorm:
      skyR = 0.3; skyG = 0.05; skyB = 0.02;
      waterR = 0.2; waterG = 0.05; waterB = 0.03;
      fogR = 0.35; fogG = 0.08; fogB = 0.03;
      fogDensity = 0.02;
      lightIntensity = 0.4;
      break;
    case WeatherType.Snow:
      skyR = 0.6; skyG = 0.65; skyB = 0.7;
      waterR = 0.3; waterG = 0.38; waterB = 0.42;
      fogR = 0.7; fogG = 0.74; fogB = 0.78;
      fogDensity = 0.012;
      lightIntensity *= 0.55;
      break;
  }

  return {
    skyColor: [skyR, skyG, skyB],
    waterColor: [waterR, waterG, waterB],
    fogColor: [fogR, fogG, fogB],
    fogDensity,
    lightIntensity,
    weatherType: weatherState.type,
    isNight,
  };
}

export function getWeatherVisual(): {
  skyColor: [number, number, number];
  waterColor: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number;
  lightIntensity: number;
  weatherType: number;
  isNight: boolean;
} {
  const target = computeWeatherVisualTarget();
  return {
    skyColor: [...weatherVisualCurrent.skyColor] as [number, number, number],
    waterColor: [...weatherVisualCurrent.waterColor] as [number, number, number],
    fogColor: [...weatherVisualCurrent.fogColor] as [number, number, number],
    fogDensity: weatherVisualCurrent.fogDensity,
    lightIntensity: weatherVisualCurrent.lightIntensity,
    weatherType: target.weatherType,
    isNight: target.isNight,
  };
}
