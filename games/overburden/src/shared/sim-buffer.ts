// ============================================================================
// Overburden — SharedArrayBuffer layout
//
// The SAB transfers grid data + blockhead state from the sim worker to the
// renderer without copying. The renderer reads from the SAB each frame.
// ============================================================================

import {
    ACTIVE_GRID_CELLS,
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
} from "./constants";
import { BH_STRIDE, MAX_BLOCKHEADS } from "./types";

// --- SAB layout ---
// All offsets are in bytes. All arrays are views into the same buffer.
//
// Region          Size (bytes)     Description
// ---------------------------------------------------------------
// HEADER          48               tick, originCx, originCy, blockheadCount,
//                                  daylight, mineX, mineY, mineDamage,
//                                  selectedSlot, dropCount
// GRID_FOREGROUND 2 * AG_CELLS     Uint16Array — foreground blocks
// GRID_BACKGROUND 2 * AG_CELLS     Uint16Array — background blocks
// GRID_LIGHT      4 * AG_CELLS     Uint8Array — RGBA8 light (R,G,B,A per cell)
// GRID_EXPLORED   1 * AG_CELLS     Uint8Array — fog of war
// BLOCKHEADS      4 * BH_STRIDE * MAX_BLOCKHEADS  Float32Array — blockhead state
// DROPS           4 * DROP_STRIDE * MAX_DROPS     Float32Array — world drop items
// INPUT           128              Int32Array + Float32Array — input from renderer

export const HEADER_SIZE = 48;
export const GRID_FG_OFFSET = HEADER_SIZE;
export const GRID_FG_SIZE = 2 * ACTIVE_GRID_CELLS;
export const GRID_BG_OFFSET = GRID_FG_OFFSET + GRID_FG_SIZE;
export const GRID_BG_SIZE = 2 * ACTIVE_GRID_CELLS;
export const GRID_LIGHT_OFFSET = GRID_BG_OFFSET + GRID_BG_SIZE;
export const GRID_LIGHT_SIZE = 4 * ACTIVE_GRID_CELLS; // RGBA8 per cell
export const GRID_EXPLORED_OFFSET = GRID_LIGHT_OFFSET + GRID_LIGHT_SIZE;
export const GRID_EXPLORED_SIZE = ACTIVE_GRID_CELLS;
export const BLOCKHEADS_OFFSET = GRID_EXPLORED_OFFSET + GRID_EXPLORED_SIZE;
export const BLOCKHEADS_SIZE = 4 * BH_STRIDE * MAX_BLOCKHEADS;

// --- Drop entities (world drops that spin + can be picked up) ---
// Per drop: x, y, vx, vy, spin, spinSpeed, itemCode, lifetime = 8 floats
export const DROP_STRIDE = 8;
export const MAX_DROPS = 512;
export const DROPS_OFFSET = BLOCKHEADS_OFFSET + BLOCKHEADS_SIZE;
export const DROPS_SIZE = 4 * DROP_STRIDE * MAX_DROPS;

export const INPUT_OFFSET = DROPS_OFFSET + DROPS_SIZE;
export const INPUT_SIZE = 128; // 32 Int32s or 32 Float32s

export const SAB_SIZE =
  HEADER_SIZE +
  GRID_FG_SIZE +
  GRID_BG_SIZE +
  GRID_LIGHT_SIZE +
  GRID_EXPLORED_SIZE +
  BLOCKHEADS_SIZE +
  DROPS_SIZE +
  INPUT_SIZE;

// --- Input field offsets (within the 128-byte input region) ---
// Int32 fields (booleans as 0/1):
export const INP_LEFT = 0;       // Int32
export const INP_RIGHT = 4;      // Int32
export const INP_UP = 8;         // Int32
export const INP_DOWN = 12;      // Int32
export const INP_JUMP = 16;      // Int32
export const INP_NOCLIP = 20;    // Int32
export const INP_MINE_ACTIVE = 24;  // Int32 (1 = mining)
export const INP_PLACE_ACTIVE = 28; // Int32 (1 = placing)
// Float32 fields:
export const INP_MINE_X = 32;    // Float32 (world X)
export const INP_MINE_Y = 36;    // Float32 (world Y)
export const INP_PLACE_X = 40;   // Float32 (world X)
export const INP_PLACE_Y = 44;   // Float32 (world Y)
export const INP_PLACE_BLOCK = 48; // Int32 (block ID to place)
export const INP_CAMERA_X = 52;  // Float32 (camera center X in active grid coords)
export const INP_CAMERA_Y = 56;  // Float32 (camera center Y in active grid coords)
export const INP_ACTIVE_BH = 80; // Int32 — index of the directly-controlled blockhead (slot 20)
export const INP_CAMERA_ZOOM = 60;  // Float32 (camera zoom — px per block)
export const INP_CAMERA_CW = 64;    // Float32 (canvas width in CSS px)
export const INP_CAMERA_CH = 68;    // Float32 (canvas height in CSS px)
export const INP_CAM_WORLD_X = 72;  // Float32 (camera world X — origin-independent, for grid-builder culling)
export const INP_CAM_WORLD_Y = 76;  // Float32 (camera world Y — origin-independent, for grid-builder culling)

// --- Header field offsets (within the 32-byte header) ---
export const HDR_TICK = 0;        // Uint32 — current sim tick
export const HDR_ORIGIN_CX = 4;   // Int32 — active grid origin chunk X
export const HDR_ORIGIN_CY = 8;   // Int32 — active grid origin chunk Y
export const HDR_BH_COUNT = 12;   // Uint32 — number of blockheads
export const HDR_GRID_W = 16;     // Int32 — active grid width
export const HDR_GRID_H = 20;     // Int32 — active grid height
export const HDR_DAYLIGHT = 24;   // Float32 — daylight level (0-15)
export const HDR_MINE_X = 28;     // Int32 — mining target X (-1 = none)
export const HDR_MINE_Y = 32;     // Int32 — mining target Y (-1 = none)
export const HDR_MINE_DAMAGE = 36; // Float32 — mining damage progress (0-1)
export const HDR_SELECTED_SLOT = 40; // Int32 — selected hotbar slot
export const HDR_DROP_COUNT = 44;    // Uint32 — number of active drop entities

// --- Writer (sim worker side) ---
export class SimBufferWriter {
  readonly buffer: SharedArrayBuffer;
  readonly header: Uint8Array;
  readonly foreground: Uint16Array;
  readonly background: Uint16Array;
  readonly light: Uint8Array;
  readonly explored: Uint8Array;
  readonly blockheads: Float32Array;
  readonly drops: Float32Array;
  readonly inputInt32: Int32Array;
  readonly inputF32: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.buffer = sab;
    this.header = new Uint8Array(sab, 0, HEADER_SIZE);
    this.foreground = new Uint16Array(sab, GRID_FG_OFFSET, ACTIVE_GRID_CELLS);
    this.background = new Uint16Array(sab, GRID_BG_OFFSET, ACTIVE_GRID_CELLS);
    this.light = new Uint8Array(sab, GRID_LIGHT_OFFSET, 4 * ACTIVE_GRID_CELLS);
    this.explored = new Uint8Array(sab, GRID_EXPLORED_OFFSET, ACTIVE_GRID_CELLS);
    this.blockheads = new Float32Array(sab, BLOCKHEADS_OFFSET, BH_STRIDE * MAX_BLOCKHEADS);
    this.drops = new Float32Array(sab, DROPS_OFFSET, DROP_STRIDE * MAX_DROPS);
    this.inputInt32 = new Int32Array(sab, INPUT_OFFSET, INPUT_SIZE / 4);
    this.inputF32 = new Float32Array(sab, INPUT_OFFSET, INPUT_SIZE / 4);
  }

  writeHeader(
    tick: number, originCx: number, originCy: number, bhCount: number,
    daylight: number, mineX: number = -1, mineY: number = -1, mineDamage: number = 0,
    selectedSlot: number = 0, dropCount: number = 0,
  ): void {
    const view = new DataView(this.buffer, 0, HEADER_SIZE);
    view.setUint32(HDR_TICK, tick, true);
    view.setInt32(HDR_ORIGIN_CX, originCx, true);
    view.setInt32(HDR_ORIGIN_CY, originCy, true);
    view.setUint32(HDR_BH_COUNT, bhCount, true);
    view.setInt32(HDR_GRID_W, ACTIVE_GRID_W, true);
    view.setInt32(HDR_GRID_H, ACTIVE_GRID_H, true);
    view.setFloat32(HDR_DAYLIGHT, daylight, true);
    view.setInt32(HDR_MINE_X, mineX, true);
    view.setInt32(HDR_MINE_Y, mineY, true);
    view.setFloat32(HDR_MINE_DAMAGE, mineDamage, true);
    view.setInt32(HDR_SELECTED_SLOT, selectedSlot, true);
    view.setUint32(HDR_DROP_COUNT, dropCount, true);
  }

  /** Write drop entity data to the SAB. `data` is a flat Float32Array of DROP_STRIDE * count floats. */
  writeDrops(data: Float32Array, count: number): void {
    const n = Math.min(count, MAX_DROPS);
    this.drops.set(data.subarray(0, n * DROP_STRIDE));
    const view = new DataView(this.buffer, 0, HEADER_SIZE);
    view.setUint32(HDR_DROP_COUNT, n, true);
  }

  writeGrid(world: {
    activeForeground: Uint16Array;
    activeBackground: Uint16Array;
    activeLight: Uint8Array;
    activeExplored: Uint8Array;
  }): void {
    this.foreground.set(world.activeForeground);
    this.background.set(world.activeBackground);
    this.light.set(world.activeLight);
    this.explored.set(world.activeExplored);
  }

  // --- Input (written by renderer, read by worker) ---
  // The input region is at INPUT_OFFSET. The renderer writes input state here
  // each frame; the worker reads it each tick.
  writeInput(
    left: boolean, right: boolean, up: boolean, down: boolean,
    jump: boolean, noclip: boolean,
    mineActive: boolean, mineX: number, mineY: number,
    placeActive: boolean, placeX: number, placeY: number, placeBlockId: number,
    camX: number, camY: number,
    activeBh: number = 0,
  ): void {
    this.inputInt32[0] = left ? 1 : 0;
    this.inputInt32[1] = right ? 1 : 0;
    this.inputInt32[2] = up ? 1 : 0;
    this.inputInt32[3] = down ? 1 : 0;
    this.inputInt32[4] = jump ? 1 : 0;
    this.inputInt32[5] = noclip ? 1 : 0;
    this.inputInt32[6] = mineActive ? 1 : 0;
    this.inputInt32[7] = placeActive ? 1 : 0;
    this.inputF32[8] = mineX;
    this.inputF32[9] = mineY;
    this.inputF32[10] = placeX;
    this.inputF32[11] = placeY;
    this.inputInt32[12] = placeBlockId;
    this.inputF32[13] = camX;
    this.inputF32[14] = camY;
    this.inputInt32[20] = activeBh;
  }

  clearInput(): void {
    this.inputInt32.fill(0);
    this.inputF32.fill(0);
  }
}

// --- Reader (renderer side) ---
export class SimBufferReader {
  readonly buffer: ArrayBufferLike;
  readonly foreground: Uint16Array;
  readonly background: Uint16Array;
  readonly light: Uint8Array;
  readonly explored: Uint8Array;
  readonly blockheads: Float32Array;
  readonly drops: Float32Array;
  readonly inputInt32: Int32Array;
  readonly inputF32: Float32Array;

  constructor(buffer: ArrayBufferLike) {
    this.buffer = buffer;
    this.foreground = new Uint16Array(buffer, GRID_FG_OFFSET, ACTIVE_GRID_CELLS);
    this.background = new Uint16Array(buffer, GRID_BG_OFFSET, ACTIVE_GRID_CELLS);
    this.light = new Uint8Array(buffer, GRID_LIGHT_OFFSET, 4 * ACTIVE_GRID_CELLS);
    this.explored = new Uint8Array(buffer, GRID_EXPLORED_OFFSET, ACTIVE_GRID_CELLS);
    this.blockheads = new Float32Array(buffer, BLOCKHEADS_OFFSET, BH_STRIDE * MAX_BLOCKHEADS);
    this.drops = new Float32Array(buffer, DROPS_OFFSET, DROP_STRIDE * MAX_DROPS);
    this.inputInt32 = new Int32Array(buffer, INPUT_OFFSET, INPUT_SIZE / 4);
    this.inputF32 = new Float32Array(buffer, INPUT_OFFSET, INPUT_SIZE / 4);
  }

  getTick(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getUint32(HDR_TICK, true);
  }

  getOriginCx(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_ORIGIN_CX, true);
  }

  getOriginCy(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_ORIGIN_CY, true);
  }

  getBlockheadCount(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getUint32(HDR_BH_COUNT, true);
  }

  getGridW(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_GRID_W, true);
  }

  getGridH(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_GRID_H, true);
  }

  getDaylight(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getFloat32(HDR_DAYLIGHT, true);
  }

  getMineX(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_MINE_X, true);
  }

  getMineY(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getInt32(HDR_MINE_Y, true);
  }

  getMineDamage(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getFloat32(HDR_MINE_DAMAGE, true);
  }

  getDropCount(): number {
    return new DataView(this.buffer, 0, HEADER_SIZE).getUint32(HDR_DROP_COUNT, true);
  }

  /** Read blockhead state at index i. Returns a flat Float32Array slice. */
  getBlockhead(i: number): Float32Array {
    return this.blockheads.subarray(i * BH_STRIDE, (i + 1) * BH_STRIDE);
  }
}

export function createSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(SAB_SIZE);
}
