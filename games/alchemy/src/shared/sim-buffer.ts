import { MAX_GRID_H, MAX_GRID_W } from "./constants";

// ============================================================================
// SharedArrayBuffer layout for the alchemy sim ↔ renderer bridge
//
// Single cauldron layer with material grid + physics field grid, plus shared
// input + stats + mixture-histogram regions.
//
// Layout:
//   grid:     MAX_GRID_W * MAX_GRID_H * 4 bytes (Uint32 per cell)
//   fields:   MAX_GRID_W * MAX_GRID_H * 4 bytes (gravity:u8, temp:u8, windX:i8, windY:i8)
//   input:    128 bytes
//   stats:    16 bytes
//   mixture:  256 * 4 bytes (u32 count per material id — the cell histogram)
// ============================================================================

export const NUM_LAYERS = 1;

export const MAX_GRID_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const MAX_FIELD_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const LAYER_BYTES = MAX_GRID_BYTES + MAX_FIELD_BYTES;
export const ALL_LAYERS_BYTES = LAYER_BYTES * NUM_LAYERS;
export const INPUT_BYTES = 128;
export const STATS_BYTES = 16;
// 256 material ids × 4 bytes per u32 count
export const MIXTURE_BYTES = 256 * 4;

export const TOTAL_BYTES = ALL_LAYERS_BYTES + INPUT_BYTES + STATS_BYTES + MIXTURE_BYTES;

// Per-layer offsets (single layer)
export const GRID_OFFSET = 0;
export const FIELD_OFFSET = MAX_GRID_BYTES;

export const INPUT_OFFSET = ALL_LAYERS_BYTES;
export const STATS_OFFSET = ALL_LAYERS_BYTES + INPUT_BYTES;
export const MIXTURE_OFFSET = ALL_LAYERS_BYTES + INPUT_BYTES + STATS_BYTES;

// Field byte offsets within each 4-byte field cell
export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  WIND_X: 2,
  WIND_Y: 3,
} as const;

export const DEFAULT_GRAVITY = 128;
export const DEFAULT_TEMP = 128;
export const DEFAULT_WIND = 0;

export const INPUT = {
  MOUSE_DOWN: 0,
  MOUSE_RIGHT: 4,
  MOUSE_X: 8,
  MOUSE_Y: 12,
  SELECTED_MAT: 16,
  BRUSH_RADIUS: 20,
  LAST_MOUSE_X: 24,
  LAST_MOUSE_Y: 28,
  // 32..76 reserved for future use
} as const;

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
} as const;

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

export class SimBufferReader {
  private u32: Uint32Array;
  private buf: Int32Array;
  private u8: Uint8Array;
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.gridW = gridW;
    this.gridH = gridH;
  }

  setDims(w: number, h: number): void {
    this.gridW = w;
    this.gridH = h;
  }

  getGrid(): Uint32Array {
    return this.u32.subarray(GRID_OFFSET / 4, GRID_OFFSET / 4 + this.gridW * this.gridH);
  }

  getFieldGrid(): Uint8Array {
    return this.u8.subarray(FIELD_OFFSET, FIELD_OFFSET + this.gridW * this.gridH * 4);
  }

  getInput(field: number): number {
    return this.buf[INPUT_OFFSET / 4 + field / 4];
  }

  getStat(field: number): number {
    return this.buf[STATS_OFFSET / 4 + field / 4];
  }

  getMixtureHistogram(): Uint32Array {
    return this.u32.subarray(MIXTURE_OFFSET / 4, MIXTURE_OFFSET / 4 + 256);
  }
}

export class SimBufferWriter {
  private buf: Int32Array;
  private u32: Uint32Array;
  private u8: Uint8Array;
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.gridW = gridW;
    this.gridH = gridH;
  }

  setDims(w: number, h: number): void {
    this.gridW = w;
    this.gridH = h;
  }

  writeGrid(grid: Uint32Array): void {
    this.u32.set(grid.subarray(0, this.gridW * this.gridH), GRID_OFFSET / 4);
  }

  writeFieldGrid(fields: Uint8Array): void {
    this.u8.set(fields.subarray(0, this.gridW * this.gridH * 4), FIELD_OFFSET);
  }

  writeInput(field: number, value: number): void {
    this.buf[INPUT_OFFSET / 4 + field / 4] = value;
  }

  writeStat(field: number, value: number): void {
    this.buf[STATS_OFFSET / 4 + field / 4] = value;
  }

  writeMixtureHistogram(histogram: Uint32Array): void {
    this.u32.set(histogram.subarray(0, 256), MIXTURE_OFFSET / 4);
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + INPUT_BYTES) / 4);
    // Initialize field grid to defaults
    const off = FIELD_OFFSET;
    const size = this.gridW * this.gridH * 4;
    for (let i = 0; i < size; i += 4) {
      this.u8[off + i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.u8[off + i + FIELD.TEMP] = DEFAULT_TEMP;
    }
  }
}
