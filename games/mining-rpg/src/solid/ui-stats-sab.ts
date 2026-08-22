// ============================================================================
// ui-stats-sab — SharedArrayBuffer for per-frame UI-relevant scalars.
//
// The main thread (MiningRenderer) writes these values each frame after
// polling the sim SAB. The UI worker reads them synchronously on its rAF
// tick — zero round-trips, no postMessage latency.
//
// Only scalars that change frequently (every frame or near-frame) belong here.
// Event-driven data (collected items, saves, achievements) flows via
// postMessage through the bridge protocol.
//
// Layout: fixed 256 bytes, all fields 4-byte aligned.
// ============================================================================

/** Total SAB size in bytes. */
export const UI_STATS_SAB_BYTES = 256;

/** Field offsets within the SAB (in bytes). */
export const UI_STATS = {
  FPS: 0,              // f32 — render FPS (updated every 500ms)
  HEALTH: 4,           // i32 — player health (0-100)
  OXYGEN: 8,           // i32 — remaining oxygen ticks
  DEPTH: 12,           // i32 — player depth in chunks (0 = surface)
  LOADED_CHUNKS: 16,   // i32 — number of loaded chunks
  ACTIVE_CHUNKS: 20,   // i32 — number of active (simulating) chunks
  NEAR_SIGNPOST: 24,   // i32 — 1 if player is within sell range of signpost
  ON_GROUND: 28,       // i32 — 1 if player is standing on ground
  PLAYER_FACING: 32,   // i32 — 1 = right, -1 = left
  PLAYER_X: 36,        // f32 — player x in world cell coords
  PLAYER_Y: 40,        // f32 — player y in world cell coords
  PLAYER_VX: 44,       // f32 — player velocity x
  PLAYER_VY: 48,       // f32 — player velocity y
  DEATH_CAUSE: 52,     // i32 — Material ID / DeathCause ID of last damage
  SIM_READY: 56,       // i32 — 1 once the worker writes its first frame
  TICK: 60,            // i32 — sim tick counter
  GAME_OVER: 64,       // i32 — 1 when player health reaches 0
  ZOOM: 68,            // f32 — camera zoom level
  GLOWSTICK_COUNT: 72, // i32 — active glowsticks in the world
  BOMB_COUNT: 76,      // i32 — active bombs in the world
  TELEPORT_COOLDOWN: 80, // f32 — 0-1, 1 = ready
  PLAYER_SPEED: 84,    // f32 — current movement speed in cells/sec
} as const;

/** Data written by the main thread each frame. */
export interface UiStatsData {
  fps: number;
  health: number;
  oxygen: number;
  depth: number;
  loadedChunks: number;
  activeChunks: number;
  nearSignpost: boolean;
  onGround: boolean;
  playerFacing: number;
  playerX: number;
  playerY: number;
  playerVx: number;
  playerVy: number;
  deathCause: number;
  simReady: boolean;
  tick: number;
  gameOver: boolean;
  zoom: number;
  glowstickCount: number;
  bombCount: number;
  teleportCooldown: number;
  playerSpeed: number;
}

/** Allocate a new UiStatsSAB. Call on the main thread. */
export function allocateUiStatsSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(UI_STATS_SAB_BYTES);
}

/** Write per-frame stats into the SAB. Call on the main thread each frame. */
export function writeUiStats(sab: SharedArrayBuffer, data: Partial<UiStatsData>): void {
  const f32 = new Float32Array(sab);
  const i32 = new Int32Array(sab);
  if (data.fps !== undefined) f32[UI_STATS.FPS / 4] = data.fps;
  if (data.health !== undefined) i32[UI_STATS.HEALTH / 4] = data.health;
  if (data.oxygen !== undefined) i32[UI_STATS.OXYGEN / 4] = data.oxygen;
  if (data.depth !== undefined) i32[UI_STATS.DEPTH / 4] = data.depth;
  if (data.loadedChunks !== undefined) i32[UI_STATS.LOADED_CHUNKS / 4] = data.loadedChunks;
  if (data.activeChunks !== undefined) i32[UI_STATS.ACTIVE_CHUNKS / 4] = data.activeChunks;
  if (data.nearSignpost !== undefined) i32[UI_STATS.NEAR_SIGNPOST / 4] = data.nearSignpost ? 1 : 0;
  if (data.onGround !== undefined) i32[UI_STATS.ON_GROUND / 4] = data.onGround ? 1 : 0;
  if (data.playerFacing !== undefined) i32[UI_STATS.PLAYER_FACING / 4] = data.playerFacing;
  if (data.playerX !== undefined) f32[UI_STATS.PLAYER_X / 4] = data.playerX;
  if (data.playerY !== undefined) f32[UI_STATS.PLAYER_Y / 4] = data.playerY;
  if (data.playerVx !== undefined) f32[UI_STATS.PLAYER_VX / 4] = data.playerVx;
  if (data.playerVy !== undefined) f32[UI_STATS.PLAYER_VY / 4] = data.playerVy;
  if (data.deathCause !== undefined) i32[UI_STATS.DEATH_CAUSE / 4] = data.deathCause;
  if (data.simReady !== undefined) i32[UI_STATS.SIM_READY / 4] = data.simReady ? 1 : 0;
  if (data.tick !== undefined) i32[UI_STATS.TICK / 4] = data.tick;
  if (data.gameOver !== undefined) i32[UI_STATS.GAME_OVER / 4] = data.gameOver ? 1 : 0;
  if (data.zoom !== undefined) f32[UI_STATS.ZOOM / 4] = data.zoom;
  if (data.glowstickCount !== undefined) i32[UI_STATS.GLOWSTICK_COUNT / 4] = data.glowstickCount;
  if (data.bombCount !== undefined) i32[UI_STATS.BOMB_COUNT / 4] = data.bombCount;
  if (data.teleportCooldown !== undefined) f32[UI_STATS.TELEPORT_COOLDOWN / 4] = data.teleportCooldown;
  if (data.playerSpeed !== undefined) f32[UI_STATS.PLAYER_SPEED / 4] = data.playerSpeed;
}

/** Read all stats from the SAB as a plain object. Call on the worker thread. */
export function readUiStats(sab: SharedArrayBuffer): UiStatsData {
  const f32 = new Float32Array(sab);
  const i32 = new Int32Array(sab);
  return {
    fps: f32[UI_STATS.FPS / 4],
    health: i32[UI_STATS.HEALTH / 4],
    oxygen: i32[UI_STATS.OXYGEN / 4],
    depth: i32[UI_STATS.DEPTH / 4],
    loadedChunks: i32[UI_STATS.LOADED_CHUNKS / 4],
    activeChunks: i32[UI_STATS.ACTIVE_CHUNKS / 4],
    nearSignpost: i32[UI_STATS.NEAR_SIGNPOST / 4] !== 0,
    onGround: i32[UI_STATS.ON_GROUND / 4] !== 0,
    playerFacing: i32[UI_STATS.PLAYER_FACING / 4],
    playerX: f32[UI_STATS.PLAYER_X / 4],
    playerY: f32[UI_STATS.PLAYER_Y / 4],
    playerVx: f32[UI_STATS.PLAYER_VX / 4],
    playerVy: f32[UI_STATS.PLAYER_VY / 4],
    deathCause: i32[UI_STATS.DEATH_CAUSE / 4],
    simReady: i32[UI_STATS.SIM_READY / 4] !== 0,
    tick: i32[UI_STATS.TICK / 4],
    gameOver: i32[UI_STATS.GAME_OVER / 4] !== 0,
    zoom: f32[UI_STATS.ZOOM / 4],
    glowstickCount: i32[UI_STATS.GLOWSTICK_COUNT / 4],
    bombCount: i32[UI_STATS.BOMB_COUNT / 4],
    teleportCooldown: f32[UI_STATS.TELEPORT_COOLDOWN / 4],
    playerSpeed: f32[UI_STATS.PLAYER_SPEED / 4],
  };
}
