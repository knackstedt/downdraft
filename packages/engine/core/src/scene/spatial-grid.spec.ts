import { SpatialGrid, type SpatialEntry } from "./spatial-grid";
import type { Entity } from "../ecs/entity";

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

function makeEntry(index: number, pos: [number, number, number], radius = 1, layer = 0): SpatialEntry {
  return { entity: makeEntity(index), position: pos, radius, layer };
}

describe("SpatialGrid", () => {
  it("should construct with default cell size", () => {
    const grid = new SpatialGrid();
    expect(grid.cellSizeValue).toBe(16);
  });

  it("should construct with custom cell size", () => {
    const grid = new SpatialGrid(32);
    expect(grid.cellSizeValue).toBe(32);
  });

  it("should insert entries", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [5, 0, 5]));
    expect(grid.getEntryCount()).toBe(1);
    expect(grid.getActiveCellCount()).toBe(1);
  });

  it("should insert multiple entries in same cell", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [2, 0, 2]));
    expect(grid.getEntryCount()).toBe(2);
    expect(grid.getActiveCellCount()).toBe(1);
  });

  it("should insert entries in different cells", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [20, 0, 20]));
    expect(grid.getEntryCount()).toBe(2);
    expect(grid.getActiveCellCount()).toBe(2);
  });

  it("should remove entries", () => {
    const grid = new SpatialGrid(16);
    const e = makeEntity(1);
    grid.insert(makeEntry(1, [5, 0, 5]));
    grid.remove(e, [5, 0, 5]);
    expect(grid.getEntryCount()).toBe(0);
  });

  it("should not crash removing non-existent entry", () => {
    const grid = new SpatialGrid(16);
    grid.remove(makeEntity(999), [0, 0, 0]);
    expect(grid.getEntryCount()).toBe(0);
  });

  it("should update entry position within same cell", () => {
    const grid = new SpatialGrid(16);
    const e = makeEntity(1);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.update(e, [1, 0, 1], [2, 0, 2], 1, 0);

    const results = grid.queryCell(0, 0);
    expect(results.length).toBe(1);
    expect(results[0].position).toEqual([2, 0, 2]);
  });

  it("should update entry position across cells", () => {
    const grid = new SpatialGrid(16);
    const e = makeEntity(1);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.update(e, [1, 0, 1], [20, 0, 20], 1, 0);

    expect(grid.queryCell(0, 0).length).toBe(0);
    expect(grid.queryCell(1, 1).length).toBe(1);
  });

  it("queryRange should return entries in range", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [5, 0, 5]));
    grid.insert(makeEntry(3, [30, 0, 30]));

    const results = grid.queryRange([0, 0, 0], [10, 10, 10]);
    expect(results.length).toBe(2);
  });

  it("queryRange should filter by layer", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1], 1, 0));
    grid.insert(makeEntry(2, [2, 0, 2], 1, 1));
    grid.insert(makeEntry(3, [3, 0, 3], 1, 0));

    const results = grid.queryRange([0, 0, 0], [10, 10, 10], 1);
    expect(results.length).toBe(1);
    expect(results[0].entity.index).toBe(2);
  });

  it("queryRadius should return entries within radius", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [10, 0, 10]));
    grid.insert(makeEntry(3, [2, 0, 2]));

    const results = grid.queryRadius([0, 0, 0], 5);
    expect(results.length).toBe(2);
  });

  it("queryRadius should filter by layer", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1], 1, 0));
    grid.insert(makeEntry(2, [2, 0, 2], 1, 1));

    const results = grid.queryRadius([0, 0, 0], 10, 1);
    expect(results.length).toBe(1);
  });

  it("queryCell should return entries in specific cell", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [20, 0, 20]));

    const cell00 = grid.queryCell(0, 0);
    expect(cell00.length).toBe(1);
    expect(cell00[0].entity.index).toBe(1);
  });

  it("queryCell should return empty for non-existent cell", () => {
    const grid = new SpatialGrid(16);
    expect(grid.queryCell(99, 99)).toEqual([]);
  });

  it("getCellCoords should convert world to cell coords", () => {
    const grid = new SpatialGrid(16);
    expect(grid.getCellCoords([5, 0, 5])).toEqual([0, 0]);
    expect(grid.getCellCoords([16, 0, 16])).toEqual([1, 1]);
    expect(grid.getCellCoords([-1, 0, -1])).toEqual([-1, -1]);
  });

  it("getCellsInRadius should return nearby cells", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [20, 0, 20]));

    const cells = grid.getCellsInRadius([8, 0, 8], 20);
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it("clear should remove all entries and cells", () => {
    const grid = new SpatialGrid(16);
    grid.insert(makeEntry(1, [1, 0, 1]));
    grid.insert(makeEntry(2, [20, 0, 20]));
    grid.clear();

    expect(grid.getEntryCount()).toBe(0);
    expect(grid.getActiveCellCount()).toBe(0);
  });
});
