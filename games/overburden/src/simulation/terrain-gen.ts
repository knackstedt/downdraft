// ============================================================================
// Overburden — terrain generation
//
// Generates the 6-plane chunk data for a chunk:
// - Surface: grass + dirt + stone layers with rolling hills
// - Underground: stone with ore veins (Perlin worms) and caves (noise threshold)
// - Water: fills up to sea level
// - Lava: at the bottom of the world
// - Bedrock: immovable layer at the very bottom
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
    MAGMA_Y, SEA_LEVEL, SURFACE_Y, WORLD_H
} from "../shared/constants";
import { WILD_CROPS } from "../shared/crops";
import {
    isTreeBlock, makeTaggedBlock,
    pickTreeSpecies, pickVineSpecies, VINE_SPECIES,
} from "../shared/tree-species";
import type { Chunk } from "../shared/types";
import { cellIndex } from "./chunk";
import { setFlow } from "./fluid-sim";

// --- Surface height ---
// fBm noise for rolling hills. Returns world Y of the surface at world X.
function surfaceHeightAt(wx: number, seed: number): number {
  const noise = fbm2D(wx * 0.005, 0, seed, 4, 2.0, 0.5);
  return SURFACE_Y + Math.floor(noise * 60 - 30);
}

// --- Dirt depth ---
function dirtDepthAt(wx: number, seed: number): number {
  const noise = fbm2D(wx * 0.02, 100, seed, 2, 2.0, 0.5);
  return 4 + Math.floor(noise * 6); // 4-10 blocks
}

// --- Cave generation ---
// fBm noise threshold check. Returns true if this cell is a cave.
function isCave(wx: number, wy: number, seed: number): boolean {
  if (wy < SURFACE_Y + 20) return false; // no caves near surface
  const noise = fbm2D(wx * 0.03, wy * 0.03, seed + 500, 4, 2.0, 0.5);
  return noise > 0.72;
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
// Returns true if a tree trunk starts at this surface cell. 5% chance,
// only near the surface band. Species is picked separately (deterministic
// per cell via hash2) so each tree gets one of the 13 species.
function treeAt(wx: number, wy: number, seed: number): boolean {
  if (wy < SURFACE_Y - 20 || wy > SURFACE_Y + 20) return false;
  return hash2(wx, wy, seed + 999) < 0.05; // 5% chance for more trees
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

// --- Main generation ---
export function generateChunk(chunk: Chunk, seed: number): void {
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

      const surfaceY = surfaceHeightAt(wx, seed);

      if (wy < surfaceY) {
        // Above surface: air (or water if below sea level)
        if (wy > SEA_LEVEL) {
          foreground = setFlow(BLOCK_WATER, 7); // full water
        }
        // Background matches foreground above surface (air/water)
        // so the back wall doesn't fill the sky.
      } else if (wy === surfaceY) {
        // Surface block: grass (or sand near water)
        if (surfaceY >= SEA_LEVEL - 3 && surfaceY <= SEA_LEVEL + 3) {
          // Near sea level: sand beaches
          foreground = BLOCK_SAND;
          background = BLOCK_SAND;
        } else {
          foreground = BLOCK_GRASS;
          background = BLOCK_GRASS; // background matches foreground
        }
      } else if (wy < surfaceY + dirtDepthAt(wx, seed)) {
        // Dirt layer
        foreground = BLOCK_DIRT;
        background = BLOCK_DIRT;
      } else if (wy < MAGMA_Y - 5) {
        // Stone layer (with ores + caves)
        if (isCave(wx, wy, seed)) {
          // Cave: air (or water if below sea level)
          if (wy > SEA_LEVEL) {
            foreground = setFlow(BLOCK_WATER, 7);
          }
          // Background behind caves: stone (so you see the cave wall behind)
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

  // --- Trees ---
  // Plant trees on the surface in the BACKGROUND layer (layer 3).
  // Trees are behind the player (layer 2) but in front of the back wall (layer 4).
  // Each tree is one of 13 species, each with its own wood + leaf block IDs and
  // a distinct canopy shape. Vines (kiwi, grape) may spawn at a tree's base and
  // climb up the trunk in adjacent empty background cells.
  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);

      // Trees grow on grass in the foreground (the surface block)
      if (chunk.foreground[idx] !== BLOCK_GRASS) continue;
      if (!treeAt(wx, wy, seed)) continue;

      // Pick a species deterministically for this cell.
      const species = pickTreeSpecies(hash2(wx, wy, seed + 333));
      const trunkHeight = species.trunkMin +
        Math.floor(hash2(wx, wy, seed + 111) * (species.trunkMax - species.trunkMin + 1));

      // Per-tree group tag: stored in the upper 8 bits of the background
      // Uint16 so fellTree flood-fill stays within this tree only. Derived
      // from the trunk base world coords; never 0 (0 = untagged/old save).
      // Two adjacent trees always have different wx (≥1 apart), and the
      // hash mixes wx + wy so even same-X-different-Y trees differ. Trees
      // 256 blocks apart could collide, but their canopies can't touch.
      let treeTag = (Math.imul(wx, 31) + Math.imul(wy, 17)) & 0xFF;
      if (treeTag === 0) treeTag = 1;

      // Trunk: wood blocks growing upward in the background plane.
      let trunkTopLy = ly;
      for (let h = 1; h <= trunkHeight; h++) {
        const treeY = ly - h;
        if (treeY < 0) break; // tree goes into chunk above (skip for now)
        const treeIdx = cellIndex(lx, treeY);
        if (chunk.background[treeIdx] === BLOCK_AIR) {
          chunk.background[treeIdx] = makeTaggedBlock(species.woodBlock, treeTag);
          trunkTopLy = treeY;
        }
      }

      // Canopy: species-specific shape (places leaves into empty bg cells).
      species.placeCanopy(chunk, lx, ly, trunkTopLy, trunkHeight, species.leafBlock, treeTag);

      // Maybe spawn a vine at the base that climbs up the trunk.
      const vineBlock = vineAtBase(wx, wy, seed);
      if (vineBlock !== 0) {
        const vineSp = VINE_SPECIES.find((v) => v.block === vineBlock)!;
        // Climb in the background plane, in the empty cell to one side of the
        // trunk (alternate sides per height so the vine hugs the trunk).
        const side = hash2(wx, wy, seed + 555) < 0.5 ? -1 : 1;
        for (let h = 1; h <= vineSp.maxHeight; h++) {
          const vy = ly - h;
          if (vy < 0) break;
          // Alternate the side so the vine weaves up the trunk.
          const vx = lx + (h % 2 === 0 ? side : -side);
          if (vx < 0 || vx >= CHUNK_W) continue;
          const vIdx = cellIndex(vx, vy);
          // Only grow into empty background cells that are adjacent to the
          // trunk (the tree's wood) — i.e. the vine is climbing the tree.
          const trunkIdx = cellIndex(lx, vy);
          if (chunk.background[vIdx] === BLOCK_AIR &&
              isTreeBlock(chunk.background[trunkIdx])) {
            chunk.background[vIdx] = makeTaggedBlock(vineBlock, treeTag);
          } else if (chunk.background[vIdx] === BLOCK_AIR) {
            // Trunk ended above — stop climbing (no more support).
            break;
          }
        }
      }
    }
  }

  // Wild crops (berry bushes, wild mushrooms) spawn on grass cells above
  // the surface. Each wild crop type has a spawn chance per grass cell.
  // Wild mushrooms spawn in darker areas (caves, under trees); berry bushes
  // spawn in open grass. They're single mature blocks that regrow after harvest.
  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);
      // Wild crops only grow on grass in the foreground, with air above.
      if (chunk.foreground[idx] !== BLOCK_GRASS) continue;
      const aboveIdx = ly > 0 ? cellIndex(lx, ly - 1) : -1;
      if (aboveIdx >= 0 && (chunk.foreground[aboveIdx] & 0xFF) !== BLOCK_AIR) continue;
      // Don't spawn on top of a tree trunk (background has wood at this cell).
      if (isTreeBlock(chunk.background[idx])) continue;

      for (const wc of WILD_CROPS) {
        const roll = hash2(wx, wy, seed + 999 + wc.blockId);
        if (roll < wc.spawnChance) {
          // Place the wild crop in the foreground, one block above the grass.
          if (aboveIdx >= 0) {
            chunk.foreground[aboveIdx] = wc.blockId;
          }
          break; // only one wild crop per cell
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
