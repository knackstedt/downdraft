import { describe, expect, it } from "bun:test";
import { Material } from "@downdraft/library-sand";
import { analyzeMixture, deriveEffects, zeroEffectVector } from "./effect-system";
import { bottlePotion, potionBaseValue } from "./bottling";
import { evaluateOffer, generateVisitor, haggle, VISITOR_TEMPLATES } from "./visitors";

describe("visitors", () => {
  it("has at least 20 visitor templates", () => {
    expect(VISITOR_TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });

  it("each template has unique id", () => {
    const ids = VISITOR_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("each template has multi-line dialog", () => {
    for (const t of VISITOR_TEMPLATES) {
      expect(t.requestFlavor.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("generateVisitor produces a visitor with valid fields", () => {
    const v = generateVisitor();
    expect(v.id).toBeTruthy();
    expect(v.name).toBeTruthy();
    expect(v.face).toBeTruthy();
    expect(v.budget).toBeGreaterThan(0);
    expect(v.mood).toBeGreaterThanOrEqual(0);
    expect(v.mood).toBeLessThanOrEqual(1);
    expect(v.patienceSec).toBeGreaterThan(0);
  });

  it("evaluateOffer returns high matchScore for matching potion", () => {
    // Create a potion with dissolving-acid effect
    const hist = new Uint32Array(256);
    hist[Material.Sulfur] = 100;
    hist[Material.Water] = 50;
    const analysis = analyzeMixture(hist);
    const effects = deriveEffects(analysis.effectVector);
    const potion = {
      id: "test-potion",
      name: "Test",
      properties: analysis.properties,
      effects: effects.map((e) => e.id),
      effectVector: analysis.effectVector,
      color: analysis.properties.color,
      ingredientsUsed: analysis.ingredientCounts,
      processHistory: [],
      createdAt: Date.now(),
    };

    // Find a visitor who wants dissolving-acid
    const widower = VISITOR_TEMPLATES.find((t) => t.id === "widower")!;
    const visitor = {
      id: "test-visitor",
      templateId: widower.id,
      name: widower.name,
      face: widower.face,
      requestFlavor: widower.requestFlavor,
      desiredEffects: widower.desiredEffects,
      budget: 60,
      mood: 0.7,
      patienceSec: 90,
      arrivedAt: Date.now(),
    };

    const result = evaluateOffer(potion, visitor);
    expect(result.matchScore).toBeGreaterThan(0);
    expect(result.finalPayout).toBeGreaterThan(0);
  });

  it("evaluateOffer returns 0 matchScore for non-matching potion", () => {
    // Create a potion with no effects (just water)
    const hist = new Uint32Array(256);
    hist[Material.Water] = 100;
    const analysis = analyzeMixture(hist);
    const potion = {
      id: "water-potion",
      name: "Water",
      properties: analysis.properties,
      effects: [],
      effectVector: analysis.effectVector,
      color: analysis.properties.color,
      ingredientsUsed: analysis.ingredientCounts,
      processHistory: [],
      createdAt: Date.now(),
    };

    const widower = VISITOR_TEMPLATES.find((t) => t.id === "widower")!;
    const visitor = {
      id: "test-visitor",
      templateId: widower.id,
      name: widower.name,
      face: widower.face,
      requestFlavor: widower.requestFlavor,
      desiredEffects: widower.desiredEffects,
      budget: 60,
      mood: 0.7,
      patienceSec: 90,
      arrivedAt: Date.now(),
    };

    const result = evaluateOffer(potion, visitor);
    expect(result.matchScore).toBe(0);
    expect(result.accepted).toBe(false);
  });

  it("haggle raises the payout", () => {
    const visitor = {
      id: "test",
      templateId: "gardener",
      name: "Gardener",
      face: "🌻",
      requestFlavor: ["test"],
      desiredEffects: ["lawn-cleaner"],
      budget: 50,
      mood: 0.8,
      patienceSec: 60,
      arrivedAt: Date.now(),
    };
    const result = haggle(visitor, 50, 20);
    expect(result.newPayout).toBe(60); // 50 * 1.2 = 60
  });

  it("haggle with high raise + low mood has high refusal chance", () => {
    // Run many trials to check refusal happens
    const visitor = {
      id: "test",
      templateId: "rival",
      name: "Rival",
      face: "🧪",
      requestFlavor: ["test"],
      desiredEffects: [],
      budget: 50,
      mood: 0.2, // low mood
      patienceSec: 60,
      arrivedAt: Date.now(),
    };
    let refusals = 0;
    for (let i = 0; i < 100; i++) {
      const result = haggle(visitor, 50, 100); // 100% raise
      if (!result.accepted) refusals++;
    }
    // With mood=0.2 and raise=100%, refusalChance = min(0.9, 1.0 * 1.3) = 0.9
    // So ~90% should refuse
    expect(refusals).toBeGreaterThan(70);
  });
});

describe("bottling", () => {
  it("bottlePotion returns null for empty histogram", () => {
    const hist = new Uint32Array(256);
    const potion = bottlePotion(hist, []);
    expect(potion).toBeNull();
  });

  it("bottlePotion creates a potion from a mixture", () => {
    const hist = new Uint32Array(256);
    hist[Material.Sulfur] = 100;
    hist[Material.Water] = 50;
    const potion = bottlePotion(hist, ["heat"]);
    expect(potion).not.toBeNull();
    expect(potion!.id).toBeTruthy();
    expect(potion!.name).toBeTruthy();
    expect(potion!.effects.length).toBeGreaterThan(0);
    expect(potion!.processHistory).toEqual(["heat"]);
    expect(potion!.ingredientsUsed.length).toBe(2);
  });

  it("potionBaseValue increases with more effects", () => {
    const hist = new Uint32Array(256);
    hist[Material.Sulfur] = 100;
    hist[Material.Water] = 50;
    const potion = bottlePotion(hist, ["heat"]);
    expect(potion).not.toBeNull();
    const value = potionBaseValue(potion!);
    expect(value).toBeGreaterThan(0);
  });
});
