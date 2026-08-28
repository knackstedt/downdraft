// ============================================================================
// Overburden — terrain generation
//
// Generates chunk data in three phases:
//   1. generateTerrain() — foreground + background base blocks (grass, dirt,
//      stone, sand, water, lava, bedrock) using the biome system for surface
//      height + block types. Caves carve the foreground (layers 1 & 2) only;
//      the background (layers 3 & 4) stays as stone cave walls.
//   2. generateTrees()   — trees + vines in the background plane. Trees can
//      overflow across chunk borders (trunk + canopy extending into the chunk
//      above or to the sides) via the ChunkAccessor interface. A virtual grid
//      approach lets canopy shapes extend into neighbor chunks without
//      modifying the shape functions in tree-species.ts.
//   3. generateFeatures() — wild crops + fog-of-war explored flags.
//
// generateChunk() runs all three phases (for backward compatibility with
// tests that don't need cross-chunk tree overflow). BlockWorld.ensureChunk()
// calls terrain + trees separately so that tree overflow can trigger terrain-
// only generation on neighbor chunks without recursing into their tree pass.
//
// Biome system (see biomes.ts): low-frequency noise assigns each world X
// column a biome (ocean, plains, desert, mountain). Biomes control surface
// height, surface/dirt block types, tree density, and cave parameters.
//
// Layer terminology:
//   Layer 1 = foreground front (Z=0)   — main terrain (caves carve this)
//   Layer 2 = foreground back (Z=-1)   — same terrain, darker
//   Layer 3 = background main (Z=-2)   — trees + back wall
//   Layer 4 = back wall only (Z=-3)    — terrain back wall, no trees
// ============================================================================

import { fbm2D, hash2, valueNoise2D } from "@downdraft/core";
import {
    BLOCK_AIR, BLOCK_BEDROCK, BLOCK_CLAY, BLOCK_COAL_ORE, BLOCK_COPPER_ORE,
    BLOCK_DIRT, BLOCK_GOLD_ORE, BLOCK_GRASS, BLOCK_GRAVEL, BLOCK_IRON_ORE,
    BLOCK_LAVA, BLOCK_SAND,
    BLOCK_STONE,
    BLOCK_TIME_CRYSTAL,
    BLOCK_TIN_ORE,
    BLOCK_WATER,
    CHUNK_H,
    CHUNK_W,
    CHUNKS_X,
    MAGMA_Y, SEA_LEVEL, SURFACE_Y, WORLD_H
} from "../shared/constants";
import { WILD_CROPS } from "../shared/crops";
import {
    isTreeBlock, makeTaggedBlock,
    pickTreeSpecies, pickVineSpecies, VINE_SPECIES,
    type TreeSpecies,
} from "../shared/tree-species";
import type { Chunk } from "../shared/types";
import { biomeAt, type Biome, type BiomeInfo } from "./biomes";
import { cellIndex } from "./chunk";
import { setFlow } from "./fluid-sim";

// --- Chunk accessor interface ---
// Allows tree generation to write overflow blocks into neighbor chunks.
// BlockWorld implements this. When no accessor is provided (e.g. in tests),
// tree overflow is silently dropped (trees get truncated at chunk borders,
// same as the old behavior).
export interface ChunkAccessor {
  /** Ensure a chunk's terrain is generated (no trees) and return it. */
  ensureChunkTerrainOnly(cx: number, cy: number): Chunk;
}

// --- Canopy overflow margin ---
// Max canopy radius (blocks) that can extend past chunk borders. Must be ≥
// the largest canopy shape radius (spruce cone halfW ≈ 3, dome radiusX ≈ 3,
// banana droop ≈ 3). 8 gives ample headroom.
const CANOPY_MARGIN = 8;
const VG_W = CHUNK_W + 2 * CANOPY_MARGIN;
const VG_H = CHUNK_H + 2 * CANOPY_MARGIN;

// --- Surface height ---
// Delegates to the biome system. Returns world Y of the surface at world X.
function surfaceHeightAt(wx: number, seed: number): number {
  return biomeAt(wx, seed).surfaceY;
}

// --- Dirt depth ---
// Delegates to the biome system.
function dirtDepthAt(wx: number, seed: number): number {
  return biomeAt(wx, seed).dirtDepth;
}

// --- Cave generation ---
// fBm noise threshold check. Returns true if this cell is a cave.
// Caves carve the FOREGROUND (layers 1 & 2) only; the background stays as
// stone (cave walls in layers 3 & 4). Caves are excluded in the first few
// blocks below the surface (so the surface doesn't collapse into holes) and
// near the magma layer (so the magma chamber stays intact).
function isCave(wx: number, wy: number, seed: number, surfaceY: number): boolean {
  // No caves within 10 blocks of the surface (prevents surface collapse)
  if (wy < surfaceY + 10) return false;
  // No caves near the magma layer
  if (wy > MAGMA_Y - 10) return false;
  // 2D fBm with different X/Y scales for tunnel-like shapes
  const noise = fbm2D(wx * 0.025, wy * 0.04, seed + 500, 4, 2.0, 0.5);
  // Threshold ~0.58 → ~15-20% of underground cells become caves
  return noise > 0.58;
}

// --- Ore generation ---
// Depth-stratified ore selection. Returns the ore block ID or 0 if no ore.
function oreAt(wx: number, wy: number, seed: number): number {
  const depth = wy - SURFACE_Y;
  if (depth < 10) return 0;

  // Each ore has an ideal depth and spread (Gaussian distribution)
  const ores = [
    { id: BLOCK_COAL_ORE, ideal: 50, spread: 80, abundance: 0.015 },
    { id: BLOCK_COPPER_ORE, ideal: 80, spread: 100, abundance: 0.012 },
    { id: BLOCK_TIN_ORE, ideal: 100, spread: 100, abundance: 0.010 },
    { id: BLOCK_IRON_ORE, ideal: 200, spread: 150, abundance: 0.010 },
    { id: BLOCK_GOLD_ORE, ideal: 350, spread: 200, abundance: 0.005 },
    { id: BLOCK_TIME_CRYSTAL, ideal: 400, spread: 250, abundance: 0.003 },
  ];

  for (const ore of ores) {
    const gaussian = Math.exp(-((depth - ore.ideal) ** 2) / (2 * ore.spread ** 2));
    const chance = ore.abundance * gaussian;
    if (hash2(wx, wy, seed + ore.id) < chance) {
      return ore.id;
    }
  }
  return 0;
}

// --- Tree generation ---
// Returns true if a tree trunk starts at this surface cell.
// Chance is biome-dependent (deserts have very few, oceans have none).
function treeAt(wx: number, wy: number, seed: number, biome: BiomeInfo): boolean {
  if (biome.treeChance === 0) return false;
  // Trees only spawn near the surface band
  if (wy < biome.surfaceY - 5 || wy > biome.surfaceY + 5) return false;
  return hash2(wx, wy, seed + 999) < biome.treeChance;
}

// --- Vine generation ---
// Vines (kiwi, grape) climb on trees. A vine spawns at the base of a tree
// with ~12% probability and climbs up the trunk in adjacent empty background
// cells. Returns the vine block ID to plant at the base, or 0 for none.
function vineAtBase(wx: number, wy: number, seed: number): number {
  if (hash2(wx, wy, seed + 7777) < 0.12) {
    const r = hash2(wx, wy, seed + 8888);
    return pickVineSpecies(r).block;
  }
  return 0;
}

// --- Surface block selection by biome ---
// Returns the foreground surface block for a given biome + surface Y.
function surfaceBlockFor(biome: Biome, surfaceY: number): number {
  switch (biome) {
    case "ocean":
      // Ocean floor: sand near shore, stone in deep areas
      if (surfaceY > SEA_LEVEL - 20) return BLOCK_SAND;
      return BLOCK_STONE;
    case "desert":
      return BLOCK_SAND;
    case "mountain":
      // Mountain: grass at lower elevations, stone at high peaks
      if (surfaceY < SURFACE_Y + 70) return BLOCK_GRASS;
      return BLOCK_STONE;
    default:
      // Plains: grass, with sand beaches near sea level
      if (surfaceY >= SEA_LEVEL - 3 && surfaceY <= SEA_LEVEL + 3) return BLOCK_SAND;
      return BLOCK_GRASS;
  }
}

// --- Subsurface block selection by biome ---
// Returns the block below the surface (dirt for plains/mountain, sand for
// desert/ocean).
function subsurfaceBlockFor(biome: Biome): number {
  switch (biome) {
    case "ocean": return BLOCK_SAND;
    case "desert": return BLOCK_SAND;
    case "mountain": return BLOCK_DIRT;
    default: return BLOCK_DIRT;
  }
}

// ============================================================================
// Phase 1: Terrain generation (foreground + background base blocks)
// ============================================================================

export function generateTerrain(chunk: Chunk, seed: number): void {
  const baseWx = chunk.cx * CHUNK_W;
  const baseWy = chunk.cy * CHUNK_H;

  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);

      // Default: air
      let foreground = BLOCK_AIR;
      let background = BLOCK_AIR;

      const info = biomeAt(wx, seed);
      const surfaceY = info.surfaceY;

      if (wy < surfaceY) {
        // Above surface: air (or water if below sea level)
        if (wy > SEA_LEVEL) {
          foreground = setFlow(BLOCK_WATER, 7); // full water
        }
        // Background matches foreground above surface (air/water)
        // so the back wall doesn't fill the sky.
      } else if (wy === surfaceY) {
        // Surface block: biome-dependent
        foreground = surfaceBlockFor(info.biome, surfaceY);
        background = foreground;
      } else if (wy < surfaceY + info.dirtDepth) {
        // Subsurface layer (dirt or sand depending on biome)
        const subBlock = subsurfaceBlockFor(info.biome);
        foreground = subBlock;
        background = subBlock;
      } else if (wy < MAGMA_Y - 5) {
        // Stone layer (with ores + caves)
        if (isCave(wx, wy, seed, surfaceY)) {
          // Cave: air — foreground only. Water enters caves via the fluid
          // sim (from oceans/surface water), not during generation. Isolated
          // caves stay dry; caves connected to oceans fill naturally over time.
          // Background behind caves: stone (cave wall in layers 3 & 4)
          background = BLOCK_STONE;
        } else {
          const ore = oreAt(wx, wy, seed);
          if (ore !== 0) {
            foreground = ore;
            // Background behind ores: stone (the host rock)
            background = BLOCK_STONE;
          } else {
            // Occasional gravel pockets
            if (valueNoise2D(wx * 0.1, wy * 0.1, seed + 700) > 0.8) {
              foreground = BLOCK_GRAVEL;
              background = BLOCK_GRAVEL;
            } else if (valueNoise2D(wx * 0.15, wy * 0.15, seed + 800) > 0.85) {
              foreground = BLOCK_CLAY;
              background = BLOCK_CLAY;
            } else {
              foreground = BLOCK_STONE;
              background = BLOCK_STONE;
            }
          }
        }
      } else if (wy < MAGMA_Y) {
        // Deep stone (near magma)
        foreground = BLOCK_STONE;
        background = BLOCK_STONE;
      } else if (wy < WORLD_H - 5) {
        // Magma layer
        foreground = setFlow(BLOCK_LAVA, 7);
        background = BLOCK_STONE;
      } else {
        // Bedrock floor
        foreground = BLOCK_BEDROCK;
        background = BLOCK_BEDROCK;
      }

      chunk.foreground[idx] = foreground;
      chunk.background[idx] = background;

      // Initial light: daylight above surface, dark below
      if (wy < surfaceY) {
        chunk.light[idx] = 15; // full daylight
      } else {
        chunk.light[idx] = 0; // dark underground
      }

      // Lava emits light
      if (foreground === BLOCK_LAVA) {
        chunk.light[idx] = 15;
      }
    }
  }

  chunk.terrainGenerated = true;
}

// ============================================================================
// Phase 2: Tree + vine generation (background plane, with cross-chunk overflow)
// ============================================================================

/**
 * Get the background block at world coordinates (wx, wy), reading from the
 * appropriate chunk. Uses the accessor to fetch neighbor chunks if needed.
 * Returns BLOCK_AIR (0) if the chunk is out of world bounds or no accessor.
 */
function getBackgroundAt(
  baseChunk: Chunk,
  wx: number,
  wy: number,
  accessor: ChunkAccessor | null,
): number {
  const cx = ((Math.floor(wx / CHUNK_W) % CHUNKS_X) + CHUNKS_X) % CHUNKS_X;
  const cy = Math.floor(wy / CHUNK_H);
  if (cy < 0 || cy >= WORLD_H / CHUNK_H) return 1; // non-air (world bounds)

  if (cx === baseChunk.cx && cy === baseChunk.cy) {
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    return baseChunk.background[cellIndex(lx, ly)];
  }
  if (!accessor) return 0; // air (no overflow possible)
  const neighbor = accessor.ensureChunkTerrainOnly(cx, cy);
  const lx = wx - cx * CHUNK_W;
  const ly = wy - cy * CHUNK_H;
  return neighbor.background[cellIndex(lx, ly)];
}

/**
 * Set a tagged background block at world coordinates (wx, wy), writing to the
 * appropriate chunk. Only writes if the target cell is currently BLOCK_AIR.
 */
function setBackgroundAt(
  baseChunk: Chunk,
  wx: number,
  wy: number,
  blockId: number,
  treeTag: number,
  accessor: ChunkAccessor | null,
): void {
  const cx = ((Math.floor(wx / CHUNK_W) % CHUNKS_X) + CHUNKS_X) % CHUNKS_X;
  const cy = Math.floor(wy / CHUNK_H);
  if (cy < 0 || cy >= WORLD_H / CHUNK_H) return;

  let chunk: Chunk;
  if (cx === baseChunk.cx && cy === baseChunk.cy) {
    chunk = baseChunk;
  } else if (accessor) {
    chunk = accessor.ensureChunkTerrainOnly(cx, cy);
  } else {
    return; // no accessor, drop overflow
  }

  const lx = wx - cx * CHUNK_W;
  const ly = wy - cy * CHUNK_H;
  const idx = cellIndex(lx, ly);
  if (chunk.background[idx] === BLOCK_AIR) {
    chunk.background[idx] = makeTaggedBlock(blockId, treeTag);
    chunk.dirty = true;
  }
}

/**
 * Place a canopy with cross-chunk overflow support using a virtual grid.
 *
 * Creates a temporary grid larger than the chunk (CHUNK_W + 2*MARGIN) ×
 * (CHUNK_H + 2*MARGIN), copies existing background blocks from the chunk +
 * neighbors into it, runs the species' canopy shape function on the virtual
 * grid, then writes newly-placed leaves back to the appropriate chunks
 * (in-bounds → current chunk, out-of-bounds → neighbor chunks via accessor).
 */
function placeCanopyWithOverflow(
  baseChunk: Chunk,
  baseWx: number,
  baseWy: number,
  lx: number,
  ly: number,
  trunkTopLy: number,
  trunkHeight: number,
  species: TreeSpecies,
  treeTag: number,
  accessor: ChunkAccessor | null,
): void {
  // 1. Build virtual grid: copy existing background blocks from chunk + neighbors
  const vg = new Uint16Array(VG_W * VG_H);
  const occupied = new Uint8Array(VG_W * VG_H); // 1 = was non-zero before canopy

  for (let vgy = 0; vgy < VG_H; vgy++) {
    for (let vgx = 0; vgx < VG_W; vgx++) {
      const wx = baseWx + (vgx - CANOPY_MARGIN);
      const wy = baseWy + (vgy - CANOPY_MARGIN);
      const val = getBackgroundAt(baseChunk, wx, wy, accessor);
      const vi = vgy * VG_W + vgx;
      vg[vi] = val;
      if (val !== 0) occupied[vi] = 1;
    }
  }

  // 2. Run canopy placement on the virtual grid (coordinates offset by MARGIN)
  const vgLx = lx + CANOPY_MARGIN;
  const vgLy = ly + CANOPY_MARGIN;
  const vgTrunkTopLy = trunkTopLy + CANOPY_MARGIN;
  species.placeCanopy(vg, VG_W, VG_H, vgLx, vgLy, vgTrunkTopLy, trunkHeight, species.leafBlock, treeTag);

  // 3. Write newly-placed leaves back to chunks
  for (let vgy = 0; vgy < VG_H; vgy++) {
    for (let vgx = 0; vgx < VG_W; vgx++) {
      const vi = vgy * VG_W + vgx;
      if (occupied[vi]) continue; // was already non-zero, skip
      const val = vg[vi];
      if (val === 0) continue; // still air, no leaf placed
      // Newly placed leaf → write to the appropriate chunk
      const wx = baseWx + (vgx - CANOPY_MARGIN);
      const wy = baseWy + (vgy - CANOPY_MARGIN);
      const blockId = val & 0xFF;
      const tag = (val >> 8) & 0xFF;
      setBackgroundAt(baseChunk, wx, wy, blockId, tag, accessor);
    }
  }
}

export function generateTrees(chunk: Chunk, seed: number, accessor: ChunkAccessor | null = null): void {
  const baseWx = chunk.cx * CHUNK_W;
  const baseWy = chunk.cy * CHUNK_H;

  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);

      // Trees grow on the surface block in the foreground
      const fg = chunk.foreground[idx];
      if (fg !== BLOCK_GRASS && fg !== BLOCK_SAND) continue;

      const info = biomeAt(wx, seed);
      if (!treeAt(wx, wy, seed, info)) continue;

      // Pick a species deterministically for this cell.
      const species = pickTreeSpecies(hash2(wx, wy, seed + 333));
      const trunkHeight = species.trunkMin +
        Math.floor(hash2(wx, wy, seed + 111) * (species.trunkMax - species.trunkMin + 1));

      // Per-tree group tag: stored in the upper 8 bits of the background
      // Uint16 so fellTree flood-fill stays within this tree only.
      let treeTag = (Math.imul(wx, 31) + Math.imul(wy, 17)) & 0xFF;
      if (treeTag === 0) treeTag = 1;

      // Trunk: wood blocks growing upward in the background plane.
      // Uses setBackgroundAt so the trunk can overflow into the chunk above.
      let trunkTopWy = wy;
      for (let h = 1; h <= trunkHeight; h++) {
        const treeWy = wy - h;
        if (treeWy < 0) break; // above the world
        // Check if the target cell is air before placing
        const existing = getBackgroundAt(chunk, wx, treeWy, accessor);
        if (existing === BLOCK_AIR) {
          setBackgroundAt(chunk, wx, treeWy, species.woodBlock, treeTag, accessor);
          trunkTopWy = treeWy;
        } else {
          break; // blocked by existing block
        }
      }

      // Canopy: species-specific shape with cross-chunk overflow support.
      const trunkTopLy = trunkTopWy - baseWy;
      placeCanopyWithOverflow(
        chunk, baseWx, baseWy, lx, ly, trunkTopLy, trunkHeight,
        species, treeTag, accessor,
      );

      // Maybe spawn a vine at the base that climbs up the trunk.
      const vineBlock = vineAtBase(wx, wy, seed);
      if (vineBlock !== 0) {
        const vineSp = VINE_SPECIES.find((v) => v.block === vineBlock)!;
        const side = hash2(wx, wy, seed + 555) < 0.5 ? -1 : 1;
        for (let h = 1; h <= vineSp.maxHeight; h++) {
          const vy = wy - h;
          if (vy < 0) break;
          const vxSide = wx + (h % 2 === 0 ? side : -side);
          // Check trunk support at this height
          const trunkVal = getBackgroundAt(chunk, wx, vy, accessor);
          if (!isTreeBlock(trunkVal)) break; // trunk ended
          // Try to place vine in the side cell if it's air
          const sideVal = getBackgroundAt(chunk, vxSide, vy, accessor);
          if (sideVal === BLOCK_AIR) {
            setBackgroundAt(chunk, vxSide, vy, vineBlock, treeTag, accessor);
          }
        }
      }
    }
  }
}

// ============================================================================
// Phase 3: Features (wild crops + fog-of-war explored flags)
// ============================================================================

export function generateFeatures(chunk: Chunk, seed: number): void {
  const baseWx = chunk.cx * CHUNK_W;
  const baseWy = chunk.cy * CHUNK_H;

  // Wild crops (berry bushes, wild mushrooms) spawn on grass cells above
  // the surface. Each wild crop type has a spawn chance per grass cell.
  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);
      if (chunk.foreground[idx] !== BLOCK_GRASS) continue;
      const aboveIdx = ly > 0 ? cellIndex(lx, ly - 1) : -1;
      if (aboveIdx >= 0 && (chunk.foreground[aboveIdx] & 0xFF) !== BLOCK_AIR) continue;
      if (isTreeBlock(chunk.background[idx])) continue;

      for (const wc of WILD_CROPS) {
        const roll = hash2(wx, wy, seed + 999 + wc.blockId);
        if (roll < wc.spawnChance) {
          if (aboveIdx >= 0) {
            chunk.foreground[aboveIdx] = wc.blockId;
          }
          break;
        }
      }
    }
  }

  // Mark as explored near surface (fog of war: surface + sky is visible)
  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wy = baseWy + ly;
      if (wy < SURFACE_Y + 30) {
        chunk.explored[cellIndex(lx, ly)] = 1;
      }
    }
  }
}

// ============================================================================
// Full generation (all 3 phases) — backward-compatible wrapper
// ============================================================================

export function generateChunk(chunk: Chunk, seed: number): void {
  if (!chunk.terrainGenerated) {
    generateTerrain(chunk, seed);
  }
  generateTrees(chunk, seed, null);
  generateFeatures(chunk, seed);
  chunk.generated = true;
}
