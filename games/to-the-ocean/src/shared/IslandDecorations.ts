// ============================================================================
// IslandDecorations — procedural placement of trees, rocks, plants on islands
// Uses a secondary Perlin noise layer for density distribution.
// Generates low-poly mesh geometry in unit space (same format as island mesh).
// ============================================================================

import { PerlinNoise } from "./world/PerlinNoise";
import { BiomeType, IslandSize } from "./types";
import { computeFlatNormals } from "./IslandNoise";
import { generateVoxelField, sampleTerrainHeight } from "./TerrainGenerator";
import { TERRAIN_CONFIG } from "./TerrainConfig";
import type { VoxelField } from "./TerrainTypes";

// --- Decoration types ---
export enum DecorationType {
  Tree = 0,
  Rock = 1,
  Plant = 2,
  Bush = 3,
  Cactus = 4,
  Driftwood = 5,
  DeadTree = 6,
  IceCrystal = 7,
  VolcanicRock = 8,
}

export interface DecorationPlacement {
  type: DecorationType;
  x: number;       // unit space [-1, 1]
  z: number;       // unit space [-1, 1]
  y: number;       // unit space (terrain surface height)
  rotY: number;    // Y-axis rotation in radians
  scale: number;   // per-decoration scale multiplier
}

// --- Seeded PRNG (same as WorldGenerator) ---
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

// Secondary Perlin noise layer — fixed seed, sampled in world space
const decorationNoise = new PerlinNoise(0xBEEF1234);
const DECORATION_NOISE_SCALE = 8.0; // frequency within unit circle

// --- Biome-aware decoration type selection ---
function getDecorationPool(biome: BiomeType): DecorationType[] {
  switch (biome) {
    case BiomeType.BorealForest:
      return [DecorationType.Tree, DecorationType.Tree, DecorationType.Tree, DecorationType.Rock, DecorationType.Bush, DecorationType.Plant];
    case BiomeType.Tropical:
      return [DecorationType.Tree, DecorationType.Tree, DecorationType.Plant, DecorationType.Plant, DecorationType.Bush, DecorationType.Rock];
    case BiomeType.SubTropical:
      return [DecorationType.Tree, DecorationType.Plant, DecorationType.Bush, DecorationType.Rock, DecorationType.Driftwood];
    case BiomeType.Desert:
      return [DecorationType.Cactus, DecorationType.Cactus, DecorationType.Rock, DecorationType.Rock, DecorationType.DeadTree, DecorationType.Driftwood];
    case BiomeType.Arctic:
      return [DecorationType.IceCrystal, DecorationType.IceCrystal, DecorationType.Rock, DecorationType.Rock, DecorationType.DeadTree];
    case BiomeType.Volcanic:
    case BiomeType.Hell:
      return [DecorationType.VolcanicRock, DecorationType.VolcanicRock, DecorationType.Rock, DecorationType.DeadTree, DecorationType.VolcanicRock];
    case BiomeType.Ocean:
    case BiomeType.DeepOcean:
      return [DecorationType.Rock, DecorationType.Driftwood, DecorationType.Plant];
    case BiomeType.CoralReef:
      return [DecorationType.Rock, DecorationType.Plant, DecorationType.Driftwood];
    case BiomeType.KelpForest:
      return [DecorationType.Plant, DecorationType.Plant, DecorationType.Rock];
    case BiomeType.Lake:
    case BiomeType.Freshwater:
      return [DecorationType.Plant, DecorationType.Bush, DecorationType.Rock, DecorationType.Tree];
    case BiomeType.GarbagePatch:
      return [DecorationType.Rock, DecorationType.Driftwood, DecorationType.Driftwood];
    default:
      return [DecorationType.Tree, DecorationType.Rock, DecorationType.Plant, DecorationType.Bush];
  }
}

// --- Max decorations per island size ---
function getMaxDecorations(size: IslandSize): number {
  switch (size) {
    case IslandSize.Small: return 15;
    case IslandSize.Medium: return 40;
    case IslandSize.Large: return 80;
    default: return 20;
  }
}

// --- Generate decoration placements for an island ---
// chunkX/chunkZ identify the island for deterministic seeding.
// Returns placements in unit space (will be scaled by entity.scale at render).
export function generateDecorations(
  chunkX: number,
  chunkZ: number,
  biome: BiomeType,
  islandSize: IslandSize,
  islandRadius: number,
  existingField?: VoxelField,
): DecorationPlacement[] {
  const rng = mulberry32(chunkX * 92837111 + chunkZ * 72635341 + 0xDEC0DE);
  const pool = getDecorationPool(biome);
  const maxCount = getMaxDecorations(islandSize);
  const placements: DecorationPlacement[] = [];

  // Reuse existing voxel field if provided, otherwise generate one
  const field = existingField ?? generateVoxelField(chunkX, chunkZ, islandRadius, biome, islandSize);

  // Sample decoration density on a grid across the unit circle.
  // Use the secondary Perlin noise to determine where decorations cluster.
  const GRID = 10;
  const candidates: { x: number; z: number; noise: number }[] = [];

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      // Random jitter within grid cell for natural placement
      const nx = ((i + rng()) / GRID) * 2 - 1;
      const nz = ((j + rng()) / GRID) * 2 - 1;
      const r = Math.sqrt(nx * nx + nz * nz);
      if (r > 0.92) continue; // stay inside island

      // Sample secondary Perlin noise for density
      const n = decorationNoise.fbm(
        nx * DECORATION_NOISE_SCALE + chunkX * 100,
        nz * DECORATION_NOISE_SCALE + chunkZ * 100,
        3, 0.5, 2.0,
      );
      // Normalize to [0, 1]
      const density = (n + 1) * 0.5;
      candidates.push({ x: nx, z: nz, noise: density });
    }
  }

  // Sort by noise value (highest density first) and take top candidates
  candidates.sort((a, b) => b.noise - a.noise);

  for (let i = 0; i < candidates.length && placements.length < maxCount; i++) {
    const c = candidates[i];

    // Skip if noise density is too low (sparse areas get fewer decorations)
    if (c.noise < 0.35) continue;

    // Get terrain height from voxel field
    const y = sampleTerrainHeight(field, c.x, c.z);

    // Only place decorations above water (y > 0) and not on the peak
    if (y < 0.01) continue;
    if (y > TERRAIN_CONFIG.peakHeight * 0.85) continue; // avoid peak rocks area

    // Select decoration type from biome pool, weighted by noise
    const typeIdx = Math.floor(rng() * pool.length);
    const type = pool[typeIdx];

    // Random Y-rotation for all static placements (rocks, driftwood, etc.)
    const rotY = rng() * Math.PI * 2;

    // Per-decoration scale variation
    const scaleVar = 0.7 + rng() * 0.6;

    placements.push({
      type,
      x: c.x,
      z: c.z,
      y,
      rotY,
      scale: scaleVar,
    });
  }

  return placements;
}

// --- Mesh generation helpers ---

interface MeshBuilder {
  verts: number[];
  indices: number[];
  vertCount: number;
}

function pushVert(mb: MeshBuilder, x: number, y: number, z: number, r: number, g: number, b: number): void {
  mb.verts.push(x, y, z, r, g, b);
  mb.vertCount++;
}

function pushTri(mb: MeshBuilder, a: number, b: number, c: number): void {
  mb.indices.push(a, b, c);
}

// --- Tree: trunk (thin cylinder) + foliage (cone) ---
function buildTree(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const trunkH = 0.06 * s;
  const trunkR = 0.008 * s;
  const foliageH = 0.08 * s;
  const foliageR = 0.04 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);

  // Rotate a local point by rotY around Y
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const baseY = p.y;
  const trunkTopY = baseY + trunkH;

  // Trunk: 4-sided pyramid (low-poly)
  const trunkColor: [number, number, number] = [0.35, 0.22, 0.12];
  const trunkBase = mb.vertCount;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const lx = Math.cos(a) * trunkR;
    const lz = Math.sin(a) * trunkR;
    const [rx, rz] = rot(lx, lz);
    pushVert(mb, p.x + rx, baseY, p.z + rz, trunkColor[0], trunkColor[1], trunkColor[2]);
  }
  pushVert(mb, p.x, trunkTopY, p.z, trunkColor[0], trunkColor[1], trunkColor[2]);
  const trunkApex = mb.vertCount - 1;
  for (let i = 0; i < 4; i++) {
    pushTri(mb, trunkBase + i, trunkBase + (i + 1) % 4, trunkApex);
  }

  // Foliage: cone (6-sided)
  const foliageColor: [number, number, number] = [0.18, 0.38, 0.14];
  const foliageBase = mb.vertCount;
  const foliageSegments = 6;
  for (let i = 0; i < foliageSegments; i++) {
    const a = (i / foliageSegments) * Math.PI * 2;
    const lx = Math.cos(a) * foliageR;
    const lz = Math.sin(a) * foliageR;
    const [rx, rz] = rot(lx, lz);
    pushVert(mb, p.x + rx, trunkTopY, p.z + rz, foliageColor[0], foliageColor[1], foliageColor[2]);
  }
  pushVert(mb, p.x, trunkTopY + foliageH, p.z, foliageColor[0] * 0.8, foliageColor[1] * 0.8, foliageColor[2] * 0.8);
  const foliageApex = mb.vertCount - 1;
  for (let i = 0; i < foliageSegments; i++) {
    pushTri(mb, foliageBase + i, foliageBase + (i + 1) % foliageSegments, foliageApex);
  }
}

// --- Dead tree: trunk + bare branches ---
function buildDeadTree(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const trunkH = 0.08 * s;
  const trunkR = 0.006 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const baseY = p.y;
  const trunkTopY = baseY + trunkH;
  const color: [number, number, number] = [0.30, 0.22, 0.15];

  // Trunk: 4-sided
  const trunkBase = mb.vertCount;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const [rx, rz] = rot(Math.cos(a) * trunkR, Math.sin(a) * trunkR);
    pushVert(mb, p.x + rx, baseY, p.z + rz, color[0], color[1], color[2]);
  }
  pushVert(mb, p.x, trunkTopY, p.z, color[0], color[1], color[2]);
  const trunkApex = mb.vertCount - 1;
  for (let i = 0; i < 4; i++) {
    pushTri(mb, trunkBase + i, trunkBase + (i + 1) % 4, trunkApex);
  }

  // Two bare branch stubs
  for (let b = 0; b < 2; b++) {
    const branchAngle = p.rotY + (b === 0 ? 0.8 : -0.6);
    const branchLen = 0.03 * s;
    const branchStartY = trunkTopY - trunkH * 0.3;
    const [bx, bz] = rot(Math.cos(branchAngle) * branchLen, Math.sin(branchAngle) * branchLen);
    const bBase = mb.vertCount;
    pushVert(mb, p.x, branchStartY, p.z, color[0], color[1], color[2]);
    pushVert(mb, p.x + bx, branchStartY + branchLen * 0.7, p.z + bz, color[0], color[1], color[2]);
    pushVert(mb, p.x + bx * 0.5, branchStartY + branchLen, p.z + bz * 0.5, color[0], color[1], color[2]);
    pushTri(mb, bBase, bBase + 1, bBase + 2);
  }
}

// --- Rock: low-poly icosahedron with noise displacement ---
function buildRock(mb: MeshBuilder, p: DecorationPlacement, volcanic: boolean = false): void {
  const s = p.scale;
  const r = 0.035 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const color: [number, number, number] = volcanic
    ? [0.25, 0.12, 0.08]
    : [0.42, 0.40, 0.36];

  // Icosahedron vertices (golden ratio)
  const phi = (1 + Math.sqrt(5)) / 2;
  const len = Math.sqrt(1 + phi * phi);
  const k = r / len;

  const rawVerts: [number, number, number][] = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ];

  // Flatten the rock (less height) and add slight random displacement
  const flatness = 0.6;
  const verts: [number, number, number][] = [];
  for (let i = 0; i < rawVerts.length; i++) {
    const v = rawVerts[i];
    const dx = (Math.sin(i * 7.3) * 0.5 + 0.5) * 0.15;
    const dy = (Math.sin(i * 3.7) * 0.5 + 0.5) * 0.15;
    const dz = (Math.sin(i * 5.1) * 0.5 + 0.5) * 0.15;
    verts.push([
      v[0] * k * (1 + dx),
      v[1] * k * flatness * (1 + dy),
      v[2] * k * (1 + dz),
    ]);
  }

  const base = mb.vertCount;
  for (let i = 0; i < verts.length; i++) {
    const [rx, rz] = rot(verts[i][0], verts[i][2]);
    pushVert(mb, p.x + rx, p.y + verts[i][1] + r * flatness, p.z + rz, color[0], color[1], color[2]);
  }

  // Icosahedron faces (20 triangles)
  const faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let i = 0; i < faces.length; i++) {
    pushTri(mb, base + faces[i][0], base + faces[i][1], base + faces[i][2]);
  }
}

// --- Plant: blade/cross shape ---
function buildPlant(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const h = 0.025 * s;
  const w = 0.015 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const color: [number, number, number] = [0.2, 0.45, 0.15];

  // 3 crossed blades
  for (let b = 0; b < 3; b++) {
    const angle = (b / 3) * Math.PI;
    const bx = Math.cos(angle) * w;
    const bz = Math.sin(angle) * w;
    const [rx1, rz1] = rot(-bx, -bz);
    const [rx2, rz2] = rot(bx, bz);
    const base = mb.vertCount;
    pushVert(mb, p.x + rx1, p.y, p.z + rz1, color[0], color[1], color[2]);
    pushVert(mb, p.x + rx2, p.y, p.z + rz2, color[0], color[1], color[2]);
    pushVert(mb, p.x, p.y + h, p.z, color[0] * 0.7, color[1] * 0.7, color[2] * 0.7);
    pushTri(mb, base, base + 1, base + 2);
  }
}

// --- Bush: small low-poly sphere ---
function buildBush(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const r = 0.025 * s;
  const color: [number, number, number] = [0.22, 0.35, 0.16];

  // Octahedron as a simple bush shape
  const base = mb.vertCount;
  pushVert(mb, p.x, p.y + r, p.z, color[0], color[1], color[2]);       // top
  pushVert(mb, p.x + r, p.y, p.z, color[0], color[1], color[2]);       // +X
  pushVert(mb, p.x, p.y, p.z + r, color[0], color[1], color[2]);       // +Z
  pushVert(mb, p.x - r, p.y, p.z, color[0], color[1], color[2]);       // -X
  pushVert(mb, p.x, p.y, p.z - r, color[0], color[1], color[2]);       // -Z
  pushVert(mb, p.x, p.y - r * 0.3, p.z, color[0] * 0.8, color[1] * 0.8, color[2] * 0.8); // bottom

  pushTri(mb, base, base + 1, base + 2);
  pushTri(mb, base, base + 2, base + 3);
  pushTri(mb, base, base + 3, base + 4);
  pushTri(mb, base, base + 4, base + 1);
  pushTri(mb, base + 5, base + 2, base + 1);
  pushTri(mb, base + 5, base + 3, base + 2);
  pushTri(mb, base + 5, base + 4, base + 3);
  pushTri(mb, base + 5, base + 1, base + 4);
}

// --- Cactus: column with two arms ---
function buildCactus(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const h = 0.07 * s;
  const r = 0.012 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const color: [number, number, number] = [0.3, 0.45, 0.25];

  // Main column: 4-sided box
  const base = mb.vertCount;
  const [rx1, rz1] = rot(-r, -r);
  const [rx2, rz2] = rot(r, -r);
  const [rx3, rz3] = rot(r, r);
  const [rx4, rz4] = rot(-r, r);

  pushVert(mb, p.x + rx1, p.y, p.z + rz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx2, p.y, p.z + rz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx3, p.y, p.z + rz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx4, p.y, p.z + rz4, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx1, p.y + h, p.z + rz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx2, p.y + h, p.z + rz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx3, p.y + h, p.z + rz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx4, p.y + h, p.z + rz4, color[0], color[1], color[2]);

  // Sides
  pushTri(mb, base, base + 1, base + 5); pushTri(mb, base, base + 5, base + 4);
  pushTri(mb, base + 1, base + 2, base + 6); pushTri(mb, base + 1, base + 6, base + 5);
  pushTri(mb, base + 2, base + 3, base + 7); pushTri(mb, base + 2, base + 7, base + 6);
  pushTri(mb, base + 3, base + 0, base + 4); pushTri(mb, base + 3, base + 4, base + 7);
  // Top
  pushTri(mb, base + 4, base + 5, base + 6); pushTri(mb, base + 4, base + 6, base + 7);

  // Left arm
  const armH = h * 0.5;
  const armR = r * 0.6;
  const armOffset = r * 1.5;
  const [ax, az] = rot(-armOffset, 0);
  const armBase = mb.vertCount;
  const [arx1, arz1] = rot(-armR - armOffset, -armR);
  const [arx2, arz2] = rot(armR - armOffset, -armR);
  const [arx3, arz3] = rot(armR - armOffset, armR);
  const [arx4, arz4] = rot(-armR - armOffset, armR);

  pushVert(mb, p.x + arx1, p.y + h * 0.4, p.z + arz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx2, p.y + h * 0.4, p.z + arz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx3, p.y + h * 0.4, p.z + arz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx4, p.y + h * 0.4, p.z + arz4, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx1, p.y + h * 0.4 + armH, p.z + arz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx2, p.y + h * 0.4 + armH, p.z + arz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx3, p.y + h * 0.4 + armH, p.z + arz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + arx4, p.y + h * 0.4 + armH, p.z + arz4, color[0], color[1], color[2]);

  pushTri(mb, armBase, armBase + 1, armBase + 5); pushTri(mb, armBase, armBase + 5, armBase + 4);
  pushTri(mb, armBase + 1, armBase + 2, armBase + 6); pushTri(mb, armBase + 1, armBase + 6, armBase + 5);
  pushTri(mb, armBase + 2, armBase + 3, armBase + 7); pushTri(mb, armBase + 2, armBase + 7, armBase + 6);
  pushTri(mb, armBase + 3, armBase + 0, armBase + 4); pushTri(mb, armBase + 3, armBase + 4, armBase + 7);
  pushTri(mb, armBase + 4, armBase + 5, armBase + 6); pushTri(mb, armBase + 4, armBase + 6, armBase + 7);
}

// --- Driftwood: elongated angled box ---
function buildDriftwood(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const len = 0.06 * s;
  const w = 0.01 * s;
  const h = 0.008 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const color: [number, number, number] = [0.45, 0.35, 0.22];

  const [rx1, rz1] = rot(-len, -w);
  const [rx2, rz2] = rot(len, -w);
  const [rx3, rz3] = rot(len, w);
  const [rx4, rz4] = rot(-len, w);

  const base = mb.vertCount;
  pushVert(mb, p.x + rx1, p.y, p.z + rz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx2, p.y, p.z + rz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx3, p.y, p.z + rz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx4, p.y, p.z + rz4, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx1, p.y + h, p.z + rz1, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx2, p.y + h, p.z + rz2, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx3, p.y + h, p.z + rz3, color[0], color[1], color[2]);
  pushVert(mb, p.x + rx4, p.y + h, p.z + rz4, color[0], color[1], color[2]);

  pushTri(mb, base, base + 1, base + 5); pushTri(mb, base, base + 5, base + 4);
  pushTri(mb, base + 1, base + 2, base + 6); pushTri(mb, base + 1, base + 6, base + 5);
  pushTri(mb, base + 2, base + 3, base + 7); pushTri(mb, base + 2, base + 7, base + 6);
  pushTri(mb, base + 3, base + 0, base + 4); pushTri(mb, base + 3, base + 4, base + 7);
  pushTri(mb, base + 4, base + 5, base + 6); pushTri(mb, base + 4, base + 6, base + 7);
}

// --- Ice crystal: elongated octahedron ---
function buildIceCrystal(mb: MeshBuilder, p: DecorationPlacement): void {
  const s = p.scale;
  const h = 0.05 * s;
  const r = 0.012 * s;
  const cos = Math.cos(p.rotY);
  const sin = Math.sin(p.rotY);
  function rot(x: number, z: number): [number, number] {
    return [x * cos - z * sin, x * sin + z * cos];
  }

  const color: [number, number, number] = [0.7, 0.8, 0.9];

  const base = mb.vertCount;
  pushVert(mb, p.x, p.y + h, p.z, color[0], color[1], color[2]);     // top
  pushVert(mb, p.x, p.y, p.z, color[0], color[1], color[2]);         // middle
  pushVert(mb, p.x, p.y - h * 0.3, p.z, color[0] * 0.8, color[1] * 0.8, color[2] * 0.8); // bottom

  // 4 mid-vertices
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const [rx, rz] = rot(Math.cos(a) * r, Math.sin(a) * r);
    pushVert(mb, p.x + rx, p.y + h * 0.3, p.z + rz, color[0], color[1], color[2]);
  }

  // Top faces
  pushTri(mb, base + 1, base + 3, base + 0);
  pushTri(mb, base + 1, base + 4, base + 0);
  pushTri(mb, base + 1, base + 5, base + 0);
  pushTri(mb, base + 1, base + 6, base + 0);
  // Bottom faces
  pushTri(mb, base + 2, base + 6, base + 5);
  pushTri(mb, base + 2, base + 5, base + 4);
  pushTri(mb, base + 2, base + 4, base + 3);
  pushTri(mb, base + 2, base + 3, base + 6);
}

// --- Generate decoration mesh (pos+normal+color vertex format, 9 floats/vertex) ---
export function generateDecorationMesh(placements: DecorationPlacement[]): { verts: Float32Array; indices: Uint16Array } {
  const mb: MeshBuilder = { verts: [], indices: [], vertCount: 0 };

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    switch (p.type) {
      case DecorationType.Tree:
        buildTree(mb, p);
        break;
      case DecorationType.DeadTree:
        buildDeadTree(mb, p);
        break;
      case DecorationType.Rock:
        buildRock(mb, p, false);
        break;
      case DecorationType.VolcanicRock:
        buildRock(mb, p, true);
        break;
      case DecorationType.Plant:
        buildPlant(mb, p);
        break;
      case DecorationType.Bush:
        buildBush(mb, p);
        break;
      case DecorationType.Cactus:
        buildCactus(mb, p);
        break;
      case DecorationType.Driftwood:
        buildDriftwood(mb, p);
        break;
      case DecorationType.IceCrystal:
        buildIceCrystal(mb, p);
        break;
      default:
        buildRock(mb, p, false);
        break;
    }
  }

  return computeFlatNormals(new Float32Array(mb.verts), new Uint16Array(mb.indices));
}
