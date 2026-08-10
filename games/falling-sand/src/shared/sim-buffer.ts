import { MAX_GRID_H, MAX_GRID_W, MAX_MAGNETS } from "./constants";

// ============================================================================
// SharedArrayBuffer layout for the falling-sand sim ↔ renderer bridge
//
// The grid area is MAX_GRID_W * MAX_GRID_H cells × 4 bytes, but only the
// first gridW * gridH cells are used. The actual grid dimensions are
// dynamic and passed separately.
// ============================================================================

export const MAX_GRID_BYTES = MAX_GRID_W * MAX_GRID_H * 4;
export const INPUT_BYTES = 64;
export const MAGNET_BYTES = MAX_MAGNETS * 8;
export const STATS_BYTES = 16;

export const TOTAL_BYTES = MAX_GRID_BYTES + INPUT_BYTES + MAGNET_BYTES + STATS_BYTES;

export const GRID_OFFSET = 0;
export const INPUT_OFFSET = MAX_GRID_BYTES;
export const MAGNET_OFFSET = MAX_GRID_BYTES + INPUT_BYTES;
export const STATS_OFFSET = MAX_GRID_BYTES + INPUT_BYTES + MAGNET_BYTES;

export const INPUT = {
  LEFT: 0,
  RIGHT: 4,
  UP: 8,
  DOWN: 12,
  JUMP: 16,
  MOUSE_DOWN: 20,
  MOUSE_RIGHT: 24,
  MAGNET: 28,
  MOUSE_X: 32,
  MOUSE_Y: 36,
  SELECTED_MAT: 40,
  BRUSH_RADIUS: 44,
  LAST_MOUSE_X: 48,
  LAST_MOUSE_Y: 52,
} as const;

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
  GRID_W: 12,
  GRID_H: 16,
} as const;

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

export class SimBufferReader {
  private u32: Uint32Array;
  private buf: Int32Array;
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
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
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
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

  writeInput(field: number, value: number): void {
    this.buf[INPUT_OFFSET / 4 + field / 4] = value;
  }

  clearMagnets(): void {
    for (let i = 0; i < MAX_MAGNETS; i++) {
      this.buf[MAGNET_OFFSET / 4 + i * 2] = -1;
    }
  }

  writeStat(field: number, value: number): void {
    this.buf[STATS_OFFSET / 4 + field / 4] = value;
  }

  init(): void {
    this.clearMagnets();
  }
}
