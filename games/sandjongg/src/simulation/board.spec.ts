import { describe, expect, it } from "bun:test";
import { TileBoard } from "./board";

describe("TileBoard", () => {
  it("starts empty", () => {
    const b = new TileBoard(4, 4);
    expect(b.remainingCount()).toBe(0);
    expect(b.isCleared()).toBe(true);
    expect(b.elementsLeft()).toBe(0);
  });

  it("place and at", () => {
    const b = new TileBoard(4, 4);
    const t = b.place(2, 1, 5);
    expect(t.element).toBe(5);
    expect(t.col).toBe(2);
    expect(t.row).toBe(1);
    expect(b.at(2, 1)).toBe(t);
    expect(b.remainingCount()).toBe(1);
    expect(b.isCleared()).toBe(false);
    expect(b.elementsLeft()).toBe(1);
  });

  it("remove returns the tile and clears the cell", () => {
    const b = new TileBoard(4, 4);
    b.place(1, 1, 3);
    const removed = b.remove(1, 1);
    expect(removed).not.toBeNull();
    expect(removed!.element).toBe(3);
    expect(b.at(1, 1)).toBeNull();
    expect(b.isEmpty(1, 1)).toBe(true);
    expect(b.remainingCount()).toBe(0);
  });

  it("remove on empty cell returns null", () => {
    const b = new TileBoard(4, 4);
    expect(b.remove(0, 0)).toBeNull();
  });

  it("out-of-bounds at returns null", () => {
    const b = new TileBoard(4, 4);
    expect(b.at(-1, 0)).toBeNull();
    expect(b.at(0, -1)).toBeNull();
    expect(b.at(4, 0)).toBeNull();
    expect(b.at(0, 4)).toBeNull();
  });

  it("isEmpty is false for out-of-bounds", () => {
    const b = new TileBoard(4, 4);
    expect(b.isEmpty(-1, 0)).toBe(false);
    expect(b.isEmpty(4, 0)).toBe(false);
  });

  it("place out of bounds throws", () => {
    const b = new TileBoard(4, 4);
    expect(() => b.place(4, 0, 0)).toThrow();
    expect(() => b.place(0, 4, 0)).toThrow();
  });

  it("allTiles returns all placed tiles", () => {
    const b = new TileBoard(4, 4);
    b.place(0, 0, 1);
    b.place(3, 3, 2);
    b.place(1, 2, 1);
    const tiles = b.allTiles();
    expect(tiles.length).toBe(3);
  });

  it("elementsLeft counts distinct elements", () => {
    const b = new TileBoard(4, 4);
    b.place(0, 0, 1);
    b.place(1, 0, 1);
    b.place(2, 0, 2);
    b.place(3, 0, 3);
    expect(b.elementsLeft()).toBe(3);
  });

  it("serialize and deserialize round-trip", () => {
    const b = new TileBoard(4, 3);
    b.place(0, 0, 1);
    b.place(3, 2, 5);
    b.place(1, 1, 1);
    const data = b.serialize();
    const b2 = TileBoard.deserialize(data);
    expect(b2.cols).toBe(4);
    expect(b2.rows).toBe(3);
    expect(b2.remainingCount()).toBe(3);
    expect(b2.at(0, 0)!.element).toBe(1);
    expect(b2.at(3, 2)!.element).toBe(5);
    expect(b2.at(1, 1)!.element).toBe(1);
    expect(b2.at(2, 1)).toBeNull();
  });

  it("tile ids are unique and incrementing", () => {
    const b = new TileBoard(4, 4);
    const t1 = b.place(0, 0, 0);
    const t2 = b.place(1, 0, 0);
    const t3 = b.place(2, 0, 0);
    expect(t1.id).toBeLessThan(t2.id);
    expect(t2.id).toBeLessThan(t3.id);
  });

  // --- Mahjongg mode selectability (free-tile rule) ---

  it("mahjongg: edge tile with no horizontal neighbour is free", () => {
    const b = new TileBoard(4, 4, 1, "mahjongg");
    b.place(0, 0, 0);
    // col 0 → left side is off-board (empty) → free.
    expect(b.isSelectable(0, 0, 0)).toBe(true);
  });

  it("mahjongg: tile hemmed in horizontally is not free", () => {
    const b = new TileBoard(4, 4, 1, "mahjongg");
    b.place(1, 0, 0);
    b.place(0, 0, 1);
    b.place(2, 0, 2);
    // (1,0) has tiles on both left and right → not free.
    expect(b.isSelectable(1, 0, 0)).toBe(false);
  });

  it("mahjongg: tile with a tile on top is not free", () => {
    const b = new TileBoard(4, 4, 2, "mahjongg");
    b.place(1, 0, 0, 0);
    b.place(1, 0, 1, 1);
    // (1,0,0) is covered by layer 1 → not free, even though horizontally open.
    expect(b.isSelectable(1, 0, 0)).toBe(false);
    // (1,0,1) is on top and horizontally open → free.
    expect(b.isSelectable(1, 0, 1)).toBe(true);
  });

  it("mahjongg: selectableTiles returns only free tiles across layers", () => {
    const b = new TileBoard(3, 1, 2, "mahjongg");
    b.place(0, 0, 0, 0);
    b.place(1, 0, 0, 0); // hemmed in (left + right both occupied at layer 0)
    b.place(2, 0, 0, 0);
    b.place(1, 0, 1, 1); // on top of (1,0,0), horizontally open → free
    const sel = b.selectableTiles();
    // Free: (0,0,0) [left edge], (2,0,0) [right edge], (1,0,1) [top, open].
    // (1,0,0) is hemmed in AND covered → not free.
    expect(sel.length).toBe(3);
    expect(sel.some((t) => t.col === 0 && t.layer === 0)).toBe(true);
    expect(sel.some((t) => t.col === 2 && t.layer === 0)).toBe(true);
    expect(sel.some((t) => t.col === 1 && t.layer === 1)).toBe(true);
  });

  it("mahjongg: serialize/deserialize preserves mode", () => {
    const b = new TileBoard(4, 4, 2, "mahjongg");
    b.place(0, 0, 0, 0);
    b.place(3, 0, 0, 0);
    const restored = TileBoard.deserialize(b.serialize());
    expect(restored.mode).toBe("mahjongg");
  });

  it("sandjongg mode keeps per-layer top-down lock (default)", () => {
    const b = new TileBoard(4, 4, 2); // default mode = sandjongg
    b.place(0, 0, 0, 0);
    b.place(0, 0, 1, 1);
    // Only the highest occupied layer (1) is selectable.
    expect(b.isSelectable(0, 0, 1)).toBe(true);
    expect(b.isSelectable(0, 0, 0)).toBe(false);
  });
});
