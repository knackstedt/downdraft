// ─── IPC mesh data format for the Rust renderer ─────────────
export interface IPCMeshData {
  vertexCount: number;
  indexCount: number;
  posX: number;
  posZ: number;
  lodLevel: number;
  lodDistance: number;
  verts: Float32Array;
  indices: Uint32Array;
  meshType: number; // 0 = terrain, 1 = water
}

// ─── Simulation tick ───────────────────────────────────────
export const SIM_TICK_DT = 1 / 60;

// ─── Input Key Codes (ported from to-the-ocean input-buffer.ts) ──
// Maps to bit positions in a 256-bit key bitmask (8 × u32 words)
export const KEY = {
  W: 87, A: 65, S: 83, D: 68,
  Q: 81, E: 69, R: 82, F: 70,
  SHIFT: 16, CTRL: 17, ALT: 18, TAB: 9,
  SPACE: 32, ENTER: 13, ESC: 27,
  ONE: 49, TWO: 50, THREE: 51, FOUR: 52,
  FIVE: 53, SIX: 54, SEVEN: 55, EIGHT: 56,
  NINE: 57, ZERO: 48,
  I: 73, B: 66, C: 67, M: 77, P: 80,
  T: 84, V: 86, Z: 90, X: 88,
  Y: 89, G: 71, H: 72, J: 74,
  UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
  F5: 116,
  BRACKET_LEFT: 219,
  BRACKET_RIGHT: 221,
} as const;

// ─── Enums ─────────────────────────────────────────────────

// Camera modes (parity with to-the-ocean CameraMode enum)
export enum CameraMode {
  FirstPerson = 0,
  ThirdPerson = 1,
  FreeCam = 2,
}

// Biome types for terrain variation
export enum BiomeType {
  Tropical = 0,
  Temperate = 1,
  Arctic = 2,
  Desert = 3,
  Volcanic = 4,
}

// Terrain material type (determines vertex color)
export enum TerrainType {
  DeepUnderwater = 0,
  ShallowUnderwater = 1,
  Shoreline = 2,
  Sand = 3,
  Grass = 4,
  Forest = 5,
  Stone = 6,
  Rock = 7,
  Snow = 8,
  Ash = 9,
}

export enum WeatherType {
  Clear = 0,
  PartlyCloudy = 1,
  Overcast = 2,
  Rain = 3,
  Storm = 4,
  Fog = 5,
  Eclipse = 6,
  FullMoon = 7,
  HellStorm = 8,
  Snow = 9,
}

export enum WildlifeState {
  Patrol = 0,
  Hunt = 1,
  Flee = 2,
}

export enum PirateState {
  Patrol = 0,
  Chase = 1,
  Attack = 2,
  Flee = 3,
}

export enum PlantStage {
  Seed = 0,
  Sprout = 1,
  Growing = 2,
  Mature = 3,
  Overripe = 4,
}

export enum AnimalStage {
  Baby = 0,
  Juvenile = 1,
  Adult = 2,
}

export enum PetType {
  Cat = 0,
  Dog = 1,
  Parrot = 2,
  Shark = 3,
}

export enum ToolType {
  None = 0,
  Axe = 1,
  Shovel = 2,
  Gun = 3,
  FishingRod = 4,
}

// ─── Terrain Config (ported from to-the-ocean TerrainConfig.ts) ──
export const TERRAIN_CONFIG = {
  voxelSize: 0.79,
  isoLevel: 0.0,
  maxVoxelMemory: 160_000_000,

  blobCount: 5,
  blobMinRadius: 0.35,
  blobMaxRadius: 0.55,
  blobMinStrength: 0.6,
  blobMaxStrength: 0.9,
  blobSmoothUnionK: 0.8,
  blobEdgeExtend: 0.25,
  blobSpread: 0.4,

  cliffSideRadius: 0.5,
  gentleSideRadius: 1.25,
  cliffDepthFactor: 0.25,
  plateauSharpness: 0.6,

  heightNoiseScale: 2.0,
  heightNoiseOctaves: 2,
  heightNoiseAmplitude: 0.03,
  peakHeight: 0.08,
  depthHeight: 0.15,
  yExtentMultiplier: 2.0,

  beachThreshold: 0.03,
  beachGradientScale: 0.4,

  cliffGradientThreshold: 1.2,
  cliffNoiseScale: 5.0,
  cliffNoiseThreshold: 0.55,

  caveEnabled: true,
  caveNoiseScale: 4.0,
  caveNoiseOctaves: 3,
  caveThreshold: 0.15,
  caveMinDepth: 0.02,

  chunkSize: 32,
  chunkBits: 5,
  chunkMask: 31,
} as const;

// ─── Island Water Config (diffusion + wave run-up) ────────
export const ISLAND_WATER_CONFIG = {
  // Spring-diffusion parameters for ocean ↔ island water stitching
  springK: 30.0,         // spring constant — higher = faster wave propagation
  dampingK: 4.0,         // velocity damping — higher = less oscillation
  // Wave run-up parameters for water ↔ terrain interaction
  runUpAmplitude: 0.8,   // max height water rises above still-water on shore
  runUpPeriod: 4.0,      // seconds between wave run-up cycles
  runUpDamping: 0.5,     // how quickly run-up fades on steeper terrain (0-1)
} as const;

// ─── Biome-specific terrain colors ─────────────────────────
export const BIOME_COLORS: Record<number, {
  grass: [number, number, number];
  forest: [number, number, number];
  rock: [number, number, number];
  sand: [number, number, number];
  shoreline: [number, number, number];
  deepUnderwater: [number, number, number];
  shallowUnderwater: [number, number, number];
  peak: [number, number, number];
}> = {
  [BiomeType.Tropical]: {
    grass: [0.3, 0.55, 0.2], forest: [0.18, 0.42, 0.12],
    rock: [0.4, 0.38, 0.35], sand: [0.76, 0.70, 0.50],
    shoreline: [0.35, 0.32, 0.25], deepUnderwater: [0.08, 0.07, 0.06],
    shallowUnderwater: [0.16, 0.14, 0.11], peak: [0.5, 0.45, 0.4],
  },
  [BiomeType.Temperate]: {
    grass: [0.25, 0.45, 0.18], forest: [0.15, 0.35, 0.10],
    rock: [0.38, 0.36, 0.33], sand: [0.72, 0.68, 0.48],
    shoreline: [0.32, 0.30, 0.23], deepUnderwater: [0.07, 0.06, 0.05],
    shallowUnderwater: [0.14, 0.12, 0.10], peak: [0.48, 0.43, 0.38],
  },
  [BiomeType.Arctic]: {
    grass: [0.7, 0.75, 0.72], forest: [0.5, 0.6, 0.55],
    rock: [0.55, 0.55, 0.58], sand: [0.8, 0.8, 0.78],
    shoreline: [0.6, 0.62, 0.65], deepUnderwater: [0.05, 0.08, 0.12],
    shallowUnderwater: [0.12, 0.18, 0.25], peak: [0.9, 0.92, 0.95],
  },
  [BiomeType.Desert]: {
    grass: [0.65, 0.58, 0.35], forest: [0.5, 0.45, 0.28],
    rock: [0.5, 0.42, 0.30], sand: [0.85, 0.75, 0.50],
    shoreline: [0.55, 0.48, 0.32], deepUnderwater: [0.08, 0.07, 0.05],
    shallowUnderwater: [0.15, 0.13, 0.10], peak: [0.55, 0.48, 0.38],
  },
  [BiomeType.Volcanic]: {
    grass: [0.25, 0.20, 0.15], forest: [0.15, 0.12, 0.08],
    rock: [0.30, 0.22, 0.18], sand: [0.35, 0.25, 0.20],
    shoreline: [0.25, 0.20, 0.15], deepUnderwater: [0.05, 0.03, 0.02],
    shallowUnderwater: [0.10, 0.06, 0.04], peak: [0.2, 0.15, 0.12],
  },
};

// ─── Player / Survival Constants ───────────────────────────
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_HUNGER = 100;
export const PLAYER_MAX_THIRST = 100;
export const PLAYER_MAX_OXYGEN = 100;
export const PLAYER_TEMP_MIN = 34;
export const PLAYER_TEMP_MAX = 42;
export const PLAYER_TEMP_NORM = 37;
export const HUNGER_DECAY_RATE = 0.15;
export const THIRST_DECAY_RATE = 0.2;
export const OXYGEN_DRAIN_RATE = 2.5;
export const OXYGEN_REGEN_RATE = 10;
export const TEMP_DAMAGE_THRESHOLD_LOW = 35;
export const TEMP_DAMAGE_THRESHOLD_HIGH = 39;
export const TEMP_DAMAGE_RATE = 3;
export const HUNGER_DAMAGE_RATE = 2;
export const THIRST_DAMAGE_RATE = 3;
export const HEALTH_REGEN_RATE = 0.5;
export const PLAYER_WALK_SPEED = 4.5;
export const PLAYER_RUN_SPEED = 8.0;
export const PLAYER_SWIM_SPEED = 3.0;
export const PLAYER_DIVE_SPEED = 4.0;
export const PLAYER_JUMP_VELOCITY = 6.0;
export const PLAYER_GRAVITY = 9.8;
export const PLAYER_NOCLIP_SPEED = 15.0;
export const PLAYER_CLIMB_SPEED = 3.0;
export const PLAYER_FALL_DAMAGE_THRESHOLD = 8;
export const PLAYER_FALL_DAMAGE_RATE = 5;
export const PLAYER_WATER_BUOYANCY = 3.0;
export const PLAYER_WATER_DAMPING = 0.8;
export const PLAYER_GROUND_FRICTION = 0.85;
export const PLAYER_AIR_FRICTION = 0.98;
export const MOUSE_LOOK_SENSITIVITY = 0.0025;
export const CAMERA_MIN_DISTANCE = 2;
export const CAMERA_MAX_DISTANCE = 50;
export const CAMERA_FIRST_PERSON_OFFSET = 0.0;
export const CAMERA_THIRD_PERSON_DEFAULT = 15;
export const CAMERA_FREECAM_SPEED = 20;
export const HOTBAR_SLOTS = 10;

// ─── Ship Constants ────────────────────────────────────────
export const SHIP_MAX_SPEED = 12;
export const SHIP_ACCEL = 2.0;
export const SHIP_TURN_RATE = 0.8;
export const SHIP_DRAG = 0.5;
export const BUOYANCY_FORCE = 9.8;
export const WATER_LEVEL = 0;

// ─── Wildlife Constants ────────────────────────────────────
export const WILDLIFE_SPAWN_RADIUS = 80;
export const WILDLIFE_MAX_COUNT = 15;
export const WILDLIFE_DESPAWN_RADIUS = 150;
export const SHARK_SPEED = 4;
export const SHARK_ATTACK_RANGE = 2;
export const SHARK_ATTACK_DAMAGE = 20;
export const SHARK_ATTACK_COOLDOWN = 3;
export const SHARK_HUNT_RANGE = 15;
export const SHARK_DESPAWN_RANGE = 30;
export const FISH_SPEED = 1.5;

// ─── Weather Constants ─────────────────────────────────────
export const WEATHER_CLEAR_CHANCE = 0.80;
export const WEATHER_FULL_CLEAR = 0.30;
export const WEATHER_PARTLY_CLOUDY = 0.40;
export const WEATHER_OVERCAST = 0.30;
export const WEATHER_MAX_DURATION = 300;
export const WEATHER_MIN_DURATION = 60;
export const WEATHER_RARE_EVENT_CHANCE = 0.02;
export const RAIN_COLLECTOR_CAPACITY = 50;
export const RAIN_COLLECTOR_FILL_RATE = 5;
export const DAY_DURATION = 600;
export const NIGHT_START_FRAC = 0.75;
export const NIGHT_END_FRAC = 0.25;

// ─── Fishing Constants ─────────────────────────────────────
export const FISHING_CAST_RANGE = 15;
export const FISHING_MIN_WAIT = 2;
export const FISHING_MAX_WAIT = 8;
export const FISHING_CATCH_CHANCE = 0.7;

// ─── Crafting Constants ────────────────────────────────────
export const CRAFT_PLANK_COST = 1;
export const CRAFT_CAMPFIRE_COST = 3;
export const CRAFT_SAIL_COST = 5;
export const CRAFT_RAFT_COST = 8;
export const COOK_FISH_TIME = 5;

// ─── Island Constants ──────────────────────────────────────
export const ISLAND_COUNT = 6;
export const ISLAND_MIN_RADIUS = 50;
export const ISLAND_MAX_RADIUS = 120;
export const ISLAND_MIN_HEIGHT = 2;
export const ISLAND_MAX_HEIGHT = 8;
export const ISLAND_SPAWN_RANGE = 600;
export const ISLAND_BEACH_LEVEL = 0.5;

export const ISLAND_LOD_CONFIGS = [
  { step: 1, distance: 0 },
  { step: 3, distance: 150 },
  { step: 6, distance: 350 },
] as const;

export const ISLAND_TERRAIN_MAX_VERTS = 500_000;
export const ISLAND_WATER_MAX_VERTS = 200_000;

// ─── Inventory Constants ───────────────────────────────────
export const INV_MAX_SLOTS = 20;
export const SPOILAGE_RATE = 0.01;

// ─── Ship Boarding Constants ───────────────────────────────
export const BOARD_RANGE = 3;
export const REPAIR_RATE = 10;
export const REPAIR_WOOD_COST = 1;

// ─── Pirate Constants ──────────────────────────────────────
export const PIRATE_SPAWN_INTERVAL = 30;
export const PIRATE_SPAWN_CHANCE = 0.3;
export const PIRATE_SPAWN_MIN_DIST = 60;
export const PIRATE_SPAWN_MAX_DIST = 120;
export const PIRATE_SPEED = 4;
export const PIRATE_CHASE_RANGE = 50;
export const PIRATE_ATTACK_RANGE = 10;
export const PIRATE_ATTACK_DAMAGE = 5;
export const PIRATE_ATTACK_COOLDOWN = 2;
export const PIRATE_HEALTH = 60;
export const PIRATE_LOOT_DROP = 3;

// ─── Port & Market Constants ───────────────────────────────
export const PORT_TRADE_RANGE = 15;
export const MARKET_PRICE_RECOVERY = 0.01;
export const MARKET_PRICE_MAX_MOD = 2.0;
export const PORT_COUNT = 2;

// ─── Animal Constants ──────────────────────────────────────
export const ANIMAL_GROWTH_TIME = 120;
export const ANIMAL_PRODUCT_TIME = 120;
export const ANIMAL_HUNGER_DECAY = 0.5;
export const ANIMAL_COUNT_PER_ISLAND = 2;

// ─── Plant Constants ───────────────────────────────────────
export const PLANT_STAGE_DURATIONS = [30, 60, 120, 300];
export const PLANT_WATER_DECAY = 0.3;
export const PLANT_COUNT_PER_ISLAND = 3;

// ─── Pet Constants ─────────────────────────────────────────
export const PET_FOLLOW_SPEED = 2.5;
export const PET_FOLLOW_RANGE = 5;
export const PET_HUNGER_DECAY = 0.3;

// ─── Tool Constants ────────────────────────────────────────
export const TOOL_AXE_COOLDOWN = 1;
export const TOOL_AXE_RANGE = 3;
export const TOOL_SHOVEL_COOLDOWN = 2;
export const TOOL_SHOVEL_RANGE = 3;
export const TOOL_GUN_COOLDOWN = 0.5;
export const TOOL_GUN_RANGE = 50;
export const TOOL_GUN_DAMAGE = 25;

// ─── Progression Constants ─────────────────────────────────
export const XP_PER_LEVEL = 100;
export const XP_KILL_PIRATE = 50;
export const XP_CATCH_FISH = 5;
export const XP_CRAFT = 10;
export const XP_HARVEST = 15;
export const XP_MAX_LEVEL = 20;

// ─── Game Mode Constants ───────────────────────────────────
export const GAME_DIFFICULTY_EASY = 0;
export const GAME_DIFFICULTY_NORMAL = 1;
export const GAME_DIFFICULTY_HARD = 2;
