import { Material } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import { CHUNK_H, CHUNK_W, WORLD_SEED } from "../shared/constants";
import { cellHash, fbm2D, mulberry32, worldFbm } from "./noise";
import { ORE_CONFIG } from "./ore-config";
import { generateChunk, surfaceHeightAt } from "./terrain";

const SEED = WORLD_SEED;

// Helper: count cells of a specific material in a chunk grid
function countMaterial(grid: Uint32Array, mat: number): number {
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    if ((grid[i] & 0xff) === mat) count++;
  }
  return count;
}

// Helper: get material at (x, y) in a chunk grid
function matAt(grid: Uint32Array, x: number, y: number): number {
  return grid[y * CHUNK_W + x] & 0xff;
}

// --- Noise tests ---

test("mulberry32 is deterministic — same seed produces same sequence", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) {
    expect(a()).toBe(b());
  }
});

test("fbm2D returns values in [0, 1] range", () => {
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const v = fbm2D(x, y, SEED, 4);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
});

test("worldFbm is continuous across chunk boundaries", () => {
  // Noise at the right edge of chunk 0 should be close to noise at the left edge of chunk 1
  const v1 = worldFbm(CHUNK_W - 1, 100, SEED, 0.05, 4);
  const v2 = worldFbm(CHUNK_W, 100, SEED, 0.05, 4);
  const diff = Math.abs(v1 - v2);
  expect(diff).toBeLessThan(0.3); // should be smooth, not a huge jump
});

test("cellHash is deterministic", () => {
  const a = cellHash(1, 2, 3, 4, SEED);
  const b = cellHash(1, 2, 3, 4, SEED);
  expect(a).toBe(b);
});

test("cellHash returns values in [0, 1)", () => {
  for (let i = 0; i < 100; i++) {
    const v = cellHash(i, i * 2, i * 3, i * 5, SEED);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

// --- Deterministic generation tests ---

test("generateChunk is deterministic — same (cx, cy, seed) produces identical chunks", () => {
  const c1 = generateChunk(3, 5, SEED);
  const c2 = generateChunk(3, 5, SEED);
  expect(c1.grid.length).toBe(c2.grid.length);
  for (let i = 0; i < c1.grid.length; i++) {
    expect(c1.grid[i]).toBe(c2.grid[i]);
  }
});

test("different seeds produce different chunks", () => {
  const c1 = generateChunk(2, 3, SEED);
  const c2 = generateChunk(2, 3, SEED + 1);
  let diffs = 0;
  for (let i = 0; i < c1.grid.length; i++) {
    if (c1.grid[i] !== c2.grid[i]) diffs++;
  }
  // Different seeds should produce noticeably different chunks
  expect(diffs).toBeGreaterThan(100);
});

test("different chunk positions produce different chunks", () => {
  const c1 = generateChunk(1, 3, SEED);
  const c2 = generateChunk(2, 3, SEED);
  let diffs = 0;
  for (let i = 0; i < c1.grid.length; i++) {
    if (c1.grid[i] !== c2.grid[i]) diffs++;
  }
  expect(diffs).toBeGreaterThan(0);
});

// --- Surface chunk tests ---

test("surface chunk (cy=0) has sky at top, grass, then dirt, then stone", () => {
  const chunk = generateChunk(5, 0, SEED);
  // Top rows should be empty (sky)
  expect(matAt(chunk.grid, 64, 0)).toBe(Material.Empty);
  expect(matAt(chunk.grid, 64, 5)).toBe(Material.Empty);
  // Bottom rows should be solid (stone or ore — ore veins can replace stone
  // at any depth within their chunk range)
  const bottomMat = matAt(chunk.grid, 64, CHUNK_H - 1);
  expect(bottomMat).not.toBe(Material.Empty);
  expect(bottomMat).not.toBe(Material.Grass);
  expect(bottomMat).not.toBe(Material.Dirt);
  // Should have some grass
  expect(countMaterial(chunk.grid, Material.Grass)).toBeGreaterThan(0);
  // Should have some dirt
  expect(countMaterial(chunk.grid, Material.Dirt)).toBeGreaterThan(0);
});

test("surface chunk has no ores at the very top (sky region)", () => {
  const chunk = generateChunk(3, 0, SEED);
  // First 20 rows should not contain any ore materials
  const oreMats = new Set(ORE_CONFIG.map((o) => o.material));
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < CHUNK_W; x++) {
      const m = matAt(chunk.grid, x, y);
      if (m !== 0) {
        expect(oreMats.has(m)).toBe(false);
      }
    }
  }
});

test("above-surface chunks (cy<0) are all empty (sky)", () => {
  const chunk = generateChunk(5, -1, SEED);
  for (let i = 0; i < chunk.grid.length; i++) {
    expect(chunk.grid[i]).toBe(0);
  }
});

// --- Underground chunk tests ---

test("underground chunks are mostly stone", () => {
  const chunk = generateChunk(5, 2, SEED);
  const stoneCount = countMaterial(chunk.grid, Material.Stone);
  // Should be mostly stone (at least 50% of the chunk)
  expect(stoneCount).toBeGreaterThan(CHUNK_W * CHUNK_H * 0.5);
});

test("underground chunks have some cavities (empty cells in stone body)", () => {
  // Test multiple chunks to ensure cavities appear somewhere
  let totalCavities = 0;
  for (let cx = 0; cx < 5; cx++) {
    const chunk = generateChunk(cx, 3, SEED);
    for (let i = 0; i < chunk.grid.length; i++) {
      if (chunk.grid[i] === 0) totalCavities++;
    }
  }
  // Should have at least some empty cells (cavities) across 5 chunks
  expect(totalCavities).toBeGreaterThan(0);
});

// --- Ore distribution tests ---

test("shallow ores (tin, copper) appear in shallow chunks (cy 0-3)", () => {
  let tinFound = false;
  let copperFound = false;
  // Generate several shallow chunks to find ores
  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 0; cy <= 3; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      if (countMaterial(chunk.grid, Material.TinOre) > 0) tinFound = true;
      if (countMaterial(chunk.grid, Material.CopperOre) > 0) copperFound = true;
    }
  }
  // At least one of tin/copper should be found in 40 chunks
  expect(tinFound || copperFound).toBe(true);
});

test("deep ores (gold, cobalt) appear in deep chunks (cy >= 10)", () => {
  let goldFound = false;
  let cobaltFound = false;
  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 10; cy <= 14; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      if (countMaterial(chunk.grid, Material.GoldOre) > 0) goldFound = true;
      if (countMaterial(chunk.grid, Material.CobaltOre) > 0) cobaltFound = true;
    }
  }
  expect(goldFound || cobaltFound).toBe(true);
});

test("shallow ores do NOT appear in deep chunks (cy >= 10)", () => {
  let shallowOreInDeep = 0;
  const shallowMats = new Set([
    Material.TinOre,
    Material.CopperOre,
  ]);
  for (let cx = 0; cx < 5; cx++) {
    for (let cy = 10; cy <= 14; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      for (let i = 0; i < chunk.grid.length; i++) {
        if (shallowMats.has(chunk.grid[i] & 0xff)) shallowOreInDeep++;
      }
    }
  }
  // Shallow ores should not appear in deep chunks (depth-gated)
  expect(shallowOreInDeep).toBe(0);
});

test("deep ores do NOT appear in shallow chunks (cy 0-2)", () => {
  let deepOreInShallow = 0;
  const deepMats = new Set([
    Material.GoldOre,
    Material.CobaltOre,
  ]);
  for (let cx = 0; cx < 5; cx++) {
    for (let cy = 0; cy <= 2; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      for (let i = 0; i < chunk.grid.length; i++) {
        if (deepMats.has(chunk.grid[i] & 0xff)) deepOreInShallow++;
      }
    }
  }
  expect(deepOreInShallow).toBe(0);
});

// --- Lake / liquid tests ---

test("water lakes appear in shallow-mid chunks (cy 2-6)", () => {
  let waterFound = false;
  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 2; cy <= 6; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      if (countMaterial(chunk.grid, Material.Water) > 0) {
        waterFound = true;
        break;
      }
    }
    if (waterFound) break;
  }
  // May not always find water (sparse), but check across enough chunks
  // If not found in 50 chunks, the generation is too sparse
  expect(waterFound).toBe(true);
});

test("lava lakes appear in deep chunks (cy >= 8)", () => {
  let lavaFound = false;
  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 8; cy <= 14; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      if (countMaterial(chunk.grid, Material.Lava) > 0) {
        lavaFound = true;
        break;
      }
    }
    if (lavaFound) break;
  }
  expect(lavaFound).toBe(true);
});

test("lava does NOT appear in shallow chunks (cy < 8)", () => {
  let lavaInShallow = 0;
  for (let cx = 0; cx < 5; cx++) {
    for (let cy = 0; cy <= 7; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      lavaInShallow += countMaterial(chunk.grid, Material.Lava);
    }
  }
  expect(lavaInShallow).toBe(0);
});

// --- Chunk structure tests ---

test("generated chunk has correct dimensions", () => {
  const chunk = generateChunk(1, 1, SEED);
  expect(chunk.grid.length).toBe(CHUNK_W * CHUNK_H);
  expect(chunk.fields.length).toBe(CHUNK_W * CHUNK_H * 4);
  expect(chunk.wakeTick.length).toBe(CHUNK_W * CHUNK_H);
});

test("all cells start frozen (wakeTick = 0)", () => {
  const chunk = generateChunk(2, 3, SEED);
  for (let i = 0; i < chunk.wakeTick.length; i++) {
    expect(chunk.wakeTick[i]).toBe(0);
  }
});

test("fields are initialized to defaults (gravity=128, temp=128)", () => {
  const chunk = generateChunk(2, 3, SEED);
  for (let i = 0; i < chunk.fields.length; i += 4) {
    const mat = chunk.grid[i / 4] & 0xff;
    // Temp is always default (128)
    expect(chunk.fields[i + 1]).toBe(128);
    // Gravity is default (128) for most cells, but 0 for tin/copper ore
    // (they don't have gravity until mined — dig() re-enables it)
    if (mat === Material.TinOre || mat === Material.CopperOre) {
      expect(chunk.fields[i + 0]).toBe(0);
    } else {
      expect(chunk.fields[i + 0]).toBe(128);
    }
  }
});

test("chunk metadata is correct", () => {
  const chunk = generateChunk(7, 11, SEED);
  expect(chunk.cx).toBe(7);
  expect(chunk.cy).toBe(11);
  expect(chunk.generated).toBe(true);
  expect(chunk.dirty).toBe(false);
  expect(chunk.active).toBe(false);
});

// --- surfaceHeightAt tests ---

test("surfaceHeightAt returns values near the expected surface level", () => {
  const baseSurface = Math.floor(CHUNK_H * 0.3);
  for (let x = 0; x < 100; x++) {
    const h = surfaceHeightAt(x, SEED);
    // Should be within the noise amplitude of the base surface
    expect(h).toBeGreaterThanOrEqual(baseSurface - 10);
    expect(h).toBeLessThanOrEqual(baseSurface + 10);
  }
});

test("surfaceHeightAt is deterministic", () => {
  for (let x = 0; x < 50; x++) {
    expect(surfaceHeightAt(x, SEED)).toBe(surfaceHeightAt(x, SEED));
  }
});
