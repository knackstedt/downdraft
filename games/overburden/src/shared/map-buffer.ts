// ============================================================================
// Overburden — map region snapshot (shared between worker + renderer)
//
// A map region is a per-block top-down view of a horizontal strip of the
// world, centered on the player's chunk. It is the data behind the zoomed-out
// "map mode" overview. The data is streamed via a SharedArrayBuffer (the
// "map SAB") shared between the sim worker (writer) and the pixi-ui worker
// (reader), so the pixi worker can render the bitmap at full block resolution
// without postMessage transfers.
//
// Only chunks the player has actually generated/visited are included; every
// other block is reported as fog (explored=0, blockId=0). The renderer draws
// fog blocks as a flat fog color instead of a block color.
//
// Map SAB layout (SharedArrayBuffer, shared not transferred):
//   [i32 cx0]            — leftmost chunk X (mod CHUNKS_X) of the strip
//   [i32 seq]            — sequence counter, incremented each write
//   [u16 blockIds[REGION_BLOCK_W * REGION_BLOCK_H]]  — per-block block IDs
//   [u8  explored[REGION_BLOCK_W * REGION_BLOCK_H]]  — per-block explored flags
//
// Stations are sent separately via postMessage (small, infrequent).
// ============================================================================

import { CHUNK_H, CHUNK_W } from "./constants";
import type { CraftStation } from "./types";

// Region dimensions. 128 chunk columns × 16 chunk rows = 8192 × 1024 blocks,
// i.e. half the 16384-wide cylinder world at full world height. Per-block
// resolution (THUMB_W=1) gives the map full fidelity — no downsampling.
export const MAP_REGION_COLS = 128;
export const MAP_REGION_ROWS = 16; // full world height (CHUNKS_Y)
export const THUMB_W = 1;
export const THUMB_H = 1;
// Cells per chunk dimension (64/1 = 64 — one cell per block).
export const THUMB_CELLS_PER_ROW = CHUNK_W / THUMB_W;
export const THUMB_CELLS_PER_COL = CHUNK_H / THUMB_H;
export const THUMB_CELLS = THUMB_CELLS_PER_ROW * THUMB_CELLS_PER_COL; // 4096
export const REGION_BLOCK_W = MAP_REGION_COLS * THUMB_CELLS_PER_ROW; // 8192 blocks wide
export const REGION_BLOCK_H = MAP_REGION_ROWS * THUMB_CELLS_PER_COL; // 1024 blocks tall

// --- Map SAB layout ---
// 4 chunk planes + explored, all per-block (REGION_BLOCK_W * REGION_BLOCK_H cells).
// Header: cx0 (i32) + seq (i32) = 8 bytes.
// Then 5 arrays in image-order (row-major over the full grid):
//   foreground: u16[N] — block ID (0=air)
//   background: u16[N] — backwall block ID (0=none)
//   mask:       u8[N]  — bit flags (MASK_SOLID | MASK_LIQUID | ...)
//   vfx:        u32[N] — packed particle/effect data
//   explored:   u8[N]  — fog-of-war flag (0=unexplored)
const MAP_SAB_N = REGION_BLOCK_W * REGION_BLOCK_H; // 8,388,608
export const MAP_SAB_HEADER_BYTES = 8;
export const MAP_SAB_CX0_OFFSET = 0;       // i32
export const MAP_SAB_SEQ_OFFSET = 4;       // i32
export const MAP_SAB_FG_OFFSET = 8;        // u16[N]
export const MAP_SAB_BG_OFFSET = MAP_SAB_FG_OFFSET + MAP_SAB_N * 2;     // u16[N]
export const MAP_SAB_MASK_OFFSET = MAP_SAB_BG_OFFSET + MAP_SAB_N * 2;   // u8[N]
export const MAP_SAB_VFX_OFFSET = MAP_SAB_MASK_OFFSET + MAP_SAB_N;      // u32[N]
export const MAP_SAB_EXPLORED_OFFSET = MAP_SAB_VFX_OFFSET + MAP_SAB_N * 4; // u8[N]
export const MAP_SAB_BYTES = MAP_SAB_EXPLORED_OFFSET + MAP_SAB_N;

// --- Legacy ArrayBuffer encode/decode (for station data via postMessage) ---
// Header: 4 i32 = 16 bytes.
export const MAP_HEADER_BYTES = 16;
export const MAP_HEADER_I32 = 4;
// Grids: blockIds (u16) + explored (u8) per block.
export const MAP_BLOCKIDS_BYTES = MAP_REGION_COLS * MAP_REGION_ROWS * THUMB_CELLS * 2;
export const MAP_EXPLORED_BYTES = MAP_REGION_COLS * MAP_REGION_ROWS * THUMB_CELLS;
export const MAP_GRIDS_BYTES = MAP_BLOCKIDS_BYTES + MAP_EXPLORED_BYTES;
// Station record: 3 i32 = 12 bytes.
export const MAP_STATION_RECORD_BYTES = 12;

// CraftStation → stable int code (so we don't serialize strings across the
// worker boundary). Keep in sync with STATION_CODE_TO_NAME below.
export const STATION_CODES: Record<CraftStation, number> = {
  hand: 0,
  workbench: 1,
  craft_bench: 2,
  tool_bench: 3,
  woodwork_bench: 4,
  campfire: 5,
  kiln: 6,
  furnace: 7,
  metalwork_bench: 8,
  builder_bench: 9,
  tailor_bench: 10,
  compost_bin: 11,
};

export const STATION_CODE_TO_NAME: Record<number, CraftStation> = Object.fromEntries(
  Object.entries(STATION_CODES).map(([k, v]) => [v, k as CraftStation]),
) as Record<number, CraftStation>;

export interface MapStation {
  wx: number;
  wy: number;
  station: CraftStation;
}

export interface MapRegionData {
  cx0: number; // leftmost chunk X (already wrapped to [0, CHUNKS_X))
  cols: number;
  rows: number;
  blockIds: Uint16Array; // length = cols*rows*THUMB_CELLS
  explored: Uint8Array;  // length = cols*rows*THUMB_CELLS
  stations: MapStation[];
}

/**
 * Encode a MapRegionData into a single transferable ArrayBuffer.
 * Used by the worker. When blockIds is empty (SAB mode — per-block data is
 * streamed via the map SAB), only the header + stations are encoded (no
 * grid data), keeping the transfer small.
 */
export function encodeMapRegion(region: MapRegionData): ArrayBuffer {
  const stationBytes = region.stations.length * MAP_STATION_RECORD_BYTES;
  const hasGrids = region.blockIds.length > 0;
  const gridsBytes = hasGrids ? MAP_GRIDS_BYTES : 0;
  const total = MAP_HEADER_BYTES + gridsBytes + stationBytes;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setInt32(0, region.cx0, true);
  dv.setInt32(4, region.cols, true);
  dv.setInt32(8, region.rows, true);
  dv.setInt32(12, region.stations.length, true);
  if (hasGrids) {
    const u8 = new Uint8Array(buf, MAP_HEADER_BYTES);
    // blockIds (u16)
    const blockIds = new Uint8Array(region.blockIds.buffer, region.blockIds.byteOffset, region.blockIds.byteLength);
    u8.set(blockIds, 0);
    // explored (u8)
    u8.set(region.explored, MAP_BLOCKIDS_BYTES);
  }
  // stations
  let off = MAP_HEADER_BYTES + gridsBytes;
  for (const s of region.stations) {
    dv.setInt32(off, s.wx, true);
    dv.setInt32(off + 4, s.wy, true);
    dv.setInt32(off + 8, STATION_CODES[s.station] ?? 0, true);
    off += MAP_STATION_RECORD_BYTES;
  }
  return buf;
}

/**
 * Decode a transferable ArrayBuffer back into a MapRegionData.
 * Used by the renderer. Returns null if the buffer is too small / malformed.
 * In SAB mode (no grid data in the buffer), blockIds/explored are empty
 * arrays — the per-block data is read from the map SAB by the pixi worker.
 */
export function decodeMapRegion(buf: ArrayBuffer): MapRegionData | null {
  if (buf.byteLength < MAP_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  const cx0 = dv.getInt32(0, true);
  const cols = dv.getInt32(4, true);
  const rows = dv.getInt32(8, true);
  const stationCount = dv.getInt32(12, true);
  if (cols !== MAP_REGION_COLS || rows !== MAP_REGION_ROWS) return null;
  const fullGridsBytes = cols * rows * THUMB_CELLS * 2 + cols * rows * THUMB_CELLS;
  const hasGrids = buf.byteLength >= MAP_HEADER_BYTES + fullGridsBytes;

  let blockIds: Uint16Array;
  let explored: Uint8Array;
  let stationsOff: number;
  if (hasGrids) {
    const totalThumbCells = cols * rows * THUMB_CELLS;
    blockIds = new Uint16Array(buf, MAP_HEADER_BYTES, totalThumbCells);
    explored = new Uint8Array(buf, MAP_HEADER_BYTES + MAP_BLOCKIDS_BYTES, totalThumbCells);
    stationsOff = MAP_HEADER_BYTES + MAP_GRIDS_BYTES;
  } else {
    // SAB mode: no grid data in the buffer, just header + stations.
    blockIds = new Uint16Array(0);
    explored = new Uint8Array(0);
    stationsOff = MAP_HEADER_BYTES;
  }
  if (buf.byteLength < stationsOff + stationCount * MAP_STATION_RECORD_BYTES) return null;

  const stations: MapStation[] = [];
  let off = stationsOff;
  for (let i = 0; i < stationCount; i++) {
    const wx = dv.getInt32(off, true);
    const wy = dv.getInt32(off + 4, true);
    const code = dv.getInt32(off + 8, true);
    stations.push({ wx, wy, station: STATION_CODE_TO_NAME[code] ?? "hand" });
    off += MAP_STATION_RECORD_BYTES;
  }
  return { cx0, cols, rows, blockIds, explored, stations };
}

/**
 * Index into the map grids for chunk column `col`, chunk row `row`,
 * cell (tx, ty). Uses image-order layout: pixel (col*THUMB_CELLS_PER_ROW+tx,
 * row*THUMB_CELLS_PER_COL+ty) = (row*THUMB_CELLS_PER_COL+ty) * REGION_BLOCK_W
 * + (col*THUMB_CELLS_PER_ROW+tx). Matches the layout written by
 * block-world.getMapRegion so the SAB can be blitted directly into ImageData.
 */
export function thumbIndex(col: number, row: number, tx: number, ty: number): number {
  return (row * THUMB_CELLS_PER_COL + ty) * REGION_BLOCK_W + (col * THUMB_CELLS_PER_ROW + tx);
}

// --- Map SAB helpers ---

/** Allocate a SharedArrayBuffer for streaming per-block map data. */
export function createMapSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(MAP_SAB_BYTES);
}

/** Typed views into the map SAB for reading/writing per-block data. */
export interface MapSabViews {
  cx0: Int32Array;       // [1] — leftmost chunk X
  seq: Int32Array;       // [1] — sequence counter
  foreground: Uint16Array; // [N] — block IDs
  background: Uint16Array; // [N] — backwall block IDs
  mask: Uint8Array;        // [N] — bit flags
  vfx: Uint32Array;        // [N] — packed effect data
  explored: Uint8Array;    // [N] — fog-of-war flags
}

/** Create typed views into an existing map SAB. */
export function getMapSabViews(sab: SharedArrayBuffer): MapSabViews {
  const n = REGION_BLOCK_W * REGION_BLOCK_H;
  return {
    cx0: new Int32Array(sab, MAP_SAB_CX0_OFFSET, 1),
    seq: new Int32Array(sab, MAP_SAB_SEQ_OFFSET, 1),
    foreground: new Uint16Array(sab, MAP_SAB_FG_OFFSET, n),
    background: new Uint16Array(sab, MAP_SAB_BG_OFFSET, n),
    mask: new Uint8Array(sab, MAP_SAB_MASK_OFFSET, n),
    vfx: new Uint32Array(sab, MAP_SAB_VFX_OFFSET, n),
    explored: new Uint8Array(sab, MAP_SAB_EXPLORED_OFFSET, n),
  };
}
