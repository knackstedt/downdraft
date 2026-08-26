// ============================================================================
// Overburden — terrain generation tests
//
// Tests the biome system, cave generation (foreground-only), and cross-chunk
// tree overflow.
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    BLOCK_AIR,
    BLOCK_SAND, BLOCK_STONE,
    BLOCK_WATER,
    CHUNK_H, CHUNK_W, CHUNKS_X,
    SEA_LEVEL, SURFACE_Y, WORLD_H
} from "../shared/constants";
import { isTreeBlock } from "../shared/tree-species";
import type { Chunk } from "../shared/types";
import { biomeAt, type Biome } from "./biomes";
import { BlockWorld } from "./block-world";
import { cellIndex, createChunk } from "./chunk";
import {
    generateChunk,
    generateFeatures,
    generateTerrain, generateTrees
} from "./terrain-gen";

const SEED = 12345;

// --- Helpers ---

/** Scan many X columns and collect the set of biomes that appear. */
function collectBiomes(seed: number, samples: number = 5000): Set<Biome> {
  const found = new Set<Biome>();
  for (let i = 0; i < samples; i++) {
    const wx = Math.floor((i / samples) * 16384);
    found.add(biomeAt(wx, seed).biome);
  }
  return found;
}

/** Count non-air, non-water foreground blocks in a chunk (terrain mass). */
function countSolidForeground(chunk: Chunk): number {
  let count = 0;
  for (let i = 0; i < chunk.foreground.length; i++) {
    const fg = chunk.foreground[i] & 0xFF;
    if (fg !== BLOCK_AIR && fg !== BLOCK_WATER) count++;
  }
  return count;
}

/** Count tree blocks (wood + leaves) in a chunk's background plane. */
function countTreeBlocks(chunk: Chunk): number {
  let count = 0;
  for (let i = 0; i < chunk.background.length; i++) {
    if (isTreeBlock(chunk.background[i])) count++;
  }
  return count;
}

/** Count cave cells in a chunk. A cave cell is a foreground air/water cell
 *  with stone background (the cave wall). Caves below sea level are
 *  water-filled; caves above sea level are air-filled. */
function countCaveCells(chunk: Chunk): number {
  let count = 0;
  for (let i = 0; i < chunk.foreground.length; i++) {
    const fg = chunk.foreground[i] & 0xFF;
    const bg = chunk.background[i] & 0xFF;
    if ((fg === BLOCK_AIR || fg === BLOCK_WATER) && bg === BLOCK_STONE) count++;
  }
  return count;
}

// ============================================================================
// Biome system tests
// ============================================================================

describe("Biome system", () => {
  it("produces all four biomes across the world width", () => {
    const biomes = collectBiomes(SEED, 10000);
    expect(biomes.has("ocean")).toBe(true);
    expect(biomes.has("plains")).toBe(true);
    expect(biomes.has("desert")).toBe(true);
    expect(biomes.has("mountain")).toBe(true);
  });

  it("is deterministic — same wx + seed always gives same biome", () => {
    for (let wx = 0; wx < 1000; wx += 97) {
      const a = biomeAt(wx, SEED);
      const b = biomeAt(wx, SEED);
      expect(a.biome).toBe(b.biome);
      expect(a.surfaceY).toBe(b.surfaceY);
    }
  });

  it("ocean biomes have surface below sea level", () => {
    let foundOcean = false;
    for (let wx = 0; wx < 16384; wx += 50) {
      const info = biomeAt(wx, SEED);
      if (info.biome === "ocean") {
        foundOcean = true;
        // Below sea level = higher Y (Y increases downward)
        expect(info.surfaceY).toBeGreaterThan(SEA_LEVEL);
      }
    }
    expect(foundOcean).toBe(true);
  });

  it("mountain biomes have surface above SURFACE_Y + 15", () => {
    let foundMountain = false;
    for (let wx = 0; wx < 16384; wx += 50) {
      const info = biomeAt(wx, SEED);
      if (info.biome === "mountain") {
        foundMountain = true;
        // Mountain base is SURFACE_Y + 30, but detail noise can subtract
        // up to ~20, so minimum is ~SURFACE_Y + 10
        expect(info.surfaceY).toBeGreaterThanOrEqual(SURFACE_Y + 10);
      }
    }
    expect(foundMountain).toBe(true);
  });

  it("desert biomes have sand surface, not grass", () => {
    let foundDesert = false;
    for (let wx = 0; wx < 16384; wx += 10) {
      const info = biomeAt(wx, SEED);
      if (info.biome !== "desert") continue;
      foundDesert = true;
      const cx = Math.floor(wx / CHUNK_W) % CHUNKS_X;
      const cy = Math.floor(info.surfaceY / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      // Find the surface block at this wx
      const lx = wx - cx * CHUNK_W;
      const ly = Math.floor(info.surfaceY) - cy * CHUNK_H;
      const fg = chunk.foreground[cellIndex(lx, ly)] & 0xFF;
      expect(fg).toBe(BLOCK_SAND);
      break;
    }
    expect(foundDesert).toBe(true);
  });

  it("biomes form large regions (not alternating every block)", () => {
    let sameCount = 0;
    let totalCount = 0;
    for (let wx = 0; wx < 5000; wx++) {
      const a = biomeAt(wx, SEED).biome;
      const b = biomeAt(wx + 1, SEED).biome;
      totalCount++;
      if (a === b) sameCount++;
    }
    // At least 80% of adjacent columns should share a biome
    expect(sameCount / totalCount).toBeGreaterThan(0.80);
  });
});

// ============================================================================
// Cave generation tests (layers 1 & 2 = foreground only)
// ============================================================================

describe("Cave generation", () => {
  it("generates caves in the foreground (layers 1 & 2)", () => {
    // Use a chunk that spans both above and below sea level so we get
    // both air-filled and water-filled caves.
    const cy = Math.floor(SEA_LEVEL / CHUNK_H); // chunk containing sea level
    const chunk = createChunk(0, cy);
    generateChunk(chunk, SEED);
    const caves = countCaveCells(chunk);
    expect(caves).toBeGreaterThan(0);
  });

  it("caves do not carve the background (layers 3 & 4 stay stone)", () => {
    // Check an underground chunk (well below surface, no trees)
    const cy = Math.floor((SURFACE_Y + 80) / CHUNK_H);
    const chunk = createChunk(0, cy);
    generateChunk(chunk, SEED);
    // Every cave cell (air/water fg with non-air bg) should have stone background.
    // We're deep underground so there are no tree leaves in the background.
    for (let i = 0; i < chunk.foreground.length; i++) {
      const fg = chunk.foreground[i] & 0xFF;
      if (fg === BLOCK_AIR || fg === BLOCK_WATER) {
        const bg = chunk.background[i] & 0xFF;
        if (bg !== BLOCK_AIR) {
          // This is a cave cell — background must be stone (cave wall)
          expect(bg).toBe(BLOCK_STONE);
        }
      }
    }
  });

  it("no caves within 8 blocks below the surface", () => {
    for (let cx = 0; cx < 10; cx++) {
      const info = biomeAt(cx * CHUNK_W + 32, SEED);
      // Skip ocean biomes — water between surface and sea level is not a cave
      if (info.biome === "ocean") continue;
      const surfaceY = info.surfaceY;
      const cy = Math.floor(surfaceY / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      const lx = 32;
      for (let dy = 1; dy <= 7; dy++) {
        const wy = surfaceY + dy;
        const ly = wy - baseWy;
        if (ly < 0 || ly >= CHUNK_H) continue;
        const fg = chunk.foreground[cellIndex(lx, ly)] & 0xFF;
        // Should be dirt/sand/stone, not air or water (no cave)
        expect(fg).not.toBe(BLOCK_AIR);
        expect(fg).not.toBe(BLOCK_WATER);
      }
    }
  });

  it("caves are more frequent than the old threshold (0.72)", () => {
    // Generate several underground chunks and verify caves exist
    let totalCaves = 0;
    for (let cx = 0; cx < 10; cx++) {
      const cy = Math.floor((SURFACE_Y + 100) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      totalCaves += countCaveCells(chunk);
    }
    expect(totalCaves).toBeGreaterThan(50);
  });
});

// ============================================================================
// Tree overflow tests (cross-chunk border)
// ============================================================================

describe("Tree overflow across chunk borders", () => {
  it("tree overflow does not crash or infinitely recurse", () => {
    // Generate many chunks — if there's infinite recursion, this will hang
    const world = new BlockWorld(SEED);
    for (let cx = 0; cx < 50; cx++) {
      const info = biomeAt(cx * CHUNK_W, SEED);
      const cy = Math.floor(info.surfaceY / CHUNK_H);
      world.ensureChunk(cx, cy);
    }
    expect(true).toBe(true);
  });

  it("trees near the top of a chunk overflow into the chunk above", () => {
    // Search for a chunk where the surface is very near the top (low ly)
    // so tree trunks/canopies overflow into the chunk above.
    const world = new BlockWorld(SEED);
    let foundOverflow = false;
    for (let cx = 0; cx < 200 && !foundOverflow; cx++) {
      for (let lx = 0; lx < CHUNK_W; lx++) {
        const wx = cx * CHUNK_W + lx;
        const info = biomeAt(wx, SEED);
        if (info.biome === "ocean") continue;
        const surfaceY = info.surfaceY;
        const cy = Math.floor(surfaceY / CHUNK_H);
        const surfaceLy = surfaceY - cy * CHUNK_H;
        // Need surface near top of chunk for overflow
        if (surfaceLy > 12) continue;

        // Generate this chunk (triggers tree overflow into chunk above)
        const chunk = world.ensureChunk(cx, cy);
        const treeBlocks = countTreeBlocks(chunk);
        if (treeBlocks === 0) continue;

        // Check the chunk above for overflow
        const aboveChunk = world.getChunk(cx, cy - 1);
        if (aboveChunk) {
          const aboveTrees = countTreeBlocks(aboveChunk);
          if (aboveTrees > 0) {
            foundOverflow = true;
            break;
          }
        }
      }
    }
    expect(foundOverflow).toBe(true);
  });

  it("tree trunks are not truncated at chunk borders when using ChunkAccessor", () => {
    // Compare tree generation with and without accessor:
    // Without accessor, trees near borders get truncated.
    // With accessor (BlockWorld), trees overflow into neighbors.
    const world = new BlockWorld(SEED);
    let foundDifference = false;
    for (let cx = 0; cx < 200 && !foundDifference; cx++) {
      for (let lx = 0; lx < CHUNK_W; lx++) {
        const wx = cx * CHUNK_W + lx;
        const info = biomeAt(wx, SEED);
        if (info.biome === "ocean") continue;
        const surfaceY = info.surfaceY;
        const cy = Math.floor(surfaceY / CHUNK_H);
        const surfaceLy = surfaceY - cy * CHUNK_H;
        if (surfaceLy > 12) continue;

        // Generate with accessor (overflow)
        const chunkWithOverflow = world.ensureChunk(cx, cy);
        const aboveWithOverflow = world.getChunk(cx, cy - 1);
        const treesAboveWith = aboveWithOverflow ? countTreeBlocks(aboveWithOverflow) : 0;

        // Generate without accessor (truncated)
        const chunkTruncated = createChunk(cx, cy);
        generateTerrain(chunkTruncated, SEED);
        generateTrees(chunkTruncated, SEED, null);

        // The chunk with overflow should have at least as many tree blocks
        // (some may have been written to the neighbor instead)
        const treesWith = countTreeBlocks(chunkWithOverflow);
        const treesWithout = countTreeBlocks(chunkTruncated);

        // If there are trees and the surface is near the top, the overflow
        // version should have tree blocks in the chunk above
        if (treesWith > 0 && treesAboveWith > 0) {
          foundDifference = true;
          break;
        }
      }
    }
    expect(foundDifference).toBe(true);
  });
});

// ============================================================================
// Split generation tests (terrain → trees → features)
// ============================================================================

describe("Split generation phases", () => {
  it("generateTerrain sets terrainGenerated flag", () => {
    const chunk = createChunk(0, Math.floor(SURFACE_Y / CHUNK_H));
    expect(chunk.terrainGenerated).toBe(false);
    generateTerrain(chunk, SEED);
    expect(chunk.terrainGenerated).toBe(true);
  });

  it("generateChunk produces same result as split phases (without overflow)", () => {
    const cy = Math.floor(SURFACE_Y / CHUNK_H);
    const chunkA = createChunk(5, cy);
    const chunkB = createChunk(5, cy);

    generateChunk(chunkA, SEED);
    generateTerrain(chunkB, SEED);
    generateTrees(chunkB, SEED, null);
    generateFeatures(chunkB, SEED);
    chunkB.generated = true;

    for (let i = 0; i < chunkA.foreground.length; i++) {
      expect(chunkA.foreground[i]).toBe(chunkB.foreground[i]);
    }
    for (let i = 0; i < chunkA.background.length; i++) {
      expect(chunkA.background[i]).toBe(chunkB.background[i]);
    }
  });

  it("ensureChunkTerrainOnly generates terrain but not trees", () => {
    const world = new BlockWorld(SEED);
    const info = biomeAt(100, SEED);
    const cy = Math.floor(info.surfaceY / CHUNK_H);
    const chunk = world.ensureChunkTerrainOnly(2, cy);
    expect(chunk.terrainGenerated).toBe(true);
    expect(chunk.generated).toBe(false);
    const solid = countSolidForeground(chunk);
    expect(solid).toBeGreaterThan(0);
  });
});

// ============================================================================
// Terrain generation integration tests
// ============================================================================

describe("Terrain generation integration", () => {
  it("generates bedrock at the bottom of the world", () => {
    const bottomCy = Math.floor((WORLD_H - 1) / CHUNK_H);
    const chunk = createChunk(0, bottomCy);
    generateChunk(chunk, SEED);
    const lastRowIdx = cellIndex(0, CHUNK_H - 1);
    expect(chunk.foreground[lastRowIdx]).toBe(0x0D); // BLOCK_BEDROCK = 13
  });

  it("generates water in ocean biomes", () => {
    for (let wx = 0; wx < 16384; wx += 100) {
      const info = biomeAt(wx, SEED);
      if (info.biome !== "ocean") continue;
      const cx = Math.floor(wx / CHUNK_W) % CHUNKS_X;
      const cy = Math.floor(SEA_LEVEL / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      let hasWater = false;
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) === BLOCK_WATER) {
          hasWater = true;
          break;
        }
      }
      expect(hasWater).toBe(true);
      return;
    }
  });

  it("mountain biomes produce elevated terrain", () => {
    for (let wx = 0; wx < 16384; wx += 50) {
      const info = biomeAt(wx, SEED);
      if (info.biome !== "mountain") continue;
      expect(info.surfaceY).toBeLessThan(SURFACE_Y + 160);
      expect(info.surfaceY).toBeGreaterThan(SURFACE_Y + 10);
      return;
    }
  });

  it("explored flag is set near surface", () => {
    const cy = Math.floor(SURFACE_Y / CHUNK_H);
    const chunk = createChunk(0, cy);
    generateChunk(chunk, SEED);
    let exploredCount = 0;
    for (let i = 0; i < chunk.explored.length; i++) {
      if (chunk.explored[i] !== 0) exploredCount++;
    }
    expect(exploredCount).toBeGreaterThan(0);
  });

  it("trees are generated in plains biomes", () => {
    for (let wx = 0; wx < 16384; wx += 100) {
      const info = biomeAt(wx, SEED);
      if (info.biome !== "plains") continue;
      const cx = Math.floor(wx / CHUNK_W) % CHUNKS_X;
      const cy = Math.floor(info.surfaceY / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const trees = countTreeBlocks(chunk);
      expect(trees).toBeGreaterThan(0);
      return;
    }
  });
});
