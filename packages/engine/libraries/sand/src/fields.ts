// ============================================================================
// Shared per-cell physics field layout.
//
// Each cell carries 4 field bytes alongside its packed material cell:
//   [gravity:u8, temp:u8, reserved:u8, reserved:u8]
//
// Wind/velocity is no longer stored per-cell. It's handled by the coarse-grid
// FluidGrid (fluid-grid.ts) at 1/4 resolution, which provides proper pressure
// relaxation and sustained airflow. The reserved bytes are kept for SAB layout
// compatibility (avoiding save migration) but are unused.
//
// These constants are shared between the sand simulation (sand-world.ts) and
// any game-specific SharedArrayBuffer bridge (e.g. a game's sim-buffer.ts
// or a game's chunk SAB). Games keep their own SAB layout but reference
// these field offsets so the indexing stays consistent.
// ============================================================================

export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  // Bytes 2-3 are reserved (formerly WIND_X/WIND_Y, now handled by FluidGrid).
  // Kept for SAB layout compatibility — do not repurpose without updating
  // grid-sim-buffer.ts fieldCellBytes and all save files.
  RESERVED_2: 2,
  RESERVED_3: 3,
} as const;

export const DEFAULT_GRAVITY = 128; // u8, 128 = 1.0x
export const DEFAULT_TEMP = 128; // u8, 128 = 1.0
