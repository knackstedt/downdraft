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

// --- Mask flags (bitfield for the mask plane) ---
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

// --- Terrain generation ---
export const SURFACE_Y = 700; // average surface height (0=top, WORLD_H=bottom)
export const SEA_LEVEL = 720; // water fills up to this Y
export const MAGMA_Y = 1000; // magma layer starts here
export const DIRT_DEPTH = 8; // dirt layer thickness below surface
export const CAVE_THRESHOLD = 0.45; // noise threshold for caves
export const ORE_VEIN_CHANCE = 0.02; // chance per stone block to start an ore vein
