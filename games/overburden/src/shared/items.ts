// ============================================================================
// Overburden — item registry
//
// Items are inventory entries. Some items correspond to placeable blocks
// (dirt, stone, wood, ...); others are crafting-only intermediates or tools
// (stick, planks, ingots, pickaxe, ...).
//
// The block registry defines what each block drops (BlockDef.drops). This
// file defines the items themselves + which block (if any) an item places.
// ============================================================================

import {
    BLOCK_BED,
    BLOCK_BUILDER_BENCH,
    BLOCK_CAMPFIRE,
    BLOCK_CLAY,
    BLOCK_COMPOST_BIN,
    BLOCK_CRAFT_BENCH,
    BLOCK_DIRT,
    BLOCK_FURNACE,
    BLOCK_GRASS,
    BLOCK_GRAVEL,
    BLOCK_KILN,
    BLOCK_LADDER,
    BLOCK_METALWORK_BENCH,
    BLOCK_ROPE,
    BLOCK_SAND,
    BLOCK_SCAFFOLDING,
    BLOCK_STONE,
    BLOCK_TAILOR_BENCH,
    BLOCK_TOOL_BENCH,
    BLOCK_TORCH,
    BLOCK_TRELLIS,
    BLOCK_VINE_GRAPE,
    BLOCK_VINE_KIWI,
    BLOCK_WOOD,
    BLOCK_WOODWORK_BENCH,
    BLOCK_WORKBENCH
} from "./constants";

export type ItemCategory = "block" | "material" | "tool" | "food";

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  /** Block ID to place when this item is used. 0 = not placeable. */
  placeBlock: number;
  /** Max stack size in one inventory slot. */
  maxStack: number;
  /** Optional tool properties. */
  tool?: {
    type: "pickaxe" | "axe" | "shovel" | "sword";
    /** Mining speed multiplier (1 = normal). */
    speed: number;
    /** Whether this tool can mine blocks that require a tool (e.g. stone needs a pickaxe). */
    required: boolean;
  };
  /** Food: hunger restored when eaten. 0 for non-food items. */
  hungerRestore?: number;
}

const DEFS: ItemDef[] = [
  // --- Block items (placeable) ---
  { id: "dirt", name: "Dirt", category: "block", placeBlock: BLOCK_DIRT, maxStack: 64 },
  { id: "grass", name: "Grass", category: "block", placeBlock: BLOCK_GRASS, maxStack: 64 },
  { id: "stone", name: "Stone", category: "block", placeBlock: BLOCK_STONE, maxStack: 64 },
  { id: "sand", name: "Sand", category: "block", placeBlock: BLOCK_SAND, maxStack: 64 },
  { id: "wood", name: "Wood", category: "block", placeBlock: BLOCK_WOOD, maxStack: 64 },
  { id: "clay", name: "Clay", category: "block", placeBlock: BLOCK_CLAY, maxStack: 64 },
  { id: "gravel", name: "Gravel", category: "block", placeBlock: BLOCK_GRAVEL, maxStack: 64 },
  { id: "ladder", name: "Ladder", category: "block", placeBlock: BLOCK_LADDER, maxStack: 64 },
  { id: "rope", name: "Rope", category: "block", placeBlock: BLOCK_ROPE, maxStack: 64 },
  { id: "scaffolding", name: "Scaffolding", category: "block", placeBlock: BLOCK_SCAFFOLDING, maxStack: 64 },
  { id: "torch", name: "Torch", category: "block", placeBlock: BLOCK_TORCH, maxStack: 64 },
  { id: "trellis", name: "Trellis", category: "block", placeBlock: BLOCK_TRELLIS, maxStack: 64 },
  { id: "vine_kiwi", name: "Kiwi Vine", category: "block", placeBlock: BLOCK_VINE_KIWI, maxStack: 64 },
  { id: "vine_grape", name: "Grape Vine", category: "block", placeBlock: BLOCK_VINE_GRAPE, maxStack: 64 },

  // --- Station items (placeable, maxStack 1) ---
  { id: "workbench", name: "Workbench", category: "block", placeBlock: BLOCK_WORKBENCH, maxStack: 1 },
  { id: "craft_bench", name: "Craft Bench", category: "block", placeBlock: BLOCK_CRAFT_BENCH, maxStack: 1 },
  { id: "tool_bench", name: "Tool Bench", category: "block", placeBlock: BLOCK_TOOL_BENCH, maxStack: 1 },
  { id: "woodwork_bench", name: "Woodwork Bench", category: "block", placeBlock: BLOCK_WOODWORK_BENCH, maxStack: 1 },
  { id: "campfire", name: "Campfire", category: "block", placeBlock: BLOCK_CAMPFIRE, maxStack: 1 },
  { id: "kiln", name: "Kiln", category: "block", placeBlock: BLOCK_KILN, maxStack: 1 },
  { id: "furnace", name: "Furnace", category: "block", placeBlock: BLOCK_FURNACE, maxStack: 1 },
  { id: "metalwork_bench", name: "Metalwork Bench", category: "block", placeBlock: BLOCK_METALWORK_BENCH, maxStack: 1 },
  { id: "builder_bench", name: "Builder's Bench", category: "block", placeBlock: BLOCK_BUILDER_BENCH, maxStack: 1 },
  { id: "tailor_bench", name: "Tailor's Bench", category: "block", placeBlock: BLOCK_TAILOR_BENCH, maxStack: 1 },
  { id: "compost_bin", name: "Compost Bin", category: "block", placeBlock: BLOCK_COMPOST_BIN, maxStack: 1 },
  { id: "bed", name: "Bed", category: "block", placeBlock: BLOCK_BED, maxStack: 1 },

  // --- Material items (crafting intermediates, not placeable) ---
  { id: "stick", name: "Stick", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "planks", name: "Planks", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "coal", name: "Coal", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "flint", name: "Flint", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "charcoal", name: "Charcoal", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "copper_ore", name: "Copper Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "tin_ore", name: "Tin Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "iron_ore", name: "Iron Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "gold_ore", name: "Gold Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "copper_ingot", name: "Copper Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "tin_ingot", name: "Tin Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "bronze_ingot", name: "Bronze Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "iron_ingot", name: "Iron Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "gold_ingot", name: "Gold Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "steel_ingot", name: "Steel Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "crystal", name: "Crystal", category: "material", placeBlock: 0, maxStack: 16 },

  // --- Tools ---
  { id: "flint_pickaxe", name: "Flint Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 1.0, required: true } },
  { id: "flint_axe", name: "Flint Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 1.0, required: false } },
  { id: "flint_shovel", name: "Flint Shovel", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "shovel", speed: 1.0, required: false } },
  { id: "wood_pickaxe", name: "Wood Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 1.5, required: true } },
  { id: "wood_axe", name: "Wood Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 1.5, required: false } },
  { id: "wood_shovel", name: "Wood Shovel", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "shovel", speed: 1.5, required: false } },
  { id: "stone_pickaxe", name: "Stone Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 2.5, required: true } },
  { id: "stone_axe", name: "Stone Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 2.5, required: false } },
  { id: "stone_shovel", name: "Stone Shovel", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "shovel", speed: 2.5, required: false } },
  { id: "copper_pickaxe", name: "Copper Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 3.0, required: true } },
  { id: "copper_axe", name: "Copper Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 3.0, required: false } },
  { id: "tin_pickaxe", name: "Tin Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 3.5, required: true } },
  { id: "bronze_pickaxe", name: "Bronze Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 4.0, required: true } },
  { id: "bronze_axe", name: "Bronze Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 4.0, required: false } },
  { id: "iron_pickaxe", name: "Iron Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 5.0, required: true } },
  { id: "iron_axe", name: "Iron Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 5.0, required: false } },

  // --- Food ---
  { id: "apple", name: "Apple", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 10 },
  { id: "coconut", name: "Coconut", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 12 },
  { id: "orange", name: "Orange", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 10 },
  { id: "lemon", name: "Lemon", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 8 },
  { id: "lime", name: "Lime", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 8 },
  { id: "banana", name: "Banana", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 12 },
  { id: "pear", name: "Pear", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 10 },
  { id: "cherry", name: "Cherry", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 6 },
  { id: "pomegranate", name: "Pomegranate", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 14 },
  { id: "walnut", name: "Walnut", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 8 },
  { id: "hazelnut", name: "Hazelnut", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 8 },
  { id: "kiwi", name: "Kiwi", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 10 },
  { id: "grape", name: "Grape", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 8 },
  { id: "raw_meat", name: "Raw Meat", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 5 },
  { id: "cooked_meat", name: "Cooked Meat", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 25 },
  { id: "bread", name: "Bread", category: "food", placeBlock: 0, maxStack: 16, hungerRestore: 20 },
];

const byId = new Map<string, ItemDef>();
for (const def of DEFS) byId.set(def.id, def);

export function getItemDef(id: string): ItemDef | undefined {
  return byId.get(id);
}

export function getAllItems(): ItemDef[] {
  return DEFS;
}

/** Returns the item ID that places the given block, or undefined if no item places it. */
const blockToItem = new Map<number, string>();
for (const def of DEFS) {
  if (def.placeBlock > 0) blockToItem.set(def.placeBlock, def.id);
}

export function getItemForBlock(blockId: number): string | undefined {
  return blockToItem.get(blockId);
}
