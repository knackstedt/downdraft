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
    EXPLORED_GRID_OFFSET,
    FIELD_OFFSET,
    GRID_OFFSET,
    INPUT_OFFSET,
    LIGHT_REGION_BYTES,
    LIGHT_REGION_OFFSET,
    LIGHT_STRUCT_FLOATS,
    MAX_WORLD_LIGHTS,
    PLAYER_OFFSET,
    STATS_OFFSET,
    TOTAL_SAB_BYTES
} from "./constants";

// --- Layout ---

const LAYOUT: GridSimBufferLayout = {
  numLayers: 1,
  maxGridW: ACTIVE_GRID_W,
  maxGridH: ACTIVE_GRID_H,
  inputBytes: 128,
  statsBytes: 32,
  playerBytes: 40,
  extraGrids: [
    { name: "background", cellBytes: 4 },
    { name: "explored", cellBytes: 1 },
  ],
  extraRegions: [{ name: "lights", bytes: LIGHT_REGION_BYTES }],
};

export const OFFSETS: GridSimBufferOffsets = computeGridSimOffsets(LAYOUT);

// Re-export the constants from constants.ts for backward compatibility
export {
    BG_GRID_OFFSET,
    EXPLORED_GRID_OFFSET,
    FIELD_OFFSET,
    GRID_OFFSET,
    INPUT_OFFSET,
    LIGHT_REGION_OFFSET,
    PLAYER_OFFSET,
    STATS_OFFSET,
    TOTAL_SAB_BYTES
};

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

  /** Get a Uint8Array view of the explored grid (fog-of-war, 1 byte/cell). */
  getExploredGrid(): Uint8Array {
    const off = this.offsets.extraGridOffset["explored"];
    return this.u8.subarray(off, off + this.gridW * this.gridH);
  }

  /** Get the light region: a Uint32 view of the count + a Float32Array view of the light structs. */
  getLightRegion(): { count: number; lights: Float32Array } {
    const lightOff = this.offsets.extraRegionOffset["lights"];
    const count = this.u32[lightOff / 4];
    const lights = this.f32.subarray(
      (lightOff + 4) / 4,
      (lightOff + 4) / 4 + MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS,
    );
    return { count, lights };
  }
}

export class MiningSimBufferWriter extends GridSimBufferWriter {
  writeFields(fields: Uint8Array): void {
    this.writeFieldGrid(fields, 0);
  }

  writeBackgroundGrid(grid: Uint32Array): void {
    this.writeExtraGrid("background", grid);
  }

  /** Write the explored grid (fog-of-war, 1 byte/cell) to the SAB. */
  writeExploredGrid(grid: Uint8Array): void {
    const off = this.offsets.extraGridOffset["explored"];
    this.u8.set(grid.subarray(0, this.gridW * this.gridH), off);
  }

  /** Write the light list to the SAB: count header + packed light structs. */
  writeLightRegion(count: number, lights: Float32Array): void {
    const lightOff = this.offsets.extraRegionOffset["lights"];
    this.u32[lightOff / 4] = count;
    const lightFloatsOff = (lightOff + 4) / 4;
    const n = Math.min(count, MAX_WORLD_LIGHTS) * LIGHT_STRUCT_FLOATS;
    this.f32.set(lights.subarray(0, n), lightFloatsOff);
    // Zero out stale lights beyond the current count
    if (count < MAX_WORLD_LIGHTS) {
      this.f32.fill(0, lightFloatsOff + n, lightFloatsOff + MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS);
    }
  }

  init(): void {
    this.buf.fill(0, INPUT_OFFSET / 4, (INPUT_OFFSET + 128) / 4);
  }
}
