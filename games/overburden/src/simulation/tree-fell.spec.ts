import { describe, expect, test } from "bun:test";
import {
    BLOCK_AIR,
    BLOCK_LEAF_APPLE, BLOCK_LEAF_CHERRY, BLOCK_LEAF_MAPLE,
    BLOCK_VINE_GRAPE, BLOCK_VINE_KIWI,
    BLOCK_WOOD_APPLE, BLOCK_WOOD_CHERRY, BLOCK_WOOD_MAPLE,
} from "../shared/constants";
import { makeTaggedBlock } from "../shared/tree-species";
import { fellTree } from "./tree-fell";

const W = 16;
const H = 16;

function makeGrid(): Uint16Array {
  return new Uint16Array(W * H);
}

function set(grid: Uint16Array, x: number, y: number, id: number, tag = 0): void {
  grid[y * W + x] = tag === 0 ? id : makeTaggedBlock(id, tag);
}

describe("fellTree", () => {
  test("fells a single tree: trunk + canopy", () => {
    const bg = makeGrid();
    // Apple tree: trunk at x=5, y=10..6 (base at y=10, top at y=6)
    set(bg, 5, 10, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 9, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 8, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 7, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 6, BLOCK_WOOD_APPLE, 42);
    // Canopy: leaves around y=5
    set(bg, 4, 5, BLOCK_LEAF_APPLE, 42);
    set(bg, 5, 5, BLOCK_LEAF_APPLE, 42);
    set(bg, 6, 5, BLOCK_LEAF_APPLE, 42);
    set(bg, 5, 4, BLOCK_LEAF_APPLE, 42);

    const felled = fellTree(bg, W, H, 5, 8); // mine middle of trunk
    expect(felled.length).toBe(9); // 5 wood + 4 leaves
    for (const cell of felled) {
      expect(cell.blockId).not.toBe(BLOCK_AIR);
    }
  });

  test("fells the whole trunk including below the mined block", () => {
    const bg = makeGrid();
    set(bg, 3, 10, BLOCK_WOOD_MAPLE, 7);
    set(bg, 3, 9, BLOCK_WOOD_MAPLE, 7);
    set(bg, 3, 8, BLOCK_WOOD_MAPLE, 7);
    set(bg, 3, 7, BLOCK_LEAF_MAPLE, 7);

    const felled = fellTree(bg, W, H, 3, 9); // mine middle
    expect(felled.length).toBe(4); // 3 wood + 1 leaf
  });

  test("does NOT fell a neighboring tree even with touching canopies", () => {
    const bg = makeGrid();
    // Tree 1 at x=3, tag 10
    set(bg, 3, 10, BLOCK_WOOD_APPLE, 10);
    set(bg, 3, 9, BLOCK_WOOD_APPLE, 10);
    set(bg, 3, 8, BLOCK_LEAF_APPLE, 10);
    set(bg, 4, 8, BLOCK_LEAF_APPLE, 10); // canopy extends right
    // Tree 2 at x=5, tag 20 — canopy touches tree 1's canopy at x=4
    set(bg, 5, 10, BLOCK_WOOD_CHERRY, 20);
    set(bg, 5, 9, BLOCK_WOOD_CHERRY, 20);
    set(bg, 5, 8, BLOCK_LEAF_CHERRY, 20);
    set(bg, 4, 8, BLOCK_LEAF_CHERRY, 20); // overwrites tree 1's leaf (same cell)

    // Re-set tree 1's canopy leaf at x=4 (tree 2 overwrote it above)
    // Actually both can't occupy the same cell. Let's make them adjacent instead.
    // Reset: tree 1 canopy at x=4, tree 2 canopy at x=5 (adjacent, not same cell)
    bg[8 * W + 4] = makeTaggedBlock(BLOCK_LEAF_APPLE, 10);
    bg[8 * W + 5] = makeTaggedBlock(BLOCK_LEAF_CHERRY, 20);

    const felled = fellTree(bg, W, H, 3, 10); // fell tree 1
    expect(felled.length).toBe(4); // only tree 1's blocks (3 wood + 1 leaf at x=4)
    const blockIds = felled.map((c) => c.blockId);
    expect(blockIds).not.toContain(BLOCK_WOOD_CHERRY);
    expect(blockIds).not.toContain(BLOCK_LEAF_CHERRY);
  });

  test("removes vines climbing the felled tree (same tag)", () => {
    const bg = makeGrid();
    // Tree trunk
    set(bg, 5, 10, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 9, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 8, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 7, BLOCK_LEAF_APPLE, 42);
    // Vine climbing adjacent to trunk, same tag
    set(bg, 6, 9, BLOCK_VINE_KIWI, 42);
    set(bg, 6, 8, BLOCK_VINE_KIWI, 42);

    const felled = fellTree(bg, W, H, 5, 10);
    const blockIds = felled.map((c) => c.blockId);
    expect(blockIds).toContain(BLOCK_VINE_KIWI);
    const vineCount = blockIds.filter((id) => id === BLOCK_VINE_KIWI).length;
    expect(vineCount).toBe(2);
  });

  test("does not remove vines with a different tag (different tree)", () => {
    const bg = makeGrid();
    set(bg, 5, 10, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 9, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 8, BLOCK_LEAF_APPLE, 42);
    // Vine with a different tag (climbing a different tree)
    set(bg, 6, 9, BLOCK_VINE_KIWI, 99);

    const felled = fellTree(bg, W, H, 5, 10);
    const blockIds = felled.map((c) => c.blockId);
    expect(blockIds).not.toContain(BLOCK_VINE_KIWI);
  });

  test("does not remove vines not adjacent to the tree", () => {
    const bg = makeGrid();
    set(bg, 5, 10, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 9, BLOCK_WOOD_APPLE, 42);
    set(bg, 5, 8, BLOCK_LEAF_APPLE, 42);
    // Vine far from the tree (not adjacent)
    set(bg, 12, 9, BLOCK_VINE_GRAPE, 42);

    const felled = fellTree(bg, W, H, 5, 10);
    const blockIds = felled.map((c) => c.blockId);
    expect(blockIds).not.toContain(BLOCK_VINE_GRAPE);
  });

  test("returns empty for a non-tree block", () => {
    const bg = makeGrid();
    set(bg, 5, 5, BLOCK_AIR);
    const felled = fellTree(bg, W, H, 5, 5);
    expect(felled.length).toBe(0);
  });

  test("handles a single wood block (no leaves)", () => {
    const bg = makeGrid();
    set(bg, 5, 5, BLOCK_WOOD_APPLE, 42);
    const felled = fellTree(bg, W, H, 5, 5);
    expect(felled.length).toBe(1);
    expect(felled[0].blockId).toBe(BLOCK_WOOD_APPLE);
  });

  test("tag 0 fallback: fells connected untagged trees (backward compat)", () => {
    const bg = makeGrid();
    // Two untagged trees with touching canopies (tag 0 = old save)
    set(bg, 3, 10, BLOCK_WOOD_APPLE, 0);
    set(bg, 3, 9, BLOCK_WOOD_APPLE, 0);
    set(bg, 3, 8, BLOCK_LEAF_APPLE, 0);
    set(bg, 4, 8, BLOCK_LEAF_APPLE, 0);
    set(bg, 5, 10, BLOCK_WOOD_CHERRY, 0);
    set(bg, 5, 9, BLOCK_WOOD_CHERRY, 0);
    set(bg, 5, 8, BLOCK_LEAF_CHERRY, 0);

    const felled = fellTree(bg, W, H, 3, 10);
    // Tag 0 fallback: both connected trees felled (old behavior)
    expect(felled.length).toBe(7);
  });
});
