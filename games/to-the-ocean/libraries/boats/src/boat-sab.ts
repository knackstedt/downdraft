// ============================================================================
// Boat SAB Channel — defineChannel-based SharedArrayBuffer for boat cell grid
// Modern SAB framework version, replacing the manual byte-offset boat-buffer.ts.
// ============================================================================

import { defineChannel } from "@downdraft/core/sab/define";

export const BoatChannel = defineChannel({
  name: "game-boat",
  magic: 0x424f4154,
  version: 1,
  mode: "slots",
  header: {
    size: 64,
    fields: {
      boatCount: { type: "u32" },
      previewBoatSlot: { type: "u32" },
      previewPacked: { type: "u32" },
      previewGridY: { type: "u32" },
      previewRotation: { type: "u32" },
    },
  },
  sections: [
    {
      name: "boats",
      maxSlots: 32,
      slotSize: 1544,
      fields: {
        entityId: { type: "u32" },
        cellCount: { type: "u32" },
        cellData: { type: "u32", count: 384 },
      },
    },
  ],
});

// Re-export constants that match the existing manual boat-buffer.ts API
export const BOAT_MAGIC = 0x424f4154;
export const BOAT_VERSION = 1;

export const BOAT_SECTION_HEADER_SIZE = 8;
export const BOAT_CELL_SIZE = 8;
export const MAX_BOATS = 32;
export const MAX_CELLS_PER_BOAT = 192;

export const BOAT_HEADER_SIZE = 64;
export const BOAT_SECTION_SIZE = BOAT_SECTION_HEADER_SIZE + MAX_CELLS_PER_BOAT * BOAT_CELL_SIZE;
export const BOAT_BUFFER_SIZE = BOAT_HEADER_SIZE + MAX_BOATS * BOAT_SECTION_SIZE;

export const BOAT_HDR = {
  MAGIC: 0,
  VERSION: 1,
  BOAT_COUNT: 3,
  SEQUENCE: 2,
  PREVIEW_BOAT_SLOT: 4,
  PREVIEW_PACKED: 5,
  PREVIEW_GRID_Y: 6,
  PREVIEW_ROTATION: 7,
} as const;

// Cell field packing helpers
export function packCell(type: number, rotation: number, gridX: number, gridZ: number): number {
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
  return ((packed >> 16) & 0xff) << 24 >> 24;
}

export function unpackCellGridZ(packed: number): number {
  return ((packed >> 24) & 0xff) << 24 >> 24;
}

export function packCellY(gridY: number): number {
  return gridY & 0xff;
}

export function packCellSizes(sizeX: number, sizeY: number, sizeZ: number): number {
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

export function unpackCellYSizes(yPacked: number): { gridY: number; sizeX: number; sizeY: number; sizeZ: number } {
  return {
    gridY: yPacked & 0xff,
    sizeX: ((yPacked >> 8) & 0xff) + 1,
    sizeY: ((yPacked >> 16) & 0xff) + 1,
    sizeZ: ((yPacked >> 24) & 0xff) + 1,
  };
}

export function allocateBoatBuffer(): SharedArrayBuffer {
  return BoatChannel.allocate();
}

// --- Writer (sim side) ---

export class BoatBufferWriter {
  private writer: ReturnType<typeof BoatChannel.writer>;
  private slotAccessor: ReturnType<typeof BoatChannel.writer>["sections"]["boats"];

  constructor(sab: SharedArrayBuffer) {
    this.writer = BoatChannel.writer(sab);
    this.slotAccessor = this.writer.sections.boats;
  }

  init(): void {
    const w = this.writer;
    const h = BoatChannel.offsets.header;
    w.header.u32[h.boatCount] = 0;
  }

  setBoatCount(n: number): void {
    this.writer.header.u32[BoatChannel.offsets.header.boatCount] = n;
  }

  incrementSequence(): void {
    this.writer.bumpSequence();
  }

  writeBoat(slot: number, entityId: number, cells: { type: number; rotation: number; gridX: number; gridZ: number; gridY?: number; sizeX?: number; sizeY?: number; sizeZ?: number }[]): void {
    if (slot < 0 || slot >= MAX_BOATS) return;
    const sv = this.slotAccessor.slot(slot);
    const f = BoatChannel.offsets.sections.boats.fields;
    sv.u32[f.entityId] = entityId;
    const count = Math.min(cells.length, MAX_CELLS_PER_BOAT);
    sv.u32[f.cellCount] = count;
    for (let i = 0; i < count; i++) {
      const c = cells[i];
      sv.u32[f.cellData + i * 2] = packCell(c.type, c.rotation, c.gridX, c.gridZ);
      sv.u32[f.cellData + i * 2 + 1] = packCellY(c.gridY ?? 0) | packCellSizes(c.sizeX ?? 1, c.sizeY ?? 1, c.sizeZ ?? 1);
    }
  }

  clearBoat(slot: number): void {
    if (slot < 0 || slot >= MAX_BOATS) return;
    const sv = this.slotAccessor.slot(slot);
    const f = BoatChannel.offsets.sections.boats.fields;
    sv.u32[f.entityId] = 0;
    sv.u32[f.cellCount] = 0;
  }

  setPreview(boatSlot: number, gridX: number, gridZ: number, gridY: number, cellType: number, visible: boolean, rotation: number = 0): void {
    const w = this.writer;
    const h = BoatChannel.offsets.header;
    w.header.u32[h.previewBoatSlot] = boatSlot;
    const packed =
      (gridX & 0xff) |
      ((gridZ & 0xff) << 8) |
      ((cellType & 0xff) << 16) |
      (visible ? 1 : 0) << 24;
    w.header.u32[h.previewPacked] = packed;
    w.header.u32[h.previewGridY] = gridY & 0xff;
    w.header.u32[h.previewRotation] = rotation & 0xff;
  }

  clearPreview(): void {
    const w = this.writer;
    const h = BoatChannel.offsets.header;
    w.header.u32[h.previewBoatSlot] = 0;
    w.header.u32[h.previewPacked] = 0;
    w.header.u32[h.previewGridY] = 0;
    w.header.u32[h.previewRotation] = 0;
  }
}

// --- Reader (renderer side) ---

type BoatCell = { type: number; rotation: number; gridX: number; gridZ: number; gridY: number; sizeX: number; sizeY: number; sizeZ: number };

export class BoatBufferReader {
  private reader: ReturnType<typeof BoatChannel.reader>;
  private slotAccessor: ReturnType<typeof BoatChannel.reader>["sections"]["boats"];
  private lastSeq = -1;

  private cellCache: BoatCell[][] = [];
  private cellCacheSeq = -1;

  constructor(sab: SharedArrayBuffer) {
    this.reader = BoatChannel.reader(sab);
    this.slotAccessor = this.reader.sections.boats;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  getSequence(): number {
    return this.reader.getSequence();
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
    return this.reader.header.u32[BoatChannel.offsets.header.boatCount];
  }

  getBoatEntityId(slot: number): number {
    if (slot < 0 || slot >= MAX_BOATS) return 0;
    const sv = this.slotAccessor.slot(slot);
    return sv.u32[BoatChannel.offsets.sections.boats.fields.entityId];
  }

  getBoatCells(slot: number): BoatCell[] {
    if (slot < 0 || slot >= MAX_BOATS) return [];

    const seq = this.getSequence();
    if (seq !== this.cellCacheSeq) {
      this.cellCache = [];
      this.cellCacheSeq = seq;
    }

    const cached = this.cellCache[slot];
    if (cached) return cached;

    const sv = this.slotAccessor.slot(slot);
    const f = BoatChannel.offsets.sections.boats.fields;
    const count = sv.u32[f.cellCount];
    const cells: BoatCell[] = [];
    for (let i = 0; i < count && i < MAX_CELLS_PER_BOAT; i++) {
      const packed = sv.u32[f.cellData + i * 2];
      const yPacked = sv.u32[f.cellData + i * 2 + 1];
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

  getPreview(): { boatSlot: number; gridX: number; gridZ: number; gridY: number; cellType: number; visible: boolean; rotation: number } {
    const r = this.reader;
    const h = BoatChannel.offsets.header;
    const boatSlot = r.header.u32[h.previewBoatSlot];
    const packed = r.header.u32[h.previewPacked];
    const gridX = (packed & 0xff) << 24 >> 24;
    const gridZ = ((packed >> 8) & 0xff) << 24 >> 24;
    const gridY = r.header.u32[h.previewGridY] & 0xff;
    const cellType = (packed >> 16) & 0xff;
    const visible = ((packed >> 24) & 0xff) !== 0;
    const rotation = r.header.u32[h.previewRotation] & 0xff;
    return { boatSlot, gridX, gridZ, gridY, cellType, visible, rotation };
  }
}
