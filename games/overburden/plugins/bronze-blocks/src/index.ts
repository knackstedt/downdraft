// ============================================================================
// overburden-bronze-blocks — sample user-authored plugin (worker-js / native)
//
// Demonstrates the native-tier plugin surface:
//   - provides a typed ResourceToken (BronzeBlockTok) carrying the new block
//     definition + smelting recipe, which the game can inject to register the
//     block at runtime.
//   - registers an ECS system (via ctx.registerSystem) that ticks and
//     publishes a "bronze_block_registered" event once on first tick.
//   - uses the per-plugin KV state store to record registration count.
//
// This runs on the sim thread (manifest thread: "sim") inside Overburden's
// sim worker, where the ModuleHost + ECS World live.
// ============================================================================

import { resourceToken, type Stage, type NativePluginContext, type PluginEntry } from "@downdraft/core";

// ── The block definition this plugin contributes ──
// Mirrors Overburden's BlockDef shape (subset). The game consumes this via
// the BronzeBlockTok token and merges it into its block registry.

export interface BronzeBlockDef {
  id: number; // assigned by the game from its id pool
  name: string;
  category: "solid";
  hardness: number;
  color: [number, number, number];
  drops: Array<{ itemId: string; count: number; chance: number }>;
  placeable: boolean;
}

export interface BronzeRecipe {
  station: "furnace";
  inputs: Array<{ itemId: string; count: number }>;
  output: { itemId: string; count: number };
  burnTimeSec: number;
}

export interface BronzeBlockResource {
  block: BronzeBlockDef;
  recipe: BronzeRecipe;
}

/** Typed token the game injects to consume this plugin's block + recipe. */
export const BronzeBlockTok = resourceToken<BronzeBlockResource>("overburden:bronze-block");

// Use the Update stage (Stage.Update === 1). Importing the enum directly would
// couple the plugin to engine internals; we reference the numeric value via
// the Stage type to stay loose. The host passes a NativePluginContext whose
// registerSystem accepts a Stage.
const STAGE_UPDATE = 1 as Stage;

const plugin: PluginEntry<NativePluginContext> = {
  provides: [BronzeBlockTok],
  register(ctx: NativePluginContext) {
    const block: BronzeBlockDef = {
      id: -1, // game assigns the real id
      name: "Bronze Block",
      category: "solid",
      hardness: 12,
      color: [205, 127, 50], // bronze RGB
      drops: [{ itemId: "bronze_block", count: 1, chance: 1 }],
      placeable: true,
    };
    const recipe: BronzeRecipe = {
      station: "furnace",
      inputs: [
        { itemId: "copper_ore", count: 1 },
        { itemId: "tin_ore", count: 1 },
      ],
      output: { itemId: "bronze_block", count: 1 },
      burnTimeSec: 15,
    };

    // Provide the typed resource so the game (and other plugins) can inject it.
    ctx.provide(BronzeBlockTok, { block, recipe });

    // Record registration in the per-plugin KV state.
    ctx.state.set("registeredAt", Date.now());
    ctx.state.set("blockName", block.name);

    // Register a one-shot ECS system that publishes an event on first tick.
    let announced = false;
    ctx.registerSystem(STAGE_UPDATE, () => {
      if (announced) return;
      announced = true;
      ctx.events.publish("overburden:bronze_block_registered", {
        blockName: block.name,
        recipeStation: recipe.station,
      });
      ctx.log.info(`Bronze block "${block.name}" registered with recipe on ${recipe.station}.`);
    });

    // Clean up on unload.
    ctx.onDispose(() => {
      ctx.log.debug("Bronze blocks plugin unloading.");
    });
  },
};

export default plugin;
