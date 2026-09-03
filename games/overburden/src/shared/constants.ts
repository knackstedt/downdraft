// ============================================================================
// Overburden — world constants
// ============================================================================

// --- World dimensions ---
// The world is a horizontal cylinder: wraps east↔west (X modulo circumference).
// 1x world size per The Blockheads wiki: 16,384 blocks wide × 1,024 tall.
export const WORLD_W = 16384;
export const WORLD_H = 1024;

// --- Chunking ---
// Chunks of 64×64 blocks. Only chunks near active blockheads are loaded + simulated.
export const CHUNK_W = 64;
export const CHUNK_H = 64;
export const CHUNK_CELLS = CHUNK_W * CHUNK_H; // 4096
export const CHUNKS_X = WORLD_W / CHUNK_W; // 256
export const CHUNKS_Y = WORLD_H / CHUNK_H; // 16

// --- Active grid ---
// The active grid is (2*R+1) × (2*R+1) chunks centered on the focused blockhead.
// R=3 → 7×7 = 49 chunks = ~200k cells. Feasible at 30Hz.
export const ACTIVE_GRID_RADIUS = 3;
export const ACTIVE_GRID_CHUNKS = 2 * ACTIVE_GRID_RADIUS + 1; // 7
export const ACTIVE_GRID_W = ACTIVE_GRID_CHUNKS * CHUNK_W; // 448
export const ACTIVE_GRID_H = ACTIVE_GRID_CHUNKS * CHUNK_H; // 448
export const ACTIVE_GRID_CELLS = ACTIVE_GRID_W * ACTIVE_GRID_H; // 200704

// --- Simulation ---
export const TICK_RATE = 30; // sim ticks per second
export const TICK_MS = 1000 / TICK_RATE; // ~33.3ms per tick

// --- Lighting ---
export const MAX_LIGHT = 15; // per-cell light level (0-15)
export const DAYLIGHT = 15; // daylight level at noon

// --- Fluids ---
export const MAX_FLOW = 7; // max fluid flow level (0-7)

// --- Block IDs ---
// Reserved block IDs (must be stable across saves).
export const BLOCK_AIR = 0;
export const BLOCK_DIRT = 1;
export const BLOCK_GRASS = 2;
export const BLOCK_STONE = 3;
export const BLOCK_SAND = 4;
export const BLOCK_WATER = 5;
export const BLOCK_WOOD = 6;
export const BLOCK_LEAVES = 7;
export const BLOCK_COAL_ORE = 8;
export const BLOCK_COPPER_ORE = 9;
export const BLOCK_TIN_ORE = 10;
export const BLOCK_IRON_ORE = 11;
export const BLOCK_GOLD_ORE = 12;
export const BLOCK_BEDROCK = 13;
export const BLOCK_LAVA = 14;
export const BLOCK_TORCH = 15;
export const BLOCK_LADDER = 16;
export const BLOCK_ROPE = 17;
export const BLOCK_SCAFFOLDING = 18;
export const BLOCK_TIME_CRYSTAL = 19;
export const BLOCK_CLAY = 20;
export const BLOCK_GRAVEL = 21;

// --- Station + utility blocks ---
export const BLOCK_WORKBENCH = 22;
export const BLOCK_CRAFT_BENCH = 23;
export const BLOCK_TOOL_BENCH = 24;
export const BLOCK_WOODWORK_BENCH = 25;
export const BLOCK_CAMPFIRE = 26;
export const BLOCK_KILN = 27;
export const BLOCK_FURNACE = 28;
export const BLOCK_METALWORK_BENCH = 29;
export const BLOCK_BUILDER_BENCH = 30;
export const BLOCK_TAILOR_BENCH = 31;
export const BLOCK_COMPOST_BIN = 32;
export const BLOCK_BED = 33;

// --- Trellis + vines (placeable / climbable) ---
// Trellis is a foreground support block that vines climb on (layer 1).
// Vines grow in either plane: background (climbing trees, layer 3) or
// foreground (climbing walls layer 2 / trellis layer 1).
export const BLOCK_TRELLIS = 34;
export const BLOCK_VINE_KIWI = 35;
export const BLOCK_VINE_GRAPE = 36;

// --- Tree species: wood blocks (trunk) ---
// One wood block per tree species so each renders with its own palette color.
// Kiwi & grape are vines (not trees) — they have no wood block.
export const BLOCK_WOOD_COCONUT = 37;
export const BLOCK_WOOD_MAPLE = 38;
export const BLOCK_WOOD_ORANGE = 39;
export const BLOCK_WOOD_APPLE = 40;
export const BLOCK_WOOD_LEMON = 41;
export const BLOCK_WOOD_LIME = 42;
export const BLOCK_WOOD_BANANA = 43;
export const BLOCK_WOOD_SPRUCE = 44;
export const BLOCK_WOOD_PEAR = 45;
export const BLOCK_WOOD_CHERRY = 46;
export const BLOCK_WOOD_POMEGRANATE = 47;
export const BLOCK_WOOD_WALNUT = 48;
export const BLOCK_WOOD_HAZELNUT = 49;

// --- Tree species: leaf blocks (canopy) ---
// One leaf block per tree species. Distinct colors (e.g. cherry blossoms
// are pink, spruce needles are dark green) make species visually distinct.
export const BLOCK_LEAF_COCONUT = 50;
export const BLOCK_LEAF_MAPLE = 51;
export const BLOCK_LEAF_ORANGE = 52;
export const BLOCK_LEAF_APPLE = 53;
export const BLOCK_LEAF_LEMON = 54;
export const BLOCK_LEAF_LIME = 55;
export const BLOCK_LEAF_BANANA = 56;
export const BLOCK_LEAF_SPRUCE = 57;
export const BLOCK_LEAF_PEAR = 58;
export const BLOCK_LEAF_CHERRY = 59;
export const BLOCK_LEAF_POMEGRANATE = 60;
export const BLOCK_LEAF_WALNUT = 61;
export const BLOCK_LEAF_HAZELNUT = 62;

// --- Farming blocks ---
// Farmland: tilled soil that crops grow on. No collision (special category).
export const BLOCK_FARMLAND = 63;
// Compost farmland: enriched farmland for mushrooms. No collision.
export const BLOCK_COMPOST_FARMLAND = 64;

// Crop growth stages: each crop has 4 stage blocks (seed → sprout → growing → mature).
// All crop blocks are "special" category (no collision), rendered as 2D palette colors.
// Mining a mature crop drops food + seeds; mining an immature crop drops only the seed.
export const BLOCK_CROP_SEED_TOMATO = 65;
export const BLOCK_CROP_SPROUT_TOMATO = 66;
export const BLOCK_CROP_GROWING_TOMATO = 67;
export const BLOCK_CROP_MATURE_TOMATO = 68;

export const BLOCK_CROP_SEED_CARROT = 69;
export const BLOCK_CROP_SPROUT_CARROT = 70;
export const BLOCK_CROP_GROWING_CARROT = 71;
export const BLOCK_CROP_MATURE_CARROT = 72;

export const BLOCK_CROP_SEED_POTATO = 73;
export const BLOCK_CROP_SPROUT_POTATO = 74;
export const BLOCK_CROP_GROWING_POTATO = 75;
export const BLOCK_CROP_MATURE_POTATO = 76;

export const BLOCK_CROP_SEED_CORN = 77;
export const BLOCK_CROP_SPROUT_CORN = 78;
export const BLOCK_CROP_GROWING_CORN = 79;
export const BLOCK_CROP_MATURE_CORN = 80;

export const BLOCK_CROP_SEED_PUMPKIN = 81;
export const BLOCK_CROP_SPROUT_PUMPKIN = 82;
export const BLOCK_CROP_GROWING_PUMPKIN = 83;
export const BLOCK_CROP_MATURE_PUMPKIN = 84;

export const BLOCK_CROP_SEED_WHEAT = 85;
export const BLOCK_CROP_SPROUT_WHEAT = 86;
export const BLOCK_CROP_GROWING_WHEAT = 87;
export const BLOCK_CROP_MATURE_WHEAT = 88;

export const BLOCK_CROP_SEED_BROWN_MUSHROOM = 89;
export const BLOCK_CROP_SPROUT_BROWN_MUSHROOM = 90;
export const BLOCK_CROP_GROWING_BROWN_MUSHROOM = 91;
export const BLOCK_CROP_MATURE_BROWN_MUSHROOM = 92;

export const BLOCK_CROP_SEED_RED_MUSHROOM = 93;
export const BLOCK_CROP_SPROUT_RED_MUSHROOM = 94;
export const BLOCK_CROP_GROWING_RED_MUSHROOM = 95;
export const BLOCK_CROP_MATURE_RED_MUSHROOM = 96;

// Wild forageable blocks (single mature block, no growth stages — they regrow
// after harvest on a timer). Spawned during terrain gen on grass.
export const BLOCK_WILD_BERRY_BUSH = 97;
export const BLOCK_WILD_MUSHROOM = 98;

// --- Tree life-cycle blocks ---
// Saplings are young trees that live in the background plane (like adult
// trees) and grow upward into wood + leaves. The species is encoded in the
// vfx plane (bits 0-3 = species index into TREE_SPECIES).
// Fruits and seeds are NOT blocks — they're spinning 2D world drop entities
// rendered by DropPass, living on tree leaves and falling to the ground.
export const BLOCK_SAPLING = 99;

// --- Glass (placeable, solid collision but light passes through) ---
// A transparent building block: it has collision and is mineable like a solid
// block, but the volumetric light sim treats it as non-opaque (lightPasses),
// so sky light and emitter light flow through it unobstructed.
export const BLOCK_GLASS = 100;

// Mask flags (bitfield for the mask plane) ---
export const MASK_SOLID = 1 << 0; // blocks movement
export const MASK_CLIMBABLE = 1 << 1; // ladder, rope — allows vertical movement
export const MASK_LIQUID = 1 << 2; // water, lava — slows movement, drains air
export const MASK_CONDUCTIVE = 1 << 3; // passes electricity
export const MASK_MINEABLE = 1 << 4; // can be mined by blockhead
export const MASK_PLACEABLE_BG = 1 << 5; // can place backwall behind this
export const MASK_DOOR = 1 << 6; // door block (openable)
export const MASK_CRAFTING = 1 << 7; // crafting surface
export const MASK_LIGHT_EMIT = 1 << 8; // emits light
export const MASK_FLAMMABLE = 1 << 9; // can catch fire
export const MASK_BACKWALL = 1 << 10; // this is a backwall-only block

// --- Slope VFX (marching-squares full diagonal slopes) ---
// Full diagonal slope faces are added at terrain-surface corners where filled
// blocks meet air. Each cut corner creates a diagonal from that corner to the
// opposite corner of the cell, splitting it into two triangles.
// e.g. TR cut: diagonal (0,0) → (1,1), filled region is y > x (BL triangle).
// The corner mask (4 bits, one per block corner) is packed into the upper bits
// of the per-instance faceMask float (bits 8-11).
// See block-grid-pass-3d.ts + block-render-3d.wgsl for the rendering side.
export const SLOPE_DEPTH_X = 1.0; // top/bottom-side vertex retraction (full width)
export const SLOPE_DEPTH_Y = 1.0; // side-side vertex retraction (full height)

// Only terrain-style blocks get slopes. Structural/utility/crop blocks stay
// blocky. Water is excluded (rendered in its own pass).
export const SLOPE_ELIGIBLE: ReadonlySet<number> = new Set([
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_SAND,
  BLOCK_COAL_ORE,
  BLOCK_COPPER_ORE,
  BLOCK_TIN_ORE,
  BLOCK_IRON_ORE,
  BLOCK_GOLD_ORE,
  BLOCK_BEDROCK,
  BLOCK_CLAY,
  BLOCK_GRAVEL,
  BLOCK_FARMLAND,
  BLOCK_COMPOST_FARMLAND,
]);

// --- Terrain generation ---
export const SURFACE_Y = 700; // average surface height (0=top, WORLD_H=bottom)
export const SEA_LEVEL = 720; // water fills up to this Y
export const MAGMA_Y = 1000; // magma layer starts here
export const DIRT_DEPTH = 8; // dirt layer thickness below surface
export const CAVE_THRESHOLD = 0.45; // noise threshold for caves
export const ORE_VEIN_CHANCE = 0.02; // chance per stone block to start an ore vein
