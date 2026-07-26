export enum ItemCategory {
  Fish = "fish",
  Junk = "junk",
  Material = "material",
  Equipment = "equipment",
  Placeable = "placeable",
  Consumable = "consumable",
  Cosmetic = "cosmetic",
  Tool = "tool",
  Weapon = "weapon",
  Armor = "armor",
  Seed = "seed",
  Bait = "bait",
  Treasure = "treasure",
}

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  width: number;
  height: number;
  maxStack: number;
  value: number;
  rarity: number;
  spoilRate?: number;
  icon?: string;
  description?: string;
  biomeRestriction?: number[];
  cosmetic?: boolean;
  gag?: boolean;
}

export const ITEMS: Record<string, ItemDef> = {
  // --- Fish ---
  mackerel: { id: "mackerel", name: "Mackerel", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 5, rarity: 0, spoilRate: 0.017 },
  tuna: { id: "tuna", name: "Tuna", category: ItemCategory.Fish, width: 3, height: 2, maxStack: 5, value: 20, rarity: 1, spoilRate: 0.013 },
  cod: { id: "cod", name: "Cod", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 8, rarity: 0, spoilRate: 0.017 },
  bass: { id: "bass", name: "Bass", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 10, rarity: 1, spoilRate: 0.013 },
  swordfish: { id: "swordfish", name: "Swordfish", category: ItemCategory.Fish, width: 4, height: 2, maxStack: 3, value: 50, rarity: 2, spoilRate: 0.01 },
  marlin: { id: "marlin", name: "Marlin", category: ItemCategory.Fish, width: 4, height: 2, maxStack: 3, value: 60, rarity: 3, spoilRate: 0.01 },
  anglerfish: { id: "anglerfish", name: "Anglerfish", category: ItemCategory.Fish, width: 2, height: 2, maxStack: 5, value: 40, rarity: 3, spoilRate: 0.007 },
  gulper_eel: { id: "gulper_eel", name: "Gulper Eel", category: ItemCategory.Fish, width: 2, height: 3, maxStack: 5, value: 35, rarity: 3, spoilRate: 0.007 },
  parrotfish: { id: "parrotfish", name: "Parrotfish", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 15, rarity: 1, spoilRate: 0.013 },
  barracuda: { id: "barracuda", name: "Barracuda", category: ItemCategory.Fish, width: 3, height: 1, maxStack: 5, value: 25, rarity: 2, spoilRate: 0.01 },
  mahi_mahi: { id: "mahi_mahi", name: "Mahi Mahi", category: ItemCategory.Fish, width: 3, height: 2, maxStack: 5, value: 30, rarity: 2, spoilRate: 0.01 },
  arctic_char: { id: "arctic_char", name: "Arctic Char", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 18, rarity: 1, spoilRate: 0.01 },
  halibut: { id: "halibut", name: "Halibut", category: ItemCategory.Fish, width: 3, height: 2, maxStack: 5, value: 22, rarity: 1, spoilRate: 0.01 },
  clownfish: { id: "clownfish", name: "Clownfish", category: ItemCategory.Fish, width: 1, height: 1, maxStack: 20, value: 12, rarity: 1, spoilRate: 0.013 },
  lava_eel: { id: "lava_eel", name: "Lava Eel", category: ItemCategory.Fish, width: 2, height: 3, maxStack: 5, value: 80, rarity: 4, spoilRate: 0.003 },
  obsidian_fish: { id: "obsidian_fish", name: "Obsidian Fish", category: ItemCategory.Fish, width: 2, height: 2, maxStack: 5, value: 100, rarity: 4, spoilRate: 0.003 },
  mutant_fish: { id: "mutant_fish", name: "Mutant Fish", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 15, rarity: 2, spoilRate: 0.02 },
  common_fish: { id: "common_fish", name: "Common Fish", category: ItemCategory.Fish, width: 2, height: 1, maxStack: 10, value: 5, rarity: 0, spoilRate: 0.017 },
  small_fish: { id: "small_fish", name: "Small Fish", category: ItemCategory.Fish, width: 1, height: 1, maxStack: 20, value: 3, rarity: 0, spoilRate: 0.017 },

  // --- Junk ---
  discarded_net: { id: "discarded_net", name: "Discarded Net", category: ItemCategory.Junk, width: 2, height: 2, maxStack: 5, value: 2, rarity: 0 },
  broken_rod: { id: "broken_rod", name: "Broken Rod", category: ItemCategory.Junk, width: 1, height: 3, maxStack: 5, value: 1, rarity: 0 },
  old_boot: { id: "old_boot", name: "Old Boot", category: ItemCategory.Junk, width: 1, height: 1, maxStack: 10, value: 1, rarity: 0 },
  bait_scraps: { id: "bait_scraps", name: "Bait Scraps", category: ItemCategory.Bait, width: 1, height: 1, maxStack: 50, value: 1, rarity: 0 },
  dvd: { id: "dvd", name: "DVD", category: ItemCategory.Junk, width: 1, height: 1, maxStack: 10, value: 30, rarity: 4, description: "A rare find. Just sells for money.", gag: true },
  rubber_duck: { id: "rubber_duck", name: "Rubber Duck", category: ItemCategory.Junk, width: 1, height: 1, maxStack: 10, value: 50, rarity: 4, gag: true },
  vhs_tape: { id: "vhs_tape", name: "VHS Tape", category: ItemCategory.Junk, width: 1, height: 1, maxStack: 10, value: 40, rarity: 4, gag: true },
  vinyl_record: { id: "vinyl_record", name: "Vinyl Record", category: ItemCategory.Junk, width: 1, height: 1, maxStack: 10, value: 45, rarity: 4, gag: true },
  old_radio: { id: "old_radio", name: "Old Radio", category: ItemCategory.Junk, width: 2, height: 2, maxStack: 5, value: 55, rarity: 4, gag: true },
  scrap_metal: { id: "scrap_metal", name: "Scrap Metal", category: ItemCategory.Material, width: 1, height: 1, maxStack: 100, value: 5, rarity: 0 },
  plastic: { id: "plastic", name: "Plastic", category: ItemCategory.Material, width: 1, height: 1, maxStack: 100, value: 2, rarity: 0 },

  // --- Materials ---
  wood: { id: "wood", name: "Wood", category: ItemCategory.Material, width: 1, height: 2, maxStack: 100, value: 3, rarity: 0 },
  tropical_wood: { id: "tropical_wood", name: "Tropical Wood", category: ItemCategory.Material, width: 1, height: 2, maxStack: 100, value: 8, rarity: 1 },
  rope: { id: "rope", name: "Rope", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 5, rarity: 0 },
  cloth: { id: "cloth", name: "Cloth", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 6, rarity: 0 },
  metal_scrap: { id: "metal_scrap", name: "Metal Scrap", category: ItemCategory.Material, width: 1, height: 1, maxStack: 100, value: 5, rarity: 0 },
  steel_plate: { id: "steel_plate", name: "Steel Plate", category: ItemCategory.Material, width: 2, height: 2, maxStack: 50, value: 20, rarity: 2 },
  engine_part: { id: "engine_part", name: "Engine Part", category: ItemCategory.Material, width: 2, height: 2, maxStack: 20, value: 50, rarity: 3 },
  circuit_board: { id: "circuit_board", name: "Circuit Board", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 30, rarity: 3 },
  advanced_circuit: { id: "advanced_circuit", name: "Advanced Circuit", category: ItemCategory.Material, width: 1, height: 1, maxStack: 20, value: 100, rarity: 4 },
  obsidian: { id: "obsidian", name: "Obsidian", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 40, rarity: 3 },
  hellstone: { id: "hellstone", name: "Hellstone", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 80, rarity: 4 },
  ice_crystal: { id: "ice_crystal", name: "Ice Crystal", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 25, rarity: 2 },
  coral_fragment: { id: "coral_fragment", name: "Coral Fragment", category: ItemCategory.Material, width: 1, height: 1, maxStack: 50, value: 15, rarity: 1 },
  kelp: { id: "kelp", name: "Kelp", category: ItemCategory.Material, width: 1, height: 2, maxStack: 50, value: 5, rarity: 0 },
  fishing_line: { id: "fishing_line", name: "Fishing Line", category: ItemCategory.Material, width: 1, height: 1, maxStack: 20, value: 10, rarity: 0 },

  // --- Treasure ---
  pearl: { id: "pearl", name: "Pearl", category: ItemCategory.Treasure, width: 1, height: 1, maxStack: 20, value: 100, rarity: 3 },
  abyssal_pearl: { id: "abyssal_pearl", name: "Abyssal Pearl", category: ItemCategory.Treasure, width: 1, height: 1, maxStack: 10, value: 500, rarity: 5 },
  treasure_map: { id: "treasure_map", name: "Treasure Map", category: ItemCategory.Treasure, width: 1, height: 1, maxStack: 5, value: 200, rarity: 4 },
  rare_junk: { id: "rare_junk", name: "Rare Junk", category: ItemCategory.Treasure, width: 1, height: 1, maxStack: 10, value: 75, rarity: 3 },
  rare_reel: { id: "rare_reel", name: "Rare Reel", category: ItemCategory.Material, width: 1, height: 1, maxStack: 5, value: 200, rarity: 3 },
  legendary_reel: { id: "legendary_reel", name: "Legendary Reel", category: ItemCategory.Material, width: 1, height: 1, maxStack: 1, value: 1000, rarity: 5 },

  // --- Equipment ---
  basic_rod: { id: "basic_rod", name: "Basic Rod", category: ItemCategory.Equipment, width: 1, height: 3, maxStack: 1, value: 50, rarity: 0 },
  reinforced_rod: { id: "reinforced_rod", name: "Reinforced Rod", category: ItemCategory.Equipment, width: 1, height: 3, maxStack: 1, value: 150, rarity: 1 },
  professional_rod: { id: "professional_rod", name: "Professional Rod", category: ItemCategory.Equipment, width: 1, height: 3, maxStack: 1, value: 400, rarity: 2 },
  master_rod: { id: "master_rod", name: "Master Rod", category: ItemCategory.Equipment, width: 1, height: 3, maxStack: 1, value: 1000, rarity: 3 },
  legendary_rod: { id: "legendary_rod", name: "Legendary Rod", category: ItemCategory.Equipment, width: 1, height: 3, maxStack: 1, value: 5000, rarity: 5 },

  // --- Consumables ---
  cooked_fish: { id: "cooked_fish", name: "Cooked Fish", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 20, value: 10, rarity: 0, description: "Restores 30 hunger" },
  raw_fish: { id: "raw_fish", name: "Raw Fish", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 20, value: 3, rarity: 0, spoilRate: 0.017, description: "Restores 10 hunger. Better cooked." },
  coconut: { id: "coconut", name: "Coconut", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 20, value: 5, rarity: 0, description: "Restores 15 hunger, 20 thirst" },
  fresh_water: { id: "fresh_water", name: "Fresh Water", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 20, value: 5, rarity: 0, description: "Restores 30 thirst" },
  blubber: { id: "blubber", name: "Blubber", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 10, value: 15, rarity: 1, description: "Restores 40 hunger. Very fatty." },
  food: { id: "food", name: "Food", category: ItemCategory.Consumable, width: 1, height: 1, maxStack: 20, value: 4, rarity: 0, spoilRate: 0.02, description: "Restores 25 hunger" },

  // --- Seeds ---
  tomato_seed: { id: "tomato_seed", name: "Tomato Seed", category: ItemCategory.Seed, width: 1, height: 1, maxStack: 50, value: 5, rarity: 0 },
  kelp_seed: { id: "kelp_seed", name: "Kelp Seed", category: ItemCategory.Seed, width: 1, height: 1, maxStack: 50, value: 8, rarity: 1 },
  rice_seed: { id: "rice_seed", name: "Rice Seed", category: ItemCategory.Seed, width: 1, height: 1, maxStack: 50, value: 5, rarity: 0 },

  // --- Placeables ---
  bed_basic: { id: "bed_basic", name: "Basic Bed", category: ItemCategory.Placeable, width: 2, height: 2, maxStack: 5, value: 30, rarity: 0 },
  storage_locker: { id: "storage_locker", name: "Storage Locker", category: ItemCategory.Placeable, width: 2, height: 2, maxStack: 5, value: 50, rarity: 0 },
  rain_collector: { id: "rain_collector", name: "Rain Collector", category: ItemCategory.Placeable, width: 1, height: 1, maxStack: 5, value: 40, rarity: 0 },
  workbench_basic: { id: "workbench_basic", name: "Basic Workbench", category: ItemCategory.Placeable, width: 2, height: 2, maxStack: 1, value: 80, rarity: 0 },
  campfire: { id: "campfire", name: "Campfire", category: ItemCategory.Placeable, width: 1, height: 1, maxStack: 5, value: 20, rarity: 0 },
  sail: { id: "sail", name: "Sail", category: ItemCategory.Placeable, width: 2, height: 2, maxStack: 5, value: 40, rarity: 0 },
  raft_upgrade: { id: "raft_upgrade", name: "Raft Upgrade", category: ItemCategory.Placeable, width: 1, height: 1, maxStack: 5, value: 60, rarity: 0 },
  planks: { id: "planks", name: "Planks", category: ItemCategory.Material, width: 1, height: 1, maxStack: 100, value: 6, rarity: 0 },
  coin: { id: "coin", name: "Coin", category: ItemCategory.Treasure, width: 1, height: 1, maxStack: 9999, value: 1, rarity: 0 },

  // --- Boat Parts ---
  boat_hull: { id: "boat_hull", name: "Boat Hull", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 10, rarity: 0 },
  boat_bow: { id: "boat_bow", name: "Boat Bow", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 15, rarity: 0 },
  boat_wall: { id: "boat_wall", name: "Boat Wall", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 8, rarity: 0 },
  boat_cabin: { id: "boat_cabin", name: "Boat Cabin", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 25, rarity: 1 },
  boat_mast: { id: "boat_mast", name: "Boat Mast", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 20, rarity: 1 },
  boat_deck: { id: "boat_deck", name: "Boat Deck", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 8, rarity: 0 },
  boat_rail: { id: "boat_rail", name: "Boat Rail", category: ItemCategory.Material, width: 1, height: 1, maxStack: 99, value: 5, rarity: 0 },
};

export function getItem(id: string): ItemDef | null {
  return ITEMS[id] ?? null;
}

export function getItemsByCategory(category: ItemCategory): ItemDef[] {
  return Object.values(ITEMS).filter((item) => item.category === category);
}
