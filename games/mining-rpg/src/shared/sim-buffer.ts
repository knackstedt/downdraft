// ============================================================================
// Mining RPG sim-buffer — thin adapter over @downdraft/library-sand
// GridSimBuffer.
//
// The engine handles the generic SAB layout. This module defines the
// mining-rpg-specific layout config (1 layer + background grid + player) and
// re-exports the reader/writer with game-specific method names.
// ============================================================================

import {
    computeGridSimOffsets,
    GridSimBufferReader,
    GridSimBufferWriter,
    type GridSimBufferLayout,
    type GridSimBufferOffsets,
} from "@downdraft/library-sand";
import {
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
    BG_GRID_OFFSET,
    FIELD_OFFSET,
    GRID_OFFSET,
    INPUT_OFFSET,
    PLAYER_OFFSET,
    STATS_OFFSET,
    TOTAL_SAB_BYTES,
} from "./constants";

// --- Layout ---

const LAYOUT: GridSimBufferLayout = {
  numLayers: 1,
  maxGridW: ACTIVE_GRID_W,
  maxGridH: ACTIVE_GRID_H,
  inputBytes: 128,
  statsBytes: 32,
  playerBytes: 40,
  extraGrids: [{ name: "background", cellBytes: 4 }],
};

export const OFFSETS: GridSimBufferOffsets = computeGridSimOffsets(LAYOUT);

// Re-export the constants from constants.ts for backward compatibility
export { BG_GRID_OFFSET, FIELD_OFFSET, GRID_OFFSET, INPUT_OFFSET, PLAYER_OFFSET, STATS_OFFSET, TOTAL_SAB_BYTES };

// --- Allocation ---

export function allocateMiningSimBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_SAB_BYTES);
}

// --- Reader/Writer (extend generic classes with game-specific method names) ---

export class MiningSimBufferReader extends GridSimBufferReader {
  getFields(): Uint8Array {
    return this.getFieldGrid(0);
  }

  getBackgroundGrid(): Uint32Array {
    return this.getExtraGrid("background");
  }
}

export class MiningSimBufferWriter extends GridSimBufferWriter {
  writeFields(fields: Uint8Array): void {
    this.writeFieldGrid(fields, 0);
  }

  writeBackgroundGrid(grid: Uint32Array): void {
    this.writeExtraGrid("background", grid);
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + 128) / 4);
  }
}
