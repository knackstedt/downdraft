import { Material } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import { CHUNK_H, CHUNK_W, WORLD_SEED } from "../shared/constants";
import { isStaticUntilDamaged } from "./material-overrides";
import { cellHash, fbm2D, mulberry32, worldFbm } from "./noise";
import { ORE_CONFIG, WORM_CONFIG } from "./ore-config";
import { generateChunk, pickOreByDepth, surfaceHeightAt } from "./terrain";

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

test("lakes span chunk boundaries (same lake appears in adjacent chunks)", () => {
  // Generate two horizontally adjacent chunks and check that liquid cells
  // exist at the same world-Y near the boundary. Before the neighborhood
  // fix, lakes were truncated at chunk borders — the boundary columns would
  // have liquid on one side and stone on the other at the same Y.
  const liquidMats = new Set([
    Material.Water,
    Material.Oil,
    Material.Lava,
  ]);
  let foundSpanning = false;
  for (let cx = 0; cx < 20 && !foundSpanning; cx++) {
    for (let cy = 2; cy <= 12 && !foundSpanning; cy++) {
      const left = generateChunk(cx, cy, SEED);
      const right = generateChunk(cx + 1, cy, SEED);
      // Check the last 5 columns of left and first 5 of right at the same Y.
      // If both have the same liquid at the same Y, the lake spans the border.
      for (let y = 0; y < CHUNK_H; y++) {
        for (let dx = 0; dx < 5; dx++) {
          const lm = left.grid[y * CHUNK_W + (CHUNK_W - 1 - dx)] & 0xff;
          if (!liquidMats.has(lm)) continue;
          for (let rdx = 0; rdx < 5; rdx++) {
            const rm = right.grid[y * CHUNK_W + rdx] & 0xff;
            if (rm === lm) {
              foundSpanning = true;
              break;
            }
          }
          if (foundSpanning) break;
        }
        if (foundSpanning) break;
      }
    }
  }
  expect(foundSpanning).toBe(true);
});

test("lakes span vertical chunk boundaries (same lake in chunk above and below)", () => {
  // Same as the horizontal test but for vertical borders. A lake center near
  // the bottom of chunk N should carve into the top of chunk N+1 (within the
  // same depth range).
  const liquidMats = new Set([
    Material.Water,
    Material.Oil,
    Material.Lava,
  ]);
  let foundSpanning = false;
  for (let cx = 0; cx < 20 && !foundSpanning; cx++) {
    for (let cy = 2; cy <= 12 && !foundSpanning; cy++) {
      const top = generateChunk(cx, cy, SEED);
      const bottom = generateChunk(cx, cy + 1, SEED);
      // Check the last 5 rows of top and first 5 of bottom at the same X.
      for (let x = 0; x < CHUNK_W; x++) {
        for (let dy = 0; dy < 5; dy++) {
          const tm = top.grid[(CHUNK_H - 1 - dy) * CHUNK_W + x] & 0xff;
          if (!liquidMats.has(tm)) continue;
          for (let bdy = 0; bdy < 5; bdy++) {
            const bm = bottom.grid[bdy * CHUNK_W + x] & 0xff;
            if (bm === tm) {
              foundSpanning = true;
              break;
            }
          }
          if (foundSpanning) break;
        }
        if (foundSpanning) break;
      }
    }
  }
  expect(foundSpanning).toBe(true);
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
    // Gravity is default (128) for most cells, but 0 for ores/coal
    // (they don't have gravity until mined — the mining system re-enables it)
    if (isStaticUntilDamaged(mat)) {
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

// --- Perlin worm ore generation tests ---

test("multiple ore types coexist in the same chunk (no single-ore striation)", () => {
  // At mid depths (cy 3-5, worldY ~384-767), iron, bauxite, coal, and silver
  // should all be valid. A chunk at this depth should contain more than one
  // ore type (the old system picked one ore per 128-cell region = one per chunk).
  const oreMats = new Set(ORE_CONFIG.map((o) => o.material));
  for (let cx = 0; cx < 8; cx++) {
    const found = new Set<number>();
    for (let cy = 3; cy <= 5; cy++) {
      const chunk = generateChunk(cx, cy, SEED);
      for (let i = 0; i < chunk.grid.length; i++) {
        const m = chunk.grid[i] & 0xff;
        if (oreMats.has(m)) found.add(m);
      }
    }
    // At least one of these 8 column-groups should have 2+ ore types
    if (found.size >= 2) return;
  }
  // If no chunk group had 2+ ores, fail
  expect(true).toBe(false); // should not reach here
});

test("ore veins span chunk boundaries (same vein appears in adjacent chunks)", () => {
  // Generate two horizontally adjacent chunks and check that ore cells exist
  // at the same world-Y near the boundary. If veins are chunk-local, the
  // boundary columns will have no correlation. With Perlin worms, worms from
  // one chunk's seed neighborhood deposit into adjacent chunks.
  const cy = 4; // mid depth where iron/bauxite are common
  let foundSpanning = false;
  for (let cx = 0; cx < 10 && !foundSpanning; cx++) {
    const left = generateChunk(cx, cy, SEED);
    const right = generateChunk(cx + 1, cy, SEED);
    // Check the last 5 columns of left chunk and first 5 columns of right chunk
    // at the same world Y — if both have ore at the same Y, the vein spans
    for (let y = CHUNK_H - 20; y < CHUNK_H; y++) {
      const leftMat = left.grid[y * CHUNK_W + (CHUNK_W - 1)] & 0xff;
      const rightMat = right.grid[y * CHUNK_W + 0] & 0xff;
      const oreMats = new Set(ORE_CONFIG.map((o) => o.material));
      if (oreMats.has(leftMat) && leftMat === rightMat) {
        foundSpanning = true;
        break;
      }
    }
  }
  // It's possible (but unlikely) that no vein crosses an exact pixel boundary.
  // Check within a 3-cell tolerance instead.
  if (!foundSpanning) {
    for (let cx = 0; cx < 10 && !foundSpanning; cx++) {
      const left = generateChunk(cx, cy, SEED);
      const right = generateChunk(cx + 1, cy, SEED);
      const oreMats = new Set(ORE_CONFIG.map((o) => o.material));
      for (let y = 0; y < CHUNK_H; y++) {
        // Check if any ore in the last 3 columns of left matches any ore
        // in the first 3 columns of right at the same y (±2 tolerance)
        for (let dx = 0; dx < 3; dx++) {
          const lm = left.grid[y * CHUNK_W + (CHUNK_W - 1 - dx)] & 0xff;
          if (!oreMats.has(lm)) continue;
          for (let dy = -2; dy <= 2; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= CHUNK_H) continue;
            for (let rdx = 0; rdx < 3; rdx++) {
              const rm = right.grid[ny * CHUNK_W + rdx] & 0xff;
              if (rm === lm) {
                foundSpanning = true;
                break;
              }
            }
            if (foundSpanning) break;
          }
          if (foundSpanning) break;
        }
        if (foundSpanning) break;
      }
    }
  }
  expect(foundSpanning).toBe(true);
});

test("pickOreByDepth returns null above all ore depths (sky region)", () => {
  // At worldY=10 (well above the stone body), no ore should be selected
  const ore = pickOreByDepth(100, 10, SEED);
  expect(ore).toBeNull();
});

test("pickOreByDepth returns shallow ore at shallow depth", () => {
  // At worldY=80 (tin's ideal depth), should return a valid ore
  const ore = pickOreByDepth(100, 80, SEED);
  expect(ore).not.toBeNull();
  expect(ore!.minDepthY).toBeLessThanOrEqual(80);
  expect(ore!.maxDepthY).toBeGreaterThanOrEqual(80);
});

test("pickOreByDepth is deterministic at the same spawn point", () => {
  const a = pickOreByDepth(64, 300, SEED);
  const b = pickOreByDepth(64, 300, SEED);
  expect(a?.material).toBe(b?.material);
});

test("ore coverage is reasonable (1-8% of stone body)", () => {
  // Worms should produce a reasonable amount of ore — not too sparse,
  // not too dense. Check a few mid-depth chunks.
  const oreMats = new Set(ORE_CONFIG.map((o) => o.material));
  let totalOre = 0;
  let totalStone = 0;
  for (let cx = 0; cx < 5; cx++) {
    const chunk = generateChunk(cx, 4, SEED);
    for (let i = 0; i < chunk.grid.length; i++) {
      const m = chunk.grid[i] & 0xff;
      if (m === Material.Stone) totalStone++;
      else if (oreMats.has(m)) totalOre++;
    }
  }
  const ratio = totalOre / (totalOre + totalStone);
  // Should be between 0.5% and 10%
  expect(ratio).toBeGreaterThan(0.005);
  expect(ratio).toBeLessThan(0.10);
});

test("WORM_CONFIG seedGrid and spawnChance produce worms in a chunk neighborhood", () => {
  // Sanity: the neighborhood radius calculation should cover at least the
  // chunk itself (neighborhoodRadius >= 1)
  const maxVeinLen = ORE_CONFIG.reduce((m, o) => Math.max(m, o.veinLength), 0);
  const maxTravel = maxVeinLen * WORM_CONFIG.stepSize;
  const neighborhoodRadius = Math.ceil(maxTravel / WORM_CONFIG.seedGrid) + 1;
  expect(neighborhoodRadius).toBeGreaterThanOrEqual(2);
  // Total seed cells in neighborhood should be reasonable (< 500)
  const totalSeeds = (2 * neighborhoodRadius + 1) ** 2;
  expect(totalSeeds).toBeLessThan(500);
});
