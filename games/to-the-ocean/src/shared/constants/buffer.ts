// Simulation tick rates and SharedArrayBuffer layout sizes

export const SIM_TICK_RATE = 60;           // Hz
export const SIM_TICK_DT = 1 / SIM_TICK_RATE;
export const PHYSICS_SUBSTEPS = 3;
export const MAX_SIM_SPEED = 10;           // max tick multiplier for speed-up
export const MIN_SIM_SPEED = 0;            // 0 = paused (no ticks)
export const MAX_ENTITIES = 8192;
export const MAX_PLAYERS = 8;
export const CHUNK_SIZE = 256;             // meters
export const RENDER_DISTANCE = 2048;       // meters
export const CHUNKS_VISIBLE = Math.ceil(RENDER_DISTANCE / CHUNK_SIZE) + 2; // +2 chunk margin beyond render distance

// --- SharedArrayBuffer Sizes ---

export const SIM_HEADER_SIZE = 256;
export const SIM_ENTITY_SLOT_SIZE = 128;
export const SIM_PLAYER_SLOT_SIZE = 256;

export const SIM_BUFFER_SIZE = SIM_HEADER_SIZE + MAX_ENTITIES * SIM_ENTITY_SLOT_SIZE + MAX_PLAYERS * SIM_PLAYER_SLOT_SIZE;

export const INPUT_HEADER_SIZE = 64;
export const INPUT_SLOT_SIZE = 128;
export const INPUT_BUFFER_SIZE = INPUT_HEADER_SIZE + MAX_PLAYERS * INPUT_SLOT_SIZE;

export const WATER_GRID_SIZE = 256;
export const WATER_HEADER_SIZE = 64;
export const WATER_HEIGHT_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 4;   // f32
export const WATER_NORMAL_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 12; // f32x3
export const WATER_FLOW_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 8;    // f32x2
export const WATER_BUFFER_SIZE = WATER_HEADER_SIZE + WATER_HEIGHT_BYTES + WATER_NORMAL_BYTES + WATER_FLOW_BYTES;

// --- Game-specific player SAB extension ---
// The core engine player slot (SIM_PLAYER_SLOT_SIZE = 256 bytes = 64 f32s)
// reserves indices 31–63 for game-specific state. These constants define
// to-the-ocean's extension fields in that padding area.
export const GAME_PLR = {
  GOLD: 31,
  FISHING_TENSION: 32,
  FISHING_PROGRESS: 33,
} as const;
