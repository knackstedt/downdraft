// ============================================================================
// Mining RPG — world constants
// ============================================================================

import { Material } from "@downdraft/library-sand";
import type { PlayerUpgrades } from "./types";

// ============================================================================
// Death causes — unified enum for all death types.
//
// Material-based deaths (lava, fire, gas, etc.) use the Material ID directly
// (0-95). Non-material deaths use IDs starting at 1000 to avoid collision.
// The player's lastDamageMaterial field stores a DeathCause value, which is
// looked up in the DEATH_MESSAGES object to pick a quip.
// ============================================================================
export const DeathCause = {
  // Non-material death causes (IDs above 1000 to avoid Material ID collision)
  Suffocation: 1000, // fully buried / crushed by terrain
  Falling: 1001, // lethal fall impact (high vertical velocity on landing)
  Drowning: 1002, // oxygen depleted while submerged in liquid
} as const;

// Fall damage — landing with vertical velocity above FALL_DAMAGE_THRESHOLD
// (in cells/tick) deals damage that scales QUADRATICALLY with the excess
// speed: damage = (excess)^2 * FALL_DAMAGE_SCALE. This makes short falls
// forgiving and long falls lethal:
//   vy=1.5 (threshold):   0 damage (safe)
//   vy=2.0:               25 damage (minor)
//   vy=2.5 (max fall):   100 damage (lethal)
//   vy=3.0:              225 damage (overkill)
//   vy=3.5 (bomb launch): 400 damage (overkill)
// There is no cap — higher velocity always means more damage.
export const FALL_DAMAGE_THRESHOLD = 1.5;
export const FALL_DAMAGE_SCALE = 100; // damage per (cell/tick above threshold)^2

// ============================================================================
// Build system — placeable scaffolding / ladders / ropes.
//
// The player toggles "build mode" (B) and selects a material (1/2/3). While in
// build mode, left-click places the selected material at the cursor (within
// MAX_MINE_RANGE) instead of mining. Build materials are purchased at the
// surface signpost with gold. Scaffolding is solid (stand on it); ladders and
// ropes are non-solid + climbable (climb through them, gravity suspended).
// ============================================================================

/** Build material types selectable by the player. */
export type BuildMaterialType = "scaffolding" | "ladder" | "rope" | "torch";

/** Map a build material type to its sand-library Material ID. */
export const BUILD_MATERIAL_ID: Record<BuildMaterialType, number> = {
  scaffolding: Material.Scaffolding,
  ladder: Material.Ladder,
  rope: Material.Rope,
  torch: Material.Torch,
};

/** Inverse map: Material ID → build material type (null if not a build mat). */
export function buildMaterialTypeFromId(mat: number): BuildMaterialType | null {
  switch (mat) {
    case Material.Scaffolding: return "scaffolding";
    case Material.Ladder: return "ladder";
    case Material.Rope: return "rope";
    case Material.Torch: return "torch";
    default: return null;
  }
}

/** Build material display info (name + swatch color + shape description). */
export const BUILD_MATERIAL_INFO: Record<BuildMaterialType, { name: string; color: string; shape: string }> = {
  scaffolding: { name: "Scaffolding", color: "#9e6b38", shape: "5-wide + 2 legs" },
  ladder: { name: "Ladder", color: "#8c5c2e", shape: "5×7" },
  rope: { name: "Rope", color: "#c7a866", shape: "3-wide, stacks" },
  torch: { name: "Torch", color: "#e68030", shape: "1×1, emits light" },
};

/** Purchase price per unit (gold) at the signpost shop. */
export const BUILD_MATERIAL_PRICES: Record<BuildMaterialType, number> = {
  scaffolding: 4,
  ladder: 8,
  rope: 3,
  torch: 12,
};

/** Hardness of placed build blocks when mined (low — easy to remove). */
export const BUILD_HARDNESS = 6;

/** Climb speed (cells/tick) while overlapping a ladder/rope. */
export const CLIMB_SPEED = 0.35;

// ============================================================================
// Build item dimensions — each item places a dynamic multi-cell pattern in the
// background grid. The cells are computed at placement time by place().
//
// Scaffolding: 5-wide horizontal platform centered on cursor, with auto
//   supports that fill downward up to SUPPORT_DEPTH cells, stopping when they
//   hit solid ground (foreground or background solid cell).
// Ladder: 5-wide × 7-tall block, top-center at cursor, extends downward.
// Rope: 3-wide × ROPE_SEGMENT_HEIGHT-tall segment. If the cursor is directly
//   above existing rope, the rope extends downward from its current bottom
//   instead of placing a new segment.
// ============================================================================

export const BUILD_DIMENSIONS = {
  scaffolding: { width: 5, supportDepth: 7 },
  ladder: { width: 5, height: 7 },
  rope: { width: 3, segmentHeight: 5 },
  torch: { width: 1, height: 1 },
} as const;

// Chunk dimensions (configurable). Start at 128x128 cells per chunk.
export const CHUNK_W = 128;
export const CHUNK_H = 128;

// Maximum horizontal extent: 24 chunks wide.
export const MAX_CHUNKS_X = 24;

// Active radius in chunks around the player. The active grid is
// (2*R+1) chunks wide and tall. R=2 → 5x5 chunks → 640x640 cells.
export const ACTIVE_RADIUS_CHUNKS = 2;

// Near-player radius in chunks. Chunks within this Chebyshev distance of the
// player's chunk are always kept active (never frozen) and their unfrozen
// cells have wakeTick re-extended every tick (never expire). Chunks OUTSIDE
// this radius (the outer ring of the active grid) can freeze when they have
// no unfrozen cells, reducing the active list and dirty-chunk count.
//
// Set to ACTIVE_RADIUS_CHUNKS - 1 so the center 3×3 chunks are always active
// (player's chunk + 1-ring buffer for particle flow) and the outer ring
// (distance 2 = 256+ cells, well beyond MAX_MINE_RANGE=30) can freeze.
// Particles that flow into a frozen chunk re-activate it via the wakeTick
// mechanism in expireWakeTicks (FLAG_UPDATED detection).
export const NEAR_PLAYER_RADIUS_CHUNKS = ACTIVE_RADIUS_CHUNKS - 1;

// Simulation tick rate (ticks per second).
export const TICK_RATE = 60;

// ============================================================================
// Drowning — oxygen bar that ticks down while the player's head is submerged
// in liquid. The bar lasts OXYGEN_MAX_TICKS (30 seconds @ 60tps = 1800 ticks).
// Once depleted, the player takes OXYGEN_DROWN_DAMAGE_PER_TICK damage per tick
// until they surface or die. Oxygen regenerates at OXYGEN_REGEN_PER_TICK when
// the head is above liquid (full refill in ~3 seconds).
// ============================================================================
export const OXYGEN_MAX_TICKS = TICK_RATE * 10; // 30 seconds of breath
export const OXYGEN_DROWN_DAMAGE_PER_TICK = .5; // 
export const OXYGEN_REGEN_PER_TICK = TICK_RATE * 20; // full refill in 60 ticks (~1s)

// ============================================================================
// Biome effects — gameplay modifiers based on depth (meters below surface).
//
// Each biome applies passive effects to the player while they're in it:
//   - gravityMul: multiplies base gravity (deeper = denser rock = heavier)
//   - heatDmgPerTick: passive heat damage (only in the deepest biomes)
//   - oxygenDrainMul: multiplies oxygen drain rate when submerged (pressure)
//
// Depth thresholds match the biome names in the HUD/DepthNotification.
// ============================================================================
export interface BiomeEffect {
  name: string;
  threshold: number; // depth in meters at which this biome starts
  gravityMul: number;
  heatDmgPerTick: number;
  oxygenDrainMul: number;
}

export const BIOME_EFFECTS: BiomeEffect[] = [
  { name: "Surface",       threshold: 0,    gravityMul: 1.0,  heatDmgPerTick: 0,    oxygenDrainMul: 1.0 },
  { name: "Topsoil Layer", threshold: 50,   gravityMul: 1.0,  heatDmgPerTick: 0,    oxygenDrainMul: 1.0 },
  { name: "Shallow Caves", threshold: 200,  gravityMul: 1.05, heatDmgPerTick: 0,    oxygenDrainMul: 1.1 },
  { name: "Deep Caves",    threshold: 500,  gravityMul: 1.1,  heatDmgPerTick: 0,    oxygenDrainMul: 1.2 },
  { name: "Iron Belt",     threshold: 1000, gravityMul: 1.15, heatDmgPerTick: 0,    oxygenDrainMul: 1.3 },
  { name: "Silver Depths", threshold: 1500, gravityMul: 1.2,  heatDmgPerTick: 0.05, oxygenDrainMul: 1.5 },
  { name: "Gold Zone",     threshold: 2000, gravityMul: 1.25, heatDmgPerTick: 0.1,  oxygenDrainMul: 1.7 },
  { name: "Cobalt Abyss",  threshold: 3000, gravityMul: 1.3,  heatDmgPerTick: 0.2,  oxygenDrainMul: 2.0 },
  { name: "Mantle",        threshold: 4000, gravityMul: 1.4,  heatDmgPerTick: 0.4,  oxygenDrainMul: 2.5 },
];

/** Get the active biome effect for a given depth (meters below surface). */
export function getBiomeEffect(depthMeters: number): BiomeEffect {
  let effect = BIOME_EFFECTS[0];
  for (let i = 0; i < BIOME_EFFECTS.length; i++) {
    if (depthMeters >= BIOME_EFFECTS[i].threshold) effect = BIOME_EFFECTS[i];
  }
  return effect;
}

// Freeze duration in ticks. 300 seconds @ 30tps = 9000 ticks.
export const FREEZE_TICKS = TICK_RATE * 60 * 1;

// ============================================================================
// Structural integrity — auto-demolish cells disconnected from the main world.
//
// Static Stone has gravity=0, so a block of stone fully surrounded by empty
// space (a "floating island") would hang forever. A periodic 4-connected
// flood-fill from the active-grid border detects solid cells with no path to
// the border (i.e. disconnected from the main world mass) and demolishes them
// by converting them to loose falling debris (same per-cell logic as explode()).
//
// The check uses typed-array MAT_FLAGS lookups + division-free BFS, so it's
// cheap enough to run frequently. It only runs when terrain was modified since
// the last check (static world = no re-check).
// ============================================================================
// Ticks between integrity checks. ~0.5 seconds @ 60tps — frequent enough that
// floating islands collapse before the player notices, without per-tick cost.
export const INTEGRITY_CHECK_INTERVAL = TICK_RATE / 2; // 30 ticks
// Safety cap on cells demolished per check — prevents a single pathological
// collapse from causing a multi-tick spike. 20000 is high enough to not limit
// normal play (a floating island that big is extreme); lower it if frame spikes
// appear during huge collapses.
export const INTEGRITY_MAX_DEMOLISH_PER_CHECK = 20000;

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
export const DEFAULT_DIG_RADIUS = 5;

// ============================================================================
// Mining upgrade system — base stats and per-level increments.
//
// The player starts with base stats and can upgrade via the upgrade system.
// Each upgrade level adds the increment to the base value.
// ============================================================================

/** Base mining damage per hit (progress points per mining tick). */
export const BASE_MINING_DAMAGE = 10;
/** Damage increment per upgrade level. */
export const DAMAGE_UPGRADE_INCREMENT = 5;

/** Base mining radius (cells around the raycast hit point). */
export const BASE_MINING_RADIUS = 5;
/** Radius increment per upgrade level. */
export const RADIUS_UPGRADE_INCREMENT = 1;

/** Base mining rate — ticks between hits (lower = faster). */
export const BASE_MINING_RATE = 3;
/** Rate reduction per upgrade level (minimum 1 tick between hits). */
export const RATE_UPGRADE_REDUCTION = 1;

/** Base max inventory size (total item count). */
export const BASE_INVENTORY_SIZE = 250000;
/** Inventory size increment per upgrade level. */
export const INVENTORY_SIZE_UPGRADE_INCREMENT = 125;

/** Stone hardness — how much damage needed to dislodge a stone cell. */
export const STONE_HARDNESS = 30;
/** Dirt hardness — how much damage needed to dislodge a dirt cell. */
export const DIRT_HARDNESS = 10;
/** Ore hardness — how much damage needed to dislodge an ore cell. */
export const ORE_HARDNESS = 20;
/** Gravel hardness — easy to clear (fine crushed stone). */
export const GRAVEL_HARDNESS = 8;
/** LooseStone hardness — legacy (old saves only; no new LooseStone is created). */
export const LOOSE_STONE_HARDNESS = 15;

// ============================================================================
// Upgrade shop — purchasable upgrades at the surface signpost.
//
// The player earns gold by selling ore at the signpost, then spends it on
// permanent upgrades. Each upgrade has a base price that scales linearly
// with the current level (price = basePrice * (currentLevel + 1)), so each
// rank costs more than the last — creating a gold sink that scales with
// progression. Upgrades persist across deaths and saves.
// ============================================================================


/** Configuration for a single upgrade type. */
export interface UpgradeConfig {
  /** Key in PlayerUpgrades that this upgrade modifies. */
  key: keyof PlayerUpgrades;
  /** Display name shown in the shop UI. */
  name: string;
  /** Short description of what each level does. */
  description: string;
  /** Base price in gold for level 1. Higher levels cost more (see upgradePrice). */
  basePrice: number;
  /** Maximum upgrade level (cannot purchase beyond this). */
  maxLevel: number;
  /** Color used for the upgrade icon in the UI. */
  color: string;
}

/** All purchasable upgrades, in display order. */
export const UPGRADE_CONFIG: UpgradeConfig[] = [
  {
    key: "damage",
    name: "Mining Damage",
    description: "+5 damage per hit",
    basePrice: 50,
    maxLevel: 10,
    color: "#f44336",
  },
  {
    key: "radius",
    name: "Mining Radius",
    description: "+1 cell AOE radius",
    basePrice: 100,
    maxLevel: 10,
    color: "#ff9800",
  },
  {
    key: "rate",
    name: "Mining Speed",
    description: "-1 tick between hits (faster)",
    basePrice: 75,
    maxLevel: 2,
    color: "#2196f3",
  },
  {
    key: "inventorySize",
    name: "Inventory Capacity",
    description: "+125 max items carried",
    basePrice: 80,
    maxLevel: 20,
    color: "#4caf50",
  },
];

/**
 * Calculate the gold price for the NEXT level of an upgrade.
 * Price scales linearly: level 1 costs basePrice, level 2 costs 2×basePrice, etc.
 * This makes early upgrades affordable and late upgrades a significant investment.
 */
export function upgradePrice(config: UpgradeConfig, currentLevel: number): number {
  return config.basePrice * (currentLevel + 1);
}

/** Max raycast range from player (in cells). */
export const MAX_MINE_RANGE = 30;

// World seed for deterministic terrain generation.
export const WORLD_SEED = 12345;

// --- Sell prices (currency per unit) ---
// Prices reflect rarity and depth requirement. Ores found deeper are worth more.
export const SELL_PRICES: Record<number, number> = {
  // Stone/Dirt/Sand — common, low value
  3: 1,    // Stone
  14: 1,   // Dirt
  15: 1,   // Grass
  62: 1,   // Gravel
  63: 2,   // LooseStone (legacy — old saves only)
  // Shallow ores (tin, copper, iron, bauxite, coal)
  52: 5,   // TinOre
  53: 8,   // CopperOre
  54: 12,  // IronOre
  55: 10,  // BauxiteOre
  61: 7,   // Coal
  // Deep ores (silver, gold, cobalt)
  56: 30,  // SilverOre
  57: 50,  // GoldOre
  58: 80,  // CobaltOre
};

// Radius (in cells) around the spawn point where the signpost sell zone is active.
export const SIGNPOST_RADIUS = 15;

// Active grid dimensions derived from chunk size + active radius.
export const ACTIVE_GRID_W = (2 * ACTIVE_RADIUS_CHUNKS + 1) * CHUNK_W;
export const ACTIVE_GRID_H = (2 * ACTIVE_RADIUS_CHUNKS + 1) * CHUNK_H;

// Total active grid cells.
export const ACTIVE_GRID_CELLS = ACTIVE_GRID_W * ACTIVE_GRID_H;

// ============================================================================
// Fog-of-war + colored lighting constants
//
// Fog-of-war: per-cell explored tracking. The worker marks cells within
// REVEAL_RADIUS of the player as explored each tick. The explored grid is
// uploaded to the renderer as an r8unorm texture; unexplored cells render
// as solid black.
//
// Colored lighting: the worker scans the active grid for emitting materials
// (lava, fire, torches, etc.) on a sparse grid every LIGHT_SCAN_INTERVAL
// ticks, clusters them, and writes a packed light list to the SAB. The
// renderer combines worker lights with renderer-side lights (headlamp,
// explosions) and renders them to a half-res light accumulation texture.
// ============================================================================

/** Cells around the player marked explored each tick (filled circle stamp). */
export const REVEAL_RADIUS = 32;

/** Max dynamic lights from the worker (emitting cells). Renderer adds more. */
export const MAX_WORLD_LIGHTS = 128;

/** Packed light struct: posX, posY, colorR, colorG, colorB, intensity, radius, pad (8 f32 = 32 bytes). */
export const LIGHT_STRUCT_FLOATS = 8;
export const LIGHT_STRUCT_BYTES = LIGHT_STRUCT_FLOATS * 4;

/** Light region: 4-byte count header + MAX_WORLD_LIGHTS * LIGHT_STRUCT_BYTES. */
export const LIGHT_REGION_BYTES = 4 + MAX_WORLD_LIGHTS * LIGHT_STRUCT_BYTES;

/** Sparse grid stride (in cells) for the emitting-cell scan. */
export const LIGHT_GRID_STRIDE = 12;

/** Scan emitting cells every N ticks (lights don't need 60Hz updates). */
export const LIGHT_SCAN_INTERVAL = 4;

/** Douse torches touched by liquids every N ticks. Torch-liquid interaction
 *  is not time-critical — 10 ticks (~6x/sec at 60tps) is responsive enough. */
export const TORCH_DOUSE_INTERVAL = 10;

// --- Headlamp (renderer-side light that follows the player) ---
export const HEADLAMP_RADIUS = 40;
export const HEADLAMP_COLOR: [number, number, number] = [0.7, 0.85, 1.0];
export const HEADLAMP_INTENSITY = 1.2;

// --- Torch (placeable build material that emits light) ---
export const TORCH_LIGHT_RADIUS = 25;
export const TORCH_LIGHT_COLOR: [number, number, number] = [1.0, 0.6, 0.2];
export const TORCH_LIGHT_INTENSITY = 0.9;

// --- Explosion light (renderer-side, brief flash) ---
export const EXPLOSION_LIGHT_RADIUS = 30;
export const EXPLOSION_LIGHT_COLOR: [number, number, number] = [1.0, 0.8, 0.4];
export const EXPLOSION_LIGHT_INTENSITY = 2.0;

// --- Volumetric light diffusion (GPU compute pass) ---
// Light propagates through air/water/solid cells with per-medium coefficients.
// Air spreads light well, water absorbs it (with a blue-green tint), and solid
// walls heavily attenuate light (slight bleed only) so caves are visualized
// with light flooding through air tunnels and dimming in water-filled caverns.
export interface VolumetricLightConfig {
  /** Number of Jacobi diffusion iterations per frame (~8 spreads light ~8 cells). */
  iterations: number;
  /** Light propagation per iteration through air (0..0.25 for stability). */
  airPropagation: number;
  /** Light propagation per iteration through water (lower = more absorption). */
  waterPropagation: number;
  /** Light bleed per iteration through solid walls (very low — heavy attenuation). */
  solidPropagation: number;
  /** Absorption tint applied to light passing through water (RGB multiplier). */
  waterAbsorption: [number, number, number];
  /** Ambient sky light color at the surface. */
  ambientSurface: [number, number, number];
  /** Cells below surface for ambient to reach black (quadratic falloff). */
  ambientDepthFalloff: number;
}

export const DEFAULT_VOLUMETRIC_LIGHT_CONFIG: VolumetricLightConfig = {
  iterations: 24,
  airPropagation: 1,
  waterPropagation: .8,
  solidPropagation: .4,
  waterAbsorption: [0.92, 0.96, 1.0], // slight blue-green absorption per iteration
  ambientSurface: [0.75, 0.75, 0.70],
  ambientDepthFalloff: 40,
};

// ============================================================================
// SharedArrayBuffer layout for the mining-rpg sim ↔ renderer bridge
//
// The active grid is a contiguous region that the worker writes each tick.
// Layout:
//   grid:     ACTIVE_GRID_W * ACTIVE_GRID_H * 4 bytes (Uint32 per cell)
//   fields:   ACTIVE_GRID_W * ACTIVE_GRID_H * 4 bytes (gravity, temp, windX, windY)
//   bgGrid:   ACTIVE_GRID_W * ACTIVE_GRID_H * 4 bytes (Uint32 per cell — build layer)
//   explored: ACTIVE_GRID_W * ACTIVE_GRID_H * 1 byte  (fog-of-war: 0=unexplored, 1=explored)
//   input:    128 bytes
//   stats:    32 bytes
//   player:   40 bytes (px, py, vx, vy, onGround, facing, animFrame, health, deathCause, oxygen)
//   lights:   4 + MAX_WORLD_LIGHTS * 32 bytes (count header + packed light structs)
// ============================================================================

export const ACTIVE_GRID_BYTES = ACTIVE_GRID_CELLS * CELL_BYTES;
export const ACTIVE_FIELD_BYTES = ACTIVE_GRID_CELLS * FIELD_BYTES;
export const BG_GRID_BYTES = ACTIVE_GRID_CELLS * CELL_BYTES; // same res as foreground
export const EXPLORED_GRID_BYTES = ACTIVE_GRID_CELLS * 1; // 1 byte per cell (fog-of-war)
export const INPUT_BYTES = 128;
export const STATS_BYTES = 32; // 8 int32s (6 used: frame, tick, fps, loadedChunks, originX, originY)
export const PLAYER_BYTES = 40; // 8 float32/int32 + 2 int32 (death cause, oxygen)

export const TOTAL_SAB_BYTES =
  ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES + BG_GRID_BYTES + EXPLORED_GRID_BYTES +
  INPUT_BYTES + STATS_BYTES + PLAYER_BYTES + LIGHT_REGION_BYTES;

// Offsets within the SAB
export const GRID_OFFSET = 0;
export const FIELD_OFFSET = ACTIVE_GRID_BYTES;
export const BG_GRID_OFFSET = ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES;
export const EXPLORED_GRID_OFFSET = ACTIVE_GRID_BYTES + ACTIVE_FIELD_BYTES + BG_GRID_BYTES;
export const INPUT_OFFSET = EXPLORED_GRID_OFFSET + EXPLORED_GRID_BYTES;
export const STATS_OFFSET = INPUT_OFFSET + INPUT_BYTES;
export const PLAYER_OFFSET = STATS_OFFSET + STATS_BYTES;
export const LIGHT_REGION_OFFSET = PLAYER_OFFSET + PLAYER_BYTES;

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
  BUILD_MODE: 44, // int32 — 1 when build mode is active (left-click places)
  BUILD_MAT: 48,  // int32 — Material ID to place while in build mode
  NOCLIP: 52,     // int32 — 1 when noclip (dev cheat) is active: player flies
                  //         freely through terrain, no gravity/collision/damage
  // offset 56 reserved
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
  DEATH_CAUSE: 32, // int32 — Material/DeathCause that caused death (0 = none)
  OXYGEN: 36, // int32 — remaining oxygen ticks (OXYGEN_MAX_TICKS = full)
} as const;

// ============================================================================
// Backdrop layer — low-res parallax background behind the foreground.
//
// The backdrop is at half resolution (CHUNK_W/2 × CHUNK_H/2 per chunk) and
// uses a separate SAB region. It is generated once per chunk and never
// simulated (no physics). Rendered with a parallax factor (0.5) so it
// scrolls slower than the foreground.
// ============================================================================

// Backdrop chunk dimensions — full foreground resolution (1:1). Each backdrop
// cell = 1 foreground cell, so the backdrop matches the foreground pixel-for-pixel.
// The visual depth separation comes from the dark colors + cave-wall texture,
// not from reduced resolution.
export const BACKDROP_CHUNK_W = CHUNK_W;
export const BACKDROP_CHUNK_H = CHUNK_H;

// Backdrop active grid dimensions (same chunk window as foreground, full-res).
export const BACKDROP_GRID_W = (2 * ACTIVE_RADIUS_CHUNKS + 1) * BACKDROP_CHUNK_W;
export const BACKDROP_GRID_H = (2 * ACTIVE_RADIUS_CHUNKS + 1) * BACKDROP_CHUNK_H;
export const BACKDROP_GRID_CELLS = BACKDROP_GRID_W * BACKDROP_GRID_H;

// Backdrop parallax factor. Set to 1.0 (no parallax) so the backdrop aligns
// 1:1 with the foreground — the backdrop shows the same world position as the
// foreground at each screen pixel. This is required for:
//   - Cave matching: backdrop caves align with foreground caves (same world coords)
//   - Light sampling: the volumetric/light textures (indexed by foreground local
//     coords) can be sampled at the same coords as the backdrop grid
//   - Vertical anchoring: no parallax offset accumulation with depth
// The half-resolution + dark colors provide the visual depth separation.
export const BACKDROP_PARALLAX = 1.0;

// Backdrop SAB layout:
//   grid:   BACKDROP_GRID_W * BACKDROP_GRID_H * 4 bytes (Uint32 per cell — packed color)
//   stats:  16 bytes (originX, originY, version, pad)
// The version counter is atomically incremented by the worker AFTER writing the
// grid + origin. The renderer uses a double-check pattern (read version before
// and after reading the grid) to avoid uploading a partially-written grid.
export const BACKDROP_GRID_BYTES = BACKDROP_GRID_CELLS * CELL_BYTES;
export const BACKDROP_STATS_BYTES = 16;
export const BACKDROP_TOTAL_SAB_BYTES = BACKDROP_GRID_BYTES + BACKDROP_STATS_BYTES;

export const BACKDROP_GRID_OFFSET = 0;
export const BACKDROP_STATS_OFFSET = BACKDROP_GRID_BYTES;

export const BACKDROP_STATS = {
  ORIGIN_X: 0,  // int32 — backdropOriginCx * BACKDROP_CHUNK_W
  ORIGIN_Y: 4,  // int32 — backdropOriginCy * BACKDROP_CHUNK_H
  VERSION: 8,   // int32 — atomically incremented after grid + origin write
  PAD: 12,      // int32 — padding
} as const;

// --- Backdrop cell-type encoding (packed in the r32uint grid's alpha byte) ---
// The backdrop pass is opaque (alpha=255 in the original design), so the
// alpha byte is repurposed to encode the cell type so the fragment shader
// can apply per-type lighting (cave voids catch diffused light, lava is
// self-emissive, water/oil are tinted, solid walls are modulated by light).
export const BACKDROP_CELL_TYPE = {
  CAVE: 0,     // air void (underground) — lit by diffused volumetric light
  SKY: 32,     // sky void (above surface) — rendered as sky gradient, never lit
  WATER: 64,   // water lake — dark body + blue-tinted diffused light
  OIL: 128,    // oil lake — dark, minimal light
  SOLID: 200,  // solid cave wall — texture modulated by light
  LAVA: 255,   // lava lake — self-emissive glow + small light contribution
} as const;

// --- Loose cave-match parameters ---
// The backdrop uses the SAME worldFbm noise field as the foreground isCavity
// check (same seed, same scale, same octaves) so caves are in the same areas.
// A slightly lower threshold makes backdrop caves wider than foreground caves
// — a superset, not a 1:1 copy. This reads as a parallax slice where caves
// "bleed" into the distance. Tunable: raise THRESHOLD_DELTA (more negative =
// wider backdrop caves; 0 = exact 1:1 match).
export const BACKDROP_CAVE_SEED_OFFSET = 0;
export const BACKDROP_CAVE_THRESHOLD_DELTA = -0.04;

// ============================================================================
// Material helpers — shared between chunk-world.ts and mining-player.ts
// (kept here to avoid circular imports between those two modules).
// ============================================================================

/**
 * Check if a material is collectible (ore, loose stone/dirt, refined metals).
 * Ores, refined metals, and loose stone debris (Gravel, Dirt, Grass) are
 * collected by proximity. Static Stone itself is NOT collectible — it must be
 * mined first (converted to Gravel via the mining damage system), then the
 * loose debris is collected. LooseStone is included for legacy saves.
 */
export function isCollectible(mat: number): boolean {
  return (
    mat === Material.TinOre ||
    mat === Material.CopperOre ||
    mat === Material.IronOre ||
    mat === Material.BauxiteOre ||
    mat === Material.SilverOre ||
    mat === Material.GoldOre ||
    mat === Material.CobaltOre ||
    mat === Material.Coal ||
    mat === Material.Iron ||
    mat === Material.Dirt ||
    mat === Material.Grass ||
    mat === Material.Gravel ||
    mat === Material.LooseStone
  );
}
