// ============================================================================
// Overburden — crafting recipe registry
//
// Recipes define inputs (ingredient item IDs + counts) and outputs.
// Each recipe targets a crafting station (or "hand" for no-station recipes).
// craftTime is in seconds (0 = instant). fuelCost is fuel slots consumed
// per craft (0 for hand or unfueled stations).
// ============================================================================

import type { CraftStation } from "./types";

// Re-export for backward compatibility (other files import CraftStation from recipes)
export type { CraftStation };

export interface RecipeIngredient {
  itemId: string;
  count: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  station: CraftStation;
  inputs: RecipeIngredient[];
  outputs: RecipeIngredient[];
  craftTime: number; // seconds (0 = instant, hand recipes)
  fuelCost: number; // fuel slots consumed per craft (0 = unfueled station or hand)
}

const DEFS: RecipeDef[] = [
  // --- Hand recipes (instant, craftTime: 0) ---
  {
    id: "planks_from_wood",
    name: "Planks",
    station: "hand",
    inputs: [{ itemId: "wood", count: 1 }],
    outputs: [{ itemId: "planks", count: 4 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "sticks_from_planks",
    name: "Sticks",
    station: "hand",
    inputs: [{ itemId: "planks", count: 2 }],
    outputs: [{ itemId: "stick", count: 4 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "torch_from_coal_stick",
    name: "Torch",
    station: "hand",
    inputs: [{ itemId: "coal", count: 1 }, { itemId: "stick", count: 1 }],
    outputs: [{ itemId: "torch", count: 4 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "ladder_from_planks",
    name: "Ladder",
    station: "hand",
    inputs: [{ itemId: "planks", count: 4 }],
    outputs: [{ itemId: "ladder", count: 2 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "rope_from_planks",
    name: "Rope",
    station: "hand",
    inputs: [{ itemId: "planks", count: 2 }],
    outputs: [{ itemId: "rope", count: 1 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "scaffolding_from_planks",
    name: "Scaffolding",
    station: "hand",
    inputs: [{ itemId: "planks", count: 3 }],
    outputs: [{ itemId: "scaffolding", count: 2 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "flint_pickaxe",
    name: "Flint Pickaxe",
    station: "hand",
    inputs: [{ itemId: "flint", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "flint_pickaxe", count: 1 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "flint_axe",
    name: "Flint Axe",
    station: "hand",
    inputs: [{ itemId: "flint", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "flint_axe", count: 1 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "flint_shovel",
    name: "Flint Shovel",
    station: "hand",
    inputs: [{ itemId: "flint", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "flint_shovel", count: 1 }],
    craftTime: 0,
    fuelCost: 0,
  },
  {
    id: "workbench_item",
    name: "Workbench",
    station: "hand",
    inputs: [{ itemId: "planks", count: 4 }],
    outputs: [{ itemId: "workbench", count: 1 }],
    craftTime: 0,
    fuelCost: 0,
  },

  // --- Workbench recipes (craftTime: 5-10s) ---
  {
    id: "craft_bench_item",
    name: "Craft Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "craft_bench", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "tool_bench_item",
    name: "Tool Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "stone", count: 2 }],
    outputs: [{ itemId: "tool_bench", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "woodwork_bench_item",
    name: "Woodwork Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "stick", count: 1 }],
    outputs: [{ itemId: "woodwork_bench", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "campfire_item",
    name: "Campfire",
    station: "workbench",
    inputs: [{ itemId: "stone", count: 4 }, { itemId: "stick", count: 1 }],
    outputs: [{ itemId: "campfire", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "kiln_item",
    name: "Kiln",
    station: "workbench",
    inputs: [{ itemId: "stone", count: 6 }, { itemId: "clay", count: 2 }],
    outputs: [{ itemId: "kiln", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "furnace_item",
    name: "Furnace",
    station: "workbench",
    inputs: [{ itemId: "stone", count: 8 }, { itemId: "coal", count: 2 }],
    outputs: [{ itemId: "furnace", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "metalwork_bench_item",
    name: "Metalwork Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "stone", count: 4 }],
    outputs: [{ itemId: "metalwork_bench", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "builder_bench_item",
    name: "Builder's Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "stone", count: 2 }],
    outputs: [{ itemId: "builder_bench", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "tailor_bench_item",
    name: "Tailor's Bench",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "rope", count: 2 }],
    outputs: [{ itemId: "tailor_bench", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "compost_bin_item",
    name: "Compost Bin",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "dirt", count: 2 }],
    outputs: [{ itemId: "compost_bin", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },
  {
    id: "bed_item",
    name: "Bed",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 4 }, { itemId: "rope", count: 2 }],
    outputs: [{ itemId: "bed", count: 1 }],
    craftTime: 5,
    fuelCost: 0,
  },

  // --- Tool Bench recipes (craftTime: 8-15s) ---
  {
    id: "wood_pickaxe",
    name: "Wood Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "planks", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_pickaxe", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "wood_axe",
    name: "Wood Axe",
    station: "tool_bench",
    inputs: [{ itemId: "planks", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_axe", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "wood_shovel",
    name: "Wood Shovel",
    station: "tool_bench",
    inputs: [{ itemId: "planks", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_shovel", count: 1 }],
    craftTime: 8,
    fuelCost: 0,
  },
  {
    id: "stone_pickaxe",
    name: "Stone Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "stone", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "stone_pickaxe", count: 1 }],
    craftTime: 10,
    fuelCost: 0,
  },
  {
    id: "stone_axe",
    name: "Stone Axe",
    station: "tool_bench",
    inputs: [{ itemId: "stone", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "stone_axe", count: 1 }],
    craftTime: 10,
    fuelCost: 0,
  },
  {
    id: "stone_shovel",
    name: "Stone Shovel",
    station: "tool_bench",
    inputs: [{ itemId: "stone", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "stone_shovel", count: 1 }],
    craftTime: 10,
    fuelCost: 0,
  },
  {
    id: "copper_pickaxe",
    name: "Copper Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "copper_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "copper_pickaxe", count: 1 }],
    craftTime: 12,
    fuelCost: 0,
  },
  {
    id: "copper_axe",
    name: "Copper Axe",
    station: "tool_bench",
    inputs: [{ itemId: "copper_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "copper_axe", count: 1 }],
    craftTime: 12,
    fuelCost: 0,
  },
  {
    id: "tin_pickaxe",
    name: "Tin Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "tin_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "tin_pickaxe", count: 1 }],
    craftTime: 12,
    fuelCost: 0,
  },
  {
    id: "bronze_pickaxe",
    name: "Bronze Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "bronze_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "bronze_pickaxe", count: 1 }],
    craftTime: 15,
    fuelCost: 0,
  },
  {
    id: "bronze_axe",
    name: "Bronze Axe",
    station: "tool_bench",
    inputs: [{ itemId: "bronze_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "bronze_axe", count: 1 }],
    craftTime: 15,
    fuelCost: 0,
  },
  {
    id: "iron_pickaxe",
    name: "Iron Pickaxe",
    station: "tool_bench",
    inputs: [{ itemId: "iron_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "iron_pickaxe", count: 1 }],
    craftTime: 15,
    fuelCost: 0,
  },
  {
    id: "iron_axe",
    name: "Iron Axe",
    station: "tool_bench",
    inputs: [{ itemId: "iron_ingot", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "iron_axe", count: 1 }],
    craftTime: 15,
    fuelCost: 0,
  },

  // --- Campfire recipes (fueled, craftTime: 5-10s, fuelCost: 1) ---
  {
    id: "cooked_meat",
    name: "Cooked Meat",
    station: "campfire",
    inputs: [{ itemId: "raw_meat", count: 1 }],
    outputs: [{ itemId: "cooked_meat", count: 1 }],
    craftTime: 5,
    fuelCost: 1,
  },
  {
    id: "torch_pack",
    name: "Torch Pack",
    station: "campfire",
    inputs: [{ itemId: "coal", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "torch", count: 8 }],
    craftTime: 5,
    fuelCost: 1,
  },
  {
    id: "charcoal_from_wood",
    name: "Charcoal",
    station: "campfire",
    inputs: [{ itemId: "wood", count: 4 }],
    outputs: [{ itemId: "charcoal", count: 2 }],
    craftTime: 10,
    fuelCost: 1,
  },

  // --- Kiln recipes (fueled, craftTime: 10-20s, fuelCost: 1-2) ---
  {
    id: "charcoal_kiln",
    name: "Charcoal (Kiln)",
    station: "kiln",
    inputs: [{ itemId: "wood", count: 6 }],
    outputs: [{ itemId: "charcoal", count: 3 }],
    craftTime: 15,
    fuelCost: 1,
  },
  {
    id: "glass_kiln",
    name: "Glass (Kiln)",
    station: "kiln",
    inputs: [{ itemId: "sand", count: 2 }],
    outputs: [{ itemId: "glass", count: 1 }],
    craftTime: 12,
    fuelCost: 1,
  },

  // --- Furnace recipes (fueled, craftTime: 15-30s, fuelCost: 1-3) ---
  {
    id: "copper_ingot",
    name: "Copper Ingot",
    station: "furnace",
    inputs: [{ itemId: "copper_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "copper_ingot", count: 1 }],
    craftTime: 15,
    fuelCost: 1,
  },
  {
    id: "tin_ingot",
    name: "Tin Ingot",
    station: "furnace",
    inputs: [{ itemId: "tin_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "tin_ingot", count: 1 }],
    craftTime: 15,
    fuelCost: 1,
  },
  {
    id: "bronze_ingot",
    name: "Bronze Ingot",
    station: "furnace",
    inputs: [{ itemId: "copper_ingot", count: 1 }, { itemId: "tin_ingot", count: 1 }],
    outputs: [{ itemId: "bronze_ingot", count: 2 }],
    craftTime: 20,
    fuelCost: 2,
  },
  {
    id: "iron_ingot",
    name: "Iron Ingot",
    station: "furnace",
    inputs: [{ itemId: "iron_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "iron_ingot", count: 1 }],
    craftTime: 20,
    fuelCost: 2,
  },
  {
    id: "gold_ingot",
    name: "Gold Ingot",
    station: "furnace",
    inputs: [{ itemId: "gold_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "gold_ingot", count: 1 }],
    craftTime: 25,
    fuelCost: 2,
  },
  {
    id: "steel_ingot",
    name: "Steel Ingot",
    station: "furnace",
    inputs: [{ itemId: "iron_ingot", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "steel_ingot", count: 1 }],
    craftTime: 30,
    fuelCost: 3,
  },
];

const byId = new Map<string, RecipeDef>();
for (const def of DEFS) byId.set(def.id, def);

export function getRecipe(id: string): RecipeDef | undefined {
  return byId.get(id);
}

export function getAllRecipes(): RecipeDef[] {
  return DEFS;
}

/** Recipes craftable at a given station. */
export function recipesForStation(station: CraftStation): RecipeDef[] {
  return DEFS.filter((r) => r.station === station);
}
