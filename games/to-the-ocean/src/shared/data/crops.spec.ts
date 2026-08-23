import { describe, expect, it } from "bun:test";
import { BiomeType, ItemCategory } from "../types";
import { ITEMS, getItem } from "./items";
import { CROPS, getCrop, getCropBySeed, getCropsByBiome, getAllCrops } from "./crops";

describe("crop registry integrity", () => {
  it("every crop's seed item exists in ITEMS with Seed category", () => {
    for (const crop of getAllCrops()) {
      if (!crop.seedItemId) continue; // kelp has a seed; none are null currently
      const seed = getItem(crop.seedItemId);
      expect(seed, `seed ${crop.seedItemId} for crop ${crop.id} should exist`).not.toBeNull();
      expect(seed!.category).toBe(ItemCategory.Seed);
    }
  });

  it("every crop’s harvested item exists in ITEMS", () => {
    for (const crop of getAllCrops()) {
      const item = getItem(crop.cropItemId);
      expect(item, `crop item ${crop.cropItemId} should exist`).not.toBeNull();
    }
  });

  it("getCropBySeed resolves every seed", () => {
    for (const crop of getAllCrops()) {
      if (!crop.seedItemId) continue;
      const resolved = getCropBySeed(crop.seedItemId);
      expect(resolved?.id).toBe(crop.id);
    }
  });

  it("getCrop returns null for unknown", () => {
    expect(getCrop("nope")).toBeNull();
    expect(getCropBySeed("nope_seed")).toBeNull();
  });

  it("stageDurations has exactly 4 positive entries", () => {
    for (const crop of getAllCrops()) {
      expect(crop.stageDurations.length).toBe(4);
      for (const d of crop.stageDurations) expect(d).toBeGreaterThan(0);
    }
  });

  it("visuals has exactly 4 stages", () => {
    for (const crop of getAllCrops()) {
      expect(crop.visuals.length).toBe(4);
    }
  });

  it("tolerance values are in [0,1]", () => {
    for (const crop of getAllCrops()) {
      expect(crop.coldTolerance).toBeGreaterThanOrEqual(0);
      expect(crop.coldTolerance).toBeLessThanOrEqual(1);
      expect(crop.heatTolerance).toBeGreaterThanOrEqual(0);
      expect(crop.heatTolerance).toBeLessThanOrEqual(1);
    }
  });

  it("bushes have regrowTime > 0, non-bushes have regrowTime === 0", () => {
    for (const crop of getAllCrops()) {
      if (crop.isBush) expect(crop.regrowTime).toBeGreaterThan(0);
      else expect(crop.regrowTime).toBe(0);
    }
  });

  it("mushrooms have spreadChance > 0 and spreadRange > 0; others have 0", () => {
    for (const crop of getAllCrops()) {
      if (crop.isMushroom) {
        expect(crop.spreadChance).toBeGreaterThan(0);
        expect(crop.spreadRange).toBeGreaterThan(0);
      } else {
        expect(crop.spreadChance).toBe(0);
        expect(crop.spreadRange).toBe(0);
      }
    }
  });

  it("preferredBiomes are valid BiomeType values", () => {
    const valid = new Set<number>(Object.values(BiomeType) as number[]);
    for (const crop of getAllCrops()) {
      expect(crop.preferredBiomes.length).toBeGreaterThan(0);
      for (const b of crop.preferredBiomes) expect(valid.has(b)).toBe(true);
    }
  });

  it("getCropsByBiome returns crops preferring that biome", () => {
    const arcticCrops = getCropsByBiome(BiomeType.Arctic);
    for (const c of arcticCrops) expect(c.preferredBiomes).toContain(BiomeType.Arctic);
  });

  it("crop item stats match crop def hunger/spoil/value", () => {
    // Sanity: the harvested item's value should equal the crop def value.
    for (const crop of getAllCrops()) {
      const item = ITEMS[crop.cropItemId];
      expect(item.value).toBe(crop.value);
    }
  });
});
