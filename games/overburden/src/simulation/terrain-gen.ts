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
    BLOCK_LAVA, BLOCK_LEAVES, BLOCK_SAND,
    BLOCK_STONE,
    BLOCK_TIME_CRYSTAL,
    BLOCK_TIN_ORE,
    BLOCK_WATER, BLOCK_WOOD,
    CHUNK_H,
    CHUNK_W,
    MAGMA_Y, SEA_LEVEL, SURFACE_Y, WORLD_W
} from "../shared/constants";
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
// Simple trees on the surface. Returns true if a tree trunk starts here.
function treeAt(wx: number, wy: number, seed: number): boolean {
  if (wy < SURFACE_Y - 20 || wy > SURFACE_Y + 20) return false;
  return hash2(wx, wy, seed + 999) < 0.05; // 5% chance for more trees
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
      } else if (wy === surfaceY) {
        // Surface block: grass (or sand near water)
        if (surfaceY >= SEA_LEVEL - 3 && surfaceY <= SEA_LEVEL + 3) {
          // Near sea level: sand beaches
          foreground = BLOCK_SAND;
          background = BLOCK_SAND;
        } else {
          foreground = BLOCK_GRASS;
          background = BLOCK_DIRT; // backwall behind surface
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
        } else {
          const ore = oreAt(wx, wy, seed);
          if (ore !== 0) {
            foreground = ore;
          } else {
            // Occasional gravel pockets
            if (valueNoise2D(wx * 0.1, wy * 0.1, seed + 700) > 0.8) {
              foreground = BLOCK_GRAVEL;
            } else if (valueNoise2D(wx * 0.15, wy * 0.15, seed + 800) > 0.85) {
              foreground = BLOCK_CLAY;
            } else {
              foreground = BLOCK_STONE;
            }
          }
        }
        background = BLOCK_STONE;
      } else if (wy < MAGMA_Y) {
        // Deep stone (near magma)
        foreground = BLOCK_STONE;
        background = BLOCK_STONE;
      } else if (wy < WORLD_W - 5) {
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
  // Plant trees on the surface after the base terrain is generated.
  for (let ly = 0; ly < CHUNK_H; ly++) {
    for (let lx = 0; lx < CHUNK_W; lx++) {
      const wx = baseWx + lx;
      const wy = baseWy + ly;
      const idx = cellIndex(lx, ly);

      if (chunk.foreground[idx] !== BLOCK_GRASS) continue;
      if (!treeAt(wx, wy, seed)) continue;

      // Plant a tree: trunk (wood) + canopy (leaves)
      const trunkHeight = 4 + Math.floor(hash2(wx, wy, seed + 111) * 4); // 4-7 blocks
      for (let h = 1; h <= trunkHeight; h++) {
        const treeY = ly - h;
        if (treeY < 0) break; // tree goes into chunk above (skip for now)
        const treeIdx = cellIndex(lx, treeY);
        if (chunk.foreground[treeIdx] === BLOCK_AIR) {
          chunk.foreground[treeIdx] = BLOCK_WOOD;
        }
      }
      // Canopy: leaves in a 3×3 blob on top
      const canopyY = ly - trunkHeight - 1;
      for (let dy = 0; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const lx2 = lx + dx;
          const ly2 = canopyY + dy;
          if (lx2 < 0 || lx2 >= CHUNK_W || ly2 < 0 || ly2 >= CHUNK_H) continue;
          const leafIdx = cellIndex(lx2, ly2);
          if (chunk.foreground[leafIdx] === BLOCK_AIR) {
            chunk.foreground[leafIdx] = BLOCK_LEAVES;
          }
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
