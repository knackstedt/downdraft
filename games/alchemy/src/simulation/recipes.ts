import { Material } from "@downdraft/library-sand";
import type { EffectVector, ProcessStep, Recipe } from "../shared/types";
import {
    applyProcesses, deriveEffects, INGREDIENT_EFFECTS, zeroEffectVector,
} from "./effect-system";

// ============================================================================
// 50 built-in alchemy recipes.
//
// Each recipe specifies ingredients + ratios + a process sequence. The
// expected effect vector is computed from the ingredient vectors weighted by
// ratio, then transformed by the process sequence. Recipes are matched by
// checking the player's mixture effect vector against the expected vector
// within a per-dimension tolerance.
// ============================================================================

function computeExpectedVector(
  ingredients: { mat: number; ratio: number }[],
  process: ProcessStep[],
): EffectVector {
  let v = zeroEffectVector();
  let maxRatio = 0;
  for (const { mat, ratio } of ingredients) {
    const ev = INGREDIENT_EFFECTS[mat];
    if (!ev) continue;
    for (const dim of Object.keys(ev) as (keyof EffectVector)[]) {
      v[dim] += ev[dim] * ratio;
    }
    if (ratio > maxRatio) maxRatio = ratio;
  }
  // Normalize by max ratio (matching the analyzer's max-count normalization)
  if (maxRatio > 0) {
    for (const dim of Object.keys(v) as (keyof EffectVector)[]) {
      v[dim] = v[dim] / maxRatio;
      if (v[dim] > 1) v[dim] = 1;
      if (v[dim] < -1) v[dim] = -1;
    }
  }
  return applyProcesses(v, process);
}

function makeRecipe(
  id: string,
  name: string,
  tier: number,
  ingredients: { mat: number; ratio: number }[],
  process: ProcessStep[],
  _expectedEffectIds: string[],
  description: string,
  tolerance = 0.15,
): Recipe {
  const expectedResultVector = computeExpectedVector(ingredients, process);
  // Auto-derive expected effects from the vector so they always match
  const expectedEffects = deriveEffects(expectedResultVector).map((e) => e.id);
  return {
    id, name, tier, ingredients, process,
    expectedEffects,
    expectedResultVector,
    tolerance,
    description,
  };
}

export const RECIPES: Recipe[] = [
  // --- Tier 0: starter recipes ---
  makeRecipe("salt-water", "Brine", 0,
    [{ mat: Material.Water, ratio: 2 }, { mat: Material.Salt, ratio: 1 }],
    [],
    ["lawn-cleaner"],
    "Simple saltwater. A weak cleaning agent."),
  makeRecipe("mud-water", "Muddy Water", 0,
    [{ mat: Material.Water, ratio: 2 }, { mat: Material.Sand, ratio: 1 }],
    [],
    ["inert-slag"],
    "Dirty water. Not very useful."),
  makeRecipe("sulfur-water", "Sulfur Water", 0,
    [{ mat: Material.Water, ratio: 2 }, { mat: Material.Sulfur, ratio: 1 }],
    ["heat"],
    ["lawn-cleaner", "volatile-mix"],
    "Heated sulfur water. Smells terrible, cleans well."),
  makeRecipe("bone-paste", "Bone Paste", 0,
    [{ mat: Material.BoneDust, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["settle"],
    ["grave-mist"],
    "A gray paste of ground bone. Faintly necrotic."),
  makeRecipe("iron-slush", "Iron Slush", 0,
    [{ mat: Material.IronFilings, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["settle"],
    ["heavy-syrup"],
    "Iron filings in water. Very heavy."),
  makeRecipe("spark-powder", "Spark Powder", 0,
    [{ mat: Material.IronFilings, ratio: 1 }, { mat: Material.Sulfur, ratio: 1 }],
    ["heat"],
    ["spark-powder"],
    "Iron and sulfur, heated. Explodes on impact."),

  // --- Tier 1: basic alchemy ---
  makeRecipe("oil-fire", "Fire Oil", 1,
    [{ mat: Material.Oil, ratio: 2 }, { mat: Material.Sulfur, ratio: 1 }],
    ["heat"],
    ["dragonfire", "volatile-mix"],
    "Burning oil thickened with sulfur."),
  makeRecipe("honey-tonic", "Honey Tonic", 1,
    [{ mat: Material.Honey, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["cool"],
    ["healing-draught", "heavy-syrup"],
    "Sweet and soothing. A mild restorative."),
  makeRecipe("mercury-poison", "Quicksilver Poison", 1,
    [{ mat: Material.Mercury, ratio: 2 }, { mat: Material.Sulfur, ratio: 1 }],
    ["heat"],
    ["mercury-poison"],
    "Heavy metal toxin. Accumulates in the blood."),
  makeRecipe("blood-broth", "Blood Broth", 1,
    [{ mat: Material.Blood, ratio: 2 }, { mat: Material.BoneDust, ratio: 1 }],
    ["heat"],
    ["necrotic-blight"],
    "Blood and bone, heated. Dark and thick."),
  makeRecipe("newt-eye-extract", "Newt Eye Extract", 1,
    [{ mat: Material.GroundEyeOfNewt, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["cool"],
    ["dream-narcotic"],
    "Psychic extract of newt eyes. Induces visions."),
  makeRecipe("bat-wing-dust", "Bat Wing Dust", 1,
    [{ mat: Material.GroundBatWing, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    [],
    ["dream-vapor"],
    "Ground bat wing in water. Ethereal and light."),
  makeRecipe("spore-brew", "Spore Brew", 1,
    [{ mat: Material.MushroomSpores, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["heat"],
    ["nightshade-venom", "dream-narcotic"],
    "Heated mushroom spores. Toxic and hallucinogenic."),
  makeRecipe("mandrake-tea", "Mandrake Tea", 1,
    [{ mat: Material.MandrakeRoot, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["heat"],
    ["nightshade-venom"],
    "Mandrake root tea. Deadly but popular."),

  // --- Tier 2: intermediate ---
  makeRecipe("ether-brew", "Ether Brew", 2,
    [{ mat: Material.Ether, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["heat"],
    ["ether-bomb", "will-o-wisp"],
    "Ether and water, heated. Glows and fizzles."),
  makeRecipe("syrup-paste", "Syrup Paste", 2,
    [{ mat: Material.Syrup, ratio: 2 }, { mat: Material.Honey, ratio: 1 }],
    ["settle"],
    ["heavy-syrup", "healing-draught"],
    "Thick sweet paste. Very viscous."),
  makeRecipe("nightshade-venom", "Nightshade Venom", 2,
    [{ mat: Material.NightshadeExtract, ratio: 2 }, { mat: Material.MandrakeRoot, ratio: 1 }],
    ["settle"],
    ["nightshade-venom"],
    "Concentrated nightshade. A classic poison."),
  makeRecipe("troll-regen", "Troll Regeneration", 2,
    [{ mat: Material.TrollBlood, ratio: 2 }, { mat: Material.Honey, ratio: 1 }],
    ["heat"],
    ["troll-regen"],
    "Troll blood and honey. Heals but corrupts."),
  makeRecipe("moon-brew", "Moon Brew", 2,
    [{ mat: Material.MoonstoneDust, ratio: 2 }, { mat: Material.Water, ratio: 1 }],
    ["cool"],
    ["moon-brew", "starlight-tonic"],
    "Moonstone dust in cool water. Glows softly."),
  makeRecipe("crystal-resonance", "Crystal Resonance", 2,
    [{ mat: Material.CrystalDust, ratio: 2 }, { mat: Material.IronFilings, ratio: 1 }],
    ["heat"],
    ["crystal-resonance", "spark-powder"],
    "Crystal and iron, heated. Humms with energy."),
  makeRecipe("grave-mist", "Grave Mist", 2,
    [{ mat: Material.GraveDust, ratio: 2 }, { mat: Material.Blood, ratio: 1 }],
    ["heat"],
    ["grave-mist", "necrotic-blight"],
    "Grave dust and blood. The breath of the dead."),
  makeRecipe("silk-elixir", "Silk Elixir", 2,
    [{ mat: Material.SpiderSilk, ratio: 2 }, { mat: Material.Ether, ratio: 1 }],
    [],
    ["dream-vapor", "ether-bomb"],
    "Spider silk in ether. Light and ethereal."),

  // --- Tier 3: advanced ---
  makeRecipe("shadow-oil", "Shadow Oil", 3,
    [{ mat: Material.LiquidShadow, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["liquid-shadow", "shadow-burn"],
    "Liquid shadow thickened with oil. Moves on its own."),
  makeRecipe("love-philter", "Love Philter", 3,
    [{ mat: Material.LoveEssence, ratio: 2 }, { mat: Material.Honey, ratio: 1 }],
    ["cool"],
    ["love-philter"],
    "Love essence and honey. Infatuates the drinker."),
  makeRecipe("wrath-elixir", "Wrath Elixir", 3,
    [{ mat: Material.HateEssence, ratio: 2 }, { mat: Material.Sulfur, ratio: 1 }],
    ["heat"],
    ["wrath-elixir", "hate-flux"],
    "Hate essence and sulfur. Corrosive rage."),
  makeRecipe("dream-vapor", "Dream Vapor", 3,
    [{ mat: Material.DreamMist, ratio: 2 }, { mat: Material.Ether, ratio: 1 }],
    ["heat"],
    ["dream-vapor", "ether-bomb"],
    "Dream mist and ether. Prophetic dreams."),
  makeRecipe("dragonfire", "Dragonfire", 3,
    [{ mat: Material.DragonScale, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["dragonfire"],
    "Dragon scale and oil. Burns everything."),
  makeRecipe("phoenix-tears", "Phoenix Tears", 3,
    [{ mat: Material.PhoenixFeather, ratio: 2 }, { mat: Material.Honey, ratio: 1 }],
    ["heat"],
    ["phoenix-tears", "healing-draught"],
    "Phoenix feather and honey. Legendary healing."),

  // --- Tier 4: master ---
  makeRecipe("starlight-tonic", "Starlight Tonic", 4,
    [{ mat: Material.StarShard, ratio: 2 }, { mat: Material.MoonstoneDust, ratio: 1 }],
    ["cool"],
    ["starlight-tonic", "moon-brew"],
    "Star shard and moonstone. Cold starlight."),
  makeRecipe("unicorn-elixir", "Unicorn Elixir", 4,
    [{ mat: Material.UnicornHorn, ratio: 2 }, { mat: Material.Honey, ratio: 1 }],
    ["cool"],
    ["healing-draught", "phoenix-tears"],
    "Unicorn horn and honey. Pure healing light."),
  makeRecipe("starlight-fire", "Starlight Fire", 4,
    [{ mat: Material.StarShard, ratio: 2 }, { mat: Material.PhoenixFeather, ratio: 1 }],
    ["heat"],
    ["starlight-tonic", "dragonfire"],
    "Star shard and phoenix feather. Burning starlight."),
  makeRecipe("unicorn-shadow", "Unicorn Shadow", 4,
    [{ mat: Material.UnicornHorn, ratio: 1 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["settle"],
    ["healing-draught", "liquid-shadow"],
    "Unicorn horn and shadow. Light and dark in balance."),

  // --- Tier 5: legendary ---
  makeRecipe("void-bomb", "Void Bomb", 5,
    [{ mat: Material.VoidEssence, ratio: 2 }, { mat: Material.DragonScale, ratio: 1 }],
    ["heat"],
    ["void-bomb", "necrotic-blight"],
    "Void essence and dragon scale. Reality-tearing."),
  makeRecipe("time-ender", "Time Ender", 5,
    [{ mat: Material.TimeSand, ratio: 2 }, { mat: Material.Ether, ratio: 1 }],
    ["cool"],
    ["time-ender", "dream-vapor"],
    "Time sand and ether. Stops the clock."),
  makeRecipe("void-tears", "Void Tears", 5,
    [{ mat: Material.VoidEssence, ratio: 1 }, { mat: Material.PhoenixFeather, ratio: 1 }],
    ["heat"],
    ["void-bomb", "phoenix-tears"],
    "Void and phoenix. Death and rebirth."),
  makeRecipe("time-fire", "Time Fire", 5,
    [{ mat: Material.TimeSand, ratio: 2 }, { mat: Material.DragonScale, ratio: 1 }],
    ["heat"],
    ["time-ender", "dragonfire"],
    "Time sand and dragon scale. Burning time."),

  // --- Cross-tier combinations (20 more to reach 50) ---
  makeRecipe("acid-bath", "Acid Bath", 1,
    [{ mat: Material.Sulfur, ratio: 2 }, { mat: Material.Water, ratio: 1 }, { mat: Material.Salt, ratio: 1 }],
    ["heat"],
    ["dissolving-acid", "lawn-cleaner"],
    "Sulfur, salt, and water. Dissolves organic matter."),
  makeRecipe("fire-water", "Fire Water", 1,
    [{ mat: Material.Oil, ratio: 1 }, { mat: Material.Sulfur, ratio: 1 }, { mat: Material.Water, ratio: 1 }],
    ["heat"],
    ["volatile-mix", "lawn-cleaner"],
    "Oil, sulfur, and water. Unstable and hot."),
  makeRecipe("blood-oil", "Blood Oil", 2,
    [{ mat: Material.Blood, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["necrotic-blight", "dragonfire"],
    "Blood and oil. Burns dark and thick."),
  makeRecipe("mercury-shadow", "Quicksilver Shadow", 3,
    [{ mat: Material.Mercury, ratio: 1 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["settle"],
    ["mercury-poison", "liquid-shadow"],
    "Mercury and shadow. Heavy dark poison."),
  makeRecipe("ether-philter", "Ether Philter", 3,
    [{ mat: Material.Ether, ratio: 2 }, { mat: Material.LoveEssence, ratio: 1 }],
    ["heat"],
    ["love-philter", "ether-bomb"],
    "Ether and love essence. Ethereal infatuation."),
  makeRecipe("dream-poison", "Dream Poison", 3,
    [{ mat: Material.DreamMist, ratio: 1 }, { mat: Material.NightshadeExtract, ratio: 1 }],
    ["settle"],
    ["dream-narcotic", "nightshade-venom"],
    "Dream mist and nightshade. Lethal dreams."),
  makeRecipe("crystal-fire", "Crystal Fire", 3,
    [{ mat: Material.CrystalDust, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["crystal-resonance", "dragonfire"],
    "Crystal and oil. Burning resonance."),
  makeRecipe("grave-fire", "Grave Fire", 3,
    [{ mat: Material.GraveDust, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["grave-mist", "shadow-burn"],
    "Grave dust and oil. Burning darkness."),
  makeRecipe("moon-philter", "Moon Philter", 3,
    [{ mat: Material.MoonstoneDust, ratio: 2 }, { mat: Material.LoveEssence, ratio: 1 }],
    ["cool"],
    ["moon-brew", "love-philter"],
    "Moonstone and love essence. Lunar infatuation."),
  makeRecipe("starlight-mist", "Starlight Mist", 4,
    [{ mat: Material.StarShard, ratio: 1 }, { mat: Material.DreamMist, ratio: 1 }],
    ["cool"],
    ["starlight-tonic", "dream-vapor"],
    "Star shard and dream mist. Glowing dreams."),
  makeRecipe("unicorn-fire", "Unicorn Fire", 4,
    [{ mat: Material.UnicornHorn, ratio: 2 }, { mat: Material.PhoenixFeather, ratio: 1 }],
    ["heat"],
    ["phoenix-tears", "starlight-tonic"],
    "Unicorn horn and phoenix feather. Holy fire."),
  makeRecipe("void-shadow", "Void Shadow", 5,
    [{ mat: Material.VoidEssence, ratio: 2 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["settle"],
    ["void-bomb", "liquid-shadow"],
    "Void and shadow. Ultimate darkness."),
  makeRecipe("time-shadow", "Time Shadow", 5,
    [{ mat: Material.TimeSand, ratio: 1 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["settle"],
    ["time-ender", "liquid-shadow"],
    "Time sand and shadow. Frozen darkness."),
  makeRecipe("void-dream", "Void Dream", 5,
    [{ mat: Material.VoidEssence, ratio: 1 }, { mat: Material.DreamMist, ratio: 1 }],
    ["heat"],
    ["void-bomb", "dream-vapor"],
    "Void and dream. Reality-bending nightmares."),
  makeRecipe("time-philter", "Time Philter", 5,
    [{ mat: Material.TimeSand, ratio: 2 }, { mat: Material.LoveEssence, ratio: 1 }],
    ["cool"],
    ["time-ender", "love-philter"],
    "Time sand and love. Eternal infatuation."),
  makeRecipe("starlight-void", "Starlight Void", 5,
    [{ mat: Material.StarShard, ratio: 1 }, { mat: Material.VoidEssence, ratio: 1 }],
    ["heat"],
    ["starlight-tonic", "void-bomb"],
    "Star shard and void. Light and nothingness."),
  makeRecipe("phoenix-shadow", "Phoenix Shadow", 4,
    [{ mat: Material.PhoenixFeather, ratio: 1 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["heat"],
    ["phoenix-tears", "shadow-burn"],
    "Phoenix feather and shadow. Burning rebirth."),
  makeRecipe("dragon-shadow", "Dragon Shadow", 4,
    [{ mat: Material.DragonScale, ratio: 1 }, { mat: Material.LiquidShadow, ratio: 1 }],
    ["heat"],
    ["dragonfire", "liquid-shadow"],
    "Dragon scale and shadow. Burning darkness."),
  makeRecipe("hate-fire", "Hate Fire", 3,
    [{ mat: Material.HateEssence, ratio: 2 }, { mat: Material.Oil, ratio: 1 }],
    ["heat"],
    ["wrath-elixir", "dragonfire"],
    "Hate essence and oil. Burning rage."),
  makeRecipe("love-light", "Love Light", 3,
    [{ mat: Material.LoveEssence, ratio: 2 }, { mat: Material.MoonstoneDust, ratio: 1 }],
    ["cool"],
    ["love-philter", "moon-brew"],
    "Love essence and moonstone. Gentle light."),
];

export const RECIPE_BY_ID: Record<string, Recipe> = Object.fromEntries(
  RECIPES.map((r) => [r.id, r]),
);

// ============================================================================
// Recipe matching — find a recipe whose expected effect vector matches the
// player's mixture within tolerance.
// ============================================================================

export function matchRecipe(
  mixtureVector: EffectVector,
  processHistory: ProcessStep[],
): Recipe | null {
  const dims = Object.keys(mixtureVector) as (keyof EffectVector)[];
  let best: Recipe | null = null;
  let bestDist = Infinity;

  for (const recipe of RECIPES) {
    // Process history must match (same steps in same order)
    if (processHistory.length !== recipe.process.length) continue;
    let processMatch = true;
    for (let i = 0; i < processHistory.length; i++) {
      if (processHistory[i] !== recipe.process[i]) { processMatch = false; break; }
    }
    if (!processMatch) continue;

    // Check effect vector distance
    let dist = 0;
    for (const dim of dims) {
      const diff = (mixtureVector[dim] ?? 0) - (recipe.expectedResultVector[dim] ?? 0);
      dist += diff * diff;
    }
    dist = Math.sqrt(dist);

    if (dist <= recipe.tolerance && dist < bestDist) {
      bestDist = dist;
      best = recipe;
    }
  }

  return best;
}

/** Verify a recipe's expected effects are actually derived from its vector. */
export function verifyRecipeEffects(recipe: Recipe): string[] {
  const effects = deriveEffects(recipe.expectedResultVector);
  return effects.map((e) => e.id);
}

/** Get the display names of a recipe's expected effects. */
export function recipeEffectNames(recipe: Recipe): string[] {
  // Re-derive to get effect objects with names
  return deriveEffects(recipe.expectedResultVector).map((e) => e.name);
}
