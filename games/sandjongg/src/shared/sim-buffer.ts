// ============================================================================
// Sandjongg sim-buffer — thin adapter over @downdraft/library-sand GridSimBuffer.
//
// Layout: 1 sand grid layer + input + stats + board region (tile data for
// the renderer to draw tiles without per-change RPCs).
//
// Board region stores elements indexed as [(col + row*cols) * MAX_LAYERS + layer]
// so the renderer can draw multi-layer stacked tiles.
// ============================================================================

import {
    computeGridSimOffsets,
    GridSimBufferReader,
    GridSimBufferWriter,
    type GridSimBufferLayout,
    type GridSimBufferOffsets,
} from "@downdraft/library-sand";
import { MAX_GRID_H, MAX_GRID_W, MAX_TILES } from "./constants";

// --- Layout ---

const LAYOUT: GridSimBufferLayout = {
  numLayers: 1,
  maxGridW: MAX_GRID_W,
  maxGridH: MAX_GRID_H,
  inputBytes: 64,
  statsBytes: 32,
  extraRegions: [
    // Board elements (MAX_TILES * 4 bytes) + meta (4 i32s = 16 bytes).
    { name: "board", bytes: MAX_TILES * 4 + 16 },
  ],
};

export const OFFSETS: GridSimBufferOffsets = computeGridSimOffsets(LAYOUT);

export const NUM_LAYERS = 1;
export const INPUT_BYTES = 64;
export const STATS_BYTES = 32;
export const BOARD_BYTES = MAX_TILES * 4;
export const TOTAL_BYTES = OFFSETS.totalBytes;

export const GRID_OFFSET = OFFSETS.gridOffset[0];
export const FIELD_OFFSET = OFFSETS.fieldOffset[0];
export const INPUT_OFFSET = OFFSETS.inputOffset;
export const STATS_OFFSET = OFFSETS.statsOffset;
export const BOARD_OFFSET = OFFSETS.extraRegionOffset["board"];

// --- Game-specific field offsets ---

export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  RESERVED_2: 2,
  RESERVED_3: 3,
} as const;

export const DEFAULT_GRAVITY = 128;
export const DEFAULT_TEMP = 128;

// --- Input region layout (64 bytes = 16 i32s) ---

export const INPUT = {
  MOUSE_X: 0,
  MOUSE_Y: 4,
  CLICKED_COL: 8,      // tile col of click (-1 = no click)
  CLICKED_ROW: 12,     // tile row of click (-1 = no click)
  ACTION: 16,          // 0=none, 1=match, 2=hint, 3=shuffle, 4=newGame, 5=clear
  SELECTED_COL: 20,    // currently selected tile col (-1 = none)
  SELECTED_ROW: 24,    // currently selected tile row (-1 = none)
  MATCH_A_COL: 28,     // for action=match: first tile col
  MATCH_A_ROW: 32,     // for action=match: first tile row
  MATCH_B_COL: 36,     // for action=match: second tile col
  MATCH_B_ROW: 40,     // for action=match: second tile row
  NEW_LEVEL: 44,       // for action=newGame: level to generate
  CLICKED_LAYER: 48,   // tile layer of click (0 = bottom)
  SELECTED_LAYER: 52,  // currently selected tile layer
  MATCH_A_LAYER: 56,   // for action=match: first tile layer
  MATCH_B_LAYER: 60,   // for action=match: second tile layer
} as const;

// --- Stats region layout (32 bytes = 8 i32s) ---

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
  SCORE: 12,
  COMBO: 16,
  LEVEL: 20,
  TILES_LEFT: 24,
  BOARD_COLS: 28,
} as const;

// --- Board region layout ---
// Board region = MAX_TILES * 4 bytes: element per slot (i32, -1 = empty).
// Indexed as boardElements[(col + row*cols) * MAX_LAYERS + layer].
// Meta: [cols, rows, layers, tileCount] (4 i32s = 16 bytes, placed after).

export const BOARD_ELEMENT_OFFSET = BOARD_OFFSET;
export const BOARD_META_OFFSET = BOARD_OFFSET + MAX_TILES * 4;

// --- Allocation ---

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

// --- Reader/Writer (store SAB reference for game-specific access) ---

export class SimBufferReader extends GridSimBufferReader {
  sab: SharedArrayBuffer;

  constructor(sab: SharedArrayBuffer, offsets: GridSimBufferOffsets, gridW: number, gridH: number) {
    super(sab, offsets, gridW, gridH);
    this.sab = sab;
  }

  getBoardElements(): Int32Array {
    return new Int32Array(this.sab, BOARD_ELEMENT_OFFSET, MAX_TILES);
  }
  getBoardMeta(): Int32Array {
    return new Int32Array(this.sab, BOARD_META_OFFSET, 4);
  }
}

export class SimBufferWriter extends GridSimBufferWriter {
  sab: SharedArrayBuffer;

  constructor(sab: SharedArrayBuffer, offsets: GridSimBufferOffsets, gridW: number, gridH: number) {
    super(sab, offsets, gridW, gridH);
    this.sab = sab;
  }

  writeBoardElements(elements: Int32Array): void {
    const view = new Int32Array(this.sab, BOARD_ELEMENT_OFFSET, MAX_TILES);
    view.set(elements);
  }
  writeBoardMeta(cols: number, rows: number, layers: number, tileCount: number): void {
    const view = new Int32Array(this.sab, BOARD_META_OFFSET, 4);
    view[0] = cols;
    view[1] = rows;
    view[2] = layers;
    view[3] = tileCount;
  }

  init(): void {
    // Initialize board elements to -1 (empty).
    const boardView = new Int32Array(this.sab, BOARD_ELEMENT_OFFSET, MAX_TILES);
    boardView.fill(-1);
  }
}
