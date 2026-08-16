import { describe, expect, it } from "bun:test";
import { Material } from "@downdraft/library-sand";
import { INGREDIENTS } from "./effect-system";
import { canBuyIngredient, canUnlockTier, TIER_BY_NUMBER, UNLOCK_TIERS } from "./shop";

describe("shop", () => {
  it("has 6 unlock tiers (0-5)", () => {
    expect(UNLOCK_TIERS.length).toBe(6);
    expect(UNLOCK_TIERS[0].tier).toBe(0);
    expect(UNLOCK_TIERS[5].tier).toBe(5);
  });

  it("tier 0 is free and unlocked by default", () => {
    expect(UNLOCK_TIERS[0].unlockCost).toBe(0);
    expect(canUnlockTier(0, 0, [])).toBe(true);
  });

  it("canUnlockTier requires previous tier", () => {
    expect(canUnlockTier(2, 1000, [0])).toBe(false); // missing tier 1
    expect(canUnlockTier(2, 1000, [0, 1])).toBe(true);
  });

  it("canUnlockTier requires enough money", () => {
    const tier1Cost = TIER_BY_NUMBER[1].unlockCost;
    expect(canUnlockTier(1, tier1Cost - 1, [0])).toBe(false);
    expect(canUnlockTier(1, tier1Cost, [0])).toBe(true);
  });

  it("canUnlockTier returns false for already-unlocked tier", () => {
    expect(canUnlockTier(0, 1000, [0])).toBe(false);
  });

  it("canBuyIngredient requires unlocked tier", () => {
    // Sulfur is tier 0
    const sulfur = INGREDIENTS.find((i) => i.mat === Material.Sulfur)!;
    expect(sulfur.tier).toBe(0);
    expect(canBuyIngredient(Material.Sulfur, 1, 100, [0])).toBe(true);
    expect(canBuyIngredient(Material.Sulfur, 1, 100, [])).toBe(false);
  });

  it("canBuyIngredient requires enough money", () => {
    const sulfur = INGREDIENTS.find((i) => i.mat === Material.Sulfur)!;
    expect(canBuyIngredient(Material.Sulfur, 1, sulfur.dosePrice - 1, [0])).toBe(false);
    expect(canBuyIngredient(Material.Sulfur, 1, sulfur.dosePrice, [0])).toBe(true);
  });

  it("each ingredient has a positive dose price", () => {
    for (const ing of INGREDIENTS) {
      expect(ing.dosePrice).toBeGreaterThan(0);
      expect(ing.doseSize).toBeGreaterThan(0);
    }
  });

  it("higher tiers have higher unlock costs", () => {
    for (let i = 1; i < UNLOCK_TIERS.length; i++) {
      expect(UNLOCK_TIERS[i].unlockCost).toBeGreaterThan(UNLOCK_TIERS[i - 1].unlockCost);
    }
  });

  it("all ingredients are assigned to a tier", () => {
    const allTierIngredients = UNLOCK_TIERS.flatMap((t) => t.ingredients);
    expect(allTierIngredients.length).toBe(INGREDIENTS.length);
  });
});
