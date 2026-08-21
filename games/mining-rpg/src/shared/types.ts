// ============================================================================
// Mining RPG — shared types
// ============================================================================


export interface Vec2 {
  x: number;
  y: number;
}

export interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  mouseDown: boolean;
  mouseRight: boolean;
  mouseX: number; // world cell coords
  mouseY: number; // world cell coords
  digRadius: number;
}

export interface Camera2DState {
  x: number; // world cell coords (center)
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

export interface Chunk {
  cx: number;
  cy: number;
  grid: Uint32Array; // CHUNK_W * CHUNK_H cells (4 bytes/cell, packed)
  fields: Uint8Array; // CHUNK_W * CHUNK_H * 4 (gravity, temp, windX, windY)
  // Background layer: build materials (scaffolding/ladder/rope) at the same
  // resolution as the foreground grid. Stored per-chunk so it persists across
  // active grid rebuilds and saves. Empty (all zeros) for unmodified chunks.
  bgGrid: Uint32Array; // CHUNK_W * CHUNK_H cells (4 bytes/cell, packed)
  // Fog-of-war: 1 byte per cell (0 = unexplored, 1 = explored). Stored
  // per-chunk so it persists across active grid rebuilds and saves.
  explored: Uint8Array; // CHUNK_W * CHUNK_H bytes
  wakeTick: Uint32Array; // CHUNK_W * CHUNK_H — tick when cell re-freezes (0 = frozen)
  generated: boolean;
  dirty: boolean;
  active: boolean;
}

export interface InventoryEntry {
  mat: number;
  count: number;
}

/**
 * Counts of each placeable build material the player owns. Purchased at the
 * signpost with gold and consumed by placing blocks. Persisted in the save.
 */
export interface BuildMaterials {
  scaffolding: number;
  ladder: number;
  rope: number;
  torch: number;
}

export interface MiningPlayerState {
  x: number; // world cell coords
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  facing: number;
  animFrame: number;
  health: number;
  lastDamageMaterial?: number; // Material ID that last damaged the player (for death cause)
  oxygen?: number; // remaining oxygen ticks (OXYGEN_MAX_TICKS = full breath)
}

/**
 * Player upgrade levels. Each upgrade starts at level 0 (base stats) and
 * can be increased to improve mining capabilities and inventory capacity.
 * Persisted in the save file alongside player state.
 */
export interface PlayerUpgrades {
  /** Damage per hit — how much progress each mining tick makes. */
  damage: number;
  /** Mining radius — area of effect around the raycast hit point. */
  radius: number;
  /** Mining rate — ticks between hits (lower = faster). */
  rate: number;
  /** Max inventory slots — total item count the player can carry. */
  inventorySize: number;
}

/**
 * Serializable glowstick state. Glowsticks are thrown light sources that
 * persist for 1 hour real time (GLOWSTICK_LIFETIME_MS). Persisted in the save
 * so they survive hot reload / restart. `bornAt` is a wall-clock `Date.now()`
 * timestamp (NOT `performance.now()`, which resets every reload) so the
 * lifetime check remains correct across sessions.
 */
export interface SavedGlowstick {
  x: number; y: number;       // world cell coords (float)
  vx: number; vy: number;     // velocity per tick (0 when settled)
  ticks: number;              // ticks since thrown
  settled: boolean;           // true once it hits ground
  bornAt: number;             // Date.now() when thrown
  color: [number, number, number]; // random rainbow color (0-1 each)
}

export interface WorldConfig {
  seed: number;
  chunkW: number;
  chunkH: number;
  maxChunksX: number;
  activeRadiusChunks: number;
  freezeTicks: number;
}
