import { analyzeMixture, deriveEffects, nameMixture } from "./effect-system";
import { matchRecipe } from "./recipes";
import type { Potion, ProcessStep } from "../shared/types";

/**
 * Bottle the current cauldron mixture into a Potion object.
 * Returns null if the cauldron is empty.
 */
export function bottlePotion(
  histogram: Uint32Array,
  processHistory: ProcessStep[],
): Potion | null {
  const analysis = analyzeMixture(histogram);
  if (analysis.totalCells === 0) return null;

  const effects = deriveEffects(analysis.effectVector);
  const recipe = matchRecipe(analysis.effectVector, processHistory);
  const name = recipe ? recipe.name : nameMixture(analysis.effectVector, effects);

  return {
    id: `potion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    properties: analysis.properties,
    effects: effects.map((e) => e.id),
    effectVector: analysis.effectVector,
    color: analysis.properties.color,
    ingredientsUsed: analysis.ingredientCounts,
    processHistory: [...processHistory],
    createdAt: Date.now(),
  };
}

/** Base monetary value of a potion, based on its effects + ingredient rarity. */
export function potionBaseValue(potion: Potion): number {
  // Base value: 10 per effect + 5 per ingredient type
  const effectValue = potion.effects.length * 10;
  const ingredientValue = potion.ingredientsUsed.length * 5;
  // Bonus for process steps (more processed = more valuable)
  const processBonus = potion.processHistory.length * 8;
  return effectValue + ingredientValue + processBonus + 5;
}
