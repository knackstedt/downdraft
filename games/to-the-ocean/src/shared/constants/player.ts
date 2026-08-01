// Player stats, movement physics, and inventory dimensions

export const PLAYER_MAX_HEALTH = 100000;
export const PLAYER_MAX_HUNGER = 100;
export const PLAYER_MAX_THIRST = 100;
export const PLAYER_MAX_OXYGEN = 100;
export const PLAYER_MAX_TEMPERATURE = 100;
export const PLAYER_OXYGEN_DRAIN_RATE = 5;    // per second underwater
export const PLAYER_OXYGEN_RECOVER_RATE = 20; // per second above water
export const PLAYER_HUNGER_RATE = 0.8;        // per second
export const PLAYER_THIRST_RATE = 1.0;        // per second
export const PLAYER_TEMP_COLD_RATE = 2.0;     // per second in cold biome
export const PLAYER_TEMP_HOT_RATE = 2.0;      // per second in hot biome
export const PLAYER_FALL_DAMAGE_THRESHOLD = 8; // meters
export const PLAYER_FALL_DAMAGE_MULTIPLIER = 5;
export const PLAYER_SWIM_SPEED = 4;           // m/s
export const PLAYER_WALK_SPEED = 5;           // m/s
export const PLAYER_RUN_SPEED = 8;            // m/s
export const PLAYER_FLOAT_FORCE = 12;         // m/s² upward when holding space in water
export const PLAYER_DIVE_FORCE = 10;          // m/s² downward when holding shift in water
export const PLAYER_WATER_SINK_RATE = 2;      // m/s² gentle sink when no vertical input in water
export const PLAYER_WATER_DRAG = 0.88;        // velocity multiplier per tick in water
export const PLAYER_SWIM_VERTICAL_MAX = 6;    // max vertical speed in water (m/s)
export const PLAYER_GRAVITY = 9.8;            // m/s²
export const PLAYER_JUMP_FORCE = 6;           // m/s upward velocity when jumping
export const PLAYER_HEIGHT = 1.8;             // meters — full body height (also entity.scale for players)
export const PLAYER_RADIUS = 0.4;             // meters — collision capsule radius
export const PLAYER_EYE_HEIGHT = PLAYER_HEIGHT * 0.9; // eye height above feet (~1.62m)

// --- Inventory ---

export const PLAYER_INV_WIDTH = 20;
export const PLAYER_INV_HEIGHT = 15;
export const BOAT_HOLD_INV_WIDTH = 16;
export const BOAT_HOLD_INV_HEIGHT = 10;
export const HOTBAR_SLOTS = 10;
