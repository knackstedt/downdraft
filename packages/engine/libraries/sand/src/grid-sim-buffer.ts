// ============================================================================
// GridSimBuffer — generic SharedArrayBuffer layout for grid-based games
// ============================================================================
//
// Provides a configurable SAB layout for cellular automata / sand games that
// need to transfer grid + field data between a sim worker and the renderer.
//
// Layout:
//   [grid layer 0] [field layer 0] [grid layer 1] [field layer 1] ...
//   [extra grid layers (e.g. background)]
//   [input region] [stats region] [player region] [extra regions...]
//
// Games configure the layout via GridSimBufferLayout, then use GridSimBufferReader
// and GridSimBufferWriter to access the SAB. Game-specific field offset constants
// (INPUT, STATS, PLAYER) stay in the game — only the storage boilerplate is shared.

export interface GridSimBufferLayout {
  /** Number of grid layers (each has a grid + field grid). Default: 1 */
  numLayers: number;
  /** Max grid width in cells */
  maxGridW: number;
  /** Max grid height in cells */
  maxGridH: number;
  /** Bytes per grid cell (Uint32 = 4). Default: 4 */
  gridCellBytes?: number;
  /** Bytes per field cell (gravity+temp+windX+windY = 4). Default: 4 */
  fieldCellBytes?: number;
  /** Input region size in bytes. Default: 128 */
  inputBytes?: number;
  /** Stats region size in bytes. Default: 16 */
  statsBytes?: number;
  /** Player region size in bytes. 0 = no player region. Default: 0 */
  playerBytes?: number;
  /** Extra grid layers (e.g. background grid). Each is maxGridW * maxGridH * extraCellBytes. */
  extraGrids?: { name: string; cellBytes: number }[];
  /** Extra regions after player (e.g. mixture histogram). */
  extraRegions?: { name: string; bytes: number }[];
}

export interface GridSimBufferOffsets {
  /** Byte offset of each grid layer */
  gridOffset: number[];
  /** Byte offset of each field layer */
  fieldOffset: number[];
  /** Byte offset of each extra grid */
  extraGridOffset: Record<string, number>;
  /** Byte offset of input region */
  inputOffset: number;
  /** Byte offset of stats region */
  statsOffset: number;
  /** Byte offset of player region (0 if none) */
  playerOffset: number;
  /** Byte offset of each extra region */
  extraRegionOffset: Record<string, number>;
  /** Total SAB size in bytes */
  totalBytes: number;
  /** Per-layer byte size (grid + field) */
  layerBytes: number;
  /** Grid bytes per layer */
  gridBytes: number;
  /** Field bytes per layer */
  fieldBytes: number;
}

/** Compute byte offsets for a grid SAB layout. */
export function computeGridSimOffsets(layout: GridSimBufferLayout): GridSimBufferOffsets {
  const gridCellBytes = layout.gridCellBytes ?? 4;
  const fieldCellBytes = layout.fieldCellBytes ?? 4;
  const inputBytes = layout.inputBytes ?? 128;
  const statsBytes = layout.statsBytes ?? 16;
  const playerBytes = layout.playerBytes ?? 0;

  const gridBytes = layout.maxGridW * layout.maxGridH * gridCellBytes;
  const fieldBytes = layout.maxGridW * layout.maxGridH * fieldCellBytes;
  const layerBytes = gridBytes + fieldBytes;
  const allLayersBytes = layerBytes * layout.numLayers;

  const gridOffset: number[] = [];
  const fieldOffset: number[] = [];
  for (let i = 0; i < layout.numLayers; i++) {
    gridOffset.push(i * layerBytes);
    fieldOffset.push(i * layerBytes + gridBytes);
  }

  let cursor = allLayersBytes;

  const extraGridOffset: Record<string, number> = {};
  (layout.extraGrids ?? []).forEach((eg) => {
    extraGridOffset[eg.name] = cursor;
    cursor += layout.maxGridW * layout.maxGridH * eg.cellBytes;
  });

  const inputOffset = cursor;
  cursor += inputBytes;

  const statsOffset = cursor;
  cursor += statsBytes;

  const playerOffset = playerBytes > 0 ? cursor : 0;
  if (playerBytes > 0) cursor += playerBytes;

  const extraRegionOffset: Record<string, number> = {};
  (layout.extraRegions ?? []).forEach((er) => {
    extraRegionOffset[er.name] = cursor;
    cursor += er.bytes;
  });

  return {
    gridOffset, fieldOffset, extraGridOffset,
    inputOffset, statsOffset, playerOffset, extraRegionOffset,
    totalBytes: cursor, layerBytes, gridBytes, fieldBytes,
  };
}

/** Allocate a SharedArrayBuffer for the given layout. */
export function allocateGridSimBuffer(layout: GridSimBufferLayout): SharedArrayBuffer {
  const offsets = computeGridSimOffsets(layout);
  return new SharedArrayBuffer(offsets.totalBytes);
}

// --- Reader ---

export class GridSimBufferReader {
  protected u32: Uint32Array;
  protected buf: Int32Array;
  protected u8: Uint8Array;
  protected f32: Float32Array;
  protected offsets: GridSimBufferOffsets;
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, offsets: GridSimBufferOffsets, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.f32 = new Float32Array(sab);
    this.offsets = offsets;
    this.gridW = gridW;
    this.gridH = gridH;
  }

  setDims(w: number, h: number): void {
    this.gridW = w;
    this.gridH = h;
  }

  getOffsets(): GridSimBufferOffsets {
    return this.offsets;
  }

  /** Get a view of grid layer N (Uint32Array). */
  getGrid(layer: number = 0): Uint32Array {
    const off = this.offsets.gridOffset[layer] / 4;
    return this.u32.subarray(off, off + this.gridW * this.gridH);
  }

  /** Get a view of field layer N (Uint8Array). */
  getFieldGrid(layer: number = 0): Uint8Array {
    const off = this.offsets.fieldOffset[layer];
    return this.u8.subarray(off, off + this.gridW * this.gridH * 4);
  }

  /** Get a view of an extra grid (Uint32Array). */
  getExtraGrid(name: string): Uint32Array {
    const off = this.offsets.extraGridOffset[name] / 4;
    return this.u32.subarray(off, off + this.gridW * this.gridH);
  }

  getInput(field: number): number {
    return this.buf[this.offsets.inputOffset / 4 + field / 4];
  }

  getInputF32(field: number): number {
    return this.f32[(this.offsets.inputOffset + field) / 4];
  }

  getStat(field: number): number {
    return this.buf[this.offsets.statsOffset / 4 + field / 4];
  }

  getPlayerF32(field: number): number {
    return this.f32[(this.offsets.playerOffset + field) / 4];
  }

  getPlayerI32(field: number): number {
    return this.buf[this.offsets.playerOffset / 4 + field / 4];
  }

  /** Get a Uint32Array view of an extra region. */
  getExtraRegionU32(name: string, count: number): Uint32Array {
    const off = this.offsets.extraRegionOffset[name] / 4;
    return this.u32.subarray(off, off + count);
  }
}

// --- Writer ---

export class GridSimBufferWriter {
  protected u32: Uint32Array;
  protected buf: Int32Array;
  protected u8: Uint8Array;
  protected f32: Float32Array;
  protected offsets: GridSimBufferOffsets;
  gridW: number;
  gridH: number;

  constructor(sab: SharedArrayBuffer, offsets: GridSimBufferOffsets, gridW: number, gridH: number) {
    this.u32 = new Uint32Array(sab);
    this.buf = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    this.f32 = new Float32Array(sab);
    this.offsets = offsets;
    this.gridW = gridW;
    this.gridH = gridH;
  }

  setDims(w: number, h: number): void {
    this.gridW = w;
    this.gridH = h;
  }

  getOffsets(): GridSimBufferOffsets {
    return this.offsets;
  }

  writeGrid(grid: Uint32Array, layer: number = 0): void {
    const off = this.offsets.gridOffset[layer] / 4;
    this.u32.set(grid.subarray(0, this.gridW * this.gridH), off);
  }

  writeFieldGrid(fields: Uint8Array, layer: number = 0): void {
    const off = this.offsets.fieldOffset[layer];
    this.u8.set(fields.subarray(0, this.gridW * this.gridH * 4), off);
  }

  writeExtraGrid(name: string, grid: Uint32Array): void {
    const off = this.offsets.extraGridOffset[name] / 4;
    this.u32.set(grid.subarray(0, this.gridW * this.gridH), off);
  }

  writeInput(field: number, value: number): void {
    this.buf[this.offsets.inputOffset / 4 + field / 4] = value;
  }

  writeInputF32(field: number, value: number): void {
    this.f32[(this.offsets.inputOffset + field) / 4] = value;
  }

  writeStat(field: number, value: number): void {
    this.buf[this.offsets.statsOffset / 4 + field / 4] = value;
  }

  writePlayerF32(field: number, value: number): void {
    this.f32[(this.offsets.playerOffset + field) / 4] = value;
  }

  writePlayerI32(field: number, value: number): void {
    this.buf[this.offsets.playerOffset / 4 + field / 4] = value;
  }

  writeExtraRegionU32(name: string, data: Uint32Array): void {
    const off = this.offsets.extraRegionOffset[name] / 4;
    this.u32.set(data, off);
  }

  /** Clear the input region to zeros. */
  clearInput(): void {
    const inputBytes = this.offsets.extraRegionOffset["__input_end__"] ?? 128;
    this.buf.fill(0, this.offsets.inputOffset / 4, (this.offsets.inputOffset + inputBytes) / 4);
  }
}
