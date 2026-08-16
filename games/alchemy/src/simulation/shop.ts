import type { UnlockTier } from "../shared/types";
import { INGREDIENTS } from "./effect-system";

// ============================================================================
// Shop: ingredient unlock tiers + per-ingredient prices.
// ============================================================================

export const UNLOCK_TIERS: UnlockTier[] = [
  { tier: 0, name: "Apprentice", unlockCost: 0, ingredients: INGREDIENTS.filter((i) => i.tier === 0).map((i) => i.mat) },
  { tier: 1, name: "Novice", unlockCost: 50, ingredients: INGREDIENTS.filter((i) => i.tier === 1).map((i) => i.mat) },
  { tier: 2, name: "Adept", unlockCost: 150, ingredients: INGREDIENTS.filter((i) => i.tier === 2).map((i) => i.mat) },
  { tier: 3, name: "Expert", unlockCost: 400, ingredients: INGREDIENTS.filter((i) => i.tier === 3).map((i) => i.mat) },
  { tier: 4, name: "Master", unlockCost: 800, ingredients: INGREDIENTS.filter((i) => i.tier === 4).map((i) => i.mat) },
  { tier: 5, name: "Legendary", unlockCost: 1500, ingredients: INGREDIENTS.filter((i) => i.tier === 5).map((i) => i.mat) },
];

export const TIER_BY_NUMBER: Record<number, UnlockTier> = Object.fromEntries(
  UNLOCK_TIERS.map((t) => [t.tier, t]),
);

/** Get the ingredient info for a material, or null if not a shop ingredient. */
export function getIngredientInfo(mat: number) {
  return INGREDIENTS.find((i) => i.mat === mat) ?? null;
}

/** Check if the player can unlock a tier (has enough money + previous tier unlocked). */
export function canUnlockTier(
  tier: number,
  money: number,
  unlockedTiers: number[],
): boolean {
  if (unlockedTiers.includes(tier)) return false;
  if (tier > 0 && !unlockedTiers.includes(tier - 1)) return false;
  const t = TIER_BY_NUMBER[tier];
  if (!t) return false;
  return money >= t.unlockCost;
}

/** Check if the player can buy doses of an ingredient. */
export function canBuyIngredient(
  mat: number,
  doses: number,
  money: number,
  unlockedTiers: number[],
): boolean {
  const info = getIngredientInfo(mat);
  if (!info) return false;
  if (!unlockedTiers.includes(info.tier)) return false;
  return money >= info.dosePrice * doses;
}
