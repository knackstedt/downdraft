// ============================================================================
// Worker spec — tests sand-spawn/fall/pit logic without a full WebGPU/Worker env.
//
// Tests the coordinate mapping, crumble event generation, and pit wall
// construction logic that the worker uses.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { describe, expect, it } from "bun:test";
import { TILE_CELL_SIZE, WALL_THICKNESS } from "../shared/constants";
import { elementToMaterial } from "../shared/elements";
import { TileBoard } from "./board";
import { attemptMatch, resetComboState } from "./match-engine";

describe("worker: sand-spawn coordinates", () => {
  it("crumble events map tile coords to sand grid coords correctly", () => {
    const b = new TileBoard(6, 6);
    b.place(2, 3, 5); // Ice
    b.place(4, 3, 5);
    const state = resetComboState();
    const originCol = 10;
    const originRow = 20;
    const result = attemptMatch(b, 2, 3, 0, 4, 3, 0, state, 1000, originCol, originRow);
    expect(result.ok).toBe(true);
    expect(result.crumble.length).toBe(2);
    // Tile (2,3) → sand (originCol + 2*TILE_CELL_SIZE, originRow + 3*TILE_CELL_SIZE)
    expect(result.crumble[0].sandCol).toBe(originCol + 2 * TILE_CELL_SIZE);
    expect(result.crumble[0].sandRow).toBe(originRow + 3 * TILE_CELL_SIZE);
    // Tile (4,3) → sand (originCol + 4*TILE_CELL_SIZE, originRow + 3*TILE_CELL_SIZE)
    expect(result.crumble[1].sandCol).toBe(originCol + 4 * TILE_CELL_SIZE);
    expect(result.crumble[1].sandRow).toBe(originRow + 3 * TILE_CELL_SIZE);
  });

  it("crumble events carry the correct sand material for each element", () => {
    for (let el = 0; el < 12; el++) {
      const b = new TileBoard(6, 6);
      b.place(0, 0, el);
      b.place(1, 0, el);
      const state = resetComboState();
      const result = attemptMatch(b, 0, 0, 0, 1, 0, 0, state, 1000, 0, 0);
      expect(result.ok).toBe(true);
      const expectedMat = elementToMaterial(el);
      expect(result.crumble[0].sandMaterial).toBe(expectedMat);
      expect(result.crumble[1].sandMaterial).toBe(expectedMat);
    }
  });

  it("crumble sand material is never Empty or Wall", () => {
    for (let el = 0; el < 12; el++) {
      const mat = elementToMaterial(el);
      expect(mat).not.toBe(Material.Empty);
      expect(mat).not.toBe(Material.Wall);
    }
  });
});

describe("worker: pit wall construction", () => {
  it("WALL_THICKNESS is a positive integer", () => {
    expect(WALL_THICKNESS).toBeGreaterThan(0);
    expect(Number.isInteger(WALL_THICKNESS)).toBe(true);
  });

  it("TILE_CELL_SIZE is a positive integer >= 4", () => {
    expect(TILE_CELL_SIZE).toBeGreaterThanOrEqual(4);
    expect(Number.isInteger(TILE_CELL_SIZE)).toBe(true);
  });

  it("pit wall layout: floor + side walls fit within grid", () => {
    // Simulate the pit wall construction logic.
    const W = 200, H = 120;
    const grid = new Uint32Array(W * H);
    grid.fill(0);

    // Floor wall.
    const floorRow = H - WALL_THICKNESS;
    for (let y = floorRow; y < H; y++) {
      for (let x = 0; x < W; x++) {
        grid[y * W + x] = Material.Wall;
      }
    }

    // Side walls.
    for (let x = 0; x < WALL_THICKNESS; x++) {
      for (let y = 0; y < H; y++) {
        grid[y * W + x] = Material.Wall;
        grid[y * W + (W - 1 - x)] = Material.Wall;
      }
    }

    // Verify: corners are walls, center-top is empty.
    expect(grid[0] & 0xff).toBe(Material.Wall); // top-left (side wall)
    expect(grid[(H - 1) * W] & 0xff).toBe(Material.Wall); // bottom-left
    expect(grid[(H - 1) * W + W - 1] & 0xff).toBe(Material.Wall); // bottom-right
    expect(grid[W * WALL_THICKNESS + WALL_THICKNESS] & 0xff).toBe(Material.Empty); // interior

    // Verify: floor row is all walls.
    for (let x = 0; x < W; x++) {
      expect(grid[(H - 1) * W + x] & 0xff).toBe(Material.Wall);
    }

    // Verify: side walls.
    for (let y = 0; y < H; y++) {
      expect(grid[y * W] & 0xff).toBe(Material.Wall);
      expect(grid[y * W + W - 1] & 0xff).toBe(Material.Wall);
    }
  });
});

describe("worker: sand spawn from crumble", () => {
  it("spawning sand fills the tile footprint with the correct material", () => {
    // Simulate the processPendingCrumble logic.
    const W = 100, H = 80;
    const grid = new Uint32Array(W * H);
    // No walls in this test area.
    grid.fill(0);

    const crumble = {
      sandCol: 20,
      sandRow: 30,
      sandMaterial: elementToMaterial(0), // Fire → Lava
    };

    // Paint sand across the tile footprint.
    for (let dy = 0; dy < TILE_CELL_SIZE; dy++) {
      for (let dx = 0; dx < TILE_CELL_SIZE; dx++) {
        const x = crumble.sandCol + dx;
        const y = crumble.sandRow + dy;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        grid[y * W + x] = (crumble.sandMaterial & 0xff) | (Math.floor(Math.random() * 4) << 16);
      }
    }

    // Verify: the tile footprint is filled with the correct material.
    for (let dy = 0; dy < TILE_CELL_SIZE; dy++) {
      for (let dx = 0; dx < TILE_CELL_SIZE; dx++) {
        const x = crumble.sandCol + dx;
        const y = crumble.sandRow + dy;
        const mat = grid[y * W + x] & 0xff;
        expect(mat).toBe(crumble.sandMaterial);
      }
    }

    // Verify: cells outside the footprint are still empty.
    expect(grid[0] & 0xff).toBe(Material.Empty);
    expect(grid[(H - 1) * W + W - 1] & 0xff).toBe(Material.Empty);
  });

  it("spawning sand does not overwrite walls", () => {
    const W = 100, H = 80;
    const grid = new Uint32Array(W * H);
    grid.fill(0);

    // Place a wall in the middle of where we'll spawn.
    const wallX = 22, wallY = 32;
    grid[wallY * W + wallX] = Material.Wall;

    const crumble = {
      sandCol: 20,
      sandRow: 30,
      sandMaterial: elementToMaterial(1), // Water
    };

    for (let dy = 0; dy < TILE_CELL_SIZE; dy++) {
      for (let dx = 0; dx < TILE_CELL_SIZE; dx++) {
        const x = crumble.sandCol + dx;
        const y = crumble.sandRow + dy;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const curMat = grid[y * W + x] & 0xff;
        if (curMat === Material.Wall) continue;
        grid[y * W + x] = crumble.sandMaterial & 0xff;
      }
    }

    // The wall should still be a wall.
    expect(grid[wallY * W + wallX] & 0xff).toBe(Material.Wall);
    // Surrounding cells should be the spawned material.
    expect(grid[wallY * W + wallX - 1] & 0xff).toBe(crumble.sandMaterial);
    expect(grid[wallY * W + wallX + 1] & 0xff).toBe(crumble.sandMaterial);
  });
});

describe("worker: board origin computation", () => {
  it("board is centered horizontally in the sand grid", () => {
    // Use a sand grid wide enough for the board (TILE_CELL_SIZE=20, 12 cols = 240).
    const sandW = 400;
    const boardCols = 12;
    const boardSandW = boardCols * TILE_CELL_SIZE;
    const originCol = Math.floor((sandW - boardSandW) / 2);
    // Board should be roughly centered.
    expect(originCol).toBeGreaterThan(0);
    expect(originCol + boardSandW).toBeLessThan(sandW);
    // Symmetry check (within 1 cell).
    const rightGap = sandW - originCol - boardSandW;
    expect(Math.abs(originCol - rightGap)).toBeLessThanOrEqual(1);
  });

  it("board is placed below the top wall", () => {
    const boardOriginRow = WALL_THICKNESS + 1;
    expect(boardOriginRow).toBeGreaterThan(WALL_THICKNESS);
  });
});
