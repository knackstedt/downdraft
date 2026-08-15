// ============================================================================
// Shared per-cell physics field layout.
//
// Each cell carries 4 field bytes alongside its packed material cell:
//   [gravity:u8, temp:u8, windX:i8, windY:i8]
//
// These constants are shared between the sand simulation (sand-world.ts) and
// any game-specific SharedArrayBuffer bridge (e.g. falling-sand's sim-buffer.ts
// or mining-rpg's chunk SAB). Games keep their own SAB layout but reference
// these field offsets so the indexing stays consistent.
// ============================================================================

export const FIELD = {
  GRAVITY: 0,
  TEMP: 1,
  WIND_X: 2,
  WIND_Y: 3,
} as const;

export const DEFAULT_GRAVITY = 128; // u8, 128 = 1.0x
export const DEFAULT_TEMP = 128; // u8, 128 = 1.0
export const DEFAULT_WIND = 0;
