//! Material definitions for the falling-sand simulation.
//!
//! Ported from `games/falling-sand/src/simulation/materials.ts`.
//! All material IDs, flag bits, and property tables are byte-for-byte
//! compatible with the TypeScript implementation so the WASM and JS
//! backends produce identical simulation behavior.

#![allow(dead_code)]

// ---------------------------------------------------------------------------
// Material enum — numeric IDs match the TypeScript Material enum exactly.
// ---------------------------------------------------------------------------

pub const EMPTY: u8 = 0;
pub const SAND: u8 = 1;
pub const WATER: u8 = 2;
pub const STONE: u8 = 3;
pub const WOOD: u8 = 4;
pub const FIRE: u8 = 5;
pub const SMOKE: u8 = 6;
pub const OIL: u8 = 7;
pub const GUNPOWDER: u8 = 8;
pub const IRON: u8 = 9;
pub const LAVA: u8 = 10;
pub const STEAM: u8 = 11;
pub const PLANT: u8 = 12;
pub const FLESH: u8 = 13;
pub const DIRT: u8 = 14;
pub const SEED: u8 = 15;
pub const LEAF: u8 = 16;
pub const ANTIMATTER: u8 = 17;
pub const MYSTERY: u8 = 18;
pub const FLOUR: u8 = 19;
pub const GASOLINE: u8 = 20;
pub const GAS_VAPOR: u8 = 21;
pub const HYDROGEN: u8 = 22;
pub const PLASTIC: u8 = 23;
pub const TOAST: u8 = 24;
pub const SALT: u8 = 25;
pub const WALL: u8 = 26;
pub const FIREFLIES: u8 = 27;
pub const GRASS: u8 = 28;
pub const SNOW: u8 = 29;
pub const HONEY: u8 = 30;
pub const MERCURY: u8 = 31;
pub const FUSE: u8 = 32;
pub const C4: u8 = 33;
pub const DYNAMITE: u8 = 34;
pub const WAX: u8 = 35;
pub const CONCRETE_POWDER: u8 = 36;
pub const DRY_ICE: u8 = 37;
pub const LIQUID_NITROGEN: u8 = 38;
pub const PLASMA: u8 = 39;
pub const NANOBOTS: u8 = 40;
pub const MAGIC_POWDER: u8 = 41;
pub const GLITTER: u8 = 42;
pub const POPCORN: u8 = 43;
pub const RUBBER: u8 = 44;
pub const ROOT: u8 = 45;
pub const BRINE: u8 = 46;
pub const MOLTEN_SALT: u8 = 47;
pub const CONCRETE: u8 = 48;
pub const TREE_WOOD: u8 = 49;
pub const FUSE_FIRE: u8 = 50;
pub const BURNING_OIL: u8 = 51;

pub const MAX_MATERIAL: usize = 64;

// ---------------------------------------------------------------------------
// Cell packing — matches the TypeScript pack/unpack layout exactly.
//
// packed u32 layout:
//   bits  0-7  : mat (material id)
//   bits  8-15 : lifetime
//   bits 16-23 : flags (FLAG_UPDATED | FLAG_SPARK | SHADE_MASK)
//   bits 24-31 : unused (zero)
// ---------------------------------------------------------------------------

pub const FLAG_UPDATED: u8 = 0x04; // bit 2 — cell was updated this frame
pub const FLAG_SPARK: u8 = 0x08;   // bit 3 — fire is a spark (expires to empty)
pub const SHADE_MASK: u8 = 0x03;   // bits 0-1 — shade index (0-3)
/// Precomputed bit position of FLAG_UPDATED within the packed u32 flags field.
/// OR-ing this into a packed cell value sets FLAG_UPDATED without re-packing.
pub const FLAG_UPDATED_BIT: u32 = (FLAG_UPDATED as u32) << 16;

/// Pack a cell value from raw components without allocating.
#[inline(always)]
pub fn pack_cell(mat: u8, lifetime: u8, flags: u8) -> u32 {
    (mat as u32) | ((lifetime as u32) << 8) | ((flags as u32) << 16)
}

/// Unpack the material id from a packed cell.
#[inline(always)]
pub fn cell_mat(packed: u32) -> u8 {
    (packed & 0xff) as u8
}

/// Unpack the lifetime from a packed cell.
#[inline(always)]
pub fn cell_lifetime(packed: u32) -> u8 {
    ((packed >> 8) & 0xff) as u8
}

/// Unpack the flags byte from a packed cell.
#[inline(always)]
pub fn cell_flags(packed: u32) -> u8 {
    ((packed >> 16) & 0xff) as u8
}

// ---------------------------------------------------------------------------
// Material flag bits — packed into MAT_FLAGS.
// ---------------------------------------------------------------------------

pub const MAT_FLAMMABLE: u8 = 0x01;
pub const MAT_SOLID: u8 = 0x02;
pub const MAT_LIQUID: u8 = 0x04;
pub const MAT_GAS: u8 = 0x08;
pub const MAT_MAGNETIC: u8 = 0x10;

// ---------------------------------------------------------------------------
// Field byte offsets within each 4-byte field cell.
// Matches the TypeScript FIELD enum.
// ---------------------------------------------------------------------------

pub const FIELD_GRAVITY: usize = 0;
pub const FIELD_TEMP: usize = 1;
pub const FIELD_WIND_X: usize = 2;
pub const FIELD_WIND_Y: usize = 3;

pub const DEFAULT_GRAVITY: u8 = 128;
pub const DEFAULT_TEMP: u8 = 128;
pub const DEFAULT_WIND: u8 = 0;

// ---------------------------------------------------------------------------
// Parallel property tables — precomputed at compile time from MATERIALS.
//
// These are indexed by material id (0..MAX_MATERIAL). In the simulation hot
// loops (millions of cell iterations/sec), indexing a flat array is
// significantly faster than a struct-of-structs lookup with optionals.
// ---------------------------------------------------------------------------

/// gravity multiplier as float (0-4). 0 = no gravity.
pub static MAT_GRAVITY: [f32; MAX_MATERIAL] = build_gravity();
/// gravity direction: 1 = down, -1 = up, 0 = static.
pub static MAT_GRAVITY_DIR: [i8; MAX_MATERIAL] = build_gravity_dir();
/// packed boolean flags (MAT_FLAMMABLE | MAT_SOLID | ...).
pub static MAT_FLAGS: [u8; MAX_MATERIAL] = build_flags();
/// initial lifetime when placed/ignited.
pub static MAT_LIFETIME: [u8; MAX_MATERIAL] = build_lifetime();

/// IS_HOT: fire-class + lava + molten salt + plasma (melt snow, boil water, etc.)
pub static IS_HOT: [u8; MAX_MATERIAL] = build_is_hot();
/// IS_FIRE: fire-class only (Fire, FuseFire, BurningOil)
pub static IS_FIRE: [u8; MAX_MATERIAL] = build_is_fire();

// ---------------------------------------------------------------------------
// Compile-time table builders. Each returns a [T; MAX_MATERIAL] array.
// We use const fn + manual initialization to avoid runtime init code.
// ---------------------------------------------------------------------------

const fn build_gravity() -> [f32; MAX_MATERIAL] {
    let mut g = [0.0f32; MAX_MATERIAL];
    g[SAND as usize] = 1.0;
    g[WATER as usize] = 2.0;
    g[FIRE as usize] = 2.0;
    g[FUSE_FIRE as usize] = 2.0;
    g[BURNING_OIL as usize] = 1.0;
    g[SMOKE as usize] = 3.0;
    g[OIL as usize] = 1.0;
    g[GUNPOWDER as usize] = 1.0;
    g[IRON as usize] = 1.0;
    g[LAVA as usize] = 3.0;
    g[STEAM as usize] = 2.0;
    g[FLESH as usize] = 1.0;
    g[DIRT as usize] = 1.0;
    g[SNOW as usize] = 0.5;
    g[CONCRETE_POWDER as usize] = 1.0;
    g[SEED as usize] = 1.0;
    g[GRASS as usize] = 1.0;
    g[HONEY as usize] = 1.5;
    g[MERCURY as usize] = 4.0;
    g[BRINE as usize] = 2.5;
    g[MOLTEN_SALT as usize] = 3.0;
    g[LIQUID_NITROGEN as usize] = 2.0;
    g[GAS_VAPOR as usize] = 1.0;
    g[HYDROGEN as usize] = 1.0;
    g[GLITTER as usize] = 0.2;
    g[DRY_ICE as usize] = 1.0;
    g[ANTIMATTER as usize] = 1.0;
    g[MYSTERY as usize] = 1.0;
    g[PLASMA as usize] = 1.0;
    g[DYNAMITE as usize] = 1.0;
    g[FLOUR as usize] = 1.0;
    g[GASOLINE as usize] = 1.5;
    g[TOAST as usize] = 1.0;
    g[SALT as usize] = 1.0;
    g[NANOBOTS as usize] = 0.5;
    g[MAGIC_POWDER as usize] = 1.0;
    g[POPCORN as usize] = 0.3;
    g
}

const fn build_gravity_dir() -> [i8; MAX_MATERIAL] {
    let mut d = [0i8; MAX_MATERIAL];
    d[SAND as usize] = 1;
    d[WATER as usize] = 1;
    d[FIRE as usize] = -1;
    d[FUSE_FIRE as usize] = -1;
    d[BURNING_OIL as usize] = 1;
    d[SMOKE as usize] = -1;
    d[OIL as usize] = 1;
    d[GUNPOWDER as usize] = 1;
    d[IRON as usize] = 1;
    d[LAVA as usize] = 1;
    d[STEAM as usize] = -1;
    d[FLESH as usize] = 1;
    d[DIRT as usize] = 1;
    d[SNOW as usize] = 1;
    d[CONCRETE_POWDER as usize] = 1;
    d[SEED as usize] = 1;
    d[GRASS as usize] = 1;
    d[HONEY as usize] = 1;
    d[MERCURY as usize] = 1;
    d[BRINE as usize] = 1;
    d[MOLTEN_SALT as usize] = 1;
    d[LIQUID_NITROGEN as usize] = 1;
    d[GAS_VAPOR as usize] = -1;
    d[HYDROGEN as usize] = -1;
    d[GLITTER as usize] = 1;
    d[DRY_ICE as usize] = 1;
    d[ANTIMATTER as usize] = 1;
    d[MYSTERY as usize] = 1;
    d[PLASMA as usize] = -1;
    d[DYNAMITE as usize] = 1;
    d[FLOUR as usize] = 1;
    d[GASOLINE as usize] = 1;
    d[TOAST as usize] = 1;
    d[SALT as usize] = 1;
    d[NANOBOTS as usize] = -1;
    d[MAGIC_POWDER as usize] = 1;
    d[POPCORN as usize] = 1;
    d
}

const fn build_flags() -> [u8; MAX_MATERIAL] {
    // Empty is flagged as gas (matches TS: { gas: true })
    let mut f = [0u8; MAX_MATERIAL];
    f[EMPTY as usize] = MAT_GAS;
    f[SAND as usize] = MAT_SOLID;
    f[WATER as usize] = MAT_LIQUID;
    f[STONE as usize] = MAT_SOLID;
    f[WOOD as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[FIRE as usize] = MAT_GAS;
    f[FUSE_FIRE as usize] = MAT_GAS;
    f[BURNING_OIL as usize] = MAT_LIQUID;
    f[SMOKE as usize] = MAT_GAS;
    f[OIL as usize] = MAT_FLAMMABLE | MAT_LIQUID;
    f[GUNPOWDER as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[IRON as usize] = MAT_SOLID;
    f[LAVA as usize] = MAT_LIQUID;
    f[STEAM as usize] = MAT_GAS;
    f[PLANT as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[FLESH as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[DIRT as usize] = MAT_SOLID;
    f[SEED as usize] = MAT_SOLID;
    f[LEAF as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[ANTIMATTER as usize] = MAT_SOLID;
    f[MYSTERY as usize] = MAT_SOLID;
    f[FLOUR as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[GASOLINE as usize] = MAT_FLAMMABLE | MAT_LIQUID;
    f[GAS_VAPOR as usize] = MAT_FLAMMABLE | MAT_GAS;
    f[HYDROGEN as usize] = MAT_FLAMMABLE | MAT_GAS;
    f[PLASTIC as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[TOAST as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[SALT as usize] = MAT_SOLID;
    f[WALL as usize] = MAT_SOLID;
    f[FIREFLIES as usize] = MAT_GAS;
    f[GRASS as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[SNOW as usize] = MAT_SOLID;
    f[HONEY as usize] = MAT_LIQUID;
    f[MERCURY as usize] = MAT_LIQUID;
    f[FUSE as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[C4 as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[DYNAMITE as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[WAX as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[CONCRETE_POWDER as usize] = MAT_SOLID;
    f[DRY_ICE as usize] = MAT_SOLID;
    f[LIQUID_NITROGEN as usize] = MAT_LIQUID;
    f[PLASMA as usize] = MAT_GAS;
    f[NANOBOTS as usize] = MAT_GAS;
    f[MAGIC_POWDER as usize] = MAT_SOLID;
    f[GLITTER as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[POPCORN as usize] = MAT_SOLID;
    f[RUBBER as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[ROOT as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f[BRINE as usize] = MAT_LIQUID;
    f[MOLTEN_SALT as usize] = MAT_LIQUID;
    f[CONCRETE as usize] = MAT_SOLID;
    f[TREE_WOOD as usize] = MAT_FLAMMABLE | MAT_SOLID;
    f
}

const fn build_lifetime() -> [u8; MAX_MATERIAL] {
    let mut l = [0u8; MAX_MATERIAL];
    l[FIRE as usize] = 30;
    l[FUSE_FIRE as usize] = 15;
    l[BURNING_OIL as usize] = 60;
    l[SMOKE as usize] = 120;
    l[STEAM as usize] = 120;
    l[GAS_VAPOR as usize] = 200;
    l[HYDROGEN as usize] = 200;
    l[PLASMA as usize] = 30;
    l[FIREFLIES as usize] = 255;
    l[NANOBOTS as usize] = 255;
    l[MAGIC_POWDER as usize] = 60;
    l
}

const fn build_is_hot() -> [u8; MAX_MATERIAL] {
    let mut h = [0u8; MAX_MATERIAL];
    h[FIRE as usize] = 1;
    h[FUSE_FIRE as usize] = 1;
    h[BURNING_OIL as usize] = 1;
    h[LAVA as usize] = 1;
    h[MOLTEN_SALT as usize] = 1;
    h[PLASMA as usize] = 1;
    h
}

const fn build_is_fire() -> [u8; MAX_MATERIAL] {
    let mut f = [0u8; MAX_MATERIAL];
    f[FIRE as usize] = 1;
    f[FUSE_FIRE as usize] = 1;
    f[BURNING_OIL as usize] = 1;
    f
}

/// Get the initial lifetime for a material (used when placing/igniting).
#[inline(always)]
pub fn initial_lifetime(mat: u8) -> u8 {
    MAT_LIFETIME[mat as usize]
}
