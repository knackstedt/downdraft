// ============================================================================
// Ore & lake distribution configuration — data-driven terrain generation.
//
// Each ore/lake entry specifies:
//   - material: the Material enum value to place
//   - minChunkY / maxChunkY: depth range (in chunk Y coords) where it appears
//   - noiseThreshold: fBm noise value must exceed this for a vein to spawn
//   - noiseScale: spatial frequency of the noise (lower = larger blobs)
//   - octaves: fBm octaves (more = finer detail)
//   - rarity: per-cell probability multiplier (after noise threshold passes)
//   - veinSize: approximate vein radius in cells (for blob expansion)
// ============================================================================

import { Material } from "@downdraft/library-sand";

export interface OreEntry {
  material: number;
  name: string;
  minChunkY: number; // minimum depth (chunk Y, 0 = surface)
  maxChunkY: number; // maximum depth (chunk Y, inclusive)
  noiseThreshold: number; // 0-1, fBm must exceed this
  noiseScale: number; // spatial frequency
  octaves: number;
  rarity: number; // 0-1, probability multiplier
  veinSize: number; // approximate radius in cells
}

export interface LakeEntry {
  material: number;
  name: string;
  minChunkY: number;
  maxChunkY: number;
  noiseThreshold: number;
  noiseScale: number;
  octaves: number;
  minSize: number; // minimum lake radius in cells
  maxSize: number; // maximum lake radius in cells
  fillChance: number; // 0-1, probability of a lake center spawning per candidate cell
}

// --- Ore distribution table ---
// Depth bands (chunk Y):
//   cy 0-3:   shallow (tin, copper)
//   cy 3-8:   mid (iron, bauxite)
//   cy 6-12:  mid-deep (silver)
//   cy 10+:   deep (gold, cobalt)

export const ORE_CONFIG: OreEntry[] = [
  {
    material: Material.TinOre,
    name: "Tin",
    minChunkY: 0,
    maxChunkY: 3,
    noiseThreshold: 0.62,
    noiseScale: 0.08,
    octaves: 3,
    rarity: 0.7,
    veinSize: 4,
  },
  {
    material: Material.CopperOre,
    name: "Copper",
    minChunkY: 0,
    maxChunkY: 4,
    noiseThreshold: 0.60,
    noiseScale: 0.07,
    octaves: 3,
    rarity: 0.65,
    veinSize: 5,
  },
  {
    material: Material.IronOre,
    name: "Iron",
    minChunkY: 3,
    maxChunkY: 8,
    noiseThreshold: 0.63,
    noiseScale: 0.06,
    octaves: 4,
    rarity: 0.6,
    veinSize: 5,
  },
  {
    material: Material.BauxiteOre,
    name: "Bauxite",
    minChunkY: 3,
    maxChunkY: 9,
    noiseThreshold: 0.65,
    noiseScale: 0.09,
    octaves: 3,
    rarity: 0.5,
    veinSize: 4,
  },
  {
    material: Material.SilverOre,
    name: "Silver",
    minChunkY: 6,
    maxChunkY: 12,
    noiseThreshold: 0.68,
    noiseScale: 0.07,
    octaves: 4,
    rarity: 0.4,
    veinSize: 3,
  },
  {
    material: Material.GoldOre,
    name: "Gold",
    minChunkY: 10,
    maxChunkY: 99,
    noiseThreshold: 0.70,
    noiseScale: 0.06,
    octaves: 4,
    rarity: 0.3,
    veinSize: 3,
  },
  {
    material: Material.CobaltOre,
    name: "Cobalt",
    minChunkY: 10,
    maxChunkY: 99,
    noiseThreshold: 0.72,
    noiseScale: 0.08,
    octaves: 4,
    rarity: 0.25,
    veinSize: 3,
  },
];

// --- Lake / liquid distribution table ---
// Underground liquid lakes carved into stone:
//   cy 2-6:   water (shallow-mid)
//   cy 5-10:  oil (mid)
//   cy 8+:    lava (deep)
//   cy 10+:   methane gas pockets
//   cy 12+:   sulfur gas pockets

export const LAKE_CONFIG: LakeEntry[] = [
  {
    material: Material.Water,
    name: "Water",
    minChunkY: 2,
    maxChunkY: 6,
    noiseThreshold: 0.70,
    noiseScale: 0.04,
    octaves: 3,
    minSize: 8,
    maxSize: 20,
    fillChance: 0.008,
  },
  {
    material: Material.Oil,
    name: "Oil",
    minChunkY: 5,
    maxChunkY: 10,
    noiseThreshold: 0.72,
    noiseScale: 0.04,
    octaves: 3,
    minSize: 6,
    maxSize: 16,
    fillChance: 0.006,
  },
  {
    material: Material.Lava,
    name: "Lava",
    minChunkY: 8,
    maxChunkY: 99,
    noiseThreshold: 0.74,
    noiseScale: 0.05,
    octaves: 4,
    minSize: 6,
    maxSize: 18,
    fillChance: 0.007,
  },
  {
    material: Material.MethaneGas,
    name: "Methane",
    minChunkY: 10,
    maxChunkY: 99,
    noiseThreshold: 0.76,
    noiseScale: 0.06,
    octaves: 3,
    minSize: 5,
    maxSize: 14,
    fillChance: 0.005,
  },
  {
    material: Material.SulfurGas,
    name: "Sulfur",
    minChunkY: 12,
    maxChunkY: 99,
    noiseThreshold: 0.78,
    noiseScale: 0.06,
    octaves: 3,
    minSize: 5,
    maxSize: 12,
    fillChance: 0.004,
  },
];

// --- Cavity (cave) configuration ---

export const CAVITY_CONFIG = {
  noiseScale: 0.03,
  noiseThreshold: 0.72,
  octaves: 4,
  minChunkY: 1, // no caves at surface
  maxChunkY: 99,
};

// --- Surface configuration ---

export const SURFACE_CONFIG = {
  surfaceYRatio: 0.3, // surface at 30% down in chunk cy=0
  grassDepth: 1, // grass layer thickness
  dirtDepth: 5, // dirt layer thickness below grass
  noiseScale: 0.02, // surface height variation
  noiseAmplitude: 8, // max height variation in cells
};
