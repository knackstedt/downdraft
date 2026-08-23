// ============================================================================
// Overburden — crafting recipe registry
//
// Recipes define inputs (ingredient item IDs + counts) and outputs.
// A recipe may require a nearby crafting surface (workbench block).
// For now, "hand" recipes (no station) and "workbench" recipes are supported.
// ============================================================================

export type CraftStation = "hand" | "workbench" | "furnace";

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
}

const DEFS: RecipeDef[] = [
  // --- Hand recipes (no station) ---
  {
    id: "planks_from_wood",
    name: "Planks",
    station: "hand",
    inputs: [{ itemId: "wood", count: 1 }],
    outputs: [{ itemId: "planks", count: 4 }],
  },
  {
    id: "sticks_from_planks",
    name: "Sticks",
    station: "hand",
    inputs: [{ itemId: "planks", count: 2 }],
    outputs: [{ itemId: "stick", count: 4 }],
  },
  {
    id: "torch_from_coal_stick",
    name: "Torch",
    station: "hand",
    inputs: [{ itemId: "coal", count: 1 }, { itemId: "stick", count: 1 }],
    outputs: [{ itemId: "torch", count: 4 }],
  },
  {
    id: "ladder_from_planks",
    name: "Ladder",
    station: "hand",
    inputs: [{ itemId: "planks", count: 4 }],
    outputs: [{ itemId: "ladder", count: 2 }],
  },
  {
    id: "rope_from_planks",
    name: "Rope",
    station: "hand",
    inputs: [{ itemId: "planks", count: 2 }],
    outputs: [{ itemId: "rope", count: 1 }],
  },
  {
    id: "scaffolding_from_planks",
    name: "Scaffolding",
    station: "hand",
    inputs: [{ itemId: "planks", count: 3 }],
    outputs: [{ itemId: "scaffolding", count: 2 }],
  },

  // --- Workbench recipes ---
  {
    id: "wood_pickaxe",
    name: "Wood Pickaxe",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_pickaxe", count: 1 }],
  },
  {
    id: "wood_axe",
    name: "Wood Axe",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_axe", count: 1 }],
  },
  {
    id: "wood_shovel",
    name: "Wood Shovel",
    station: "workbench",
    inputs: [{ itemId: "planks", count: 1 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "wood_shovel", count: 1 }],
  },
  {
    id: "stone_pickaxe",
    name: "Stone Pickaxe",
    station: "workbench",
    inputs: [{ itemId: "stone", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "stone_pickaxe", count: 1 }],
  },
  {
    id: "stone_axe",
    name: "Stone Axe",
    station: "workbench",
    inputs: [{ itemId: "stone", count: 3 }, { itemId: "stick", count: 2 }],
    outputs: [{ itemId: "stone_axe", count: 1 }],
  },

  // --- Furnace recipes (smelting) ---
  {
    id: "copper_ingot",
    name: "Copper Ingot",
    station: "furnace",
    inputs: [{ itemId: "copper_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "copper_ingot", count: 1 }],
  },
  {
    id: "tin_ingot",
    name: "Tin Ingot",
    station: "furnace",
    inputs: [{ itemId: "tin_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "tin_ingot", count: 1 }],
  },
  {
    id: "bronze_ingot",
    name: "Bronze Ingot",
    station: "furnace",
    inputs: [{ itemId: "copper_ingot", count: 1 }, { itemId: "tin_ingot", count: 1 }],
    outputs: [{ itemId: "bronze_ingot", count: 2 }],
  },
  {
    id: "iron_ingot",
    name: "Iron Ingot",
    station: "furnace",
    inputs: [{ itemId: "iron_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "iron_ingot", count: 1 }],
  },
  {
    id: "gold_ingot",
    name: "Gold Ingot",
    station: "furnace",
    inputs: [{ itemId: "gold_ore", count: 1 }, { itemId: "coal", count: 1 }],
    outputs: [{ itemId: "gold_ingot", count: 1 }],
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
