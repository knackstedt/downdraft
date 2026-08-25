// ============================================================================
// Overburden — map region snapshot (shared between worker + renderer)
//
// A map region is a downsampled top-down thumbnail of a horizontal strip of
// the world, centered on the player's chunk. It is the data behind the
// zoomed-out "map mode" overview (see components/map-overview.tsx).
//
// Only chunks the player has actually generated/visited are included; every
// other cell is reported as fog (explored=0, blockId=0). The renderer draws
// fog cells as a flat fog color instead of a block color.
//
// Layout (single ArrayBuffer, transferable across the worker boundary):
//   [i32 cx0]            — leftmost chunk X (mod CHUNKS_X) of the strip
//   [i32 cols]           — number of chunk columns (MAP_REGION_COLS)
//   [i32 rows]           — number of chunk rows    (MAP_REGION_ROWS)
//   [i32 stationCount]   — number of station records following the grids
//   [u16 blockIds[cols*rows*THUMB_W*THUMB_H]]
//   [u8  explored[cols*rows*THUMB_W*THUMB_H]]
//   then `stationCount` station records, each:
//     [i32 wx][i32 wy][i32 stationTypeCode]
// ============================================================================

import type { CraftStation } from "./types";

// Region dimensions. 128 chunk columns × 16 chunk rows = 8192 × 1024 blocks,
// i.e. half the 16384-wide cylinder world at full world height. Each chunk is
// downsampled to an 8×8 thumbnail (one representative block per 8×8 cell group).
export const MAP_REGION_COLS = 128;
export const MAP_REGION_ROWS = 16; // full world height (CHUNKS_Y)
export const THUMB_W = 8;
export const THUMB_H = 8;
export const THUMB_CELLS = THUMB_W * THUMB_H; // 64
export const REGION_BLOCK_W = MAP_REGION_COLS * THUMB_W; // 1024 thumbnail cells wide
export const REGION_BLOCK_H = MAP_REGION_ROWS * THUMB_H; // 128 thumbnail cells tall

// Header: 4 i32 = 16 bytes.
export const MAP_HEADER_BYTES = 16;
export const MAP_HEADER_I32 = 4;
// Grids: blockIds (u16) + explored (u8) per thumbnail cell.
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
 * Used by the worker.
 */
export function encodeMapRegion(region: MapRegionData): ArrayBuffer {
  const stationBytes = region.stations.length * MAP_STATION_RECORD_BYTES;
  const total = MAP_HEADER_BYTES + MAP_GRIDS_BYTES + stationBytes;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setInt32(0, region.cx0, true);
  dv.setInt32(4, region.cols, true);
  dv.setInt32(8, region.rows, true);
  dv.setInt32(12, region.stations.length, true);
  const u8 = new Uint8Array(buf, MAP_HEADER_BYTES);
  // blockIds (u16)
  const blockIds = new Uint8Array(region.blockIds.buffer, region.blockIds.byteOffset, region.blockIds.byteLength);
  u8.set(blockIds, 0);
  // explored (u8)
  u8.set(region.explored, MAP_BLOCKIDS_BYTES);
  // stations
  let off = MAP_HEADER_BYTES + MAP_GRIDS_BYTES;
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
 */
export function decodeMapRegion(buf: ArrayBuffer): MapRegionData | null {
  if (buf.byteLength < MAP_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  const cx0 = dv.getInt32(0, true);
  const cols = dv.getInt32(4, true);
  const rows = dv.getInt32(8, true);
  const stationCount = dv.getInt32(12, true);
  if (cols !== MAP_REGION_COLS || rows !== MAP_REGION_ROWS) return null;
  const gridsBytes = cols * rows * THUMB_CELLS * 2 + cols * rows * THUMB_CELLS;
  if (buf.byteLength < MAP_HEADER_BYTES + gridsBytes + stationCount * MAP_STATION_RECORD_BYTES) return null;

  const totalThumbCells = cols * rows * THUMB_CELLS;
  const blockIds = new Uint16Array(buf, MAP_HEADER_BYTES, totalThumbCells);
  const explored = new Uint8Array(buf, MAP_HEADER_BYTES + MAP_BLOCKIDS_BYTES, totalThumbCells);

  const stations: MapStation[] = [];
  let off = MAP_HEADER_BYTES + MAP_GRIDS_BYTES;
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
 * Index into the thumbnail grids for chunk column `col`, chunk row `row`,
 * thumbnail cell (tx, ty). Matches the layout written by block-world.getMapRegion.
 */
export function thumbIndex(col: number, row: number, tx: number, ty: number): number {
  return ((row * MAP_REGION_COLS + col) * THUMB_H + ty) * THUMB_W + tx;
}
