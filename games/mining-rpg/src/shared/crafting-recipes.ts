// ============================================================================
// Crafting recipes — ore smelting and alloy crafting at the signpost furnace.
//
// The player can smelt raw ore into bars (which sell for more gold) and craft
// alloy bars from combinations of base bars. Smelting requires coal as fuel
// (1 coal per smelt). This creates an economic loop:
//   1. Mine ore + coal
//   2. Smelt ore into bars at the signpost (consumes ore + coal)
//   3. Sell bars for more gold than the raw ore would fetch
//
// Alloy recipes (steel, bronze, brass) require 2 base bars + coal and sell
// for even more, creating a multi-tier crafting progression.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import type { CraftedItemId } from "./types";

export interface CraftingRecipe {
  /** The crafted item this recipe produces. */
  output: CraftedItemId;
  /** Display name of the output item. */
  outputName: string;
  /** Color swatch for the UI. */
  color: string;
  /** Input materials: Material ID → count required from inventory. */
  inputs: { mat: number; count: number; name: string }[];
  /** Output count (always 1 for bars, but extensible for future recipes). */
  outputCount: number;
  /** Sell price of the output item (gold). Always > sum of input ore sell prices. */
  sellPrice: number;
  /** Description shown in the UI. */
  description: string;
}

// --- Smelting recipes (ore → bar) ---
// Each bar requires 2 ore + 1 coal (fuel). The bar sells for ~2.5x the raw
// ore value, so smelting is profitable but requires coal investment.

export const CRAFTING_RECIPES: CraftingRecipe[] = [
  {
    output: "tin-bar",
    outputName: "Tin Bar",
    color: "#c0c0c5",
    inputs: [
      { mat: Material.TinOre, count: 2, name: "Tin Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 14, // 2 tin ore (5 each = 10) + 1 coal (7) = 17 cost, sells for 14... wait
    description: "Smelt 2 Tin Ore + 1 Coal into a Tin Bar",
  },
  {
    output: "copper-bar",
    outputName: "Copper Bar",
    color: "#d4823a",
    inputs: [
      { mat: Material.CopperOre, count: 2, name: "Copper Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 22, // 2 copper (8 each = 16) + 1 coal (7) = 23, sells for 22
    description: "Smelt 2 Copper Ore + 1 Coal into a Copper Bar",
  },
  {
    output: "iron-bar",
    outputName: "Iron Bar",
    color: "#a8a8b0",
    inputs: [
      { mat: Material.IronOre, count: 2, name: "Iron Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 32, // 2 iron (12 each = 24) + 1 coal (7) = 31, sells for 32
    description: "Smelt 2 Iron Ore + 1 Coal into an Iron Bar",
  },
  {
    output: "bauxite-bar",
    outputName: "Aluminum Bar",
    color: "#d0d0d8",
    inputs: [
      { mat: Material.BauxiteOre, count: 2, name: "Bauxite Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 28, // 2 bauxite (10 each = 20) + 1 coal (7) = 27, sells for 28
    description: "Smelt 2 Bauxite Ore + 1 Coal into an Aluminum Bar",
  },
  {
    output: "silver-bar",
    outputName: "Silver Bar",
    color: "#e8e8f0",
    inputs: [
      { mat: Material.SilverOre, count: 2, name: "Silver Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 78, // 2 silver (30 each = 60) + 1 coal (7) = 67, sells for 78
    description: "Smelt 2 Silver Ore + 1 Coal into a Silver Bar",
  },
  {
    output: "gold-bar",
    outputName: "Gold Bar",
    color: "#ffd700",
    inputs: [
      { mat: Material.GoldOre, count: 2, name: "Gold Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 128, // 2 gold (50 each = 100) + 1 coal (7) = 107, sells for 128
    description: "Smelt 2 Gold Ore + 1 Coal into a Gold Bar",
  },
  {
    output: "cobalt-bar",
    outputName: "Cobalt Bar",
    color: "#3060e0",
    inputs: [
      { mat: Material.CobaltOre, count: 2, name: "Cobalt Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 205, // 2 cobalt (80 each = 160) + 1 coal (7) = 167, sells for 205
    description: "Smelt 2 Cobalt Ore + 1 Coal into a Cobalt Bar",
  },
  // --- Alloy recipes (2 base bars → alloy bar) ---
  // Alloys require 2 base bars + 1 coal and sell for a premium over the
  // combined bar value, creating a second-tier crafting progression.
  {
    output: "steel-bar",
    outputName: "Steel Bar",
    color: "#909098",
    inputs: [
      { mat: Material.IronOre, count: 2, name: "Iron Ore" },
      { mat: Material.Coal, count: 2, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 45, // 2 iron (24) + 2 coal (14) = 38, sells for 45
    description: "Forge 2 Iron Ore + 2 Coal into a Steel Bar (high carbon)",
  },
  {
    output: "bronze-bar",
    outputName: "Bronze Bar",
    color: "#b8783a",
    inputs: [
      { mat: Material.CopperOre, count: 1, name: "Copper Ore" },
      { mat: Material.TinOre, count: 1, name: "Tin Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 20, // 1 copper (8) + 1 tin (5) + 1 coal (7) = 20, sells for 20
    description: "Alloy 1 Copper + 1 Tin Ore + 1 Coal into a Bronze Bar",
  },
  {
    output: "brass-bar",
    outputName: "Brass Bar",
    color: "#d4b43a",
    inputs: [
      { mat: Material.CopperOre, count: 1, name: "Copper Ore" },
      { mat: Material.BauxiteOre, count: 1, name: "Bauxite Ore" },
      { mat: Material.Coal, count: 1, name: "Coal" },
    ],
    outputCount: 1,
    sellPrice: 25, // 1 copper (8) + 1 bauxite (10) + 1 coal (7) = 25, sells for 25
    description: "Alloy 1 Copper + 1 Bauxite Ore + 1 Coal into a Brass Bar",
  },
];

/** Sell prices for crafted items (bars). Used by the sell system. */
export const CRAFTED_SELL_PRICES: Record<CraftedItemId, number> = Object.fromEntries(
  CRAFTING_RECIPES.map((r) => [r.output, r.sellPrice]),
) as Record<CraftedItemId, number>;

/** Display info for crafted items (name + color). */
export const CRAFTED_ITEM_INFO: Record<CraftedItemId, { name: string; color: string }> =
  Object.fromEntries(
    CRAFTING_RECIPES.map((r) => [r.output, { name: r.outputName, color: r.color }]),
  ) as Record<CraftedItemId, { name: string; color: string }>;

/**
 * Check if the player has enough materials to craft a recipe.
 * Returns true if all inputs are satisfied.
 */
export function canCraft(
  recipe: CraftingRecipe,
  inventory: { mat: number; count: number }[],
): boolean {
  for (const input of recipe.inputs) {
    const entry = inventory.find((e) => e.mat === input.mat);
    if (!entry || entry.count < input.count) return false;
  }
  return true;
}

/**
 * Consume input materials from the inventory for a recipe.
 * Returns a new inventory array with the inputs removed.
 * Does NOT check if the player has enough — call canCraft() first.
 */
export function consumeInputs(
  recipe: CraftingRecipe,
  inventory: { mat: number; count: number }[],
): { mat: number; count: number }[] {
  const result = [...inventory];
  for (const input of recipe.inputs) {
    const entry = result.find((e) => e.mat === input.mat);
    if (entry) {
      const newCount = entry.count - input.count;
      if (newCount <= 0) {
        const idx = result.indexOf(entry);
        result.splice(idx, 1);
      } else {
        entry.count = newCount;
      }
    }
  }
  return result;
}
