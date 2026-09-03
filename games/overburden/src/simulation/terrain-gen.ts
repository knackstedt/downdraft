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
    BLOCK_LAVA, BLOCK_OIL_POCKET, BLOCK_OIL_SATURATED_ROCK, BLOCK_SAND,
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
import { biomeAt, DESERT_THRESHOLD, MOUNTAIN_THRESHOLD, OCEAN_THRESHOLD, type BiomeInfo } from "./biomes";
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

// --- Cave generation (depth-graded noise + sprawl tunnels) ---
//
// Two channels produce the cave system:
//
// 1. SMALL CAVES (majority): high-frequency fBm with a high threshold → many
//    small scattered pockets. This is the common case.
//
// 2. SPRAWL TUNNELS (rare, large): a second noise channel that produces long,
//    winding, sprawling tunnel systems — NOT round caverns. The key technique
//    is ROTATED ANISOTROPIC noise: world coordinates are rotated by a slowly-
//    varying angle (from a very low-frequency noise), then sampled with
//    highly anisotropic scales (one axis ~5x lower frequency than the other).
//    This stretches the cave noise into long corridors that wind in different
//    directions across the world. A regional gate noise determines WHERE
//    sprawl systems exist (rare — only ~15% of the underground), so most of
//    the map has only small caves, with occasional large sprawling tunnel
//    networks.
//
// Both channels share the same smooth surface/magma fade (no artificial roofs,
// intact magma chamber) and depth-graded threshold (smaller near surface,
// larger toward magma).
//
// Caves carve the FOREGROUND (layers 1 & 2) only; the background stays as
// stone (cave walls in layers 3 & 4).
function smoothstepEdge(t: number): number {
  return t * t * (3 - 2 * t);
}
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Sprawl tunnel config:
//   gateScale: very low-freq noise that gates WHERE sprawl systems exist.
//   gateThreshold: high → only ~8% of the map qualifies (rare regions).
//   angleScale: very low-freq noise that determines the tunnel direction.
//     Varies slowly across the world so corridors wind in different directions.
//   longScale / shortScale: the anisotropic fBm frequencies. longScale is
//     ~5x lower than shortScale → corridors stretch ~5x along one axis.
//   threshold: higher than before so tunnels are thin corridors, not wide
//     rooms. Depth-graded: 0.74 (surface) → 0.62 (magma).
const SPRAWL = {
  gateScale: 0.005,
  gateThreshold: 0.74,
  angleScale: 0.004,
  longScale: 0.018,
  shortScale: 0.09,
  baseThreshold: 0.76,
  magmaThresholdDrop: 0.06,
};

function isCave(wx: number, wy: number, seed: number, surfaceY: number): boolean {
  const depth = wy - surfaceY;
  // Thin crust right under the surface — no carved roof at all.
  if (depth < 4) return false;

  // Smooth fade-in over 16 blocks below the crust → caves ramp in gradually,
  // eliminating the flat artificial roof the hard cutoff produced.
  const surfaceFactor = smoothstepEdge(clamp01((depth - 4) / 16));
  // Smooth fade-out over 10 blocks above the magma layer → magma chamber
  // stays intact, no abrupt cave/magma seam.
  const magmaFactor = smoothstepEdge(clamp01((MAGMA_Y - 5 - wy) / 10));
  if (surfaceFactor <= 0 || magmaFactor <= 0) return false;

  // Shared depth factor + boundary fade (both channels use these).
  const depthFactor = clamp01((wy - SURFACE_Y) / (MAGMA_Y - SURFACE_Y));
  const fade = Math.min(surfaceFactor, magmaFactor);

  // --- Channel 1: small caves (high-freq, high threshold) ---
  // Range 0.76 (surface) → 0.68 (magma). High threshold → small pockets.
  const smallThreshold = 0.76 - depthFactor * 0.08;
  const smallEff = smallThreshold + (1 - fade) * 0.20;
  const smallNoise = fbm2D(wx * 0.08, wy * 0.12, seed + 500, 4, 2.0, 0.5);
  if (smallNoise > smallEff) return true;

  // --- Channel 2: sprawl tunnels (rare, large, winding corridors) ---
  // Regional gate: only ~15% of the map has sprawl systems at all.
  const gateNoise = fbm2D(wx * SPRAWL.gateScale, wy * SPRAWL.gateScale, seed + 510, 2, 2.0, 0.5);
  if (gateNoise < SPRAWL.gateThreshold) return false;

  // Tunnel direction: slowly-varying angle across the world. This rotates
  // the anisotropic noise so corridors wind in different directions by
  // region, creating sprawling networks rather than straight lines.
  const angle = fbm2D(wx * SPRAWL.angleScale, wy * SPRAWL.angleScale, seed + 520, 2, 2.0, 0.5) * Math.PI;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  // Rotate world coords, then sample anisotropic fBm (long axis = stretched).
  const rx = (wx * cosA + wy * sinA) * SPRAWL.longScale;
  const ry = (-wx * sinA + wy * cosA) * SPRAWL.shortScale;
  const sprawlNoise = fbm2D(rx, ry, seed + 530, 3, 2.0, 0.5);

  // Lower threshold than small caves → large tunnels when present.
  // Range 0.66 (surface) → 0.54 (magma).
  const sprawlThreshold = SPRAWL.baseThreshold - depthFactor * SPRAWL.magmaThresholdDrop;
  const sprawlEff = sprawlThreshold + (1 - fade) * 0.20;
  return sprawlNoise > sprawlEff;
}

// --- Ore generation (Perlin-worm veins) ---
//
// Instead of the old per-cell hash scatter (which produced isolated single
// ore blocks — "a random noise overlay"), ore veins are generated by
// "worms" that walk through the stone body depositing ore along their path.
// This produces long, winding, connected veins that look like mineralized
// fractures — the same technique used by Minecraft and by the mining-rpg
// game in this repo (games/mining-rpg/src/simulation/terrain.ts).
//
// How it works:
//   1. The world is divided into a coarse seed grid (every WORM_CONFIG.seedGrid
//      cells). At each seed point, a worm may spawn (deterministic hash check).
//   2. The worm's ore type is chosen by depth-weighted Gaussian selection at
//      its spawn point — multiple ore types coexist, grading smoothly with depth.
//   3. The worm walks in a noise-perturbed direction for up to ore.veinLength
//      steps, depositing ore in a small radius at each step.
//   4. When generating a chunk, worms from seed cells in a neighborhood are
//      simulated so veins span chunk boundaries seamlessly.
//
// Determinism: each worm is seeded by its grid cell coordinates + world seed.
// The entire path is deterministic, so a vein is identical regardless of
// which chunk is being generated. This guarantees seamless chunk-spanning.

interface OreEntry {
  id: number;
  name: string;
  // --- Depth grading (world Y coordinates, y increases downward) ---
  idealY: number;   // world Y where this ore is most common (Gaussian peak)
  spread: number;   // Gaussian standard deviation (in world Y cells)
  minY: number;     // hard minimum depth — no ore above this
  maxY: number;     // hard maximum depth — no ore below this
  abundance: number; // relative rarity at peak depth (0-1, higher = more common)
  // --- Vein shape (Perlin worm parameters) ---
  veinLength: number; // max worm steps (longer = more stretched vein)
  veinRadius: number; // deposit radius per step in cells (thicker vein)
}

// Depth is in world Y coordinates. Surface ≈ SURFACE_Y (700), magma starts at
// MAGMA_Y (1000). Stone body ≈ worldY 710-995. Each chunk is 64 cells tall.
//
//   worldY 710-880:  shallow (coal, copper, tin)
//   worldY 780-940:  mid (iron)
//   worldY 820-980:  mid-deep (oil-saturated rock)
//   worldY 860-995:  deep (gold, time crystal)
//
// Vein shape: veins are intentionally small so ore is distributed as many
// short, thin pockets rather than a few massive blobs. Common ores (coal,
// copper, tin) get short, thin veins (22-26 steps, peak radius 1.0-1.2).
// Rare ores (gold, time crystal) get very short, very thin veins (12-16
// steps, peak radius 0.7-0.8). Oil-saturated rock gets short veins (20
// steps, peak radius 1.0). The radius is further modulated along the vein's
// length (width variation + tapered ends) in simulateWorm, so veinRadius
// here is the PEAK radius — actual deposited width varies from ~0 at the
// ends to this peak in the middle, with noise-driven bulges/pinches along
// the way. spawnChance is high (0.55) and abundance is tuned high so ore is
// genuinely common — many small, findable deposits per chunk.
const ORE_CONFIG: OreEntry[] = [
  { id: BLOCK_COAL_ORE,             name: "Coal",       idealY: 750, spread: 60, minY: 710, maxY: 880, abundance: 0.075, veinLength: 26, veinRadius: 1.3 },
  { id: BLOCK_COPPER_ORE,           name: "Copper",     idealY: 780, spread: 70, minY: 720, maxY: 920, abundance: 0.120, veinLength: 24, veinRadius: 1.2 },
  { id: BLOCK_TIN_ORE,              name: "Tin",        idealY: 800, spread: 70, minY: 740, maxY: 940, abundance: 0.100, veinLength: 24, veinRadius: 1.2 },
  { id: BLOCK_IRON_ORE,             name: "Iron",       idealY: 850, spread: 80, minY: 780, maxY: 970, abundance: 0.100, veinLength: 22, veinRadius: 1.1 },
  { id: BLOCK_OIL_SATURATED_ROCK,   name: "Oil Rock",   idealY: 880, spread: 70, minY: 820, maxY: 980, abundance: 0.080, veinLength: 20, veinRadius: 1.1 },
  { id: BLOCK_GOLD_ORE,             name: "Gold",       idealY: 920, spread: 70, minY: 860, maxY: 995, abundance: 0.025, veinLength: 16, veinRadius: 0.9 },
  { id: BLOCK_TIME_CRYSTAL,         name: "Crystal",    idealY: 950, spread: 60, minY: 890, maxY: 995, abundance: 0.032, veinLength: 12, veinRadius: 0.8 },
];

const WORM_CONFIG = {
  // Seed grid spacing: one potential worm spawn point every N world cells.
  // Smaller (24) = more spawn points = more veins. Compensates for the
  // reduced per-vein volume from tapering + width variation.
  seedGrid: 24,
  // Probability that a seed cell actually spawns a worm. High (0.85) so the
  // small tapered veins are frequent — ore is common overall, each deposit
  // is modest. Higher than a uniform-width worm would need because tapering
  // + width variation reduce the average deposited volume per vein.
  spawnChance: 0.85,
  // Distance the worm travels per step (in cells). Smaller = smoother path.
  stepSize: 1.5,
  // Maximum direction change per step (radians). Higher = more curvy veins.
  turnRate: 0.35,
  // Spatial frequency of the noise that perturbs the worm's direction.
  noiseScale: 0.04,
  // Early exit: if a worm has been outside the chunk neighborhood for this
  // many consecutive steps, stop simulating it (optimization).
  maxStepsOutside: 15,
};

/**
 * Pick an ore type for a worm spawning at (worldX, worldY) using depth-weighted
 * Gaussian probability. Multiple ores can coexist at overlapping depths; the
 * abundance parameter controls the relative mix. Returns null if no ore is
 * valid at this depth.
 */
function pickOreByDepth(worldX: number, worldY: number, seed: number): OreEntry | null {
  let totalWeight = 0;
  const weights: number[] = [];
  for (const ore of ORE_CONFIG) {
    if (worldY < ore.minY || worldY > ore.maxY) {
      weights.push(0);
      continue;
    }
    const depthDelta = worldY - ore.idealY;
    const w = ore.abundance * Math.exp(-(depthDelta * depthDelta) / (2 * ore.spread * ore.spread));
    weights.push(w);
    totalWeight += w;
  }
  if (totalWeight === 0) return null;

  // Deterministic pick using the seed cell's hash
  const sgx = Math.floor(worldX / WORM_CONFIG.seedGrid);
  const sgy = Math.floor(worldY / WORM_CONFIG.seedGrid);
  const r = hash2(sgx, sgy, seed + 4242) * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < ORE_CONFIG.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) return ORE_CONFIG[i];
  }
  return ORE_CONFIG[ORE_CONFIG.length - 1];
}

/**
 * Deposit ore material in a small radius around a world coordinate, but only
 * into the chunk being generated (chunkCx, chunkCy). Only overwrites stone —
 * cavities (air), dirt, existing ores, and walls are preserved. The ore is
 * written to the FOREGROUND plane; the background stays as the host rock
 * (set to stone by the caller's base terrain pass).
 */
function depositOreAt(
  wx: number,
  wy: number,
  radius: number,
  blockId: number,
  chunk: Chunk,
  chunkCx: number,
  chunkCy: number,
): void {
  const chunkWorldX = chunkCx * CHUNK_W;
  const chunkWorldY = chunkCy * CHUNK_H;
  const lx = Math.floor(wx - chunkWorldX);
  const ly = Math.floor(wy - chunkWorldY);
  const r = Math.ceil(radius);
  const r2 = radius * radius;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = lx + dx;
      const y = ly + dy;
      if (x < 0 || x >= CHUNK_W || y < 0 || y >= CHUNK_H) continue;
      const idx = cellIndex(x, y);
      const existing = chunk.foreground[idx] & 0xFF;
      // Only overwrite stone (preserve caves/air, dirt, existing ores, walls,
      // and lava lakes which were carved in an earlier pass).
      if (existing !== BLOCK_STONE) continue;
      // Don't place ore on top of lava: skip if the cell directly below (within
      // this chunk) is lava. Lava lakes are carved before ore worms, so lava
      // cells are already present. (Cells at the bottom edge of the chunk
      // can't check the next chunk — acceptable rare edge case.)
      if (y + 1 < CHUNK_H) {
        const below = chunk.foreground[cellIndex(x, y + 1)] & 0xFF;
        if (below === BLOCK_LAVA) continue;
      }
      chunk.foreground[idx] = blockId; // ores are plain (untagged) block IDs
      chunk.dirty = true;
    }
  }
}

/**
 * Simulate a single Perlin worm from its spawn point. The worm walks in a
 * noise-perturbed direction, depositing ore at each step. Only deposits that
 * fall within the target chunk (chunkCx, chunkCy) are written.
 *
 * Early-exit: if the worm wanders outside the chunk neighborhood for too many
 * consecutive steps, it stops (optimization — the worm is unlikely to return).
 */
function simulateWorm(
  spawnX: number,
  spawnY: number,
  ore: OreEntry,
  seed: number,
  chunk: Chunk,
  chunkCx: number,
  chunkCy: number,
): void {
  // Initial direction: deterministic from spawn position + ore type
  const sgx = Math.floor(spawnX / WORM_CONFIG.seedGrid);
  const sgy = Math.floor(spawnY / WORM_CONFIG.seedGrid);
  let angle = hash2(sgx, sgy, seed + ore.id * 13) * Math.PI * 2;

  const maxSteps = ore.veinLength;
  const peakRadius = ore.veinRadius;
  const stepSize = WORM_CONFIG.stepSize;
  const turnRate = WORM_CONFIG.turnRate;
  const noiseScale = WORM_CONFIG.noiseScale;

  let x = spawnX;
  let y = spawnY;

  // Chunk bounds + margin for early-exit check. The margin uses peakRadius
  // (the widest the vein gets) so deposits near the edge aren't missed.
  const chunkWorldX = chunkCx * CHUNK_W;
  const chunkWorldY = chunkCy * CHUNK_H;
  const margin = peakRadius + stepSize * WORM_CONFIG.maxStepsOutside;
  const minX = chunkWorldX - margin;
  const maxX = chunkWorldX + CHUNK_W + margin;
  const minY = chunkWorldY - margin;
  const maxY = chunkWorldY + CHUNK_H + margin;

  let stepsOutside = 0;

  for (let step = 0; step < maxSteps; step++) {
    // --- Variable width: taper the ends + noise-driven bulges/pinches ---
    //
    // Taper envelope: smoothstep from 0→1 over the first 25% of steps, full
    // width through the middle, then 1→0 over the last 25%. This makes both
    // ends of the vein narrow to a point instead of ending abruptly (no more
    // "cut off" vein tips).
    const t = step / (maxSteps - 1);
    const taperT = Math.min(t / 0.25, (1 - t) / 0.25);
    const taper = smoothstepEdge(clamp01(taperT));

    // Width variation: low-frequency noise modulates the radius along the
    // vein's length so it bulges and pinches — not a uniform-width noodle.
    // The noise is sampled along the vein's path (not along world X/Y) so the
    // variation follows the vein, not the world grid. Scale 0.5-1.0 of peak.
    const widthNoise = fbm2D(step * 0.15, ore.id * 3.7, seed + ore.id * 2025, 2, 2.0, 0.5);
    const widthMod = 0.75 + widthNoise * 0.5; // ~0.75-1.25 range

    const radius = peakRadius * taper * widthMod;

    // Deposit ore at current position (skip if radius is too small to matter)
    if (radius > 0.3) {
      depositOreAt(x, y, radius, ore.id, chunk, chunkCx, chunkCy);
    }

    // Perturb direction using noise (veins curve and meander)
    const turnNoise = fbm2D(x * noiseScale, y * noiseScale, seed + ore.id * 101, 2, 2.0, 0.5);
    angle += (turnNoise - 0.5) * 2 * turnRate;

    // Move forward
    x += Math.cos(angle) * stepSize;
    y += Math.sin(angle) * stepSize;

    // Early exit if the worm has wandered far outside the chunk
    if (x < minX || x > maxX || y < minY || y > maxY) {
      stepsOutside++;
      if (stepsOutside > WORM_CONFIG.maxStepsOutside) break;
    } else {
      stepsOutside = 0;
    }
  }
}

/**
 * Generate all ore veins that intersect a chunk by simulating worms from seed
 * cells in a neighborhood. The neighborhood radius is determined by the
 * maximum worm travel distance, ensuring veins span chunk boundaries.
 *
 * Called after base terrain + caves, before lava lakes / oil pockets. Only
 * overwrites stone — cavities and dirt are preserved.
 */
function generateOreWorms(chunk: Chunk, seed: number): void {
  const cx = chunk.cx;
  const cy = chunk.cy;
  const chunkWorldX = cx * CHUNK_W;
  const chunkWorldY = cy * CHUNK_H;

  // Find the maximum vein length across all ores to determine neighborhood
  const maxVeinLen = ORE_CONFIG.reduce((m, o) => Math.max(m, o.veinLength), 0);
  const maxTravel = maxVeinLen * WORM_CONFIG.stepSize;
  const neighborhoodRadius = Math.ceil(maxTravel / WORM_CONFIG.seedGrid) + 1;

  // Find the seed grid origin closest to the chunk's top-left corner
  const sgOriginX = Math.floor(chunkWorldX / WORM_CONFIG.seedGrid);
  const sgOriginY = Math.floor(chunkWorldY / WORM_CONFIG.seedGrid);

  // Iterate seed cells in the neighborhood and simulate any worms that spawn
  for (let sgy = sgOriginY - neighborhoodRadius; sgy <= sgOriginY + neighborhoodRadius; sgy++) {
    for (let sgx = sgOriginX - neighborhoodRadius; sgx <= sgOriginX + neighborhoodRadius; sgx++) {
      // Deterministic spawn check
      if (hash2(sgx, sgy, seed + 7777) >= WORM_CONFIG.spawnChance) continue;

      // Worm spawn position (center of the seed cell)
      const spawnX = sgx * WORM_CONFIG.seedGrid + WORM_CONFIG.seedGrid * 0.5;
      const spawnY = sgy * WORM_CONFIG.seedGrid + WORM_CONFIG.seedGrid * 0.5;

      // Pick ore type by depth at spawn point
      const ore = pickOreByDepth(spawnX, spawnY, seed);
      if (!ore) continue;

      simulateWorm(spawnX, spawnY, ore, seed, chunk, cx, cy);
    }
  }
}

// ============================================================================
// Lava lakes (deep, scattered above the magma layer)
//
// In addition to the bottom magma layer (MAGMA_Y → WORLD_H-5), sparse
// lava-filled cavities are carved into the deep stone band just above the
// magma layer. These are blob-carved (noise-perturbed radius) and only
// overwrite stone — caves, ores, and dirt are preserved. Lake centers are
// detected per-cell via a deterministic hash + noise gate, and a
// neighborhood scan lets lakes span chunk boundaries seamlessly (same
// pattern as the ore-worm neighborhood).
// ============================================================================

const LAVA_LAKE = {
  minY: MAGMA_Y - 60, // worldY where lava lakes may start (deep only)
  maxY: MAGMA_Y - 5,  // worldY where lava lakes end (just above magma chamber)
  noiseThreshold: 0.74,
  noiseScale: 0.05,
  octaves: 4,
  minSize: 5, // minimum lake radius in cells
  maxSize: 14, // maximum lake radius in cells
  fillChance: 0.006, // probability of a lake center spawning per candidate cell
};

/** Returns true if (wx, wy) is the center of a lava lake. */
function lavaLakeCenterAt(wx: number, wy: number, seed: number): boolean {
  if (wy < LAVA_LAKE.minY || wy > LAVA_LAKE.maxY) return false;
  const noise = fbm2D(wx * LAVA_LAKE.noiseScale, wy * LAVA_LAKE.noiseScale, seed + 600, LAVA_LAKE.octaves, 2.0, 0.5);
  if (noise < LAVA_LAKE.noiseThreshold) return false;
  return hash2(wx, wy, seed + BLOCK_LAVA + 7777) < LAVA_LAKE.fillChance;
}

/**
 * Carve an irregular lava lake around a center point (in WORLD coords) into
 * the chunk being generated. The lake shape is anisotropic (stretched) and
 * noise-perturbed with strong multi-octave noise so it looks like an
 * organic, elongated blob rather than a round circle. Fills cells with
 * full-flow lava (overwriting stone/gravel/clay only). Depth-gated to
 * [minY, maxY] so lakes don't spill out of the deep band. Sets light=15 on
 * carved lava (matches the magma layer).
 */
function carveLavaLake(
  chunk: Chunk,
  chunkCx: number,
  chunkCy: number,
  centerWX: number,
  centerWY: number,
  radius: number,
  seed: number,
): void {
  const chunkWorldX = chunkCx * CHUNK_W;
  const chunkWorldY = chunkCy * CHUNK_H;
  const lcx = centerWX - chunkWorldX;
  const lcy = centerWY - chunkWorldY;

  // Anisotropic stretch: lakes are elongated along a deterministic angle,
  // giving them an organic puddle/lenticular shape instead of a circle.
  // stretchX > 1, stretchY < 1 → wider than tall (or vice versa).
  const stretchAngle = hash2(Math.floor(centerWX), Math.floor(centerWY), seed + BLOCK_LAVA * 7) * Math.PI;
  const cosA = Math.cos(stretchAngle);
  const sinA = Math.sin(stretchAngle);
  const stretchX = 1.0 + hash2(Math.floor(centerWX), Math.floor(centerWY), seed + BLOCK_LAVA * 11) * 0.6; // 1.0-1.6
  const stretchY = 1.0 / stretchX; // inverse → preserves approximate area

  // Bounding box accounts for the anisotropic stretch.
  const maxR = radius * Math.max(stretchX, stretchY) * 1.4; // 1.4 = noise margin
  const x0 = Math.max(0, Math.floor(lcx - maxR));
  const x1 = Math.min(CHUNK_W - 1, Math.floor(lcx + maxR));
  const y0 = Math.max(0, Math.floor(lcy - maxR));
  const y1 = Math.min(CHUNK_H - 1, Math.floor(lcy + maxR));

  const r2 = radius * radius;

  for (let y = y0; y <= y1; y++) {
    const cellWY = chunkWorldY + y;
    if (cellWY < LAVA_LAKE.minY || cellWY > LAVA_LAKE.maxY) continue;
    for (let x = x0; x <= x1; x++) {
      const dx = x - lcx;
      const dy = y - lcy;
      // Rotate into the lake's principal axes, then apply anisotropic stretch.
      const rx = (dx * cosA + dy * sinA) / stretchX;
      const ry = (-dx * sinA + dy * cosA) / stretchY;
      const dist2 = rx * rx + ry * ry;

      // Strong multi-octave noise perturbation → irregular, wavy boundary.
      // Two noise samples at different scales for coarse + fine detail.
      const worldX = chunkWorldX + x;
      const coarseNoise = fbm2D(worldX * 0.08, cellWY * 0.08, seed + BLOCK_LAVA * 31, 3, 2.0, 0.5);
      const fineNoise = valueNoise2D(worldX * 0.3, cellWY * 0.3, seed + BLOCK_LAVA * 37);
      // Combined perturbation: 0.5-1.5 range (very irregular boundary).
      const perturb = 0.5 + coarseNoise * 0.7 + fineNoise * 0.3;
      const effectiveR2 = r2 * perturb;

      if (dist2 <= effectiveR2) {
        const idx = cellIndex(x, y);
        const existing = chunk.foreground[idx] & 0xFF;
        // Carve into stone, gravel, and clay (lava replaces these soft
        // materials). Don't overwrite ores, caves/air, dirt, or walls.
        if (existing !== BLOCK_STONE && existing !== BLOCK_GRAVEL && existing !== BLOCK_CLAY) continue;
        chunk.foreground[idx] = setFlow(BLOCK_LAVA, 7);
        chunk.light[idx] = 15; // lava emits light (matches magma layer)
        chunk.dirty = true;
      }
    }
  }
}

/** Generate all lava lakes intersecting a chunk (neighborhood scan). */
function generateLavaLakes(chunk: Chunk, seed: number): void {
  const cx = chunk.cx;
  const cy = chunk.cy;
  const chunkWorldX = cx * CHUNK_W;
  const chunkWorldY = cy * CHUNK_H;
  const startWX = chunkWorldX - LAVA_LAKE.maxSize;
  const endWX = chunkWorldX + CHUNK_W + LAVA_LAKE.maxSize;
  const startWY = Math.max(LAVA_LAKE.minY, chunkWorldY - LAVA_LAKE.maxSize);
  const endWY = Math.min(LAVA_LAKE.maxY, chunkWorldY + CHUNK_H + LAVA_LAKE.maxSize);
  for (let wy = startWY; wy < endWY; wy++) {
    for (let wx = startWX; wx < endWX; wx++) {
      if (!lavaLakeCenterAt(wx, wy, seed)) continue;
      // Deterministic radius from the center's world coords
      const sizeHash = hash2(wx, wy, seed + BLOCK_LAVA + 9999);
      const radius = LAVA_LAKE.minSize + sizeHash * (LAVA_LAKE.maxSize - LAVA_LAKE.minSize);
      carveLavaLake(chunk, cx, cy, wx, wy, Math.floor(radius), seed);
    }
  }
}

// ============================================================================
// Oil pockets (rare, mid-deep, glossy-black emissive marker)
//
// Small carved pockets of BLOCK_OIL_POCKET at mid-deep depth. Rare (low
// fillChance) so they're a discovery. The block has a dark amber emissive
// glow (lightEmit 4) so it stands out in dark caves — a clear visual
// indicator. The special oil-pocket mechanic is TBD (intentionally just a
// rare marker + generous oil drop for now). Only overwrites stone; chunk-
// spanning via neighborhood scan.
// ============================================================================

const OIL_POCKET = {
  minY: 820, // worldY where oil pockets may start (mid-deep)
  maxY: 980, // worldY where oil pockets end
  fillChance: 0.000035, // very rare (neighborhood scan amplifies candidates)
  minSize: 2, // small pocket
  maxSize: 4,
};

/** Returns true if (wx, wy) is the center of an oil pocket. */
function oilPocketCenterAt(wx: number, wy: number, seed: number): boolean {
  if (wy < OIL_POCKET.minY || wy > OIL_POCKET.maxY) return false;
  return hash2(wx, wy, seed + BLOCK_OIL_POCKET + 9999) < OIL_POCKET.fillChance;
}

/**
 * Carve a small oil-pocket blob around a center point (in WORLD coords).
 * Writes BLOCK_OIL_POCKET only where the foreground is stone. Bumps the cell
 * light up to at least 4 so the emissive sheen reads in dark caves.
 */
function carveOilPocket(
  chunk: Chunk,
  chunkCx: number,
  chunkCy: number,
  centerWX: number,
  centerWY: number,
  radius: number,
  seed: number,
): void {
  const r2 = radius * radius;
  const chunkWorldX = chunkCx * CHUNK_W;
  const chunkWorldY = chunkCy * CHUNK_H;
  const lcx = centerWX - chunkWorldX;
  const lcy = centerWY - chunkWorldY;
  const x0 = Math.max(0, Math.floor(lcx - radius));
  const x1 = Math.min(CHUNK_W - 1, Math.floor(lcx + radius));
  const y0 = Math.max(0, Math.floor(lcy - radius));
  const y1 = Math.min(CHUNK_H - 1, Math.floor(lcy + radius));

  for (let y = y0; y <= y1; y++) {
    const cellWY = chunkWorldY + y;
    if (cellWY < OIL_POCKET.minY || cellWY > OIL_POCKET.maxY) continue;
    for (let x = x0; x <= x1; x++) {
      const dx = x - lcx;
      const dy = y - lcy;
      const distNoise = valueNoise2D((chunkWorldX + x) * 0.15, cellWY * 0.15, seed + BLOCK_OIL_POCKET * 31);
      const effectiveR2 = r2 * (0.7 + distNoise * 0.6);
      if (dx * dx + dy * dy <= effectiveR2) {
        const idx = cellIndex(x, y);
        const existing = chunk.foreground[idx] & 0xFF;
        if (existing !== BLOCK_STONE) continue;
        chunk.foreground[idx] = BLOCK_OIL_POCKET;
        // Emissive sheen: ensure the cell's light is at least the pocket's
        // lightEmit so it glows in otherwise-dark caves.
        if (chunk.light[idx] < 4) chunk.light[idx] = 4;
        chunk.dirty = true;
      }
    }
  }
}

/** Generate all oil pockets intersecting a chunk (neighborhood scan). */
function generateOilPockets(chunk: Chunk, seed: number): void {
  const cx = chunk.cx;
  const cy = chunk.cy;
  const chunkWorldX = cx * CHUNK_W;
  const chunkWorldY = cy * CHUNK_H;
  const startWX = chunkWorldX - OIL_POCKET.maxSize;
  const endWX = chunkWorldX + CHUNK_W + OIL_POCKET.maxSize;
  const startWY = Math.max(OIL_POCKET.minY, chunkWorldY - OIL_POCKET.maxSize);
  const endWY = Math.min(OIL_POCKET.maxY, chunkWorldY + CHUNK_H + OIL_POCKET.maxSize);
  for (let wy = startWY; wy < endWY; wy++) {
    for (let wx = startWX; wx < endWX; wx++) {
      if (!oilPocketCenterAt(wx, wy, seed)) continue;
      const sizeHash = hash2(wx, wy, seed + BLOCK_OIL_POCKET + 1234);
      const radius = OIL_POCKET.minSize + sizeHash * (OIL_POCKET.maxSize - OIL_POCKET.minSize);
      carveOilPocket(chunk, cx, cy, wx, wy, Math.ceil(radius), seed);
    }
  }
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

// --- Surface block selection (continuous blending) ---
//
// The old version used hard switch(biome) which produced sharp edges: the
// surface block flipped instantly from grass to sand at the exact biome
// threshold, even though the surface height was smoothly interpolated. This
// version uses the continuous elevation + aridity values to blend block
// types smoothly across biome boundaries.
//
// Block selection logic (all blended, no hard switches):
//   - Deep ocean (very low elevation) → stone
//   - Shore / shallow ocean → sand
//   - Beach (near sea level, any land biome) → sand (with sand subsurface)
//   - Plains (mid elevation, low aridity) → grass
//   - Desert (mid elevation, high aridity) → sand
//   - Mountain (high elevation) → grass, transitioning to stone at peaks
//
// The beach zone uses a WIDE smooth band around sea level so the transition
// from grass to sand is gradual, and the subsurface matches (sand under
// sand) — fixing the "1 sand on several dirt" issue where a single surface
// sand block sat on dirt columns.

// Beach blend: sand appears within ±8 blocks of sea level, blending smoothly.
// This is wider than the old ±3 hard band, and uses smoothstep so the
// transition is gradual (no single-column sand flips).
const BEACH_RANGE = 8;

function surfaceBlockFor(info: BiomeInfo): number {
  const { elevation, aridity, surfaceY } = info;

  // --- Ocean: stone (deep) → sand (shore) ---
  if (elevation < OCEAN_THRESHOLD) {
    // Deep ocean → stone, shallow ocean → sand. Blend by depth.
    const depthT = smoothstepEdge(clamp01(elevation / OCEAN_THRESHOLD));
    // t=0 (deepest) → stone, t=1 (shore) → sand
    return depthT > 0.4 ? BLOCK_SAND : BLOCK_STONE;
  }

  // --- Land: determine the "ideal" surface block, then apply beach blend ---

  // Desert blend: 0 (grass/dirt) → 1 (sand). Smooth transition by aridity
  // across the desert threshold, so plains→desert is gradual.
  const desertBlend = smoothstepEdge(clamp01((aridity - DESERT_THRESHOLD + 0.04) / 0.08));

  // Mountain stone blend: 0 (grass) → 1 (stone). High elevation mountains
  // transition from grass to bare stone at peaks.
  let mountainStone = 0;
  if (elevation > MOUNTAIN_THRESHOLD) {
    mountainStone = smoothstepEdge(clamp01((elevation - MOUNTAIN_THRESHOLD - 0.15) / 0.15));
  }

  // Ideal land surface: grass by default, sand if desert-blended, stone if
  // high mountain. Desert sand takes priority over mountain stone (deserts
  // don't have stone peaks). Pick the dominant one.
  let landBlock: number;
  if (desertBlend > 0.5) {
    landBlock = BLOCK_SAND;
  } else if (mountainStone > 0.5) {
    landBlock = BLOCK_STONE;
  } else {
    landBlock = BLOCK_GRASS;
  }

  // --- Beach blend: near sea level, blend toward sand ---
  // This creates gradual sandy beaches around oceans/lakes. The blend is
  // smooth so there's no single-column sand flip. The beach zone is wider
  // than the old ±3 hard band (±8 with smoothstep).
  const beachDist = Math.abs(surfaceY - SEA_LEVEL);
  if (beachDist < BEACH_RANGE) {
    const beachT = smoothstepEdge(clamp01(1 - beachDist / BEACH_RANGE));
    if (beachT > 0.5) return BLOCK_SAND;
    // Partial blend: if beach is strong, use sand; otherwise keep land block.
    // The threshold at 0.5 with smoothstep gives a ~4-block transition zone.
  }

  return landBlock;
}

// --- Subsurface block selection (continuous blending) ---
// Returns the block below the surface. Matches the surface block type:
// sand surface → sand subsurface (fixes "1 sand on dirt"), grass/stone
// surface → dirt subsurface. Blended across biome boundaries.
function subsurfaceBlockFor(info: BiomeInfo): number {
  const { elevation, aridity, surfaceY } = info;

  // Ocean: sand subsurface (matches shore sand, and sand under shallow water)
  if (elevation < OCEAN_THRESHOLD) return BLOCK_SAND;

  // Desert blend: sand subsurface in desert, dirt in plains
  const desertBlend = smoothstepEdge(clamp01((aridity - DESERT_THRESHOLD + 0.04) / 0.08));

  // Beach: sand subsurface near sea level (so beach sand doesn't sit on dirt)
  const beachDist = Math.abs(surfaceY - SEA_LEVEL);
  const beachT = beachDist < BEACH_RANGE
    ? smoothstepEdge(clamp01(1 - beachDist / BEACH_RANGE))
    : 0;

  // Sand if desert-blended or beach-blended; otherwise dirt
  if (desertBlend > 0.5 || beachT > 0.5) return BLOCK_SAND;
  return BLOCK_DIRT;
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
        // Surface block: continuously blended by elevation/aridity/sea-level
        foreground = surfaceBlockFor(info);
        background = foreground;
      } else if (wy < surfaceY + info.dirtDepth) {
        // Subsurface layer (dirt or sand, blended to match surface)
        const subBlock = subsurfaceBlockFor(info);
        foreground = subBlock;
        background = subBlock;
      } else if (wy < MAGMA_Y - 5) {
        // Stone layer (caves carved here; ores/lava-lakes/oil-pockets added
        // in dedicated passes after the main loop). Occasional gravel/clay
        // pockets are placed inline; everything else is plain stone that the
        // later passes overwrite.
        if (isCave(wx, wy, seed, surfaceY)) {
          // Cave: air — foreground only. Water enters caves via the fluid
          // sim (from oceans/surface water), not during generation. Isolated
          // caves stay dry; caves connected to oceans fill naturally over time.
          // Background behind caves: stone (cave wall in layers 3 & 4)
          background = BLOCK_STONE;
        } else {
          // Occasional gravel/clay pockets (rare — 5x rarer than before).
          // These are placed inline as part of the base stone layer. Lava
          // lakes (carved in a later pass) will overwrite them if they
          // overlap, so gravel/clay never ends up inside lava.
          if (valueNoise2D(wx * 0.1, wy * 0.1, seed + 700) > 0.96) {
            foreground = BLOCK_GRAVEL;
            background = BLOCK_GRAVEL;
          } else if (valueNoise2D(wx * 0.15, wy * 0.15, seed + 800) > 0.97) {
            foreground = BLOCK_CLAY;
            background = BLOCK_CLAY;
          } else {
            foreground = BLOCK_STONE;
            background = BLOCK_STONE;
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

  // --- Post-passes (run after the base per-cell loop so they overwrite stone) ---
  // Order: caves are already carved inline above. Now carve lava lakes FIRST,
  // then ore worms, then oil pockets. Lava lakes before ore worms is important:
  // depositOreAt only overwrites stone, so ore won't be deposited on top of
  // lava (lava cells are no longer stone by the time worms run). Each pass
  // only overwrites stone, so the ordering preserves caves (air) and earlier
  // features. All three use world-coordinate noise/hashes + neighborhood scans
  // so features span chunk boundaries seamlessly.
  generateLavaLakes(chunk, seed);
  generateOreWorms(chunk, seed);
  generateOilPockets(chunk, seed);

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
