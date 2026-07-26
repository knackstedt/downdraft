import { Component, getComponentId, Stage, system, type Plugin, type PluginContext } from "@downdraft/core";
import { addItem, countItem, GridInventory, removeItemById, type InventoryGrid } from "./inventory-plugin.ts";
import { CRAFTING_TIER_RECIPES, RECIPES, type Recipe } from "./recipes.ts";

export interface CraftQueueEntry {
  recipeId: string;
  progress: number;
}

export const CraftState = Component.register("CraftState", {
  queue: [] as CraftQueueEntry[],
  unlockedRecipes: new Set<string>(CRAFTING_TIER_RECIPES[0] ?? []),
  craftingTier: 0,
});

export function unlockRecipesForTier(tier: number, unlocked: Set<string>): void {
  for (let t = 0; t <= tier && t < CRAFTING_TIER_RECIPES.length; t++) {
    for (const recipeId of CRAFTING_TIER_RECIPES[t]) {
      unlocked.add(recipeId);
    }
  }
}

export function canCraft(recipe: Recipe, grid: InventoryGrid): boolean {
  return recipe.inputs.every(
    (input) => countItem(grid, input.itemId) >= input.quantity,
  );
}

export function hasStation(recipe: Recipe, stations: Set<string>): boolean {
  if (!recipe.station) return true;
  return stations.has(recipe.station);
}

export function executeCraft(recipe: Recipe, grid: InventoryGrid): boolean {
  if (!canCraft(recipe, grid)) return false;
  for (const input of recipe.inputs) {
    removeItemById(grid, input.itemId, input.quantity);
  }
  addItem(grid, recipe.output.itemId, recipe.output.quantity);
  return true;
}

export function getUnlockedRecipes(unlocked: Set<string>): Recipe[] {
  return RECIPES.filter((r) => unlocked.has(r.id));
}

const gridInvId = getComponentId("GridInventory");

const craftingSystemFn = system("crafting-queue", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const stations = ctx.world.getResource<Set<string>>("craftingStations") ?? new Set<string>();

  for (const arch of ctx.world.allArchetypes) {
    const craftCol = arch.columns.get(CraftState.id);
    if (!craftCol) continue;
    const invCol = arch.columns.get(gridInvId);

    for (let i = 0; i < arch.entities.length; i++) {
      const craft = craftCol[i] as typeof CraftState.defaults;
      if (craft.queue.length === 0) continue;

      const entry = craft.queue[0];
      const recipe = RECIPES.find((r) => r.id === entry.recipeId);
      if (!recipe) {
        craft.queue.shift();
        continue;
      }

      if (recipe.station && !stations.has(recipe.station)) {
        craft.queue.shift();
        continue;
      }

      let grid: InventoryGrid | null = null;
      if (invCol) {
        grid = (invCol[i] as typeof GridInventory.defaults).grid;
      } else {
        grid = ctx.world.getResource<InventoryGrid>("playerInventoryGrid") ?? null;
      }

      if (!grid || !canCraft(recipe, grid)) {
        craft.queue.shift();
        continue;
      }

      entry.progress += dt / recipe.craftingTime;

      if (entry.progress >= 1) {
        executeCraft(recipe, grid);
        craft.queue.shift();
      }
    }
  }
}, { queries: [] });

export const CraftingPlugin: Plugin = {
  name: "ocean-crafting",
  version: "1.0.0",
  dependencies: ["ocean-inventory"],
  register(ctx: PluginContext) {
    ctx.registerSystem(Stage.Update, craftingSystemFn.fn);
  },
};
