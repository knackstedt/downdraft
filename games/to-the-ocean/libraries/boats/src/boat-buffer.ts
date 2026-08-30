// ============================================================================
// Boat Buffer — SharedArrayBuffer for boat cell grid data (sim → renderer)
// ============================================================================

export const BOAT_MAGIC = 0x424f4154; // 'BOAT'
export const BOAT_VERSION = 1;

// Header: 64 bytes (16 u32s)
// [0] magic, [1] version, [2] boatCount, [3] sequence (atomic)
// [4] preview: boatSlot, [5] preview: packed gridX|gridZ|cellType|visible, [6..15] reserved

export const BOAT_HDR = {
  MAGIC: 0,
  VERSION: 1,
  BOAT_COUNT: 2,
  SEQUENCE: 3,
  PREVIEW_BOAT_SLOT: 4,
  PREVIEW_PACKED: 5,
  PREVIEW_GRID_Y: 6,
  PREVIEW_ROTATION: 7,
} as const;

// Per-boat section: 8 bytes header + MAX_CELLS_PER_BOAT * 8 bytes
// Boat header: entityId (u32), cellCount (u32)
// Per cell: type (u8), rotation (u8), gridX (i8), gridZ (i8), gridY (u8), sizeX (u8), sizeY (u8), sizeZ (u8)
// Packed as 2 u32s per cell: u32_0 = type|rotation|gridX|gridZ, u32_1 = gridY|sizeX|sizeY|sizeZ
// Sizes are stored as (size-1) so 0 means size=1 (default for all existing 1x1x1 cells)

export const BOAT_SECTION_HEADER_SIZE = 8; // 2 u32s
export const BOAT_CELL_SIZE = 8; // 2 u32s per cell
export const MAX_BOATS = 32;
export const MAX_CELLS_PER_BOAT = 192;

export const BOAT_HEADER_SIZE = 64;
export const BOAT_SECTION_SIZE = BOAT_SECTION_HEADER_SIZE + MAX_CELLS_PER_BOAT * BOAT_CELL_SIZE;
export const BOAT_BUFFER_SIZE = BOAT_HEADER_SIZE + MAX_BOATS * BOAT_SECTION_SIZE;

// Cell field packing helpers
export function packCell(type: number, rotation: number, gridX: number, gridZ: number): number {
  // Pack into a single u32: byte0=type, byte1=rotation, byte2=gridX (signed), byte3=gridZ (signed)
  return (
    (type & 0xff) |
    ((rotation & 0xff) << 8) |
    ((gridX & 0xff) << 16) |
    ((gridZ & 0xff) << 24)
  );
}

export function unpackCellType(packed: number): number {
  return packed & 0xff;
}

export function unpackCellRotation(packed: number): number {
  return (packed >> 8) & 0xff;
}

export function unpackCellGridX(packed: number): number {
  return ((packed >> 16) & 0xff) << 24 >> 24; // sign-extend from 8-bit
}

export function unpackCellGridZ(packed: number): number {
  return ((packed >> 24) & 0xff) << 24 >> 24; // sign-extend from 8-bit
}

export function packCellY(gridY: number): number {
  return gridY & 0xff;
}

export function packCellSizes(sizeX: number, sizeY: number, sizeZ: number): number {
  // Pack sizes as (size-1) into bits 8-31 of the Y u32 (bits 0-7 are gridY)
  return (((sizeX - 1) & 0xff) << 8) | (((sizeY - 1) & 0xff) << 16) | (((sizeZ - 1) & 0xff) << 24);
}

export function unpackCellSizeX(yPacked: number): number {
  return ((yPacked >> 8) & 0xff) + 1;
}

export function unpackCellSizeY(yPacked: number): number {
  return ((yPacked >> 16) & 0xff) + 1;
}

export function unpackCellSizeZ(yPacked: number): number {
  return ((yPacked >> 24) & 0xff) + 1;
}

export function unpackCellY(yPacked: number): number {
  return yPacked & 0xff;
}

// Full unpack helper for the Y+sizes u32
export function unpackCellYSizes(yPacked: number): { gridY: number; sizeX: number; sizeY: number; sizeZ: number } {
  return {
    gridY: yPacked & 0xff,
    sizeX: ((yPacked >> 8) & 0xff) + 1,
    sizeY: ((yPacked >> 16) & 0xff) + 1,
    sizeZ: ((yPacked >> 24) & 0xff) + 1,
  };
}

export function allocateBoatBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(BOAT_BUFFER_SIZE);
}

// --- Writer (sim side) ---

export class BoatBufferWriter {
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private sectionOffsets: number[] = [];

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    for (let i = 0; i < MAX_BOATS; i++) {
      this.sectionOffsets[i] = (BOAT_HEADER_SIZE + i * BOAT_SECTION_SIZE) / 4;
    }
  }

  init(): void {
    this.u32[BOAT_HDR.MAGIC] = BOAT_MAGIC;
    this.u32[BOAT_HDR.VERSION] = BOAT_VERSION;
    this.u32[BOAT_HDR.BOAT_COUNT] = 0;
  }

  setBoatCount(n: number): void {
    this.u32[BOAT_HDR.BOAT_COUNT] = n;
  }

  incrementSequence(): void {
    Atomics.add(this.u32, BOAT_HDR.SEQUENCE, 1);
  }

  writeBoat(slot: number, entityId: number, cells: { type: number; rotation: number; gridX: number; gridZ: number; gridY?: number; sizeX?: number; sizeY?: number; sizeZ?: number }[]): void {
    if (slot < 0 || slot >= MAX_BOATS) return;
    const base = this.sectionOffsets[slot];
    this.u32[base] = entityId;
    const count = Math.min(cells.length, MAX_CELLS_PER_BOAT);
    this.u32[base + 1] = count;
    for (let i = 0; i < count; i++) {
      const c = cells[i];
      this.u32[base + 2 + i * 2] = packCell(c.type, c.rotation, c.gridX, c.gridZ);
      this.u32[base + 2 + i * 2 + 1] = packCellY(c.gridY ?? 0) | packCellSizes(c.sizeX ?? 1, c.sizeY ?? 1, c.sizeZ ?? 1);
    }
  }

  clearBoat(slot: number): void {
    if (slot < 0 || slot >= MAX_BOATS) return;
    const base = this.sectionOffsets[slot];
    this.u32[base] = 0;
    this.u32[base + 1] = 0;
  }

  // Preview cell: write which boat slot and grid position the player is aiming at
  // packed: byte0=gridX (signed), byte1=gridZ (signed), byte2=cellType, byte3=visible (0/1)
  setPreview(boatSlot: number, gridX: number, gridZ: number, gridY: number, cellType: number, visible: boolean, rotation: number = 0): void {
    this.u32[BOAT_HDR.PREVIEW_BOAT_SLOT] = boatSlot;
    const packed =
      (gridX & 0xff) |
      ((gridZ & 0xff) << 8) |
      ((cellType & 0xff) << 16) |
      (visible ? 1 : 0) << 24;
    this.u32[BOAT_HDR.PREVIEW_PACKED] = packed;
    this.u32[BOAT_HDR.PREVIEW_GRID_Y] = gridY & 0xff;
    this.u32[BOAT_HDR.PREVIEW_ROTATION] = rotation & 0xff;
  }

  clearPreview(): void {
    this.u32[BOAT_HDR.PREVIEW_BOAT_SLOT] = 0;
    this.u32[BOAT_HDR.PREVIEW_PACKED] = 0;
    this.u32[BOAT_HDR.PREVIEW_GRID_Y] = 0;
    this.u32[BOAT_HDR.PREVIEW_ROTATION] = 0;
  }
}

// --- Reader (renderer side) ---

type BoatCell = { type: number; rotation: number; gridX: number; gridZ: number; gridY: number; sizeX: number; sizeY: number; sizeZ: number };

export class BoatBufferReader {
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private sectionOffsets: number[] = [];
  private lastSeq = -1;

  // Per-slot cell cache: invalidated when buffer sequence changes
  private cellCache: BoatCell[][] = [];
  private cellCacheSeq = -1;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    for (let i = 0; i < MAX_BOATS; i++) {
      this.sectionOffsets[i] = (BOAT_HEADER_SIZE + i * BOAT_SECTION_SIZE) / 4;
    }
  }

  isValid(): boolean {
    return this.u32[BOAT_HDR.MAGIC] === BOAT_MAGIC;
  }

  getSequence(): number {
    return Atomics.load(this.u32, BOAT_HDR.SEQUENCE);
  }

  hasChanged(): boolean {
    const seq = this.getSequence();
    if (seq !== this.lastSeq) {
      this.lastSeq = seq;
      return true;
    }
    return false;
  }

  getBoatCount(): number {
    return this.u32[BOAT_HDR.BOAT_COUNT];
  }

  getBoatEntityId(slot: number): number {
    if (slot < 0 || slot >= MAX_BOATS) return 0;
    return this.u32[this.sectionOffsets[slot]];
  }

  getBoatCells(slot: number): BoatCell[] {
    if (slot < 0 || slot >= MAX_BOATS) return [];

    // Invalidate cache if buffer sequence changed
    const seq = this.getSequence();
    if (seq !== this.cellCacheSeq) {
      this.cellCache = [];
      this.cellCacheSeq = seq;
    }

    // Return cached cells if available
    const cached = this.cellCache[slot];
    if (cached) return cached;

    const base = this.sectionOffsets[slot];
    const count = this.u32[base + 1];
    const cells: BoatCell[] = [];
    for (let i = 0; i < count && i < MAX_CELLS_PER_BOAT; i++) {
      const packed = this.u32[base + 2 + i * 2];
      const yPacked = this.u32[base + 2 + i * 2 + 1];
      const ys = unpackCellYSizes(yPacked);
      cells.push({
        type: unpackCellType(packed),
        rotation: unpackCellRotation(packed),
        gridX: unpackCellGridX(packed),
        gridZ: unpackCellGridZ(packed),
        gridY: ys.gridY,
        sizeX: ys.sizeX,
        sizeY: ys.sizeY,
        sizeZ: ys.sizeZ,
      });
    }
    this.cellCache[slot] = cells;
    return cells;
  }

  // Preview cell: returns { boatSlot, gridX, gridZ, gridY, cellType, visible }
  getPreview(): { boatSlot: number; gridX: number; gridZ: number; gridY: number; cellType: number; visible: boolean; rotation: number } {
    const boatSlot = this.u32[BOAT_HDR.PREVIEW_BOAT_SLOT];
    const packed = this.u32[BOAT_HDR.PREVIEW_PACKED];
    const gridX = (packed & 0xff) << 24 >> 24;
    const gridZ = ((packed >> 8) & 0xff) << 24 >> 24;
    const gridY = this.u32[BOAT_HDR.PREVIEW_GRID_Y] & 0xff;
    const cellType = (packed >> 16) & 0xff;
    const visible = ((packed >> 24) & 0xff) !== 0;
    const rotation = this.u32[BOAT_HDR.PREVIEW_ROTATION] & 0xff;
    return { boatSlot, gridX, gridZ, gridY, cellType, visible, rotation };
  }
}
