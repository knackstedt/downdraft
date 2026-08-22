// ============================================================================
// Falling-sand sim-buffer — thin adapter over @downdraft/library-sand
// GridSimBuffer.
//
// The engine handles the generic SAB layout. This module defines the
// falling-sand-specific layout config (2 layers + player) and field offsets.
// ============================================================================

import {
    computeGridSimOffsets,
    GridSimBufferReader,
    GridSimBufferWriter,
    type GridSimBufferLayout,
    type GridSimBufferOffsets,
} from "@downdraft/library-sand";
import { MAX_GRID_H, MAX_GRID_W } from "./constants";

// --- Layout ---

const LAYOUT: GridSimBufferLayout = {
  numLayers: 1,
  maxGridW: MAX_GRID_W,
  maxGridH: MAX_GRID_H,
  inputBytes: 128,
  statsBytes: 16,
  playerBytes: 32,
};

export const OFFSETS: GridSimBufferOffsets = computeGridSimOffsets(LAYOUT);

export const NUM_LAYERS = 1;
export const MAX_GRID_BYTES = OFFSETS.gridBytes;
export const MAX_FIELD_BYTES = OFFSETS.fieldBytes;
export const LAYER_BYTES = OFFSETS.layerBytes;
export const ALL_LAYERS_BYTES = LAYER_BYTES * NUM_LAYERS;
export const INPUT_BYTES = 128;
export const STATS_BYTES = 16;
export const PLAYER_BYTES = 32;
export const TOTAL_BYTES = OFFSETS.totalBytes;

export function gridOffset(layer: number): number {
  return OFFSETS.gridOffset[layer];
}
export function fieldOffset(layer: number): number {
  return OFFSETS.fieldOffset[layer];
}

export const INPUT_OFFSET = OFFSETS.inputOffset;
export const STATS_OFFSET = OFFSETS.statsOffset;
export const PLAYER_OFFSET = OFFSETS.playerOffset;

// --- Game-specific field offsets ---
// Wind is now handled by the coarse-grid FluidGrid, not per-cell fields.
// Bytes 2-3 are reserved (formerly WIND_X/WIND_Y).

export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  RESERVED_2: 2,
  RESERVED_3: 3,
} as const;

export const DEFAULT_GRAVITY = 128;
export const DEFAULT_TEMP = 128;

export const INPUT = {
  LEFT: 0,
  RIGHT: 4,
  UP: 8,
  DOWN: 12,
  JUMP: 16,
  MOUSE_DOWN: 20,
  MOUSE_RIGHT: 24,
  MOUSE_X: 32,
  MOUSE_Y: 36,
  SELECTED_MAT: 40,
  BRUSH_RADIUS: 44,
  LAST_MOUSE_X: 48,
  LAST_MOUSE_Y: 52,
  BRUSH_MODE: 56,
  FIELD_TYPE: 60,
  FIELD_VALUE: 64,
  IMPULSE_CHANCE: 68,
  IMPULSE_STRENGTH: 72,
  SHOW_FIELDS: 76,
  ACTIVE_LAYER: 80,
} as const;

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
} as const;

export const PLAYER = {
  PX: 0,
  PY: 4,
  VX: 8,
  VY: 12,
  ON_GROUND: 16,
  FACING: 20,
  ANIM_FRAME: 24,
  HEALTH: 28,
} as const;

// --- Allocation ---

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

// --- Reader/Writer ---

export class SimBufferReader extends GridSimBufferReader {}
export class SimBufferWriter extends GridSimBufferWriter {
  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + INPUT_BYTES) / 4);
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
