export interface Recipe {
  id: string;
  name: string;
  tier: number;
  inputs: { itemId: string; quantity: number }[];
  output: { itemId: string; quantity: number };
  craftingTime: number;
  station?: string;
  needsFire?: boolean;
}

export const RECIPES: Recipe[] = [
  // Tier 0 — Basic
  { id: "wood_plank", name: "Wood Plank", tier: 0, inputs: [{ itemId: "wood", quantity: 1 }], output: { itemId: "planks", quantity: 2 }, craftingTime: 2 },
  { id: "rope", name: "Rope", tier: 0, inputs: [{ itemId: "cloth", quantity: 2 }], output: { itemId: "rope", quantity: 1 }, craftingTime: 3 },
  { id: "basic_rod", name: "Basic Rod", tier: 0, inputs: [{ itemId: "wood", quantity: 3 }, { itemId: "rope", quantity: 2 }], output: { itemId: "basic_rod", quantity: 1 }, craftingTime: 10 },
  { id: "cooked_fish", name: "Cooked Fish", tier: 0, inputs: [{ itemId: "raw_fish", quantity: 1 }], output: { itemId: "cooked_fish", quantity: 1 }, craftingTime: 5, needsFire: true },
  { id: "campfire", name: "Campfire", tier: 0, inputs: [{ itemId: "planks", quantity: 3 }], output: { itemId: "campfire", quantity: 1 }, craftingTime: 3 },
  { id: "sail", name: "Sail", tier: 0, inputs: [{ itemId: "planks", quantity: 5 }], output: { itemId: "sail", quantity: 1 }, craftingTime: 5 },
  { id: "raft_upgrade", name: "Raft Upgrade", tier: 0, inputs: [{ itemId: "planks", quantity: 8 }], output: { itemId: "raft_upgrade", quantity: 1 }, craftingTime: 8 },

  // Tier 1 — Intermediate
  { id: "storage_locker", name: "Storage Locker", tier: 1, inputs: [{ itemId: "wood", quantity: 10 }, { itemId: "metal_scrap", quantity: 5 }], output: { itemId: "storage_locker", quantity: 1 }, craftingTime: 15, station: "workbench_basic" },
  { id: "reinforced_rod", name: "Reinforced Rod", tier: 1, inputs: [{ itemId: "wood", quantity: 5 }, { itemId: "rope", quantity: 3 }, { itemId: "metal_scrap", quantity: 2 }], output: { itemId: "reinforced_rod", quantity: 1 }, craftingTime: 20, station: "workbench_basic" },
  { id: "bed_basic", name: "Basic Bed", tier: 1, inputs: [{ itemId: "wood", quantity: 8 }, { itemId: "cloth", quantity: 4 }], output: { itemId: "bed_basic", quantity: 1 }, craftingTime: 15, station: "workbench_basic" },
  { id: "rain_collector", name: "Rain Collector", tier: 1, inputs: [{ itemId: "wood", quantity: 5 }, { itemId: "plastic", quantity: 3 }], output: { itemId: "rain_collector", quantity: 1 }, craftingTime: 10, station: "workbench_basic" },
  { id: "workbench_basic", name: "Basic Workbench", tier: 1, inputs: [{ itemId: "wood", quantity: 15 }, { itemId: "metal_scrap", quantity: 8 }], output: { itemId: "workbench_basic", quantity: 1 }, craftingTime: 20 },

  // Tier 2 — Advanced
  { id: "professional_rod", name: "Professional Rod", tier: 2, inputs: [{ itemId: "metal_scrap", quantity: 10 }, { itemId: "fishing_line", quantity: 5 }], output: { itemId: "professional_rod", quantity: 1 }, craftingTime: 30, station: "workbench_basic" },
  { id: "steel_plate", name: "Steel Plate", tier: 2, inputs: [{ itemId: "metal_scrap", quantity: 5 }], output: { itemId: "steel_plate", quantity: 1 }, craftingTime: 10, station: "workbench_basic" },
  { id: "engine_part", name: "Engine Part", tier: 2, inputs: [{ itemId: "steel_plate", quantity: 5 }, { itemId: "circuit_board", quantity: 1 }], output: { itemId: "engine_part", quantity: 1 }, craftingTime: 60, station: "workbench_basic" },

  // Tier 3 — Expert
  { id: "master_rod", name: "Master Rod", tier: 3, inputs: [{ itemId: "steel_plate", quantity: 5 }, { itemId: "rare_reel", quantity: 1 }], output: { itemId: "master_rod", quantity: 1 }, craftingTime: 60, station: "workbench_basic" },
  { id: "circuit_board", name: "Circuit Board", tier: 3, inputs: [{ itemId: "plastic", quantity: 10 }, { itemId: "metal_scrap", quantity: 5 }], output: { itemId: "circuit_board", quantity: 1 }, craftingTime: 30, station: "workbench_basic" },

  // Tier 4 — Master
  { id: "legendary_rod", name: "Legendary Rod", tier: 4, inputs: [{ itemId: "abyssal_pearl", quantity: 1 }, { itemId: "legendary_reel", quantity: 1 }], output: { itemId: "legendary_rod", quantity: 1 }, craftingTime: 120, station: "workbench_basic" },
  { id: "advanced_circuit", name: "Advanced Circuit", tier: 4, inputs: [{ itemId: "circuit_board", quantity: 5 }, { itemId: "obsidian", quantity: 2 }], output: { itemId: "advanced_circuit", quantity: 1 }, craftingTime: 60, station: "workbench_basic" },

  // Boat parts
  { id: "boat_hull", name: "Boat Hull", tier: 0, inputs: [{ itemId: "wood", quantity: 3 }], output: { itemId: "boat_hull", quantity: 1 }, craftingTime: 3 },
  { id: "boat_bow", name: "Boat Bow", tier: 0, inputs: [{ itemId: "wood", quantity: 4 }], output: { itemId: "boat_bow", quantity: 1 }, craftingTime: 4 },
  { id: "boat_wall", name: "Boat Wall", tier: 0, inputs: [{ itemId: "wood", quantity: 2 }], output: { itemId: "boat_wall", quantity: 1 }, craftingTime: 2 },
  { id: "boat_cabin", name: "Boat Cabin", tier: 1, inputs: [{ itemId: "wood", quantity: 6 }, { itemId: "cloth", quantity: 2 }], output: { itemId: "boat_cabin", quantity: 1 }, craftingTime: 8 },
  { id: "boat_mast", name: "Boat Mast", tier: 1, inputs: [{ itemId: "wood", quantity: 5 }, { itemId: "rope", quantity: 2 }], output: { itemId: "boat_mast", quantity: 1 }, craftingTime: 6 },
  { id: "boat_deck", name: "Boat Deck", tier: 0, inputs: [{ itemId: "wood", quantity: 2 }], output: { itemId: "boat_deck", quantity: 1 }, craftingTime: 2 },
  { id: "boat_rail", name: "Boat Rail", tier: 0, inputs: [{ itemId: "wood", quantity: 1 }], output: { itemId: "boat_rail", quantity: 1 }, craftingTime: 1 },
];

export function getRecipe(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}

export function getRecipesByTier(tier: number): Recipe[] {
  return RECIPES.filter((r) => r.tier === tier);
}

export function getRecipesForTierUpTo(maxTier: number): Recipe[] {
  return RECIPES.filter((r) => r.tier <= maxTier);
}

export const CRAFTING_TIER_RECIPES: string[][] = [
  ["wood_plank", "rope", "basic_rod", "cooked_fish", "campfire", "sail", "raft_upgrade"],
  ["storage_locker", "reinforced_rod", "bed_basic", "rain_collector", "workbench_basic", "boat_cabin", "boat_mast"],
  ["professional_rod", "steel_plate", "engine_part"],
  ["master_rod", "circuit_board"],
  ["legendary_rod", "advanced_circuit"],
];
