import { MAX_GRID_H, MAX_GRID_W } from "./constants";

// ============================================================================
// SharedArrayBuffer layout for the falling-sand sim ↔ renderer bridge
//
// Supports N_LAYER layers, each with its own material grid + physics field grid.
//
// Layout (per layer):
//   grid:   MAX_GRID_W * MAX_GRID_H * 4 bytes (Uint32 per cell)
//   fields: MAX_GRID_W * MAX_GRID_H * 4 bytes (gravity:u8, temp:u8, windX:i8, windY:i8)
//
// Then shared input + stats regions.
// ============================================================================

export const NUM_LAYERS = 2;

export const MAX_GRID_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const MAX_FIELD_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const LAYER_BYTES = MAX_GRID_BYTES + MAX_FIELD_BYTES;
export const ALL_LAYERS_BYTES = LAYER_BYTES * NUM_LAYERS;
export const INPUT_BYTES = 128;
export const STATS_BYTES = 16;

export const TOTAL_BYTES = ALL_LAYERS_BYTES + INPUT_BYTES + STATS_BYTES;

// Per-layer offsets
export function gridOffset(layer: number): number {
  return layer * LAYER_BYTES;
}

export function fieldOffset(layer: number): number {
  return layer * LAYER_BYTES + MAX_GRID_BYTES;
}

export const INPUT_OFFSET = ALL_LAYERS_BYTES;
export const STATS_OFFSET = ALL_LAYERS_BYTES + INPUT_BYTES;

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
  LEFT: 0,
  RIGHT: 4,
  UP: 8,
  DOWN: 12,
  JUMP: 16,
  MOUSE_DOWN: 20,
  MOUSE_RIGHT: 24,
  // offset 28 reserved
  MOUSE_X: 32,
  MOUSE_Y: 36,
  SELECTED_MAT: 40,
  BRUSH_RADIUS: 44,
  LAST_MOUSE_X: 48,
  LAST_MOUSE_Y: 52,
  BRUSH_MODE: 56,    // 0 = material, 1 = field
  FIELD_TYPE: 60,    // 0=gravity, 1=temp, 2=windX, 3=windY
  FIELD_VALUE: 64,   // raw byte value
  IMPULSE_CHANCE: 68,
  IMPULSE_STRENGTH: 72,
  SHOW_FIELDS: 76,
  ACTIVE_LAYER: 80,  // which layer the brush paints on (0 or 1)
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

  getGrid(layer: number): Uint32Array {
    const off = gridOffset(layer) / 4;
    return this.u32.subarray(off, off + this.gridW * this.gridH);
  }

  getFieldGrid(layer: number): Uint8Array {
    const off = fieldOffset(layer);
    return this.u8.subarray(off, off + this.gridW * this.gridH * 4);
  }

  getInput(field: number): number {
    return this.buf[INPUT_OFFSET / 4 + field / 4];
  }

  getStat(field: number): number {
    return this.buf[STATS_OFFSET / 4 + field / 4];
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

  writeGrid(layer: number, grid: Uint32Array): void {
    const off = gridOffset(layer) / 4;
    this.u32.set(grid.subarray(0, this.gridW * this.gridH), off);
  }

  writeFieldGrid(layer: number, fields: Uint8Array): void {
    const off = fieldOffset(layer);
    this.u8.set(fields.subarray(0, this.gridW * this.gridH * 4), off);
  }

  writeInput(field: number, value: number): void {
    this.buf[INPUT_OFFSET / 4 + field / 4] = value;
  }

  writeStat(field: number, value: number): void {
    this.buf[STATS_OFFSET / 4 + field / 4] = value;
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + INPUT_BYTES) / 4);
    // Initialize all layer field grids to defaults
    for (let layer = 0; layer < NUM_LAYERS; layer++) {
      const off = fieldOffset(layer);
      const size = this.gridW * this.gridH * 4;
      for (let i = 0; i < size; i += 4) {
        this.u8[off + i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
        this.u8[off + i + FIELD.TEMP] = DEFAULT_TEMP;
      }
    }
  }
}
