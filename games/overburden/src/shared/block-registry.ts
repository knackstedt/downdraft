// ============================================================================
// Overburden — block registry
// Defines all block types with their properties.
// ============================================================================

import {
    BLOCK_AIR,
    BLOCK_BEDROCK,
    BLOCK_CLAY,
    BLOCK_COAL_ORE, BLOCK_COPPER_ORE,
    BLOCK_DIRT,
    BLOCK_GOLD_ORE,
    BLOCK_GRASS,
    BLOCK_GRAVEL,
    BLOCK_IRON_ORE,
    BLOCK_LADDER,
    BLOCK_LAVA,
    BLOCK_LEAVES,
    BLOCK_ROPE,
    BLOCK_SAND,
    BLOCK_SCAFFOLDING,
    BLOCK_STONE,
    BLOCK_TIME_CRYSTAL,
    BLOCK_TIN_ORE,
    BLOCK_TORCH,
    BLOCK_WATER,
    BLOCK_WOOD,
    MASK_BACKWALL,
    MASK_CLIMBABLE,
    MASK_FLAMMABLE,
    MASK_LIGHT_EMIT,
    MASK_LIQUID, MASK_MINEABLE,
    MASK_PLACEABLE_BG,
    MASK_SOLID,
} from "./constants";
import type { BlockDef } from "./types";

// --- Block definitions ---
// Colors are RGB 0-255. These map to the sand engine palette system.
const DEFS: BlockDef[] = [
  {
    id: BLOCK_AIR, name: "Air", category: "gas",
    hardness: 0, color: [0, 0, 0], textureVariant: 0,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [], placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_DIRT, name: "Dirt", category: "solid",
    hardness: 5, color: [120, 80, 50], textureVariant: 0,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_GRASS, name: "Grass", category: "solid",
    hardness: 5, color: [80, 160, 60], textureVariant: 1,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "dirt", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_STONE, name: "Stone", category: "solid",
    hardness: 15, color: [128, 128, 128], textureVariant: 2,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "stone", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_SAND, name: "Sand", category: "solid",
    hardness: 3, color: [220, 200, 140], textureVariant: 3,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "sand", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_WATER, name: "Water", category: "liquid",
    hardness: 0, color: [60, 120, 200], textureVariant: 4,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 7, drops: [], placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_WOOD, name: "Wood", category: "solid",
    hardness: 8, color: [140, 100, 60], textureVariant: 5,
    lightEmit: 0, conductive: false, climbable: false, flammable: true,
    fuelValue: 2, liquidFlow: 0, drops: [{ itemId: "wood", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_LEAVES, name: "Leaves", category: "solid",
    hardness: 2, color: [60, 130, 50], textureVariant: 6,
    lightEmit: 0, conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "stick", count: 1, chance: 0.5 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_COAL_ORE, name: "Coal Ore", category: "solid",
    hardness: 20, color: [50, 50, 50], textureVariant: 7,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 3, liquidFlow: 0, drops: [{ itemId: "coal", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_COPPER_ORE, name: "Copper Ore", category: "solid",
    hardness: 25, color: [180, 120, 70], textureVariant: 8,
    lightEmit: 0, conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "copper_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_TIN_ORE, name: "Tin Ore", category: "solid",
    hardness: 25, color: [200, 200, 210], textureVariant: 9,
    lightEmit: 0, conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "tin_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_IRON_ORE, name: "Iron Ore", category: "solid",
    hardness: 30, color: [160, 140, 120], textureVariant: 10,
    lightEmit: 0, conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "iron_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_GOLD_ORE, name: "Gold Ore", category: "solid",
    hardness: 35, color: [220, 200, 80], textureVariant: 11,
    lightEmit: 0, conductive: true, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "gold_ore", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_BEDROCK, name: "Bedrock", category: "solid",
    hardness: 100, color: [40, 40, 50], textureVariant: 12,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [], placeable: false, backwallProjection: true,
  },
  {
    id: BLOCK_LAVA, name: "Lava", category: "liquid",
    hardness: 0, color: [220, 80, 20], textureVariant: 13,
    lightEmit: 15, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 3, drops: [], placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_TORCH, name: "Torch", category: "special",
    hardness: 1, color: [240, 200, 80], textureVariant: 14,
    lightEmit: 14, conductive: false, climbable: false, flammable: false,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "torch", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
  },
  {
    id: BLOCK_LADDER, name: "Ladder", category: "special",
    hardness: 2, color: [180, 140, 80], textureVariant: 15,
    lightEmit: 0, conductive: false, climbable: true, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "ladder", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
  },
  {
    id: BLOCK_ROPE, name: "Rope", category: "special",
    hardness: 1, color: [200, 180, 120], textureVariant: 16,
    lightEmit: 0, conductive: false, climbable: true, flammable: true,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "rope", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
  },
  {
    id: BLOCK_SCAFFOLDING, name: "Scaffolding", category: "special",
    hardness: 1, color: [160, 130, 90], textureVariant: 17,
    lightEmit: 0, conductive: false, climbable: false, flammable: true,
    fuelValue: 1, liquidFlow: 0, drops: [{ itemId: "scaffolding", count: 1, chance: 1 }],
    placeable: true, backwallProjection: false,
  },
  {
    id: BLOCK_TIME_CRYSTAL, name: "Time Crystal", category: "solid",
    hardness: 40, color: [180, 220, 255], textureVariant: 18,
    lightEmit: 8, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "time_crystal", count: 1, chance: 1 }],
    placeable: false, backwallProjection: false,
  },
  {
    id: BLOCK_CLAY, name: "Clay", category: "solid",
    hardness: 5, color: [180, 160, 150], textureVariant: 19,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "clay", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
  {
    id: BLOCK_GRAVEL, name: "Gravel", category: "solid",
    hardness: 4, color: [140, 135, 130], textureVariant: 20,
    lightEmit: 0, conductive: false, climbable: false, flammable: false,
    fuelValue: 0, liquidFlow: 0, drops: [{ itemId: "gravel", count: 1, chance: 1 }],
    placeable: true, backwallProjection: true,
  },
];

// --- Lookup tables ---
const byId = new Map<number, BlockDef>();
const byName = new Map<string, BlockDef>();
for (const def of DEFS) {
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
  return DEFS;
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
  return mask;
}

// Precomputed mask table (indexed by block ID)
const maskTable = new Uint16Array(256);
for (const def of DEFS) {
  maskTable[def.id] = computeMask(def);
}

export function getBlockMask(id: number): number {
  return maskTable[id] ?? 0;
}

// --- Palette (for renderer) ---
// Returns a Uint8Array of RGBA colors indexed by block ID (256 blocks × 4 bytes).
export function getBlockPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 4); // RGBA per block (0-255)
  for (const def of DEFS) {
    const offset = def.id * 4;
    palette[offset] = def.color[0];
    palette[offset + 1] = def.color[1];
    palette[offset + 2] = def.color[2];
    palette[offset + 3] = def.category === "gas" ? 0 : 255;
  }
  return palette;
}
