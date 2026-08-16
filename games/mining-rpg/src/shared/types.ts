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
  wakeTick: Uint32Array; // CHUNK_W * CHUNK_H — tick when cell re-freezes (0 = frozen)
  generated: boolean;
  dirty: boolean;
  active: boolean;
}

export interface InventoryEntry {
  mat: number;
  count: number;
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

export interface WorldConfig {
  seed: number;
  chunkW: number;
  chunkH: number;
  maxChunksX: number;
  activeRadiusChunks: number;
  freezeTicks: number;
}
