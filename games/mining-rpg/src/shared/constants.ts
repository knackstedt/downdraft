// ============================================================================
// Mining RPG — world constants
// ============================================================================

// Chunk dimensions (configurable). Start at 128x128 cells per chunk.
export const CHUNK_W = 128;
export const CHUNK_H = 128;

// Maximum horizontal extent: 24 chunks wide.
export const MAX_CHUNKS_X = 24;

// Active radius in chunks around the player. The active grid is
// (2*R+1) chunks wide and tall. R=2 → 5x5 chunks → 640x640 cells.
export const ACTIVE_RADIUS_CHUNKS = 2;

// Simulation tick rate (ticks per second).
export const TICK_RATE = 30;

// Freeze duration in ticks. 300 seconds @ 30tps = 9000 ticks.
export const FREEZE_TICKS = 9000;

// Cell bytes (same as the sand library: 4 bytes per cell in the grid Uint32Array).
export const CELL_BYTES = 4;

// Field bytes per cell (gravity, temp, windX, windY).
export const FIELD_BYTES = 4;

// Player collision box (in grid cells).
export const PLAYER_W = 3;
export const PLAYER_H = 7;

// Collection magnet radius (in grid cells) for auto-collecting loose ore.
export const COLLECT_RADIUS = 16;

// Dig brush radius (in grid cells) for the mining tool.
export const DEFAULT_DIG_RADIUS = 3;

// World seed for deterministic terrain generation.
export const WORLD_SEED = 12345;

// Active grid dimensions derived from chunk size + active radius.
export const ACTIVE_GRID_W = (2 * ACTIVE_RADIUS_CHUNKS + 1) * CHUNK_W;
export const ACTIVE_GRID_H = (2 * ACTIVE_RADIUS_CHUNKS + 1) * CHUNK_H;

// Total active grid cells.
export const ACTIVE_GRID_CELLS = ACTIVE_GRID_W * ACTIVE_GRID_H;

// ============================================================================
// SharedArrayBuffer layout for the mining-rpg sim ↔ renderer bridge
//
// The active grid is a contiguous region that the worker writes each tick.
// Layout:
//   grid:   ACTIVE_GRID_W * ACTIVE_GRID_H * 4 bytes (Uint32 per cell)
//   fields: ACTIVE_GRID_W * ACTIVE_GRID_H * 4 bytes (gravity, temp, windX, windY)
//   input:  128 bytes
//   stats:  16 bytes
//   player: 32 bytes (px, py, vx, vy, onGround, facing, animFrame, health)
// ============================================================================

export const ACTIVE_GRID_BYTES = ACTIVE_GRID_CELLS * CELL_BYTES;
export const ACTIVE_FIELD_BYTES = ACTIVE_GRID_CELLS * FIELD_BYTES;
export const INPUT_BYTES = 128;
export const STATS_BYTES = 32; // 8 int32s (6 used: frame, tick, fps, loadedChunks, originX, originY)
export const PLAYER_BYTES = 32;

export const TOTAL_SAB_BYTES =
  ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES + INPUT_BYTES + STATS_BYTES + PLAYER_BYTES;

// Offsets within the SAB
export const GRID_OFFSET = 0;
export const FIELD_OFFSET = ACTIVE_GRID_BYTES;
export const INPUT_OFFSET = ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES;
export const STATS_OFFSET = ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES + INPUT_BYTES;
export const PLAYER_OFFSET = ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES + INPUT_BYTES + STATS_BYTES;

// Input field offsets (within the INPUT region, byte offsets)
export const INPUT = {
  LEFT: 0,
  RIGHT: 4,
  UP: 8,
  DOWN: 12,
  JUMP: 16,
  MOUSE_DOWN: 20,
  MOUSE_RIGHT: 24,
  MOUSE_X: 32, // world X in grid cells (float32)
  MOUSE_Y: 36, // world Y in grid cells (float32)
  DIG_RADIUS: 40,
  // offset 44-56 reserved
  IMPULSE_CHANCE: 60,
  IMPULSE_STRENGTH: 64,
} as const;

export const STATS = {
  FRAME: 0,
  TICK: 4,
  FPS: 8,
  LOADED_CHUNKS: 12,
  // Active grid origin in world cell coords (so renderer can convert world↔local)
  ORIGIN_X: 16, // int32 — activeOriginCx * CHUNK_W
  ORIGIN_Y: 20, // int32 — activeOriginCy * CHUNK_H
} as const;

export const PLAYER = {
  PX: 0, // float32 — player x in world cell coords
  PY: 4, // float32 — player y in world cell coords
  VX: 8, // float32 — velocity x
  VY: 12, // float32 — velocity y
  ON_GROUND: 16, // int32 — 1 if on ground
  FACING: 20, // int32 — 1 = right, -1 = left
  ANIM_FRAME: 24, // int32 — animation frame counter
  HEALTH: 28, // int32 — player health
} as const;

// ============================================================================
// Backdrop layer — low-res parallax background behind the foreground.
//
// The backdrop is at half resolution (CHUNK_W/2 × CHUNK_H/2 per chunk) and
// uses a separate SAB region. It is generated once per chunk and never
// simulated (no physics). Rendered with a parallax factor (0.5) so it
// scrolls slower than the foreground.
// ============================================================================

// Backdrop chunk dimensions (half the foreground resolution).
export const BACKDROP_CHUNK_W = CHUNK_W / 2;
export const BACKDROP_CHUNK_H = CHUNK_H / 2;

// Backdrop active grid dimensions (same chunk window as foreground, half-res cells).
export const BACKDROP_GRID_W = (2 * ACTIVE_RADIUS_CHUNKS + 1) * BACKDROP_CHUNK_W;
export const BACKDROP_GRID_H = (2 * ACTIVE_RADIUS_CHUNKS + 1) * BACKDROP_CHUNK_H;
export const BACKDROP_GRID_CELLS = BACKDROP_GRID_W * BACKDROP_GRID_H;

// Backdrop parallax factor (camera offset is multiplied by this).
export const BACKDROP_PARALLAX = 0.5;

// Backdrop SAB layout:
//   grid:   BACKDROP_GRID_W * BACKDROP_GRID_H * 4 bytes (Uint32 per cell — packed color)
//   stats:  8 bytes (originX, originY — backdrop grid origin in backdrop cell coords)
export const BACKDROP_GRID_BYTES = BACKDROP_GRID_CELLS * CELL_BYTES;
export const BACKDROP_STATS_BYTES = 8;
export const BACKDROP_TOTAL_SAB_BYTES = BACKDROP_GRID_BYTES + BACKDROP_STATS_BYTES;

export const BACKDROP_GRID_OFFSET = 0;
export const BACKDROP_STATS_OFFSET = BACKDROP_GRID_BYTES;

export const BACKDROP_STATS = {
  ORIGIN_X: 0, // int32 — backdropOriginCx * BACKDROP_CHUNK_W
  ORIGIN_Y: 4, // int32 — backdropOriginCy * BACKDROP_CHUNK_H
} as const;
