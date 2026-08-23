// ============================================================================
// Overburden — block registry
// Defines all block types with their properties.
// ============================================================================

import {
    BLOCK_AIR,
    BLOCK_BED,
    BLOCK_BEDROCK,
    BLOCK_BUILDER_BENCH,
    BLOCK_CAMPFIRE,
    BLOCK_CLAY,
    BLOCK_COAL_ORE,
    BLOCK_COMPOST_BIN,
    BLOCK_COMPOST_FARMLAND,
    BLOCK_COPPER_ORE,
    BLOCK_CRAFT_BENCH,
    BLOCK_DIRT,
    BLOCK_FARMLAND,
    BLOCK_FURNACE,
    BLOCK_GOLD_ORE,
    BLOCK_GRASS,
    BLOCK_GRAVEL,
    BLOCK_IRON_ORE,
    BLOCK_KILN,
    BLOCK_LADDER,
    BLOCK_LAVA,
    BLOCK_LEAVES,
    BLOCK_METALWORK_BENCH,
    BLOCK_ROPE,
    BLOCK_SAND,
    BLOCK_SCAFFOLDING,
    BLOCK_STONE,
    BLOCK_TAILOR_BENCH,
    BLOCK_TIME_CRYSTAL,
    BLOCK_TIN_ORE,
    BLOCK_TOOL_BENCH,
    BLOCK_TORCH,
    BLOCK_TRELLIS,
    BLOCK_VINE_GRAPE,
    BLOCK_VINE_KIWI,
    BLOCK_WATER,
    BLOCK_WOOD,
    BLOCK_WOODWORK_BENCH,
    BLOCK_WORKBENCH,
    MASK_BACKWALL,
    MASK_CLIMBABLE,
    MASK_CRAFTING,
    MASK_FLAMMABLE,
    MASK_LIGHT_EMIT,
    MASK_LIQUID, MASK_MINEABLE,
    MASK_PLACEABLE_BG,
    MASK_SOLID
} from "./constants";
import { CROPS, WILD_CROPS } from "./crops";
import { TREE_SPECIES } from "./tree-species";
import type { BlockDef } from "./types";

// --- Block definitions ---
// Colors are RGB 0-255. These map to the sand engine palette system.
const DEFS: BlockDef[] = [
  {
    id: BLOCK_AIR, name: "Air", category: "gas",
    hardness: 0, color: [0, 0, 0], textureVariant: 0,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [], placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_DIRT, name: "Dirt", category: "solid",
    hardness: 5, color: [120, 80, 50], textureVariant: 0,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_GRASS, name: "Grass", category: "solid",
    hardness: 5, color: [80, 160, 60], textureVariant: 1,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_STONE, name: "Stone", category: "solid",
    hardness: 15, color: [128, 128, 128], textureVariant: 2,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "stone", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_SAND, name: "Sand", category: "solid",
    hardness: 3, color: [220, 200, 140], textureVariant: 3,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "sand", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_WATER, name: "Water", category: "liquid",
    hardness: 0, color: [60, 120, 200], textureVariant: 4,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 7, drops: [], placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_WOOD, name: "Wood", category: "solid",
    hardness: 8, color: [140, 100, 60], textureVariant: 5,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "wood", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_LEAVES, name: "Leaves", category: "solid",
    hardness: 2, color: [60, 130, 50], textureVariant: 6,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "stick", count: 1, chance: 0.5 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_COAL_ORE, name: "Coal Ore", category: "solid",
    hardness: 20, color: [50, 50, 50], textureVariant: 7,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 3, liquidFlow: 0, drops: [{ itemId: "coal", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_COPPER_ORE, name: "Copper Ore", category: "solid",
    hardness: 25, color: [180, 120, 70], textureVariant: 8,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "copper_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_TIN_ORE, name: "Tin Ore", category: "solid",
    hardness: 25, color: [200, 200, 210], textureVariant: 9,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "tin_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_IRON_ORE, name: "Iron Ore", category: "solid",
    hardness: 30, color: [160, 140, 120], textureVariant: 10,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "iron_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_GOLD_ORE, name: "Gold Ore", category: "solid",
    hardness: 35, color: [220, 200, 80], textureVariant: 11,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "gold_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_BEDROCK, name: "Bedrock", category: "solid",
    hardness: 100, color: [40, 40, 50], textureVariant: 12,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [], placeable: false, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_LAVA, name: "Lava", category: "liquid",
    hardness: 0, color: [220, 80, 20], textureVariant: 13,
    lightEmit: 15, lightColor: [255, 100, 20], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 3, drops: [], placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_TORCH, name: "Torch", category: "special",
    hardness: 1, color: [240, 200, 80], textureVariant: 14,
    lightEmit: 14, lightColor: [255, 180, 80], conductive: false, climbable: false, flammable: false,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "torch", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_LADDER, name: "Ladder", category: "special",
    hardness: 2, color: [180, 140, 80], textureVariant: 15,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: true, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "ladder", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_ROPE, name: "Rope", category: "special",
    hardness: 1, color: [200, 180, 120], textureVariant: 16,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: true, flammable: true,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "rope", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_SCAFFOLDING, name: "Scaffolding", category: "special",
    hardness: 1, color: [160, 130, 90], textureVariant: 17,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "scaffolding", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_TIME_CRYSTAL, name: "Crystal Ore", category: "solid",
    hardness: 40, color: [180, 220, 255], textureVariant: 18,
    lightEmit: 8, lightColor: [180, 220, 255], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "crystal", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_CLAY, name: "Clay", category: "solid",
    hardness: 5, color: [180, 160, 150], textureVariant: 19,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "clay", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
    isStation: false,
  },
  {
    id: BLOCK_GRAVEL, name: "Gravel", category: "solid",
    hardness: 4, color: [140, 135, 130], textureVariant: 20,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [
      { itemId: "gravel", count: 1, chance: 1 },
      { itemId: "flint", count: 1, chance: 0.3 },
    ],
    placeable: true, backwallProjection: true,
    isStation: false,
  },

  // --- Station blocks (crafting surfaces) ---
  {
    id: BLOCK_WORKBENCH, name: "Workbench", category: "special",
    hardness: 8, color: [160, 110, 70], textureVariant: 21,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "workbench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "workbench",
  },
  {
    id: BLOCK_CRAFT_BENCH, name: "Craft Bench", category: "special",
    hardness: 8, color: [170, 120, 80], textureVariant: 22,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "craft_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "craft_bench",
  },
  {
    id: BLOCK_TOOL_BENCH, name: "Tool Bench", category: "special",
    hardness: 8, color: [150, 100, 60], textureVariant: 23,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "tool_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "tool_bench",
  },
  {
    id: BLOCK_WOODWORK_BENCH, name: "Woodwork Bench", category: "special",
    hardness: 8, color: [130, 90, 50], textureVariant: 24,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "woodwork_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "woodwork_bench",
  },
  {
    id: BLOCK_CAMPFIRE, name: "Campfire", category: "special",
    hardness: 5, color: [200, 100, 40], textureVariant: 25,
    lightEmit: 14, lightColor: [255, 160, 60], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "campfire", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "campfire",
  },
  {
    id: BLOCK_KILN, name: "Kiln", category: "special",
    hardness: 15, color: [180, 140, 100], textureVariant: 26,
    lightEmit: 6, lightColor: [255, 140, 60], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "kiln", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "kiln",
  },
  {
    id: BLOCK_FURNACE, name: "Furnace", category: "special",
    hardness: 15, color: [100, 100, 110], textureVariant: 27,
    lightEmit: 8, lightColor: [255, 120, 40], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "furnace", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "furnace",
  },
  {
    id: BLOCK_METALWORK_BENCH, name: "Metalwork Bench", category: "special",
    hardness: 12, color: [120, 120, 140], textureVariant: 28,
    lightEmit: 6, lightColor: [255, 130, 50], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "metalwork_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "metalwork_bench",
  },
  {
    id: BLOCK_BUILDER_BENCH, name: "Builder's Bench", category: "special",
    hardness: 8, color: [160, 140, 100], textureVariant: 29,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "builder_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "builder_bench",
  },
  {
    id: BLOCK_TAILOR_BENCH, name: "Tailor's Bench", category: "special",
    hardness: 8, color: [180, 160, 120], textureVariant: 30,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "tailor_bench", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "tailor_bench",
  },
  {
    id: BLOCK_COMPOST_BIN, name: "Compost Bin", category: "special",
    hardness: 6, color: [100, 80, 50], textureVariant: 31,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "compost_bin", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: true, stationType: "compost_bin",
  },

  // --- Utility blocks ---
  {
    id: BLOCK_BED, name: "Bed", category: "special",
    hardness: 2, color: [200, 180, 200], textureVariant: 21,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "bed", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },

  // --- Trellis (placeable support for vines, layer 1) ---
  {
    id: BLOCK_TRELLIS, name: "Trellis", category: "special",
    hardness: 2, color: [170, 130, 80], textureVariant: 32,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: true, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "trellis", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },

  // --- Vines (climbable, grow on trees/walls/trellis) ---
  {
    id: BLOCK_VINE_KIWI, name: "Kiwi Vine", category: "special",
    hardness: 1, color: [90, 130, 60], textureVariant: 33,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: true, flammable: true,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "kiwi", count: 1, chance: 0.06 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_VINE_GRAPE, name: "Grape Vine", category: "special",
    hardness: 1, color: [110, 90, 130], textureVariant: 34,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: true, flammable: true,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "grape", count: 1, chance: 0.08 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },

  // --- Farmland (tilled soil, no collision) ---
  {
    id: BLOCK_FARMLAND, name: "Farmland", category: "special",
    hardness: 1, color: [100, 65, 35], textureVariant: 35,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
  {
    id: BLOCK_COMPOST_FARMLAND, name: "Compost Farmland", category: "special",
    hardness: 1, color: [70, 50, 25], textureVariant: 36,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
    isStation: false,
  },
];

// --- Per-species wood + leaf block definitions ---
// Generated from TREE_SPECIES so each species gets a distinct palette color.
// Wood blocks all drop the generic "wood" item (which places BLOCK_WOOD);
// the species distinction is visual at generation time. Leaf blocks drop
// their species' fruit (with chance) + a stick.
let _textureVariant = 35;
const SPECIES_DEFS: BlockDef[] = [];
for (const sp of TREE_SPECIES) {
  // Wood: brownish, varies slightly per species.
  const woodDef: BlockDef = {
    id: sp.woodBlock, name: `${sp.name} Wood`, category: "solid",
    hardness: 8, color: spWoodColor(sp.id), textureVariant: _textureVariant++,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "wood", count: 1, chance: 1 }],
    placeable: false, backwallProjection: true,
    isStation: false,
  };
  // Leaves: species-tinted green (cherry = pink blossoms, spruce = dark, etc.).
  const leafDrops = sp.fruitItem
    ? [
        { itemId: sp.fruitItem, count: 1, chance: sp.fruitChance },
        { itemId: "stick", count: 1, chance: 0.5 },
      ]
    : [{ itemId: "stick", count: 1, chance: 0.5 }];
  const leafDef: BlockDef = {
    id: sp.leafBlock, name: `${sp.name} Leaves`, category: "solid",
    hardness: 2, color: spLeafColor(sp.id), textureVariant: _textureVariant++,
    lightEmit: 0, lightColor: [0, 0, 0], conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: leafDrops,
    placeable: false, backwallProjection: false,
    isStation: false,
  };
  SPECIES_DEFS.push(woodDef, leafDef);
}

// --- Crop block definitions (generated from CROPS registry) ---
// Each crop has 4 stage blocks. All are "special" category (no collision),
// rendered as 2D palette colors. Mature crops drop food + seeds; immature
// crops drop only the seed. Seeds are not placeable by the player directly
// (planting is handled by the crop-growth system via seed items).
let _cropTextureVariant = 37;
const CROP_DEFS: BlockDef[] = [];
for (const crop of Object.values(CROPS)) {
  for (let stage = 0; stage < 4; stage++) {
    const stageNames = ["Seed", "Sprout", "Growing", "Mature"];
    const isMature = stage === 3;
    const drops = isMature
      ? [
          { itemId: crop.foodItem, count: crop.foodYield, chance: 1 },
          { itemId: crop.seedItem, count: crop.seedYield, chance: 1 },
        ]
      : [{ itemId: crop.seedItem, count: 1, chance: 1 }];
    CROP_DEFS.push({
      id: crop.stages[stage],
      name: `${crop.name} ${stageNames[stage]}`,
      category: "special",
      hardness: 1,
      color: crop.colors[stage],
      textureVariant: _cropTextureVariant++,
      lightEmit: 0, lightColor: [0, 0, 0],
      conductive: false, climbable: false, flammable: !crop.isMushroom,
      fuelValue: 0, liquidFlow: 0,
      drops,
      placeable: false, // seeds are planted via the crop system, not placed directly
      backwallProjection: false,
      isStation: false,
    });
  }
}

// --- Wild crop block definitions (single mature block, regrows after harvest) ---
const WILD_DEFS: BlockDef[] = [];
for (const wc of WILD_CROPS) {
  WILD_DEFS.push({
    id: wc.blockId,
    name: wc.name,
    category: "special",
    hardness: 1,
    color: wc.color,
    textureVariant: _cropTextureVariant++,
    lightEmit: 0, lightColor: [0, 0, 0],
    conductive: false, climbable: false, flammable: !wc.isMushroom,
    fuelValue: 0, liquidFlow: 0,
    drops: [{ itemId: wc.foodItem, count: 1, chance: 1 }],
    placeable: false, // wild crops are spawned by terrain gen, not placed by player
    backwallProjection: false,
    isStation: false,
  });
}

/** Per-species wood color (RGB 0-255). */
function spWoodColor(id: string): [number, number, number] {
  switch (id) {
    case "coconut": return [120, 90, 60];
    case "maple": return [150, 110, 70];
    case "orange": return [145, 105, 65];
    case "apple": return [140, 100, 60];
    case "lemon": return [150, 120, 70];
    case "lime": return [135, 115, 65];
    case "banana": return [130, 140, 70]; // greenish pseudo-stem
    case "spruce": return [90, 70, 50]; // dark
    case "pear": return [145, 115, 75];
    case "cherry": return [160, 110, 80];
    case "pomegranate": return [130, 95, 60];
    case "walnut": return [100, 75, 55]; // dark
    case "hazelnut": return [150, 115, 80];
    default: return [140, 100, 60];
  }
}

/** Per-species leaf color (RGB 0-255). */
function spLeafColor(id: string): [number, number, number] {
  switch (id) {
    case "coconut": return [50, 120, 70]; // palm fronds
    case "maple": return [70, 140, 55];
    case "orange": return [60, 135, 50];
    case "apple": return [65, 130, 55];
    case "lemon": return [70, 145, 60];
    case "lime": return [80, 160, 65];
    case "banana": return [90, 150, 60];
    case "spruce": return [35, 80, 45]; // dark needles
    case "pear": return [60, 125, 60];
    case "cherry": return [230, 170, 200]; // pink blossoms
    case "pomegranate": return [75, 130, 55];
    case "walnut": return [55, 110, 50];
    case "hazelnut": return [80, 135, 60];
    default: return [60, 130, 50];
  }
}

// --- Lookup tables ---
const byId = new Map<number, BlockDef>();
const byName = new Map<string, BlockDef>();
for (const def of [...DEFS, ...SPECIES_DEFS, ...CROP_DEFS, ...WILD_DEFS]) {
  byId.set(def.id, def);
  byName.set(def.name, def);
}

export function getBlockDef(id: number): BlockDef | undefined {
  return byId.get(id);
}

export function getBlockByName(name: string): BlockDef | undefined {
  return byName.get(name);
}

export function getAllBlocks(): BlockDef[] {
  return [...DEFS, ...SPECIES_DEFS, ...CROP_DEFS, ...WILD_DEFS];
}

// --- Mask computation ---
// Computes the mask flags for a block based on its definition.
export function computeMask(def: BlockDef): number {
  let mask = 0;
  if (def.category === "solid" || def.category === "special") {
    // Liquids and gases are not solid (except special blocks like torch/ladder)
    if (def.category === "solid") mask |= MASK_SOLID;
  }
  if (def.climbable) mask |= MASK_CLIMBABLE;
  if (def.category === "liquid") mask |= MASK_LIQUID;
  if (def.conductive) mask |= MASK_MINEABLE; // placeholder for conductive
  if (def.hardness > 0 && def.hardness < 100) mask |= MASK_MINEABLE;
  if (def.lightEmit > 0) mask |= MASK_LIGHT_EMIT;
  if (def.flammable) mask |= MASK_FLAMMABLE;
  if (def.backwallProjection) mask |= MASK_PLACEABLE_BG;
  if (def.category === "backwall") mask |= MASK_BACKWALL;
  if (def.isStation) mask |= MASK_CRAFTING;
  return mask;
}

// Precomputed mask table (indexed by block ID)
const maskTable = new Uint16Array(256);
for (const def of [...DEFS, ...SPECIES_DEFS, ...CROP_DEFS, ...WILD_DEFS]) {
  maskTable[def.id] = computeMask(def);
}

export function getBlockMask(id: number): number {
  return maskTable[id] ?? 0;
}

// --- Palette (for renderer) ---
// Returns a Uint8Array of RGBA colors indexed by block ID (256 blocks × 4 bytes).
export function getBlockPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 4); // RGBA per block (0-255)
  for (const def of [...DEFS, ...SPECIES_DEFS, ...CROP_DEFS, ...WILD_DEFS]) {
    const offset = def.id * 4;
    palette[offset] = def.color[0];
    palette[offset + 1] = def.color[1];
    palette[offset + 2] = def.color[2];
    palette[offset + 3] = def.category === "gas" ? 0 : 255;
  }
  return palette;
}
