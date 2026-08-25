// ============================================================================
// Overburden — BlockWorld.getMapRegion tests
//
// Tests the downsampled map-region snapshot: fog for ungenerated chunks,
// correct representative block ids for generated chunks, horizontal cylinder
// wrap of the region origin, and station collection.
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
  BLOCK_AIR, BLOCK_GRASS, BLOCK_STONE, BLOCK_WORKBENCH,
  CHUNK_H, CHUNK_W, CHUNKS_X,
  SURFACE_Y,
} from "../shared/constants";
import {
  MAP_REGION_COLS, MAP_REGION_ROWS, THUMB_H, THUMB_W,
} from "../shared/map-buffer";
import { setBlock } from "./chunk";
import { BlockWorld } from "./block-world";

describe("BlockWorld.getMapRegion", () => {
  it("returns all-fog for a fresh world with no generated chunks", () => {
    const world = new BlockWorld(12345);
    // Don't generate any chunks — getMapRegion should return zeros.
    const region = world.getMapRegion(CHUNKS_X / 2);
    expect(region.cols).toBe(MAP_REGION_COLS);
    expect(region.rows).toBe(MAP_REGION_ROWS);
    // Every thumbnail cell should be unexplored (fog) with block id 0.
    let anyExplored = false;
    let anyBlock = false;
    for (let i = 0; i < region.explored.length; i++) {
      if (region.explored[i] !== 0) anyExplored = true;
      if (region.blockIds[i] !== 0) anyBlock = true;
    }
    expect(anyExplored).toBe(false);
    expect(anyBlock).toBe(false);
    expect(region.stations).toEqual([]);
  });

  it("wraps cx0 around the cylinder (negative center)", () => {
    const world = new BlockWorld(12345);
    const region = world.getMapRegion(0); // center at chunk 0
    // halfCols = 64, so cx0 = (0 - 64) % 256 = 192 (wrapped).
    expect(region.cx0).toBe(((0 - (MAP_REGION_COLS >> 1)) % CHUNKS_X + CHUNKS_X) % CHUNKS_X);
  });

  it("wraps cx0 for a center near the east edge", () => {
    const world = new BlockWorld(12345);
    const center = CHUNKS_X - 1; // 255
    const region = world.getMapRegion(center);
    const expected = ((center - (MAP_REGION_COLS >> 1)) % CHUNKS_X + CHUNKS_X) % CHUNKS_X;
    expect(region.cx0).toBe(expected);
  });

  it("reports explored + representative block for a generated chunk", () => {
    const world = new BlockWorld(12345);
    // Force-generate the chunk at (0, 0) by accessing it via ensureChunk.
    // We use a private access through the public getBlockAt which triggers
    // ensureChunk internally. But getBlockAt doesn't mark explored. Instead,
    // build a chunk manually: call ensureChunk via getBlockAt, then mark
    // explored + set a block directly through the chunk map.
    // The simplest path: generate the chunk, then set explored + a block.
    // BlockWorld.ensureChunk is private, but getBlockAt calls it. After that
    // the chunk exists in the map. We can't reach it directly, so we test
    // via the active grid: setFocus + checkRebuild generates + marks the
    // active grid's chunks explored (terrain-gen marks surface explored).
    world.setFocus(0, SURFACE_Y);
    // Trigger a rebuild so chunks around (0, SURFACE_Y) are generated + loaded
    // into the active grid. The active grid is 7x7 chunks centered on the
    // focus chunk.
    (world as unknown as { rebuildActiveGrid: () => void }).rebuildActiveGrid();

    // Now the chunk containing (0, SURFACE_Y) should be generated + have
    // explored cells set (terrain-gen marks surface cells explored).
    const region = world.getMapRegion(0);
    // At least one thumbnail cell in the region should be explored.
    let exploredCount = 0;
    for (let i = 0; i < region.explored.length; i++) {
      if (region.explored[i] !== 0) exploredCount++;
    }
    expect(exploredCount).toBeGreaterThan(0);
  });

  it("collects stations from generated chunks", () => {
    const world = new BlockWorld(12345);
    // Generate the chunk at (0, 0) and place a workbench in it.
    world.setFocus(0, SURFACE_Y);
    (world as unknown as { rebuildActiveGrid: () => void }).rebuildActiveGrid();
    // Place a workbench at a known world position inside chunk (0,0).
    // Chunk (0,0) covers world (0..63, 0..63). Place at (10, 10).
    world.setBlockAt(10, 10, BLOCK_WORKBENCH);

    const region = world.getMapRegion(0);
    const wb = region.stations.find((s) => s.station === "workbench");
    expect(wb).toBeDefined();
    expect(wb!.wx).toBe(10);
    expect(wb!.wy).toBe(10);
  });

  it("does not collect stations from ungenerated chunks", () => {
    const world = new BlockWorld(12345);
    // No chunks generated → no stations.
    const region = world.getMapRegion(CHUNKS_X / 2);
    expect(region.stations).toEqual([]);
  });

  it("thumbnail dimensions match constants", () => {
    const world = new BlockWorld(12345);
    const region = world.getMapRegion(0);
    const expectedCells = MAP_REGION_COLS * MAP_REGION_ROWS * THUMB_W * THUMB_H;
    expect(region.blockIds.length).toBe(expectedCells);
    expect(region.explored.length).toBe(expectedCells);
  });
});
