import { MAX_GRID_H, MAX_GRID_W } from "./constants";

// ============================================================================
// SharedArrayBuffer layout for the falling-sand sim ↔ renderer bridge
//
// The grid area is MAX_GRID_W * MAX_GRID_H cells × 4 bytes, but only the
// first gridW * gridH cells are used. The actual grid dimensions are
// dynamic and passed separately.
//
// Layout:
//   [0 .. MAX_GRID_BYTES)         — material grid (Uint32 per cell)
//   [MAX_GRID_BYTES .. +FIELD_BYTES) — physics field grid (4 bytes per cell:
//       gravity:u8, temp:u8, windX:i8, windY:i8)
//   [.. +INPUT_BYTES)             — input state
//   [.. +STATS_BYTES)             — stats
// ============================================================================

export const MAX_GRID_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const MAX_FIELD_BYTES = MAX_GRID_W * MAX_GRID_H * 4; // 4 bytes per cell
export const INPUT_BYTES = 96;
export const STATS_BYTES = 16;

export const TOTAL_BYTES = MAX_GRID_BYTES + MAX_FIELD_BYTES + INPUT_BYTES + STATS_BYTES;

export const GRID_OFFSET = 0;
export const FIELD_OFFSET = MAX_GRID_BYTES;
export const INPUT_OFFSET = MAX_GRID_BYTES + MAX_FIELD_BYTES;
export const STATS_OFFSET = MAX_GRID_BYTES + MAX_FIELD_BYTES + INPUT_BYTES;

// Field byte offsets within each 4-byte field cell
export const FIELD = {
  GRAVITY: 0,  // u8: 0-255, 128 = 1× gravity
  TEMP: 1,     // u8: 0-255, 128 = normal temp (1.0)
  WIND_X: 2,   // i8: -128 to 127, 0 = no wind
  WIND_Y: 3,   // i8: -128 to 127, 0 = no wind
} as const;

// Default field values (encoded)
export const DEFAULT_GRAVITY = 128; // 1.0×
export const DEFAULT_TEMP = 128;    // 1.0
export const DEFAULT_WIND = 0;      // no wind

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
  // Brush mode: 0 = material, 1 = field
  BRUSH_MODE: 56,
  // When brush mode = field: which field to paint (0=gravity, 1=temp, 2=windX, 3=windY)
  FIELD_TYPE: 60,
  // Field value to paint (i32 × 1000)
  FIELD_VALUE: 64,
  // Impulse settings
  IMPULSE_CHANCE: 68,
  IMPULSE_STRENGTH: 72,
  // Toggle: show field overlay
  SHOW_FIELDS: 76,
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

  init(): void {
    // Zero input region
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + INPUT_BYTES) / 4);
    // Initialize field grid to defaults
    const fieldBytes = this.gridW * this.gridH * 4;
    for (let i = 0; i < fieldBytes; i += 4) {
      this.u8[FIELD_OFFSET + i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.u8[FIELD_OFFSET + i + FIELD.TEMP] = DEFAULT_TEMP;
      this.u8[FIELD_OFFSET + i + FIELD.WIND_X] = DEFAULT_WIND;
      this.u8[FIELD_OFFSET + i + FIELD.WIND_Y] = DEFAULT_WIND;
    }
  }
}
