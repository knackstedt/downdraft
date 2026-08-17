// ============================================================================
// SharedArrayBuffer reader/writer for the mining-rpg sim ↔ renderer bridge.
//
// The SAB holds the active grid (a contiguous window of chunks centered on the
// player), its field grid, the input region, stats, and player state.
// The worker writes the grid + fields + player + stats each tick; the renderer
// reads them. The renderer writes input (keyboard, mouse, dig radius).
// ============================================================================

import {
    BG_GRID_OFFSET,
    FIELD_OFFSET,
    GRID_OFFSET,
    INPUT_OFFSET,
    PLAYER_OFFSET,
    STATS_OFFSET,
    TOTAL_SAB_BYTES
} from "./constants";

export function allocateMiningSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_SAB_BYTES);
}

export class MiningSimBufferReader {
  private u32: Uint32Array;
  private buf: Int32Array;
  private u8: Uint8Array;
  private f32: Float32Array;
  activeGridW: number;
  activeGridH: number;

  constructor(sab: SharedArrayBuffer, activeGridW: number, activeGridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.f32 = new Float32Array(sab);
    this.activeGridW = activeGridW;
    this.activeGridH = activeGridH;
  }

  setDims(w: number, h: number): void {
    this.activeGridW = w;
    this.activeGridH = h;
  }

  /** Get a view of the active grid (Uint32Array, length = activeGridW * activeGridH). */
  getGrid(): Uint32Array {
    const off = GRID_OFFSET / 4;
    return this.u32.subarray(off, off + this.activeGridW * this.activeGridH);
  }

  /** Get a view of the active field grid (Uint8Array). */
  getFields(): Uint8Array {
    const off = FIELD_OFFSET;
    return this.u8.subarray(off, off + this.activeGridW * this.activeGridH * 4);
  }

  /** Get a view of the background grid (Uint32Array — build materials layer). */
  getBackgroundGrid(): Uint32Array {
    const off = BG_GRID_OFFSET / 4;
    return this.u32.subarray(off, off + this.activeGridW * this.activeGridH);
  }

  getInput(field: number): number {
    return this.buf[INPUT_OFFSET / 4 + field / 4];
  }

  getInputF32(field: number): number {
    return this.f32[(INPUT_OFFSET + field) / 4];
  }

  getStat(field: number): number {
    return this.buf[STATS_OFFSET / 4 + field / 4];
  }

  getPlayerF32(field: number): number {
    return this.f32[(PLAYER_OFFSET + field) / 4];
  }

  getPlayerI32(field: number): number {
    return this.buf[PLAYER_OFFSET / 4 + field / 4];
  }
}

export class MiningSimBufferWriter {
  private buf: Int32Array;
  private u32: Uint32Array;
  private u8: Uint8Array;
  private f32: Float32Array;
  activeGridW: number;
  activeGridH: number;

  constructor(sab: SharedArrayBuffer, activeGridW: number, activeGridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.f32 = new Float32Array(sab);
    this.activeGridW = activeGridW;
    this.activeGridH = activeGridH;
  }

  setDims(w: number, h: number): void {
    this.activeGridW = w;
    this.activeGridH = h;
  }

  writeGrid(grid: Uint32Array): void {
    const off = GRID_OFFSET / 4;
    this.u32.set(grid.subarray(0, this.activeGridW * this.activeGridH), off);
  }

  writeFields(fields: Uint8Array): void {
    const off = FIELD_OFFSET;
    this.u8.set(fields.subarray(0, this.activeGridW * this.activeGridH * 4), off);
  }

  writeBackgroundGrid(grid: Uint32Array): void {
    const off = BG_GRID_OFFSET / 4;
    this.u32.set(grid.subarray(0, this.activeGridW * this.activeGridH), off);
  }

  writeInput(field: number, value: number): void {
    this.buf[INPUT_OFFSET / 4 + field / 4] = value;
  }

  writeInputF32(field: number, value: number): void {
    this.f32[(INPUT_OFFSET + field) / 4] = value;
  }

  writeStat(field: number, value: number): void {
    this.buf[STATS_OFFSET / 4 + field / 4] = value;
  }

  writePlayerF32(field: number, value: number): void {
    this.f32[(PLAYER_OFFSET + field) / 4] = value;
  }

  writePlayerI32(field: number, value: number): void {
    this.buf[PLAYER_OFFSET / 4 + field / 4] = value;
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + 128) / 4);
  }
}
