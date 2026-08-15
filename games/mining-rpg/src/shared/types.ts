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
}

export interface WorldConfig {
  seed: number;
  chunkW: number;
  chunkH: number;
  maxChunksX: number;
  activeRadiusChunks: number;
  freezeTicks: number;
}
