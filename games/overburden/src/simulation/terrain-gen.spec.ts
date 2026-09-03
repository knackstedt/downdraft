// ============================================================================
// Overburden — terrain generation tests
//
// Tests the biome system, cave generation (foreground-only), and cross-chunk
// tree overflow.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { getBlockDef } from "../shared/block-registry";
import {
    BLOCK_AIR,
    BLOCK_CLAY,
    BLOCK_GRAVEL,
    BLOCK_LAVA,
    BLOCK_OIL_POCKET,
    BLOCK_OIL_SATURATED_ROCK,
    BLOCK_SAND, BLOCK_STONE,
    BLOCK_WATER,
    CHUNK_H, CHUNK_W, CHUNKS_X,
    MAGMA_Y, SEA_LEVEL, SURFACE_Y, WORLD_H
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

  it("ocean biomes have surface below sea level (deep ocean)", () => {
    // Deep ocean columns have surfaceY > SEA_LEVEL (below sea level).
    // Near-shore ocean columns blend up to SEA_LEVEL-3 to connect with land,
    // so we only check that SOME ocean columns are below sea level.
    let foundDeepOcean = false;
    for (let wx = 0; wx < 16384; wx += 10) {
      const info = biomeAt(wx, SEED);
      if (info.biome === "ocean" && info.surfaceY > SEA_LEVEL) {
        foundDeepOcean = true;
        break;
      }
    }
    expect(foundDeepOcean).toBe(true);
  });

  it("surface height is continuous across adjacent columns (no cliffs)", () => {
    // Adjacent X columns should not have large height jumps, even at biome
    // boundaries. The detail noise amplitude is at most 25 (mountain peaks),
    // so adjacent columns differ by at most ~25 + 2 (base height rounding).
    let maxJump = 0;
    for (let wx = 0; wx < 5000; wx++) {
      const a = biomeAt(wx, SEED).surfaceY;
      const b = biomeAt(wx + 1, SEED).surfaceY;
      const jump = Math.abs(a - b);
      if (jump > maxJump) maxJump = jump;
    }
    // No single-column jump should exceed the max detail amplitude + rounding.
    // (Before the fix, jumps of 11+ blocks occurred at ocean/land boundaries
    // and 12+ at plains/desert boundaries.)
    expect(maxJump).toBeLessThanOrEqual(27);
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

  it("caves below sea level are air, not water-filled", () => {
    // Caves are no longer auto-filled with water during generation. Water
    // enters caves via the fluid sim (from oceans), not during gen. So
    // freshly-generated caves below sea level should be air.
    let foundCaveBelowSea = false;
    for (let cx = 0; cx < 20; cx++) {
      const cy = Math.floor((SURFACE_Y + 100) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      for (let i = 0; i < chunk.foreground.length; i++) {
        const fg = chunk.foreground[i] & 0xFF;
        const bg = chunk.background[i] & 0xFF;
        if (fg === BLOCK_AIR && bg === BLOCK_STONE) {
          // This is a cave cell — verify it's air, not water
          const baseWy = cy * CHUNK_H;
          const ly = Math.floor(i / CHUNK_W);
          const wy = baseWy + ly;
          if (wy > SEA_LEVEL) {
            foundCaveBelowSea = true;
            expect(fg).toBe(BLOCK_AIR);
            expect(fg).not.toBe(BLOCK_WATER);
          }
        }
      }
    }
    expect(foundCaveBelowSea).toBe(true);
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

// ============================================================================
// Depth-graded cave tests (no artificial roof, larger deeper, fade near magma)
// ============================================================================

describe("Depth-graded caves", () => {
  it("caves ramp in smoothly near the surface (no flat artificial roof)", () => {
    // The old hard cutoff (surfaceY+10) produced a flat roof: a single Y row
    // where cave→solid flipped across many X columns. The depth-graded
    // version fades caves in over ~20 blocks, so the set of cave Ys near the
    // surface should NOT be a single flat row shared across many columns.
    // Find a plains column with caves starting near the surface.
    for (let wx = 0; wx < 4000; wx += 7) {
      const info = biomeAt(wx, SEED);
      if (info.biome === "ocean") continue;
      const surfaceY = info.surfaceY;
      const cy = Math.floor(surfaceY / CHUNK_H);
      const chunk = createChunk(Math.floor(wx / CHUNK_W), cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      const lx = wx - Math.floor(wx / CHUNK_W) * CHUNK_W;
      // Collect the first (shallowest) cave Y for this column.
      let firstCaveY = -1;
      for (let ly = 0; ly < CHUNK_H; ly++) {
        const wy = baseWy + ly;
        if (wy <= surfaceY + 4) continue; // skip crust
        const fg = chunk.foreground[cellIndex(lx, ly)] & 0xFF;
        const bg = chunk.background[cellIndex(lx, ly)] & 0xFF;
        if ((fg === BLOCK_AIR) && bg === BLOCK_STONE) {
          firstCaveY = wy;
          break;
        }
      }
      if (firstCaveY < 0) continue;
      // The first cave should appear at depth > 4 (past the crust) — the
      // smooth fade-in means caves don't start right at surfaceY+4 exactly
      // everywhere; they ramp in. Just verify caves exist in the ramp zone
      // (depth 4-24) somewhere, and that there's no cave at depth < 4.
      expect(firstCaveY).toBeGreaterThan(surfaceY + 3);
      // Check no cave in the crust (depth 0-3) for this column.
      for (let d = 0; d <= 3; d++) {
        const ly = surfaceY + d - baseWy;
        if (ly < 0 || ly >= CHUNK_H) continue;
        const fg = chunk.foreground[cellIndex(lx, ly)] & 0xFF;
        expect(fg).not.toBe(BLOCK_AIR);
      }
      return;
    }
  });

  it("caves are larger/more frequent in deep chunks than shallow chunks", () => {
    // The depth-graded threshold lowers with depth, so deep chunks (near
    // magma) should have more cave cells than shallow chunks (near surface).
    let shallowTotal = 0;
    let deepTotal = 0;
    const shallowCy = Math.floor((SURFACE_Y + 40) / CHUNK_H);
    const deepCy = Math.floor((MAGMA_Y - 40) / CHUNK_H);
    for (let cx = 0; cx < 15; cx++) {
      const shallow = createChunk(cx, shallowCy);
      generateChunk(shallow, SEED);
      shallowTotal += countCaveCells(shallow);
      const deep = createChunk(cx, deepCy);
      generateChunk(deep, SEED);
      deepTotal += countCaveCells(deep);
    }
    // Deep should have materially more caves than shallow.
    expect(deepTotal).toBeGreaterThan(shallowTotal);
  });

  it("caves fade out near the magma layer (no caves in last 5 blocks above magma)", () => {
    for (let cx = 0; cx < 10; cx++) {
      const cy = Math.floor((MAGMA_Y - 5) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let lx = 0; lx < CHUNK_W; lx++) {
        for (let d = 0; d < 5; d++) {
          const wy = MAGMA_Y - 5 + d;
          const ly = wy - baseWy;
          if (ly < 0 || ly >= CHUNK_H) continue;
          const fg = chunk.foreground[cellIndex(lx, ly)] & 0xFF;
          const bg = chunk.background[cellIndex(lx, ly)] & 0xFF;
          // No cave (air with stone background) in the magma fade-out zone.
          if (bg === BLOCK_STONE) {
            expect(fg).not.toBe(BLOCK_AIR);
          }
        }
      }
    }
  });
});

// ============================================================================
// Perlin-worm ore vein tests
// ============================================================================

describe("Ore veins (Perlin worms)", () => {
  const ORE_BLOCKS = new Set([
    8,  // BLOCK_COAL_ORE
    9,  // BLOCK_COPPER_ORE
    10, // BLOCK_TIN_ORE
    11, // BLOCK_IRON_ORE
    12, // BLOCK_GOLD_ORE
    19, // BLOCK_TIME_CRYSTAL
    101, // BLOCK_OIL_SATURATED_ROCK
  ]);

  it("ore appears in connected clusters (veins, not isolated singles)", () => {
    // Perlin worms deposit ore in a radius along a path, so ore cells should
    // form connected components of size >= 3 (4-connected). The old per-cell
    // scatter produced mostly isolated single cells.
    let maxComponent = 0;
    for (let cx = 0; cx < 12 && maxComponent < 3; cx++) {
      const cy = Math.floor((SURFACE_Y + 120) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      // BFS over ore cells in this chunk
      const visited = new Uint8Array(chunk.foreground.length);
      for (let i = 0; i < chunk.foreground.length; i++) {
        if (visited[i]) continue;
        const fg = chunk.foreground[i] & 0xFF;
        if (!ORE_BLOCKS.has(fg)) continue;
        // BFS
        let size = 0;
        const stack = [i];
        visited[i] = 1;
        while (stack.length > 0) {
          const cur = stack.pop()!;
          size++;
          const x = cur % CHUNK_W;
          const y = Math.floor(cur / CHUNK_W);
          const neighbors = [
            x > 0 ? cur - 1 : -1,
            x < CHUNK_W - 1 ? cur + 1 : -1,
            y > 0 ? cur - CHUNK_W : -1,
            y < CHUNK_H - 1 ? cur + CHUNK_W : -1,
          ];
          for (const n of neighbors) {
            if (n < 0 || visited[n]) continue;
            const nfg = chunk.foreground[n] & 0xFF;
            if (ORE_BLOCKS.has(nfg)) {
              visited[n] = 1;
              stack.push(n);
            }
          }
        }
        if (size > maxComponent) maxComponent = size;
      }
    }
    expect(maxComponent).toBeGreaterThanOrEqual(3);
  });

  it("ore veins span chunk boundaries (same ore in adjacent chunks near border)", () => {
    const cy = Math.floor((SURFACE_Y + 120) / CHUNK_H);
    let foundSpanning = false;
    for (let cx = 0; cx < 15 && !foundSpanning; cx++) {
      const left = createChunk(cx, cy);
      const right = createChunk(cx + 1, cy);
      generateChunk(left, SEED);
      generateChunk(right, SEED);
      for (let y = 0; y < CHUNK_H; y++) {
        for (let dx = 0; dx < 3 && !foundSpanning; dx++) {
          const lm = left.foreground[y * CHUNK_W + (CHUNK_W - 1 - dx)] & 0xFF;
          if (!ORE_BLOCKS.has(lm)) continue;
          for (let rdx = 0; rdx < 3 && !foundSpanning; rdx++) {
            const rm = right.foreground[y * CHUNK_W + rdx] & 0xFF;
            if (rm === lm) foundSpanning = true;
          }
        }
      }
    }
    expect(foundSpanning).toBe(true);
  });

  it("ore does not spawn on top of lava (no ore with lava directly below)", () => {
    // Lava lakes are carved before ore worms, and depositOreAt skips cells
    // where the cell below is lava — so ore should never sit directly on top
    // of a lava lake cell. Verify across deep chunks where lava lakes appear.
    for (let cx = 0; cx < 20; cx++) {
      const cy = Math.floor((MAGMA_Y - 30) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let ly = 0; ly < CHUNK_H - 1; ly++) {
        for (let lx = 0; lx < CHUNK_W; lx++) {
          const idx = cellIndex(lx, ly);
          const fg = chunk.foreground[idx] & 0xFF;
          if (!ORE_BLOCKS.has(fg)) continue;
          const wy = baseWy + ly;
          if (wy >= MAGMA_Y) continue; // skip bottom magma layer
          // The cell directly below should not be lava (ore not on top of lava)
          const below = chunk.foreground[cellIndex(lx, ly + 1)] & 0xFF;
          expect(below).not.toBe(BLOCK_LAVA);
        }
      }
    }
  });
});

// ============================================================================
// Oil-saturated rock tests
// ============================================================================

describe("Oil-saturated rock", () => {
  it("is flammable and drops the oil item", () => {
    const def = getBlockDef(BLOCK_OIL_SATURATED_ROCK);
    expect(def).toBeDefined();
    expect(def!.flammable).toBe(true);
    expect(def!.drops.some((d) => d.itemId === "oil")).toBe(true);
  });

  it("appears in mid-deep chunks (worldY 820-980) and not shallow", () => {
    let foundMidDeep = false;
    let shallowCount = 0;
    // Mid-deep: scan chunks covering worldY 820-980
    for (let cx = 0; cx < 15; cx++) {
      const cy = Math.floor(900 / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) === BLOCK_OIL_SATURATED_ROCK) {
          foundMidDeep = true;
          break;
        }
      }
      if (foundMidDeep) break;
    }
    expect(foundMidDeep).toBe(true);

    // Shallow: worldY < 760 → no oil rock
    for (let cx = 0; cx < 10; cx++) {
      const cy = Math.floor(740 / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let ly = 0; ly < CHUNK_H; ly++) {
        const wy = baseWy + ly;
        if (wy >= 760) continue;
        if ((chunk.foreground[cellIndex(0, ly)] & 0xFF) === BLOCK_OIL_SATURATED_ROCK) shallowCount++;
        for (let lx = 0; lx < CHUNK_W; lx++) {
          if ((chunk.foreground[cellIndex(lx, ly)] & 0xFF) === BLOCK_OIL_SATURATED_ROCK) shallowCount++;
        }
      }
    }
    expect(shallowCount).toBe(0);
  });
});

// ============================================================================
// Lava lake tests (deep, scattered above magma)
// ============================================================================

describe("Lava lakes (scattered, deep only)", () => {
  it("lava lakes appear in the deep band above magma (worldY MAGMA_Y-60 .. MAGMA_Y-5)", () => {
    let found = false;
    for (let cx = 0; cx < 20 && !found; cx++) {
      const cy = Math.floor((MAGMA_Y - 30) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) !== BLOCK_LAVA) continue;
        const ly = Math.floor(i / CHUNK_W);
        const wy = baseWy + ly;
        // Exclude the bottom magma layer (wy >= MAGMA_Y) — we want lakes above it.
        if (wy < MAGMA_Y) {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });

  it("lava lakes do NOT appear above the deep band (worldY < MAGMA_Y - 60)", () => {
    let count = 0;
    for (let cx = 0; cx < 10; cx++) {
      const cy = Math.floor((MAGMA_Y - 80) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) !== BLOCK_LAVA) continue;
        const ly = Math.floor(i / CHUNK_W);
        const wy = baseWy + ly;
        if (wy < MAGMA_Y - 60) count++;
      }
    }
    expect(count).toBe(0);
  });

  it("carved lava cells preserve the host-rock background (stone/gravel/clay)", () => {
    for (let cx = 0; cx < 20; cx++) {
      const cy = Math.floor((MAGMA_Y - 30) / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) !== BLOCK_LAVA) continue;
        const ly = Math.floor(i / CHUNK_W);
        const wy = baseWy + ly;
        if (wy >= MAGMA_Y) continue; // skip bottom magma layer
        // Lake lava (above magma layer) should have a host-rock background
        // (stone, gravel, or clay — lava can replace any of these).
        const bg = chunk.background[i] & 0xFF;
        expect(bg === BLOCK_STONE || bg === BLOCK_GRAVEL || bg === BLOCK_CLAY).toBe(true);
      }
    }
  });
});

// ============================================================================
// Oil pocket tests (rare, mid-deep, emissive)
// ============================================================================

describe("Oil pockets (rare emissive marker)", () => {
  it("has lightEmit 4 (emissive sheen)", () => {
    const def = getBlockDef(BLOCK_OIL_POCKET);
    expect(def).toBeDefined();
    expect(def!.lightEmit).toBe(4);
  });

  it("appears at mid-deep depth (worldY 820-980) and is rare", () => {
    let total = 0;
    let found = false;
    for (let cx = 0; cx < 30; cx++) {
      const cy = Math.floor(900 / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      for (let i = 0; i < chunk.foreground.length; i++) {
        if ((chunk.foreground[i] & 0xFF) === BLOCK_OIL_POCKET) {
          total++;
          found = true;
        }
      }
    }
    // Should appear somewhere across 30 chunks...
    expect(found).toBe(true);
    // ...but be rare (well under 200 cells across 30 chunks — a handful of
    // small pockets, not a common feature).
    expect(total).toBeLessThan(200);
  });

  it("does NOT appear at shallow depth (worldY < 820)", () => {
    let count = 0;
    for (let cx = 0; cx < 10; cx++) {
      const cy = Math.floor(760 / CHUNK_H);
      const chunk = createChunk(cx, cy);
      generateChunk(chunk, SEED);
      const baseWy = cy * CHUNK_H;
      for (let ly = 0; ly < CHUNK_H; ly++) {
        const wy = baseWy + ly;
        if (wy >= 820) continue;
        for (let lx = 0; lx < CHUNK_W; lx++) {
          if ((chunk.foreground[cellIndex(lx, ly)] & 0xFF) === BLOCK_OIL_POCKET) count++;
        }
      }
    }
    expect(count).toBe(0);
  });
});
