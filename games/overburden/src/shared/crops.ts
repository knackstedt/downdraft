// ============================================================================
// Overburden — crop registry
//
// Maps crop types to their 4 growth-stage block IDs, growth timing (in ticks
// at 30tps), harvest drops, and season/biome tolerance. Crops are block-based:
// each growth stage is a distinct block ID so the existing renderer picks them
// up via the palette system with no new rendering code.
//
// Mushrooms grow on compost farmland; other crops grow on regular farmland.
// Wild bushes/mushrooms are single mature blocks that regrow after harvest.
// ============================================================================

import {
  BLOCK_COMPOST_FARMLAND,
  BLOCK_FARMLAND,
  BLOCK_CROP_MATURE_BROWN_MUSHROOM, BLOCK_CROP_MATURE_CARROT, BLOCK_CROP_MATURE_CORN,
  BLOCK_CROP_MATURE_POTATO, BLOCK_CROP_MATURE_PUMPKIN, BLOCK_CROP_MATURE_RED_MUSHROOM,
  BLOCK_CROP_MATURE_TOMATO, BLOCK_CROP_MATURE_WHEAT,
  BLOCK_CROP_SEED_BROWN_MUSHROOM, BLOCK_CROP_SEED_CARROT, BLOCK_CROP_SEED_CORN,
  BLOCK_CROP_SEED_POTATO, BLOCK_CROP_SEED_PUMPKIN, BLOCK_CROP_SEED_RED_MUSHROOM,
  BLOCK_CROP_SEED_TOMATO, BLOCK_CROP_SEED_WHEAT,
  BLOCK_CROP_SPROUT_BROWN_MUSHROOM, BLOCK_CROP_SPROUT_CARROT, BLOCK_CROP_SPROUT_CORN,
  BLOCK_CROP_SPROUT_POTATO, BLOCK_CROP_SPROUT_PUMPKIN, BLOCK_CROP_SPROUT_RED_MUSHROOM,
  BLOCK_CROP_SPROUT_TOMATO, BLOCK_CROP_SPROUT_WHEAT,
  BLOCK_CROP_GROWING_BROWN_MUSHROOM, BLOCK_CROP_GROWING_CARROT, BLOCK_CROP_GROWING_CORN,
  BLOCK_CROP_GROWING_POTATO, BLOCK_CROP_GROWING_PUMPKIN, BLOCK_CROP_GROWING_RED_MUSHROOM,
  BLOCK_CROP_GROWING_TOMATO, BLOCK_CROP_GROWING_WHEAT,
  BLOCK_WILD_BERRY_BUSH, BLOCK_WILD_MUSHROOM,
} from "./constants";

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface CropDef {
  id: string;
  name: string;
  /** Block IDs for each growth stage [seed, sprout, growing, mature]. */
  stages: [number, number, number, number];
  /** Ticks per growth stage (at 30tps). 600 ticks = 20s real time. */
  stageTicks: [number, number, number];
  /** Seed item id (for planting + drop on immature harvest). */
  seedItem: string;
  /** Food item id (dropped on mature harvest). */
  foodItem: string;
  /** Number of food items dropped on harvest. */
  foodYield: number;
  /** Number of seeds dropped on harvest (in addition to food). */
  seedYield: number;
  /** Hunger restored by the food item. */
  hungerRestore: number;
  /** True if this crop grows on compost farmland (mushrooms). */
  isMushroom: boolean;
  /** Seasons in which this crop can grow. Empty = grows year-round. */
  growSeasons: Season[];
  /** Cold tolerance 0-1 (1 = immune to winter kill). */
  coldTolerance: number;
  /** Whether this crop can spread to adjacent compost/farmland (mushrooms). */
  canSpread: boolean;
  /** Palette colors for each growth stage [seed, sprout, growing, mature]. */
  colors: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
}

export interface WildCropDef {
  blockId: number;
  name: string;
  /** Food item dropped when harvested. */
  foodItem: string;
  /** Hunger restored. */
  hungerRestore: number;
  /** Ticks before regrowing after harvest (at 30tps). */
  regrowTicks: number;
  /** Palette color. */
  color: [number, number, number];
  /** True if this is a mushroom (spawns in dark/caves). */
  isMushroom: boolean;
  /** Chance per grass cell during terrain gen (0-1). */
  spawnChance: number;
}

export const CROPS: Record<string, CropDef> = {
  tomato: {
    id: "tomato", name: "Tomato",
    stages: [BLOCK_CROP_SEED_TOMATO, BLOCK_CROP_SPROUT_TOMATO, BLOCK_CROP_GROWING_TOMATO, BLOCK_CROP_MATURE_TOMATO],
    stageTicks: [600, 900, 1200],
    seedItem: "seed_tomato", foodItem: "tomato", foodYield: 2, seedYield: 1,
    hungerRestore: 10, isMushroom: false,
    growSeasons: ["spring", "summer", "autumn"], coldTolerance: 0.2, canSpread: false,
    colors: [[100, 80, 50], [120, 140, 60], [100, 160, 70], [200, 60, 50]],
  },
  carrot: {
    id: "carrot", name: "Carrot",
    stages: [BLOCK_CROP_SEED_CARROT, BLOCK_CROP_SPROUT_CARROT, BLOCK_CROP_GROWING_CARROT, BLOCK_CROP_MATURE_CARROT],
    stageTicks: [500, 800, 1000],
    seedItem: "seed_carrot", foodItem: "carrot", foodYield: 2, seedYield: 1,
    hungerRestore: 8, isMushroom: false,
    growSeasons: ["spring", "summer", "autumn"], coldTolerance: 0.4, canSpread: false,
    colors: [[90, 70, 40], [100, 130, 50], [90, 150, 60], [230, 140, 40]],
  },
  potato: {
    id: "potato", name: "Potato",
    stages: [BLOCK_CROP_SEED_POTATO, BLOCK_CROP_SPROUT_POTATO, BLOCK_CROP_GROWING_POTATO, BLOCK_CROP_MATURE_POTATO],
    stageTicks: [600, 900, 1200],
    seedItem: "seed_potato", foodItem: "potato", foodYield: 3, seedYield: 1,
    hungerRestore: 12, isMushroom: false,
    growSeasons: ["spring", "summer", "autumn"], coldTolerance: 0.5, canSpread: false,
    colors: [[100, 80, 50], [110, 130, 60], [100, 140, 70], [180, 150, 80]],
  },
  corn: {
    id: "corn", name: "Corn",
    stages: [BLOCK_CROP_SEED_CORN, BLOCK_CROP_SPROUT_CORN, BLOCK_CROP_GROWING_CORN, BLOCK_CROP_MATURE_CORN],
    stageTicks: [800, 1200, 1500],
    seedItem: "seed_corn", foodItem: "corn", foodYield: 2, seedYield: 1,
    hungerRestore: 14, isMushroom: false,
    growSeasons: ["summer", "autumn"], coldTolerance: 0.2, canSpread: false,
    colors: [[120, 100, 50], [130, 150, 60], [120, 160, 70], [220, 190, 60]],
  },
  pumpkin: {
    id: "pumpkin", name: "Pumpkin",
    stages: [BLOCK_CROP_SEED_PUMPKIN, BLOCK_CROP_SPROUT_PUMPKIN, BLOCK_CROP_GROWING_PUMPKIN, BLOCK_CROP_MATURE_PUMPKIN],
    stageTicks: [900, 1200, 1800],
    seedItem: "seed_pumpkin", foodItem: "pumpkin", foodYield: 1, seedYield: 2,
    hungerRestore: 18, isMushroom: false,
    growSeasons: ["summer", "autumn"], coldTolerance: 0.3, canSpread: false,
    colors: [[120, 90, 50], [130, 140, 60], [120, 150, 70], [230, 130, 40]],
  },
  wheat: {
    id: "wheat", name: "Wheat",
    stages: [BLOCK_CROP_SEED_WHEAT, BLOCK_CROP_SPROUT_WHEAT, BLOCK_CROP_GROWING_WHEAT, BLOCK_CROP_MATURE_WHEAT],
    stageTicks: [500, 700, 900],
    seedItem: "seed_wheat", foodItem: "wheat", foodYield: 2, seedYield: 1,
    hungerRestore: 8, isMushroom: false,
    growSeasons: ["spring", "summer"], coldTolerance: 0.3, canSpread: false,
    colors: [[110, 90, 50], [130, 140, 60], [160, 160, 80], [210, 180, 80]],
  },
  brown_mushroom: {
    id: "brown_mushroom", name: "Brown Mushroom",
    stages: [BLOCK_CROP_SEED_BROWN_MUSHROOM, BLOCK_CROP_SPROUT_BROWN_MUSHROOM, BLOCK_CROP_GROWING_BROWN_MUSHROOM, BLOCK_CROP_MATURE_BROWN_MUSHROOM],
    stageTicks: [400, 600, 800],
    seedItem: "spore_brown_mushroom", foodItem: "brown_mushroom", foodYield: 2, seedYield: 1,
    hungerRestore: 6, isMushroom: true,
    growSeasons: [], coldTolerance: 0.8, canSpread: true,
    colors: [[80, 70, 50], [100, 90, 60], [120, 100, 70], [150, 120, 80]],
  },
  red_mushroom: {
    id: "red_mushroom", name: "Red Mushroom",
    stages: [BLOCK_CROP_SEED_RED_MUSHROOM, BLOCK_CROP_SPROUT_RED_MUSHROOM, BLOCK_CROP_GROWING_RED_MUSHROOM, BLOCK_CROP_MATURE_RED_MUSHROOM],
    stageTicks: [400, 600, 800],
    seedItem: "spore_red_mushroom", foodItem: "red_mushroom", foodYield: 2, seedYield: 1,
    hungerRestore: 8, isMushroom: true,
    growSeasons: [], coldTolerance: 0.8, canSpread: true,
    colors: [[80, 70, 50], [100, 90, 60], [140, 80, 60], [180, 60, 50]],
  },
};

export const WILD_CROPS: WildCropDef[] = [
  {
    blockId: BLOCK_WILD_BERRY_BUSH, name: "Wild Berry Bush",
    foodItem: "berries", hungerRestore: 6, regrowTicks: 6000,
    color: [60, 100, 50], isMushroom: false, spawnChance: 0.015,
  },
  {
    blockId: BLOCK_WILD_MUSHROOM, name: "Wild Mushroom",
    foodItem: "wild_mushroom", hungerRestore: 5, regrowTicks: 4000,
    color: [140, 110, 70], isMushroom: true, spawnChance: 0.008,
  },
];

// --- Lookup tables ---

/** Map from any crop stage block ID → CropDef + stage index (0-3). */
const BLOCK_TO_CROP = new Map<number, { crop: CropDef; stage: number }>();
for (const crop of Object.values(CROPS)) {
  for (let i = 0; i < 4; i++) {
    BLOCK_TO_CROP.set(crop.stages[i], { crop, stage: i });
  }
}

/** Map from wild block ID → WildCropDef. */
const WILD_BY_BLOCK = new Map<number, WildCropDef>();
for (const wc of WILD_CROPS) WILD_BY_BLOCK.set(wc.blockId, wc);

export function getCropByBlock(blockId: number): { crop: CropDef; stage: number } | null {
  return BLOCK_TO_CROP.get(blockId) ?? null;
}

export function getCropById(id: string): CropDef | null {
  return CROPS[id] ?? null;
}

export function getWildCropByBlock(blockId: number): WildCropDef | null {
  return WILD_BY_BLOCK.get(blockId) ?? null;
}

/** Is this block any crop stage (seed through mature)? */
export function isCropBlock(blockId: number): boolean {
  return BLOCK_TO_CROP.has(blockId);
}

/** Is this block a wild forageable? */
export function isWildCropBlock(blockId: number): boolean {
  return WILD_BY_BLOCK.has(blockId);
}

/** Is this block a mature crop (harvestable)? */
export function isMatureCrop(blockId: number): boolean {
  const entry = BLOCK_TO_CROP.get(blockId);
  return entry?.stage === 3;
}

/** Get the farmland block ID required by a crop (compost for mushrooms, regular otherwise). */
export function getFarmlandForCrop(crop: CropDef): number {
  return crop.isMushroom ? BLOCK_COMPOST_FARMLAND : BLOCK_FARMLAND;
}

/** Get all crop definitions as an array. */
export function getAllCrops(): CropDef[] {
  return Object.values(CROPS);
}
