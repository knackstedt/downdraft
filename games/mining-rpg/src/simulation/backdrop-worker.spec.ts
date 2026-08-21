import { Material } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import {
    BACKDROP_CELL_TYPE,
    BACKDROP_CHUNK_H,
    BACKDROP_CHUNK_W,
    CHUNK_H,
    CHUNK_W,
    WORLD_SEED,
} from "../shared/constants";
import {
    backdropCellType,
    backdropLakeAt,
    backdropSurfaceHeightAt,
    generateBackdropChunk,
    isBackdropCavity,
} from "./backdrop-worker";
import { CAVITY_CONFIG, LAKE_CONFIG } from "./ore-config";
import { isCavity, surfaceHeightAt } from "./terrain";

const SEED = WORLD_SEED;

// Helper: count backdrop cells of a specific cell-type alpha
function countCellType(grid: Uint32Array, type: number): number {
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    if (((grid[i] >>> 24) & 0xff) === type) count++;
  }
  return count;
}

// Helper: cell-type alpha at (lx, ly) in a backdrop chunk grid
function typeAt(grid: Uint32Array, lx: number, ly: number): number {
  return (grid[ly * BACKDROP_CHUNK_W + lx] >>> 24) & 0xff;
}

// --- Cave detection tests ---

test("isBackdropCavity returns false above CAVITY_CONFIG.minChunkY", () => {
  // cy=0 is the surface chunk — no caves (minChunkY=1)
  for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
    const wx = 5 * CHUNK_W + lx * 2;
    const wy = 0 * CHUNK_H + 10 * 2;
    expect(isBackdropCavity(wx, wy, 0, SEED)).toBe(false);
  }
});

test("isBackdropCavity can return true at valid depths (cy >= minChunkY)", () => {
  let found = false;
  for (let cx = 0; cx < 5 && !found; cx++) {
    for (let cy = CAVITY_CONFIG.minChunkY; cy <= 5 && !found; cy++) {
      for (let lx = 0; lx < BACKDROP_CHUNK_W && !found; lx++) {
        for (let ly = 0; ly < BACKDROP_CHUNK_H && !found; ly++) {
          const wx = cx * CHUNK_W + lx * 2;
          const wy = cy * CHUNK_H + ly * 2;
          if (isBackdropCavity(wx, wy, cy, SEED)) found = true;
        }
      }
    }
  }
  expect(found).toBe(true);
});

test("isBackdropCavity is deterministic — same coords produce same result", () => {
  const wx = 200;
  const wy = 300;
  const cy = 3;
  const a = isBackdropCavity(wx, wy, cy, SEED);
  const b = isBackdropCavity(wx, wy, cy, SEED);
  expect(a).toBe(b);
});

// --- Lake detection tests ---

test("backdropLakeAt returns null for water above its minChunkY", () => {
  // Water lakes start at cy=2
  const water = LAKE_CONFIG.find((l) => l.material === Material.Water)!;
  for (let cx = 0; cx < 3; cx++) {
    for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
      const wx = cx * CHUNK_W + lx * 2;
      const wy = 0 * CHUNK_H + 50 * 2; // cy=0, well above water range
      expect(backdropLakeAt(wx, wy, 0, SEED)).toBeNull();
    }
  }
});

test("backdropLakeAt can find lava in deep chunks (cy >= 8)", () => {
  let lavaFound = false;
  for (let cx = 0; cx < 10 && !lavaFound; cx++) {
    for (let cy = 8; cy <= 12 && !lavaFound; cy++) {
      for (let lx = 0; lx < BACKDROP_CHUNK_W && !lavaFound; lx++) {
        for (let ly = 0; ly < BACKDROP_CHUNK_H && !lavaFound; ly++) {
          const wx = cx * CHUNK_W + lx * 2;
          const wy = cy * CHUNK_H + ly * 2;
          const lake = backdropLakeAt(wx, wy, cy, SEED);
          if (lake && lake.material === Material.Lava) lavaFound = true;
        }
      }
    }
  }
  expect(lavaFound).toBe(true);
});

// --- Chunk generation tests ---

test("generateBackdropChunk is deterministic — same (cx, cy, seed) produces identical grids", () => {
  const a = generateBackdropChunk(3, 5, SEED);
  const b = generateBackdropChunk(3, 5, SEED);
  expect(a.grid.length).toBe(b.grid.length);
  for (let i = 0; i < a.grid.length; i++) {
    expect(a.grid[i]).toBe(b.grid[i]);
  }
});

test("generateBackdropChunk produces CAVE cells in underground chunks with caves", () => {
  // Scan several chunks to find one with cave cells
  let found = false;
  for (let cx = 0; cx < 5 && !found; cx++) {
    for (let cy = CAVITY_CONFIG.minChunkY; cy <= 5 && !found; cy++) {
      const chunk = generateBackdropChunk(cx, cy, SEED);
      if (countCellType(chunk.grid, BACKDROP_CELL_TYPE.CAVE) > 0) {
        found = true;
      }
    }
  }
  expect(found).toBe(true);
});

test("generateBackdropChunk: above-surface chunk (cy<0) is all SKY", () => {
  const chunk = generateBackdropChunk(0, -1, SEED);
  const skyCount = countCellType(chunk.grid, BACKDROP_CELL_TYPE.SKY);
  expect(skyCount).toBe(BACKDROP_CHUNK_W * BACKDROP_CHUNK_H);
});

test("generateBackdropChunk: surface chunk (cy=0) has SKY cells above surface", () => {
  const chunk = generateBackdropChunk(0, 0, SEED);
  // The top portion should be sky (SKY), bottom should be solid
  const topRowType = typeAt(chunk.grid, BACKDROP_CHUNK_W / 2, 0);
  expect(topRowType).toBe(BACKDROP_CELL_TYPE.SKY);
  // Bottom row should not be SKY (should have solid or cave from generation)
  const bottomRowType = typeAt(chunk.grid, BACKDROP_CHUNK_W / 2, BACKDROP_CHUNK_H - 1);
  // At the bottom of the surface chunk, we should be in stone territory
  // (solid wall, possibly carved by caves)
  expect(bottomRowType).not.toBe(BACKDROP_CELL_TYPE.SKY);
});

test("generateBackdropChunk: LAVA cells appear only in deep chunks (cy >= 8)", () => {
  // Shallow chunks should have no lava
  for (let cx = 0; cx < 3; cx++) {
    for (let cy = 0; cy < 7; cy++) {
      const chunk = generateBackdropChunk(cx, cy, SEED);
      expect(countCellType(chunk.grid, BACKDROP_CELL_TYPE.LAVA)).toBe(0);
    }
  }
  // Deep chunks should have lava somewhere
  let lavaFound = false;
  for (let cx = 0; cx < 10 && !lavaFound; cx++) {
    for (let cy = 8; cy <= 14 && !lavaFound; cy++) {
      const chunk = generateBackdropChunk(cx, cy, SEED);
      if (countCellType(chunk.grid, BACKDROP_CELL_TYPE.LAVA) > 0) {
        lavaFound = true;
      }
    }
  }
  expect(lavaFound).toBe(true);
});

test("generateBackdropChunk: WATER cells appear only in chunks cy 2-6", () => {
  // Above water range — no water
  for (let cx = 0; cx < 3; cx++) {
    const chunk = generateBackdropChunk(cx, 0, SEED);
    expect(countCellType(chunk.grid, BACKDROP_CELL_TYPE.WATER)).toBe(0);
  }
  // In water range — should find water somewhere
  let waterFound = false;
  for (let cx = 0; cx < 10 && !waterFound; cx++) {
    for (let cy = 2; cy <= 6 && !waterFound; cy++) {
      const chunk = generateBackdropChunk(cx, cy, SEED);
      if (countCellType(chunk.grid, BACKDROP_CELL_TYPE.WATER) > 0) {
        waterFound = true;
      }
    }
  }
  expect(waterFound).toBe(true);
});

test("generateBackdropChunk: all cells have a valid cell-type alpha", () => {
  const validTypes = new Set<number>([
    BACKDROP_CELL_TYPE.CAVE,
    BACKDROP_CELL_TYPE.SKY,
    BACKDROP_CELL_TYPE.WATER,
    BACKDROP_CELL_TYPE.OIL,
    BACKDROP_CELL_TYPE.SOLID,
    BACKDROP_CELL_TYPE.LAVA,
  ]);
  const chunk = generateBackdropChunk(2, 4, SEED);
  for (let i = 0; i < chunk.grid.length; i++) {
    const t = backdropCellType(chunk.grid[i]);
    expect(validTypes.has(t)).toBe(true);
  }
});

// --- Loose overlap with foreground caves ---

test("backdrop caves loosely overlap foreground caves (same areas, not 1:1)", () => {
  // The backdrop uses the same noise field with a lower threshold, so
  // backdrop caves are a superset of foreground caves: every foreground
  // cave cell is also a backdrop cave cell, plus extra cells from the
  // wider threshold. This gives "loosely matching" — same areas, not 1:1.
  const cy = 3;
  let bothCave = 0;
  let onlyBackdrop = 0;
  let onlyForeground = 0;
  const total = 500;

  for (let i = 0; i < total; i++) {
    const wx = Math.floor(Math.random() * CHUNK_W * 3) + CHUNK_W;
    const wy = cy * CHUNK_H + Math.floor(Math.random() * CHUNK_H);
    const fgCave = isCavity(wx, wy, cy, SEED);
    const bdCave = isBackdropCavity(wx, wy, cy, SEED);
    if (fgCave && bdCave) bothCave++;
    else if (bdCave && !fgCave) onlyBackdrop++;
    else if (fgCave && !bdCave) onlyForeground++;
  }

  // Same noise field + lower threshold → backdrop is a superset.
  // Every foreground cave should also be a backdrop cave.
  expect(bothCave).toBeGreaterThan(0);
  expect(onlyForeground).toBe(0);
  // The lower threshold means backdrop has extra cave cells (not 1:1).
  expect(onlyBackdrop).toBeGreaterThan(0);
});

// --- Surface height test ---

test("backdropSurfaceHeightAt matches terrain surfaceHeightAt", () => {
  // The backdrop reimplementation should produce the same surface height
  // as the foreground terrain.ts surfaceHeightAt.
  for (let wx = 0; wx < CHUNK_W * 3; wx += 7) {
    expect(backdropSurfaceHeightAt(wx, SEED)).toBe(surfaceHeightAt(wx, SEED));
  }
});
