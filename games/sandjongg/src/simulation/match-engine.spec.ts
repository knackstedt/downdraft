import { describe, expect, it } from "bun:test";
import { COMBO_WINDOW_MS, TILE_CELL_SIZE } from "../shared/constants";
import { elementToMaterial } from "../shared/elements";
import { TileBoard } from "./board";
import { attemptMatch, resetComboState } from "./match-engine";

const ORIGIN_COL = 0;
const ORIGIN_ROW = 0;
const LAYER = 0;

describe("match-engine", () => {
  it("valid adjacent match succeeds", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER);
    b.place(2, 1, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(true);
    expect(result.path).not.toBeNull();
    expect(result.score).toBeGreaterThan(0);
    expect(result.combo).toBe(1);
    expect(result.crumble.length).toBe(2);
    expect(b.at(1, 1, LAYER)).toBeNull();
    expect(b.at(2, 1, LAYER)).toBeNull();
  });

  it("different elements fail", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER);
    b.place(2, 1, 1, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("different-element");
    expect(result.score).toBe(0);
  });

  it("same tile fails", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 1, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("same-tile");
  });

  it("no tile fails", () => {
    const b = new TileBoard(6, 6);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-tile");
  });

  it("no path fails", () => {
    const b = new TileBoard(6, 6);
    // Surround (1,1) with walls.
    b.place(0, 0, 1, LAYER); b.place(1, 0, 1, LAYER); b.place(2, 0, 1, LAYER);
    b.place(0, 1, 1, LAYER); b.place(1, 1, 0, LAYER); b.place(2, 1, 1, LAYER);
    b.place(0, 2, 1, LAYER); b.place(1, 2, 1, LAYER); b.place(2, 2, 1, LAYER);
    b.place(4, 4, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 4, 4, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-path");
  });

  it("combo increments within window", () => {
    const b1 = new TileBoard(8, 6);
    b1.place(1, 1, 0, LAYER);
    b1.place(6, 1, 0, LAYER);
    b1.place(1, 4, 1, LAYER);
    b1.place(6, 4, 1, LAYER);
    const state = resetComboState();
    const r1 = attemptMatch(b1, 1, 1, LAYER, 6, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(r1.combo).toBe(1);
    // Second match within the combo window.
    const r2 = attemptMatch(b1, 1, 4, LAYER, 6, 4, LAYER, state, 1000 + COMBO_WINDOW_MS - 1, ORIGIN_COL, ORIGIN_ROW);
    expect(r2.combo).toBe(2);
    expect(r2.score).toBeGreaterThan(r1.score); // combo multiplier
  });

  it("combo resets after window expires", () => {
    const b = new TileBoard(8, 6);
    b.place(1, 1, 0, LAYER);
    b.place(6, 1, 0, LAYER);
    b.place(1, 4, 0, LAYER);
    b.place(6, 4, 0, LAYER);
    const state = resetComboState();
    const r1 = attemptMatch(b, 1, 1, LAYER, 6, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(r1.combo).toBe(1);
    // Second match after the combo window.
    const r2 = attemptMatch(b, 1, 4, LAYER, 6, 4, LAYER, state, 1000 + COMBO_WINDOW_MS + 1, ORIGIN_COL, ORIGIN_ROW);
    expect(r2.combo).toBe(1);
  });

  it("crumble events carry correct sand material", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER); // Fire → Lava
    b.place(2, 1, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.crumble[0].sandMaterial).toBe(elementToMaterial(0));
    expect(result.crumble[1].sandMaterial).toBe(elementToMaterial(0));
  });

  it("crumble events carry correct sand coordinates", () => {
    const b = new TileBoard(6, 6);
    b.place(2, 3, 5, LAYER); // Ice
    b.place(4, 3, 5, LAYER);
    const state = resetComboState();
    const originCol = 10;
    const originRow = 20;
    const result = attemptMatch(b, 2, 3, LAYER, 4, 3, LAYER, state, 1000, originCol, originRow);
    // TILE_CELL_SIZE is the sand-cell footprint per tile.
    expect(result.crumble[0].sandCol).toBe(originCol + 2 * TILE_CELL_SIZE);
    expect(result.crumble[0].sandRow).toBe(originRow + 3 * TILE_CELL_SIZE);
    expect(result.crumble[1].sandCol).toBe(originCol + 4 * TILE_CELL_SIZE);
    expect(result.crumble[1].sandRow).toBe(originRow + 3 * TILE_CELL_SIZE);
  });

  it("score is never negative", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER);
    b.place(2, 1, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("resetComboState starts with combo 0", () => {
    const state = resetComboState();
    expect(state.combo).toBe(0);
    expect(state.lastMatchTime).toBe(0);
  });

  it("first match always has combo 1 (even if state.combo was 0)", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0, LAYER);
    b.place(2, 1, 0, LAYER);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, LAYER, 2, 1, LAYER, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.combo).toBe(1);
  });

  it("multi-layer: tile under another is not selectable", () => {
    const b = new TileBoard(6, 6, 2);
    b.place(1, 1, 0, 0); // bottom layer
    b.place(1, 1, 0, 1); // top layer (blocks selection of bottom)
    b.place(2, 1, 0, 0);
    const state = resetComboState();
    // Try to match the bottom tile at (1,1) — should fail (not selectable).
    const result = attemptMatch(b, 1, 1, 0, 2, 1, 0, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-selectable");
  });

  it("multi-layer: top tile is selectable and matchable", () => {
    const b = new TileBoard(6, 6, 2);
    b.place(1, 1, 0, 0); // bottom
    b.place(1, 1, 0, 1); // top (same element)
    b.place(2, 1, 0, 1); // top layer, same element
    const state = resetComboState();
    // Match the two top-layer tiles.
    const result = attemptMatch(b, 1, 1, 1, 2, 1, 1, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(true);
    expect(b.at(1, 1, 1)).toBeNull();
    expect(b.at(2, 1, 1)).toBeNull();
    // Bottom tile should still be there.
    expect(b.at(1, 1, 0)).not.toBeNull();
  });

  it("multi-layer: different layers cannot be matched", () => {
    const b = new TileBoard(6, 6, 2);
    b.place(1, 1, 0, 0);
    b.place(2, 1, 0, 1);
    const state = resetComboState();
    const result = attemptMatch(b, 1, 1, 0, 2, 1, 1, state, 1000, ORIGIN_COL, ORIGIN_ROW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("different-layer");
  });
});
