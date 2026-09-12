// Simulation tick rates and SharedArrayBuffer layout sizes

export const SIM_TICK_RATE = 60;           // Hz
export const SIM_TICK_DT = 1 / SIM_TICK_RATE;
export const MAX_SIM_SPEED = 10;
export const MIN_SIM_SPEED = 0;

// --- Entity slot game-specific field mapping ---
// The engine's SimChannel defines fixed fields for the first part of each
// 128-byte entity slot (see ENT in @downdraft/core). We repurpose unused
// engine fields and use the DATA area (f32 indices 22–29) for physics props.
//
// Engine fields we repurpose:
//   ENT.ID         (u32 idx 18) → model node id (renderer-side)
//   ENT.PARENT_ID  (u32 idx 19) → physics body handle (sim-side)
//   ENT.CHUNK_X    (u32 idx 20) → prop flags (PropFlags bitfield)
//   ENT.CHUNK_Z    (u32 idx 21) → paint texture handle (renderer-side)
//
// DATA area (f32 indices 22–29, 8 floats):
export const ENT_DATA = {
  CONTENT_ID_HASH: 0,  // f32 idx 22 — hash of content id for lookup
  MASS: 1,             // f32 idx 23 — physics mass
  RESTITUTION: 2,      // f32 idx 24 — physics bounciness
  FRICTION: 3,         // f32 idx 25 — physics friction
  GRAVITY_SCALE: 4,    // f32 idx 26 — physics gravity scale
  SHAPE: 5,            // u32 — 0 = box, 1 = sphere (stored as f32)
  // Squish visual deformation (driven by bounce-impact detection in the sim):
  SQUISH_AMOUNT: 6,    // f32 idx 28 — 0 = none, up to ~0.35 compression
  // Signed axis code: ±1=x, ±2=y, ±3=z. The sign is the impact-side direction
  // in the prop's local frame (which face was hit). 0 = no active squish. The
  // renderer decodes axis = |code| - 1 and shifts the prop's center toward the
  // far side so the impact face compresses inward from the contact point.
  SQUISH_AXIS: 7,      // i32 idx 29 — signed axis + impact-side direction
} as const;

// --- Player slot game-specific extension (indices 31–63 = f32 padding) ---
export const GAME_PLR = {
  ACTIVE_TOOL: 31,    // u32 — ToolType (stored as f32 slot index)
  FUN_MODE: 32,       // u32 — FunMode (stored as f32 slot index)
} as const;
