import { ITEMS, getItem } from "@to-the-ocean/plugin-items";
import { describe, expect, it } from "bun:test";
import { addItem, createGrid, moveItem, processSpoilage } from "./inventory";

const _testItem = ITEMS["mackerel"];
const _testItem2 = ITEMS["cod"];

describe("moveItem transaction safety", () => {
  it("moves item to empty slot successfully", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 1);
    const moved = moveItem(grid, 0, 0, 5, 0);
    expect(moved).toBe(true);
    expect(getItem("mackerel") && grid.slots[0][5] !== null).toBe(true);
    expect(grid.slots[0][0]).toBe(null);
  });

  it("returns false when moving to out-of-bounds position", () => {
    const grid = createGrid(4, 4);
    addItem(grid, "mackerel", 1);
    const stackBefore = grid.slots[0][0];
    const moved = moveItem(grid, 0, 0, 10, 10);
    expect(moved).toBe(false);
    expect(grid.slots[0][0]).toBe(stackBefore);
  });

  it("swaps two items when dimensions allow", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 1);
    addItem(grid, "cod", 1);
    const sourceStack = grid.slots[0][0];
    const targetStack = grid.slots[0][2];
    const moved = moveItem(grid, 0, 0, 2, 0);
    expect(moved).toBe(true);
    expect(grid.slots[0][0]).toBe(targetStack);
    expect(grid.slots[0][2]).toBe(sourceStack);
  });

  it("preserves source on failed move (no item loss)", () => {
    const grid = createGrid(3, 3);
    addItem(grid, "mackerel", 1);
    const stackBefore = grid.slots[0][0];
    const moved = moveItem(grid, 0, 0, 2, 0);
    expect(moved).toBe(false);
    expect(grid.slots[0][0]).toBe(stackBefore);
  });
});

describe("processSpoilage progress clamp", () => {
  it("clamps spoilProgress to [0, 1]", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 1);
    const stack = grid.slots[0][0];
    expect(stack).not.toBe(null);
    if (!stack) return;

    stack.spoilProgress = 0.99;
    processSpoilage(grid, 1000, 24);
    expect(stack.spoilProgress).toBeLessThanOrEqual(1);
    expect(stack.spoilProgress).toBeGreaterThanOrEqual(0);
  });

  it("does not go negative", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 1);
    const stack = grid.slots[0][0];
    expect(stack).not.toBe(null);
    if (!stack) return;

    stack.spoilProgress = -0.5;
    processSpoilage(grid, 0, 24);
    expect(stack.spoilProgress).toBeGreaterThanOrEqual(0);
  });
});
