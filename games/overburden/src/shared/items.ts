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
  BLOCK_CLAY,
  BLOCK_DIRT,
  BLOCK_GRAVEL,
  BLOCK_GRASS,
  BLOCK_LADDER,
  BLOCK_ROPE,
  BLOCK_SAND,
  BLOCK_SCAFFOLDING,
  BLOCK_STONE,
  BLOCK_TORCH,
  BLOCK_WOOD,
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

  // --- Material items (crafting intermediates, not placeable) ---
  { id: "stick", name: "Stick", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "planks", name: "Planks", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "coal", name: "Coal", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "copper_ore", name: "Copper Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "tin_ore", name: "Tin Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "iron_ore", name: "Iron Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "gold_ore", name: "Gold Ore", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "copper_ingot", name: "Copper Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "tin_ingot", name: "Tin Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "bronze_ingot", name: "Bronze Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "iron_ingot", name: "Iron Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "gold_ingot", name: "Gold Ingot", category: "material", placeBlock: 0, maxStack: 64 },
  { id: "time_crystal", name: "Time Crystal", category: "material", placeBlock: 0, maxStack: 16 },

  // --- Tools ---
  { id: "wood_pickaxe", name: "Wood Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 1.5, required: true } },
  { id: "stone_pickaxe", name: "Stone Pickaxe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "pickaxe", speed: 2.5, required: true } },
  { id: "wood_axe", name: "Wood Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 1.5, required: false } },
  { id: "stone_axe", name: "Stone Axe", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "axe", speed: 2.5, required: false } },
  { id: "wood_shovel", name: "Wood Shovel", category: "tool", placeBlock: 0, maxStack: 1, tool: { type: "shovel", speed: 1.5, required: false } },

  // --- Food ---
  { id: "apple", name: "Apple", category: "food", placeBlock: 0, maxStack: 16 },
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
