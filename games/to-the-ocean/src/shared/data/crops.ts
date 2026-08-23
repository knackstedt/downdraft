// ============================================================================
// Crop Definitions — registry of farmable/forageable crops
// ============================================================================
// Each CropDef maps a seed item -> harvested crop item and describes growth,
// water needs, biome/season tolerance, yield, bush/mushroom behaviour, and
// procedural visual descriptors per growth stage (consumed by the renderer).
//
// Stage semantics: 0=seed, 1=sprout, 2=growing, 3=mature (harvestable),
// 4=overripe (bushes/mushrooms only — crops just stay at 3).
//
// Biomes in `preferredBiomes` are where the crop survives and where wild
// specimens spawn for foraging. Crops can be PLANTED in any biome, but if the
// current biome+season is outside their tolerance and they are not sheltered,
// they accumulate stress and eventually die (see PlantSystem).

import { BiomeType } from "../types";

export type CropCategory =
  | "vegetable"
  | "grain"
  | "fruit"
  | "berry"
  | "mushroom"
  | "gourd"
  | "stalk"
  | "bean";

export type CropId =
  | "tomato"
  | "kelp"
  | "rice"
  | "cabbage"
  | "potato"
  | "carrot"
  | "beet"
  | "turnip"
  | "onion"
  | "broccoli"
  | "pepper"
  | "pumpkin"
  | "watermelon"
  | "corn"
  | "wheat"
  | "sugar_cane"
  | "coffee"
  | "strawberry"
  | "blueberry"
  | "blackberry"
  | "raspberry"
  | "blue_mushroom"
  | "red_mushroom"
  | "brown_mushroom";

/** Procedural visual descriptor for one growth stage. */
export interface CropStageVisual {
  /** Stem/stalk height in meters at this stage. */
  height: number;
  /** Foliage radius in meters (leaf canopy / bush spread). */
  foliageRadius: number;
  /** Foliage colour [r,g,b] 0..1. */
  foliageColor: [number, number, number];
  /** Fruit colour [r,g,b] 0..1, or null if no fruit at this stage. */
  fruitColor: [number, number, number] | null;
  /** Number of fruit instances rendered (0 if none). */
  fruitCount: number;
  /** Fruit radius in meters. */
  fruitRadius: number;
  /** Stem colour [r,g,b] 0..1. */
  stemColor: [number, number, number];
  /** Stem radius in meters. */
  stemRadius: number;
}

export interface CropDef {
  id: CropId;
  name: string;
  /** Seed item id (or spore for mushrooms). null for kelp (wild-only material). */
  seedItemId: string | null;
  /** Harvested crop item id. */
  cropItemId: string;
  category: CropCategory;
  /** Seconds per stage [seed, sprout, growing, mature]. Index 3 = time spent mature before overripe/regrow. */
  stageDurations: [number, number, number, number];
  /** Base yield at harvest (before variance). */
  baseYield: number;
  /** +/- random spread on yield. */
  yieldVariance: number;
  /** Water drain multiplier vs the default 0.3/s. */
  waterNeed: number;
  /** Water level below which growth pauses. */
  minWaterToGrow: number;
  /** Biomes where the crop thrives and where wild ones spawn. */
  preferredBiomes: BiomeType[];
  /** 0..1 — resistance to cold seasons/biomes. 1 = unaffected by cold. */
  coldTolerance: number;
  /** 0..1 — resistance to hot biomes/summer heat. 1 = unaffected by heat. */
  heatTolerance: number;
  /** Persistent bush: regrows fruit after harvest instead of resetting. */
  isBush: boolean;
  /** Mushroom: spreads to nearby planters/ground when mature. */
  isMushroom: boolean;
  /** Seconds for a bush to regrow fruit after harvest (bushes only). */
  regrowTime: number;
  /** Per-tick probability (scaled by dt) that a mature mushroom spreads. */
  spreadChance: number;
  /** Max horizontal distance (meters) a mushroom can spread. */
  spreadRange: number;
  /** Hunger restored when the crop is eaten. */
  hungerRestore: number;
  /** Thirst restored when the crop is eaten. */
  thirstRestore: number;
  /** Spoil rate (per game hour) of the harvested item — mirrors ItemDef. */
  spoilRate: number;
  /** Base sell value — mirrors ItemDef. */
  value: number;
  /** Procedural visuals for stages 0..3 (index by growthStage). */
  visuals: [CropStageVisual, CropStageVisual, CropStageVisual, CropStageVisual];
}

// --- helpers for visuals -----------------------------------------------------

const GREEN: [number, number, number] = [0.30, 0.55, 0.20];
const DARK_GREEN: [number, number, number] = [0.20, 0.42, 0.16];
const BROWN_STEM: [number, number, number] = [0.36, 0.26, 0.16];
const TAN_STEM: [number, number, number] = [0.62, 0.50, 0.30];

/** Seed stage: tiny nub in the ground. */
function seedStage(stemColor: [number, number, number] = BROWN_STEM): CropStageVisual {
  return {
    height: 0.05, foliageRadius: 0.02, foliageColor: BROWN_STEM,
    fruitColor: null, fruitCount: 0, fruitRadius: 0,
    stemColor, stemRadius: 0.02,
  };
}
/** Sprout: small green shoot. */
function sproutStage(foliageColor: [number, number, number] = GREEN): CropStageVisual {
  return {
    height: 0.15, foliageRadius: 0.08, foliageColor,
    fruitColor: null, fruitCount: 0, fruitRadius: 0,
    stemColor: GREEN, stemRadius: 0.025,
  };
}
/** Growing: taller, leafier, no fruit yet. */
function growingStage(
  height: number,
  foliageRadius: number,
  foliageColor: [number, number, number] = GREEN,
  stemColor: [number, number, number] = GREEN,
  stemRadius = 0.04,
): CropStageVisual {
  return {
    height, foliageRadius, foliageColor,
    fruitColor: null, fruitCount: 0, fruitRadius: 0,
    stemColor, stemRadius,
  };
}
/** Mature: full height + fruit. */
function matureStage(
  height: number,
  foliageRadius: number,
  foliageColor: [number, number, number],
  fruitColor: [number, number, number] | null,
  fruitCount: number,
  fruitRadius: number,
  stemColor: [number, number, number] = GREEN,
  stemRadius = 0.05,
): CropStageVisual {
  return { height, foliageRadius, foliageColor, fruitColor, fruitCount, fruitRadius, stemColor, stemRadius };
}

// --- the registry ------------------------------------------------------------

export const CROPS: Record<CropId, CropDef> = {
  // --- Existing / legacy ---
  tomato: {
    id: "tomato", name: "Tomato", seedItemId: "tomato_seed", cropItemId: "tomato", category: "vegetable",
    stageDurations: [30, 60, 120, 240], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.Tropical, BiomeType.SubTropical],
    coldTolerance: 0.2, heatTolerance: 0.9, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 16, thirstRestore: 8, spoilRate: 0.015, value: 7,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.45, 0.25),
      matureStage(0.6, 0.35, GREEN, [0.78, 0.12, 0.10], 4, 0.06),
    ],
  },
  kelp: {
    id: "kelp", name: "Kelp", seedItemId: "kelp_seed", cropItemId: "kelp", category: "stalk",
    stageDurations: [40, 80, 160, 300], baseYield: 2, yieldVariance: 1, waterNeed: 0.4, minWaterToGrow: 5,
    preferredBiomes: [BiomeType.KelpForest, BiomeType.Ocean],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 5, thirstRestore: 0, spoilRate: 0.012, value: 5,
    visuals: [
      seedStage(DARK_GREEN),
      sproutStage(DARK_GREEN),
      growingStage(0.6, 0.10, DARK_GREEN, DARK_GREEN, 0.03),
      matureStage(1.2, 0.15, DARK_GREEN, [0.18, 0.40, 0.18], 0, 0, DARK_GREEN, 0.04),
    ],
  },
  rice: {
    id: "rice", name: "Rice", seedItemId: "rice_seed", cropItemId: "rice", category: "grain",
    stageDurations: [30, 70, 140, 200], baseYield: 4, yieldVariance: 1, waterNeed: 1.4, minWaterToGrow: 20,
    preferredBiomes: [BiomeType.Freshwater, BiomeType.Lake, BiomeType.SubTropical],
    coldTolerance: 0.4, heatTolerance: 0.8, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 12, thirstRestore: 0, spoilRate: 0.006, value: 5,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.4, 0.12, [0.45, 0.60, 0.25]),
      matureStage(0.7, 0.18, [0.70, 0.62, 0.20], [0.85, 0.72, 0.20], 6, 0.02, [0.45, 0.60, 0.25], 0.03),
    ],
  },

  // --- Vegetables ---
  cabbage: {
    id: "cabbage", name: "Cabbage", seedItemId: "cabbage_seed", cropItemId: "cabbage", category: "vegetable",
    stageDurations: [25, 60, 120, 200], baseYield: 2, yieldVariance: 1, waterNeed: 1.1, minWaterToGrow: 15,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 18, thirstRestore: 0, spoilRate: 0.012, value: 6,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.25, 0.22, [0.40, 0.60, 0.30]),
      matureStage(0.4, 0.35, [0.50, 0.70, 0.40], null, 0, 0, [0.40, 0.60, 0.30], 0.06),
    ],
  },
  potato: {
    id: "potato", name: "Potato", seedItemId: "potato_seed", cropItemId: "potato", category: "vegetable",
    stageDurations: [30, 70, 150, 220], baseYield: 4, yieldVariance: 2, waterNeed: 0.9, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 20, thirstRestore: 0, spoilRate: 0.006, value: 5,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.35, 0.25),
      matureStage(0.5, 0.35, GREEN, [0.78, 0.62, 0.30], 3, 0.07, GREEN, 0.05),
    ],
  },
  carrot: {
    id: "carrot", name: "Carrot", seedItemId: "carrot_seed", cropItemId: "carrot", category: "vegetable",
    stageDurations: [25, 55, 110, 180], baseYield: 3, yieldVariance: 1, waterNeed: 0.9, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.6, heatTolerance: 0.6, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 15, thirstRestore: 5, spoilRate: 0.008, value: 5,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.3, 0.18, [0.40, 0.62, 0.25]),
      matureStage(0.45, 0.25, [0.40, 0.62, 0.25], [0.95, 0.55, 0.15], 1, 0.05, [0.40, 0.62, 0.25], 0.04),
    ],
  },
  beet: {
    id: "beet", name: "Beet", seedItemId: "beet_seed", cropItemId: "beet", category: "vegetable",
    stageDurations: [25, 55, 110, 180], baseYield: 3, yieldVariance: 1, waterNeed: 0.9, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.6, heatTolerance: 0.6, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 16, thirstRestore: 0, spoilRate: 0.008, value: 6,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.3, 0.20, [0.35, 0.55, 0.30]),
      matureStage(0.45, 0.28, [0.35, 0.55, 0.30], [0.70, 0.18, 0.22], 1, 0.06, [0.35, 0.55, 0.30], 0.04),
    ],
  },
  turnip: {
    id: "turnip", name: "Turnip", seedItemId: "turnip_seed", cropItemId: "turnip", category: "vegetable",
    stageDurations: [25, 55, 110, 170], baseYield: 3, yieldVariance: 1, waterNeed: 0.9, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 15, thirstRestore: 0, spoilRate: 0.008, value: 5,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.3, 0.20, [0.40, 0.58, 0.28]),
      matureStage(0.45, 0.28, [0.40, 0.58, 0.28], [0.92, 0.90, 0.82], 1, 0.06, [0.40, 0.58, 0.28], 0.04),
    ],
  },
  onion: {
    id: "onion", name: "Onion", seedItemId: "onion_seed", cropItemId: "onion", category: "vegetable",
    stageDurations: [30, 60, 120, 190], baseYield: 3, yieldVariance: 1, waterNeed: 0.8, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.Desert],
    coldTolerance: 0.5, heatTolerance: 0.7, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 14, thirstRestore: 0, spoilRate: 0.005, value: 6,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.35, 0.12, [0.45, 0.60, 0.30]),
      matureStage(0.5, 0.18, [0.45, 0.60, 0.30], [0.88, 0.78, 0.45], 1, 0.07, [0.45, 0.60, 0.30], 0.04),
    ],
  },
  broccoli: {
    id: "broccoli", name: "Broccoli", seedItemId: "broccoli_seed", cropItemId: "broccoli", category: "vegetable",
    stageDurations: [30, 70, 140, 220], baseYield: 2, yieldVariance: 1, waterNeed: 1.1, minWaterToGrow: 15,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.7, heatTolerance: 0.4, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 22, thirstRestore: 0, spoilRate: 0.014, value: 8,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.4, 0.22, [0.30, 0.50, 0.25]),
      matureStage(0.55, 0.30, [0.22, 0.45, 0.22], [0.22, 0.45, 0.22], 1, 0.10, [0.30, 0.50, 0.25], 0.05),
    ],
  },
  pepper: {
    id: "pepper", name: "Pepper", seedItemId: "pepper_seed", cropItemId: "pepper", category: "vegetable",
    stageDurations: [30, 65, 130, 210], baseYield: 4, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.Tropical, BiomeType.SubTropical],
    coldTolerance: 0.2, heatTolerance: 0.9, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 14, thirstRestore: 0, spoilRate: 0.012, value: 8,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.4, 0.22, [0.35, 0.55, 0.25]),
      matureStage(0.55, 0.30, [0.35, 0.55, 0.25], [0.85, 0.30, 0.10], 4, 0.05, [0.35, 0.55, 0.25], 0.04),
    ],
  },

  // --- Gourds & large fruits ---
  pumpkin: {
    id: "pumpkin", name: "Pumpkin", seedItemId: "pumpkin_seed", cropItemId: "pumpkin", category: "gourd",
    stageDurations: [40, 90, 180, 300], baseYield: 2, yieldVariance: 1, waterNeed: 1.2, minWaterToGrow: 15,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.5, heatTolerance: 0.7, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 35, thirstRestore: 0, spoilRate: 0.006, value: 18,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.3, 0.4, [0.45, 0.60, 0.28]),
      matureStage(0.4, 0.6, [0.45, 0.60, 0.28], [0.90, 0.55, 0.15], 1, 0.18, [0.45, 0.60, 0.28], 0.05),
    ],
  },
  watermelon: {
    id: "watermelon", name: "Watermelon", seedItemId: "watermelon_seed", cropItemId: "watermelon", category: "gourd",
    stageDurations: [40, 90, 180, 300], baseYield: 2, yieldVariance: 1, waterNeed: 1.3, minWaterToGrow: 20,
    preferredBiomes: [BiomeType.Tropical, BiomeType.SubTropical],
    coldTolerance: 0.2, heatTolerance: 0.9, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 25, thirstRestore: 30, spoilRate: 0.01, value: 20,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.35, 0.45, [0.35, 0.55, 0.25]),
      matureStage(0.45, 0.6, [0.35, 0.55, 0.25], [0.20, 0.55, 0.22], 1, 0.20, [0.35, 0.55, 0.25], 0.05),
    ],
  },

  // --- Grains & stalks ---
  corn: {
    id: "corn", name: "Corn", seedItemId: "corn_seed", cropItemId: "corn", category: "grain",
    stageDurations: [35, 80, 160, 260], baseYield: 3, yieldVariance: 1, waterNeed: 1.1, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.4, heatTolerance: 0.7, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 18, thirstRestore: 0, spoilRate: 0.006, value: 7,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.9, 0.10, [0.45, 0.60, 0.25], TAN_STEM, 0.03),
      matureStage(1.6, 0.15, [0.45, 0.60, 0.25], [0.95, 0.80, 0.20], 1, 0.08, TAN_STEM, 0.04),
    ],
  },
  wheat: {
    id: "wheat", name: "Wheat", seedItemId: "wheat_seed", cropItemId: "wheat", category: "grain",
    stageDurations: [30, 70, 140, 200], baseYield: 4, yieldVariance: 1, waterNeed: 0.9, minWaterToGrow: 10,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.6, heatTolerance: 0.6, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 8, thirstRestore: 0, spoilRate: 0.0, value: 4,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.5, 0.06, [0.50, 0.62, 0.30], TAN_STEM, 0.02),
      matureStage(0.9, 0.10, [0.78, 0.65, 0.25], [0.90, 0.75, 0.25], 8, 0.02, TAN_STEM, 0.025),
    ],
  },
  sugar_cane: {
    id: "sugar_cane", name: "Sugar Cane", seedItemId: "sugar_cane_seed", cropItemId: "sugar_cane", category: "stalk",
    stageDurations: [35, 80, 160, 240], baseYield: 3, yieldVariance: 1, waterNeed: 1.4, minWaterToGrow: 20,
    preferredBiomes: [BiomeType.Tropical, BiomeType.Freshwater, BiomeType.Lake],
    coldTolerance: 0.1, heatTolerance: 0.95, isBush: false, isMushroom: false, regrowTime: 0,
    spreadChance: 0, spreadRange: 0, hungerRestore: 6, thirstRestore: 12, spoilRate: 0.01, value: 6,
    visuals: [
      seedStage(DARK_GREEN),
      sproutStage(DARK_GREEN),
      growingStage(0.8, 0.08, [0.40, 0.58, 0.25], [0.45, 0.60, 0.28], 0.04),
      matureStage(1.8, 0.12, [0.45, 0.60, 0.28], [0.55, 0.70, 0.30], 0, 0, [0.45, 0.60, 0.28], 0.05),
    ],
  },
  coffee: {
    id: "coffee", name: "Coffee", seedItemId: "coffee_seed", cropItemId: "coffee", category: "bean",
    stageDurations: [40, 90, 200, 320], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.Tropical, BiomeType.SubTropical],
    coldTolerance: 0.2, heatTolerance: 0.8, isBush: true, isMushroom: false, regrowTime: 180,
    spreadChance: 0, spreadRange: 0, hungerRestore: 5, thirstRestore: 0, spoilRate: 0.003, value: 12,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.5, 0.3, [0.30, 0.50, 0.22]),
      matureStage(0.9, 0.45, [0.30, 0.50, 0.22], [0.75, 0.45, 0.20], 5, 0.04, [0.30, 0.50, 0.22], 0.04),
    ],
  },

  // --- Berries (persistent bushes) ---
  strawberry: {
    id: "strawberry", name: "Strawberry", seedItemId: "strawberry_seed", cropItemId: "strawberry", category: "berry",
    stageDurations: [25, 55, 110, 160], baseYield: 3, yieldVariance: 1, waterNeed: 1.1, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.5, heatTolerance: 0.6, isBush: true, isMushroom: false, regrowTime: 120,
    spreadChance: 0, spreadRange: 0, hungerRestore: 10, thirstRestore: 10, spoilRate: 0.02, value: 9,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.2, 0.25, [0.35, 0.55, 0.25]),
      matureStage(0.3, 0.35, [0.35, 0.55, 0.25], [0.90, 0.15, 0.15], 4, 0.04, [0.35, 0.55, 0.25], 0.03),
    ],
  },
  blueberry: {
    id: "blueberry", name: "Blueberry", seedItemId: "blueberry_seed", cropItemId: "blueberry", category: "berry",
    stageDurations: [30, 60, 120, 180], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.8, heatTolerance: 0.4, isBush: true, isMushroom: false, regrowTime: 140,
    spreadChance: 0, spreadRange: 0, hungerRestore: 8, thirstRestore: 8, spoilRate: 0.02, value: 8,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.3, 0.3, [0.30, 0.48, 0.22]),
      matureStage(0.5, 0.45, [0.30, 0.48, 0.22], [0.25, 0.30, 0.65], 6, 0.035, [0.30, 0.48, 0.22], 0.03),
    ],
  },
  blackberry: {
    id: "blackberry", name: "Blackberry", seedItemId: "blackberry_seed", cropItemId: "blackberry", category: "berry",
    stageDurations: [30, 60, 120, 180], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.SubTropical, BiomeType.BorealForest],
    coldTolerance: 0.6, heatTolerance: 0.6, isBush: true, isMushroom: false, regrowTime: 140,
    spreadChance: 0, spreadRange: 0, hungerRestore: 9, thirstRestore: 7, spoilRate: 0.02, value: 8,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.35, 0.32, [0.32, 0.50, 0.24]),
      matureStage(0.6, 0.5, [0.32, 0.50, 0.24], [0.18, 0.12, 0.22], 6, 0.035, [0.32, 0.50, 0.24], 0.03),
    ],
  },
  raspberry: {
    id: "raspberry", name: "Raspberry", seedItemId: "raspberry_seed", cropItemId: "raspberry", category: "berry",
    stageDurations: [30, 60, 120, 180], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 12,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: true, isMushroom: false, regrowTime: 140,
    spreadChance: 0, spreadRange: 0, hungerRestore: 9, thirstRestore: 9, spoilRate: 0.02, value: 9,
    visuals: [
      seedStage(),
      sproutStage(),
      growingStage(0.35, 0.30, [0.35, 0.52, 0.25]),
      matureStage(0.6, 0.48, [0.35, 0.52, 0.25], [0.85, 0.20, 0.30], 6, 0.035, [0.35, 0.52, 0.25], 0.03),
    ],
  },

  // --- Mushrooms (spread when mature) ---
  blue_mushroom: {
    id: "blue_mushroom", name: "Blue Mushroom", seedItemId: "blue_mushroom_spore", cropItemId: "blue_mushroom", category: "mushroom",
    stageDurations: [25, 50, 100, 160], baseYield: 2, yieldVariance: 1, waterNeed: 1.2, minWaterToGrow: 20,
    preferredBiomes: [BiomeType.Volcanic, BiomeType.DeepOcean, BiomeType.Hell],
    coldTolerance: 0.6, heatTolerance: 0.8, isBush: false, isMushroom: true, regrowTime: 0,
    spreadChance: 0.002, spreadRange: 5, hungerRestore: 12, thirstRestore: 6, spoilRate: 0.012, value: 14,
    visuals: [
      seedStage([0.4, 0.4, 0.6]),
      sproutStage([0.4, 0.5, 0.8]),
      growingStage(0.12, 0.10, [0.4, 0.5, 0.8], [0.85, 0.82, 0.78], 0.04),
      matureStage(0.22, 0.16, [0.4, 0.5, 0.8], [0.35, 0.45, 0.95], 1, 0.09, [0.85, 0.82, 0.78], 0.04),
    ],
  },
  red_mushroom: {
    id: "red_mushroom", name: "Red Mushroom", seedItemId: "red_mushroom_spore", cropItemId: "red_mushroom", category: "mushroom",
    stageDurations: [25, 50, 100, 160], baseYield: 2, yieldVariance: 1, waterNeed: 1.1, minWaterToGrow: 18,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical, BiomeType.Volcanic],
    coldTolerance: 0.7, heatTolerance: 0.6, isBush: false, isMushroom: true, regrowTime: 0,
    spreadChance: 0.002, spreadRange: 5, hungerRestore: 14, thirstRestore: 0, spoilRate: 0.012, value: 16,
    visuals: [
      seedStage([0.5, 0.3, 0.3]),
      sproutStage([0.6, 0.4, 0.3]),
      growingStage(0.12, 0.10, [0.6, 0.4, 0.3], [0.85, 0.82, 0.78], 0.04),
      matureStage(0.24, 0.18, [0.6, 0.4, 0.3], [0.85, 0.15, 0.12], 1, 0.10, [0.85, 0.82, 0.78], 0.04),
    ],
  },
  brown_mushroom: {
    id: "brown_mushroom", name: "Brown Mushroom", seedItemId: "brown_mushroom_spore", cropItemId: "brown_mushroom", category: "mushroom",
    stageDurations: [20, 45, 90, 140], baseYield: 3, yieldVariance: 1, waterNeed: 1.0, minWaterToGrow: 15,
    preferredBiomes: [BiomeType.BorealForest, BiomeType.SubTropical, BiomeType.KelpForest],
    coldTolerance: 0.7, heatTolerance: 0.5, isBush: false, isMushroom: true, regrowTime: 0,
    spreadChance: 0.003, spreadRange: 5, hungerRestore: 16, thirstRestore: 0, spoilRate: 0.012, value: 10,
    visuals: [
      seedStage([0.4, 0.3, 0.2]),
      sproutStage([0.5, 0.4, 0.25]),
      growingStage(0.12, 0.11, [0.5, 0.4, 0.25], [0.85, 0.80, 0.75], 0.04),
      matureStage(0.24, 0.18, [0.5, 0.4, 0.25], [0.55, 0.40, 0.25], 1, 0.10, [0.85, 0.80, 0.75], 0.04),
    ],
  },
};

// --- lookups -----------------------------------------------------------------

const SEED_TO_CROP = new Map<string, CropId>();
for (const crop of Object.values(CROPS)) {
  if (crop.seedItemId) SEED_TO_CROP.set(crop.seedItemId, crop.id);
}

// --- crop id hashing (mirrors plant-system.ts cropIdHash) ---
const CROP_HASH_TO_ID = new Map<number, CropId>();
function computeCropHash(id: CropId): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
for (const crop of Object.values(CROPS)) {
  CROP_HASH_TO_ID.set(computeCropHash(crop.id), crop.id);
}

/**
 * Decode a crop id from the f32-encoded hash stored in entity data[3].
 * `encodedF32` is the float32 value read from the entity's data array; we
 * reinterpret it as u32 and look up the crop. Returns null if unknown.
 */
export function getCropByEncodedHash(encodedF32: number): CropDef | null {
  // Reinterpret f32 -> u32
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, encodedF32, true);
  const u32 = dv.getUint32(0, true);
  const id = CROP_HASH_TO_ID.get(u32);
  return id ? CROPS[id] : null;
}

export function getCrop(id: string): CropDef | null {
  return CROPS[id as CropId] ?? null;
}

export function getCropBySeed(seedItemId: string): CropDef | null {
  const id = SEED_TO_CROP.get(seedItemId);
  return id ? CROPS[id] : null;
}

export function getCropsByBiome(biome: BiomeType): CropDef[] {
  return Object.values(CROPS).filter((c) => c.preferredBiomes.includes(biome));
}

export function getAllCrops(): CropDef[] {
  return Object.values(CROPS);
}
