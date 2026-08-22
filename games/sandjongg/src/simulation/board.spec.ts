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
});
