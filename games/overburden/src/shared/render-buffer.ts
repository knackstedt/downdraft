// ============================================================================
// Overburden — Render SharedArrayBuffer layout
//
// The render SAB holds pre-built instance data + padded texture buffers that
// the grid-builder worker produces from the sim SAB. The renderer reads from
// this buffer each frame and uploads directly to the GPU — no JS loops on the
// main thread.
//
// The worker writes instance data → padded textures → atomically publishes the
// build tick last (release ordering). The renderer reads the build tick first
// (acquire ordering); if it advanced, the data is ready to upload.
// ============================================================================

import {
    ACTIVE_GRID_CELLS,
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
} from "./constants";

// --- Render SAB layout ---
// All offsets in bytes.
//
// Region            Size (bytes)                          Description
// -------------------------------------------------------------------------
// RENDER_HEADER     32                                    build tick + instance counts
// INSTANCE_DATA     4 * 5 * AG_CELLS * 4                  Float32Array — per-instance data
// PADDED_FG_GRID    paddedGridRowBytes * AG_H             Uint8Array — R8 block IDs (fg)
// PADDED_BG_GRID    paddedGridRowBytes * AG_H             Uint8Array — R8 block IDs (bg)
// PADDED_LIGHT      paddedLightRowBytes * AG_H            Uint8Array — RGBA8 light
// PADDED_EXPLORED   paddedExploredRowBytes * AG_H         Uint8Array — R8 explored

// Max instances: all cells rendered across 4 layers (2 fg + 2 bg).
const NUM_LAYERS = 4;
export const MAX_INSTANCES = ACTIVE_GRID_CELLS * NUM_LAYERS;
export const INSTANCE_STRIDE = 5; // 5 floats per instance (x, y, z, blockId, faceMask)

// Padded row sizes (must be 256-byte aligned for WebGPU writeTexture).
export const PADDED_GRID_ROW_BYTES = Math.ceil(ACTIVE_GRID_W / 256) * 256; // 512
export const PADDED_LIGHT_ROW_BYTES = Math.ceil((ACTIVE_GRID_W * 4) / 256) * 256; // 1792
export const PADDED_EXPLORED_ROW_BYTES = Math.ceil(ACTIVE_GRID_W / 256) * 256; // 512

export const RENDER_HEADER_SIZE = 32;
export const RENDER_HEADER_TICK = 0;        // Uint32 (atomic) — sim tick this build corresponds to
export const RENDER_HEADER_FG_COUNT = 4;    // Uint32 — foreground instance count
export const RENDER_HEADER_BG_WALL_COUNT = 8; // Uint32 — back-wall instance count
export const RENDER_HEADER_BG_TREE_COUNT = 12; // Uint32 — tree instance count
export const RENDER_HEADER_TOTAL_COUNT = 16; // Uint32 — total instance count
export const RENDER_HEADER_WATER_COUNT = 28; // Uint32 — water (transparent) instance count
// Origin of the active grid this build corresponds to (Int32). The renderer
// uses THIS origin (not the sim SAB origin) for camera/shader/stickman/input
// positioning so it always matches the grid data currently on the GPU. This
// eliminates the chunk-boundary flash caused by the sim SAB origin advancing
// before the grid-builder has published the matching grid data.
export const RENDER_HEADER_ORIGIN_CX = 20;  // Int32 — active grid origin chunk X
export const RENDER_HEADER_ORIGIN_CY = 24;  // Int32 — active grid origin chunk Y

export const INSTANCE_DATA_OFFSET = RENDER_HEADER_SIZE;
export const INSTANCE_DATA_SIZE = 4 * INSTANCE_STRIDE * MAX_INSTANCES;

export const PADDED_FG_GRID_OFFSET = INSTANCE_DATA_OFFSET + INSTANCE_DATA_SIZE;
export const PADDED_FG_GRID_SIZE = PADDED_GRID_ROW_BYTES * ACTIVE_GRID_H;

export const PADDED_BG_GRID_OFFSET = PADDED_FG_GRID_OFFSET + PADDED_FG_GRID_SIZE;
export const PADDED_BG_GRID_SIZE = PADDED_GRID_ROW_BYTES * ACTIVE_GRID_H;

export const PADDED_LIGHT_OFFSET = PADDED_BG_GRID_OFFSET + PADDED_BG_GRID_SIZE;
export const PADDED_LIGHT_SIZE = PADDED_LIGHT_ROW_BYTES * ACTIVE_GRID_H;

export const PADDED_EXPLORED_OFFSET = PADDED_LIGHT_OFFSET + PADDED_LIGHT_SIZE;
export const PADDED_EXPLORED_SIZE = PADDED_EXPLORED_ROW_BYTES * ACTIVE_GRID_H;

export const RENDER_SAB_SIZE =
  RENDER_HEADER_SIZE +
  INSTANCE_DATA_SIZE +
  PADDED_FG_GRID_SIZE +
  PADDED_BG_GRID_SIZE +
  PADDED_LIGHT_SIZE +
  PADDED_EXPLORED_SIZE;

// --- Writer (grid-builder worker side) ---
// Sentinel value stored in the build-tick field before the first real build.
// A freshly zeroed SAB would read as tick 0 — the same as the sim's first tick.
// Without this sentinel, the renderer would consume the zeroed default as
// "build 0 is ready" and then skip the worker's actual first build (also tick 0).
export const RENDER_TICK_SENTINEL = 0xFFFFFFFF;

export class RenderBufferWriter {
  readonly buffer: SharedArrayBuffer;
  readonly header: Uint32Array;
  readonly headerI32: Int32Array;
  readonly instanceData: Float32Array;
  readonly paddedFgGrid: Uint8Array;
  readonly paddedBgGrid: Uint8Array;
  readonly paddedLight: Uint8Array;
  readonly paddedExplored: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.buffer = sab;
    this.header = new Uint32Array(sab, 0, RENDER_HEADER_SIZE / 4);
    this.headerI32 = new Int32Array(sab, 0, RENDER_HEADER_SIZE / 4);
    this.instanceData = new Float32Array(sab, INSTANCE_DATA_OFFSET, INSTANCE_STRIDE * MAX_INSTANCES);
    this.paddedFgGrid = new Uint8Array(sab, PADDED_FG_GRID_OFFSET, PADDED_FG_GRID_SIZE);
    this.paddedBgGrid = new Uint8Array(sab, PADDED_BG_GRID_OFFSET, PADDED_BG_GRID_SIZE);
    this.paddedLight = new Uint8Array(sab, PADDED_LIGHT_OFFSET, PADDED_LIGHT_SIZE);
    this.paddedExplored = new Uint8Array(sab, PADDED_EXPLORED_OFFSET, PADDED_EXPLORED_SIZE);
    // Initialize the build tick to the sentinel so the renderer doesn't
    // mistake the zeroed SAB for a completed build.
    Atomics.store(this.header, RENDER_HEADER_TICK / 4, RENDER_TICK_SENTINEL);
  }

  /**
   * Atomically publish the build tick (release). Call AFTER all data is written.
   * The origin is written before the tick store so the renderer (which acquires
   * via the tick load) always sees an origin consistent with the grid data.
   */
  publishBuild(
    tick: number, fgCount: number, bgWallCount: number, bgTreeCount: number,
    originCx: number, originCy: number, waterCount: number = 0,
  ): void {
    this.header[RENDER_HEADER_FG_COUNT / 4] = fgCount;
    this.header[RENDER_HEADER_BG_WALL_COUNT / 4] = bgWallCount;
    this.header[RENDER_HEADER_BG_TREE_COUNT / 4] = bgTreeCount;
    this.header[RENDER_HEADER_WATER_COUNT / 4] = waterCount;
    this.header[RENDER_HEADER_TOTAL_COUNT / 4] = fgCount + bgWallCount + bgTreeCount + waterCount;
    this.headerI32[RENDER_HEADER_ORIGIN_CX / 4] = originCx;
    this.headerI32[RENDER_HEADER_ORIGIN_CY / 4] = originCy;
    // Write tick last with release ordering so the renderer sees all data.
    Atomics.store(this.header, RENDER_HEADER_TICK / 4, tick);
  }
}

// --- Reader (renderer side) ---
export class RenderBufferReader {
  readonly buffer: ArrayBufferLike;
  readonly header: Uint32Array;
  readonly headerI32: Int32Array;
  readonly instanceData: Float32Array;
  readonly paddedFgGrid: Uint8Array;
  readonly paddedBgGrid: Uint8Array;
  readonly paddedLight: Uint8Array;
  readonly paddedExplored: Uint8Array;

  constructor(buffer: ArrayBufferLike) {
    this.buffer = buffer;
    this.header = new Uint32Array(buffer, 0, RENDER_HEADER_SIZE / 4);
    this.headerI32 = new Int32Array(buffer, 0, RENDER_HEADER_SIZE / 4);
    this.instanceData = new Float32Array(buffer, INSTANCE_DATA_OFFSET, INSTANCE_STRIDE * MAX_INSTANCES);
    this.paddedFgGrid = new Uint8Array(buffer, PADDED_FG_GRID_OFFSET, PADDED_FG_GRID_SIZE);
    this.paddedBgGrid = new Uint8Array(buffer, PADDED_BG_GRID_OFFSET, PADDED_BG_GRID_SIZE);
    this.paddedLight = new Uint8Array(buffer, PADDED_LIGHT_OFFSET, PADDED_LIGHT_SIZE);
    this.paddedExplored = new Uint8Array(buffer, PADDED_EXPLORED_OFFSET, PADDED_EXPLORED_SIZE);
  }

  /** Atomically read the build tick (acquire). */
  getBuildTick(): number {
    return Atomics.load(this.header, RENDER_HEADER_TICK / 4);
  }

  getFgCount(): number {
    return Atomics.load(this.header, RENDER_HEADER_FG_COUNT / 4);
  }

  getBgWallCount(): number {
    return Atomics.load(this.header, RENDER_HEADER_BG_WALL_COUNT / 4);
  }

  getBgTreeCount(): number {
    return Atomics.load(this.header, RENDER_HEADER_BG_TREE_COUNT / 4);
  }

  getTotalCount(): number {
    return Atomics.load(this.header, RENDER_HEADER_TOTAL_COUNT / 4);
  }

  getWaterCount(): number {
    return Atomics.load(this.header, RENDER_HEADER_WATER_COUNT / 4);
  }

  /**
   * Read the active-grid origin this build corresponds to. Safe to read after
   * getBuildTick() returned an advanced tick (the acquire load orders the
   * origin reads after the worker's release store).
   */
  getOriginCx(): number {
    return this.headerI32[RENDER_HEADER_ORIGIN_CX / 4];
  }

  getOriginCy(): number {
    return this.headerI32[RENDER_HEADER_ORIGIN_CY / 4];
  }
}

export function createRenderBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(RENDER_SAB_SIZE);
}
