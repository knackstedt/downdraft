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

/**
 * Persistent player statistics — tracked across the entire playthrough and
 * saved with the world. These are cumulative counters that never decrease
 * (except on world reset). Used for the stats panel and achievement checks.
 */
export interface PlayerStats {
  /** Total ticks the simulation has run (1 tick = 1/60 sec at 60tps). */
  totalTicks: number;
  /** Deepest depth reached (in world Y cells below surface). */
  maxDepthCells: number;
  /** Total cells mined (dislodged from terrain). */
  totalCellsMined: number;
  /** Total items collected (ore + debris). */
  totalItemsCollected: number;
  /** Total gold earned from selling. */
  totalGoldEarned: number;
  /** Total gold spent (upgrades + build materials). */
  totalGoldSpent: number;
  /** Total number of deaths. */
  totalDeaths: number;
  /** Total number of bombs thrown. */
  totalBombsThrown: number;
  /** Total number of glowsticks thrown. */
  totalGlowsticksThrown: number;
  /** Total number of blocks placed (build mode). */
  totalBlocksPlaced: number;
  /** Total number of bars crafted (smelted at the furnace). */
  totalBarsCrafted: number;
  /** Total number of teleports to surface used. */
  totalTeleports: number;
  /** Per-material collection counts (material ID → count). */
  collectedByMaterial: Record<number, number>;
  /** Death count by cause (Material ID or DeathCause ID → count). */
  deathsByCause: Record<number, number>;
}

/** Create a fresh stats object with all counters at zero. */
export function createPlayerStats(): PlayerStats {
  return {
    totalTicks: 0,
    maxDepthCells: 0,
    totalCellsMined: 0,
    totalItemsCollected: 0,
    totalGoldEarned: 0,
    totalGoldSpent: 0,
    totalDeaths: 0,
    totalBombsThrown: 0,
    totalGlowsticksThrown: 0,
    totalBlocksPlaced: 0,
    totalBarsCrafted: 0,
    totalTeleports: 0,
    collectedByMaterial: {},
    deathsByCause: {},
  };
}

/**
 * Crafted item ID — a virtual item that exists only in inventory (not in the
 * grid). Bars are smelted from ore at the signpost furnace. Each bar sells
 * for more than the raw ore, creating an economic decision: sell raw ore for
 * quick gold, or smelt into bars for more gold (but requiring coal + a furnace).
 */
export type CraftedItemId =
  | "tin-bar"
  | "copper-bar"
  | "iron-bar"
  | "bauxite-bar"
  | "silver-bar"
  | "gold-bar"
  | "cobalt-bar"
  | "steel-bar"    // iron + coal
  | "bronze-bar"   // copper + tin
  | "brass-bar";   // copper + bauxite (aluminum)

/** Counts of each crafted item the player owns. Persisted in the save. */
export type CraftedItems = Record<CraftedItemId, number>;

/** Create a fresh crafted items object with all counts at zero. */
export function createCraftedItems(): CraftedItems {
  return {
    "tin-bar": 0,
    "copper-bar": 0,
    "iron-bar": 0,
    "bauxite-bar": 0,
    "silver-bar": 0,
    "gold-bar": 0,
    "cobalt-bar": 0,
    "steel-bar": 0,
    "bronze-bar": 0,
    "brass-bar": 0,
  };
}
