// Ship movement, collision physics, entity mass, and anchor constants

export const SHIP_BASE_SPEED = 5;             // m/s
export const SHIP_MAX_SPEED = 15;
export const SHIP_BASE_INTEGRITY = 100;
export const SHIP_LEAK_THRESHOLD = 30;        // integrity below this = leaking
export const SHIP_ACCEL_RATE = 2.0;           // throttle change per second
export const SHIP_TURN_RATE = 0.8;            // radians per second at full steering
export const SHIP_TURN_SPEED_FACTOR = 0.3;    // how much speed affects turning
export const SHIP_BOARDING_RANGE = 8;         // meters to board a ship
export const SHIP_DISEMBARK_OFFSET = 3;       // meters to place player beside ship
export const SHIP_REPAIR_RATE = 5;            // health per second when repairing
export const SHIP_REPAIR_COST_PER_HP = 2;     // material cost per HP repaired
export const SHIP_DRAG = 0.5;                 // water drag coefficient
export const SHIP_ANGULAR_DRAG = 0.8;         // angular velocity drag

// --- Ship collision physics ---
export const SHIP_MASS_PER_CELL = 800;        // kg per cell (matches BuoyancySystem)
export const SHIP_COLLISION_RESTITUTION = 0.15; // bounciness (0=plastic, 1=elastic)
export const SHIP_COLLISION_FRICTION = 0.3;
export const SHIP_COLLISION_SLOP = 0.02;      // penetration allowance before correction (m)
export const SHIP_COLLISION_CORRECTION_PCT = 0.8; // positional correction factor
export const SHIP_YAW_DAMPING = 3.0;          // angular velocity.y damping per second
export const SHIP_YAW_MAX = Math.PI * 1.5;    // max yaw rate (rad/s) from collisions
export const SHIP_PITCH_ROLL_COLLISION_MAX = 0.15; // max pitch/roll impulse from collision (rad/s)
export const SHIP_COLLISION_MAX_SUBSTEPS = 3; // max swept collision substeps per tick

// Entity mass by type (kg). Used for collision impulse resolution.
// Islands = Infinity (immovable). Ports = very large (effectively immovable).
// Wildlife mass scales with scale³ × density factor.
export const ENTITY_MASS: Record<number, number> = {
  [1]: 0,    // Ship — computed from cells at runtime
  [2]: 300,  // SmallCraft — light
  [15]: 2000, // PirateShip — medium-heavy
  [16]: Infinity, // Island — immovable
  [17]: 100000, // Port — effectively immovable
  [18]: Infinity, // Reef — immovable
  [19]: 500, // Wreck — moderate
};

// Wildlife density factors (kg/m³) — mass = scale³ × density × 100
export const WILDLIFE_DENSITY: Record<number, number> = {
  [3]: 50,   // Fish — very light
  [4]: 200,  // Shark
  [5]: 100,  // Eel
  [6]: 30,   // Jellyfish — nearly massless
  [7]: 300,  // DevilShrimp
  [8]: 800,  // Whale — very heavy (scale 8 → ~409600 kg)
  [9]: 200,  // Dolphin
  [10]: 150, // Turtle
  [11]: 80,  // Crustacean
  [12]: 50,  // Coral (static)
  [13]: 300, // Moose
};

// Ship entity data slot indices (data[0..9])
export const SHIP_DATA = {
  THROTTLE: 0,       // -1 (reverse) to 1 (full ahead)
  STEERING: 1,       // -1 (port) to 1 (starboard)
  SPEED: 2,          // current forward speed (m/s)
  HEADING: 3,        // current heading (radians)
  HULL_INTEGRITY_PCT: 4, // 0-1
  REPAIRING: 5,      // 0 or 1
  PITCH: 6,          // current pitch angle (radians, X-axis)
  ROLL: 7,           // current roll angle (radians, Z-axis)
  ANCHOR_X: 8,       // world X of anchor (NaN = no anchor deployed)
  ANCHOR_Z: 9,       // world Z of anchor (NaN = no anchor deployed)
} as const;

export const SHIP_DATA_SLOTS = 10; // number of Float32Array slots for ship data

// --- Anchor physics ---
export const ANCHOR_ROPE_LENGTH = 15;     // max rope length (meters)
export const ANCHOR_STIFFNESS = 25.0;     // spring force coefficient
export const ANCHOR_DAMPING = 5.0;        // velocity damping when at rope limit
export const ANCHOR_DEPTH = -6;           // anchor rests 6m below water surface
export const ANCHOR_BOW_OFFSET = 2.5;     // rope attaches this far forward of ship center
export const ANCHOR_DRAG = 1.5;           // drag applied to anchored ship within rope radius
