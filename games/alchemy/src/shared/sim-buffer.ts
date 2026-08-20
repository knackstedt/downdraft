// ============================================================================
// Alchemy sim-buffer — thin adapter over @downdraft/library-sand GridSimBuffer.
//
// The engine handles the generic SAB layout (grid + field layers + input +
// stats + extra regions). This module defines the alchemy-specific layout
// config, field offset constants, and re-exports the reader/writer.
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
  extraRegions: [{ name: "mixture", bytes: 256 * 4 }],
};

export const OFFSETS: GridSimBufferOffsets = computeGridSimOffsets(LAYOUT);

export const NUM_LAYERS = 1;
export const MAX_GRID_BYTES = OFFSETS.gridBytes;
export const MAX_FIELD_BYTES = OFFSETS.fieldBytes;
export const LAYER_BYTES = OFFSETS.layerBytes;
export const ALL_LAYERS_BYTES = LAYER_BYTES * NUM_LAYERS;
export const INPUT_BYTES = 128;
export const STATS_BYTES = 16;
export const MIXTURE_BYTES = 256 * 4;
export const TOTAL_BYTES = OFFSETS.totalBytes;

export const GRID_OFFSET = OFFSETS.gridOffset[0];
export const FIELD_OFFSET = OFFSETS.fieldOffset[0];
export const INPUT_OFFSET = OFFSETS.inputOffset;
export const STATS_OFFSET = OFFSETS.statsOffset;
export const MIXTURE_OFFSET = OFFSETS.extraRegionOffset["mixture"];

// --- Game-specific field offsets (kept here, not in engine) ---

export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  RESERVED_2: 2,
  RESERVED_3: 3,
} as const;

export const DEFAULT_GRAVITY = 128;
export const DEFAULT_TEMP = 128;

export const INPUT = {
  MOUSE_DOWN: 0,
  MOUSE_RIGHT: 4,
  MOUSE_X: 8,
  MOUSE_Y: 12,
  SELECTED_MAT: 16,
  BRUSH_RADIUS: 20,
  LAST_MOUSE_X: 24,
  LAST_MOUSE_Y: 28,
} as const;

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
} as const;

// --- Allocation ---

export function allocateSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

// --- Reader/Writer (extend generic classes for game-specific methods) ---

export class SimBufferReader extends GridSimBufferReader {
  getMixtureHistogram(): Uint32Array {
    return this.getExtraRegionU32("mixture", 256);
  }
}

export class SimBufferWriter extends GridSimBufferWriter {
  writeMixtureHistogram(histogram: Uint32Array): void {
    this.writeExtraRegionU32("mixture", histogram);
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + INPUT_BYTES) / 4);
    const off = FIELD_OFFSET;
    const size = this.gridW * this.gridH * 4;
    for (let i = 0; i < size; i += 4) {
      this.u8[off + i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.u8[off + i + FIELD.TEMP] = DEFAULT_TEMP;
    }
  }
}
