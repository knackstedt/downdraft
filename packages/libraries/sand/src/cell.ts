// ============================================================================
// Cell packing helpers — shared between the sand simulation and consumers.
//
// A cell is packed into a single uint32:
//   bits  0-7  : material id (0..255)
//   bits  8-15 : lifetime (0..255)
//   bits 16-23 : flags (shade bits 0-1, FLAG_UPDATED bit 2, FLAG_SPARK bit 3,
//                        FLAG_POPPED bit 5)
//   bits 24-31 : unused (reserved)
// ============================================================================

export interface Cell {
  mat: number;
  lifetime: number;
  flags: number;
}

export const FLAG_UPDATED = 0x04; // bit 2 — cell was updated this frame
export const FLAG_SPARK = 0x08; // bit 3 — this fire is a spark (expires to empty, not smoke)
export const FLAG_ANCHORED = 0x10; // bit 4 — fire stays put (wax flame, doesn't rise/drift)
export const FLAG_POPPED = 0x20; // bit 5 — popcorn that has already popped (won't re-pop)
export const SHADE_MASK = 0x03; // bits 0-1 — shade index (0-3)

// Precomputed bit position of FLAG_UPDATED within the packed uint32 flags field.
// OR-ing this into a packed cell value sets FLAG_UPDATED without re-packing.
export const FLAG_UPDATED_BIT = FLAG_UPDATED << 16;

export function pack(cell: Cell): number {
  return (cell.mat & 0xff) | ((cell.lifetime & 0xff) << 8) | ((cell.flags & 0xff) << 16);
}

export function unpack(v: number): Cell {
  return {
    mat: v & 0xff,
    lifetime: (v >> 8) & 0xff,
    flags: (v >> 16) & 0xff,
  };
}

/** Pack a cell value from raw components without allocating a Cell object. */
export function packCell(mat: number, lifetime: number, flags: number): number {
  return (mat & 0xff) | ((lifetime & 0xff) << 8) | ((flags & 0xff) << 16);
}
