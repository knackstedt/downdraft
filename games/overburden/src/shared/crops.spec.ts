import { describe, expect, it } from "bun:test";
import {
  CROPS, WILD_CROPS, getCropByBlock, getCropById, getWildCropByBlock,
  isCropBlock, isWildCropBlock, isMatureCrop, getFarmlandForCrop, getAllCrops,
} from "./crops";
import {
  BLOCK_CROP_SEED_TOMATO, BLOCK_CROP_MATURE_TOMATO, BLOCK_CROP_SPROUT_CARROT,
  BLOCK_FARMLAND, BLOCK_COMPOST_FARMLAND, BLOCK_WILD_BERRY_BUSH, BLOCK_WILD_MUSHROOM,
  BLOCK_CROP_MATURE_BROWN_MUSHROOM, BLOCK_AIR,
} from "./constants";

describe("crops registry", () => {
  it("defines all expected crops", () => {
    const ids = Object.keys(CROPS);
    expect(ids).toContain("tomato");
    expect(ids).toContain("carrot");
    expect(ids).toContain("potato");
    expect(ids).toContain("corn");
    expect(ids).toContain("pumpkin");
    expect(ids).toContain("wheat");
    expect(ids).toContain("brown_mushroom");
    expect(ids).toContain("red_mushroom");
    expect(ids.length).toBe(8);
  });

  it("each crop has 4 distinct stage block IDs", () => {
    for (const crop of Object.values(CROPS)) {
      expect(crop.stages.length).toBe(4);
      const unique = new Set(crop.stages);
      expect(unique.size).toBe(4); // all different
    }
  });

  it("getCropByBlock maps stage blocks back to crop + stage", () => {
    const entry = getCropByBlock(BLOCK_CROP_SEED_TOMATO);
    expect(entry).not.toBeNull();
    expect(entry!.crop.id).toBe("tomato");
    expect(entry!.stage).toBe(0);

    const mature = getCropByBlock(BLOCK_CROP_MATURE_TOMATO);
    expect(mature!.stage).toBe(3);
  });

  it("isCropBlock / isMatureCrop work correctly", () => {
    expect(isCropBlock(BLOCK_CROP_SEED_TOMATO)).toBe(true);
    expect(isCropBlock(BLOCK_CROP_MATURE_TOMATO)).toBe(true);
    expect(isCropBlock(BLOCK_AIR)).toBe(false);
    expect(isMatureCrop(BLOCK_CROP_MATURE_TOMATO)).toBe(true);
    expect(isMatureCrop(BLOCK_CROP_SEED_TOMATO)).toBe(false);
  });

  it("mushrooms use compost farmland, others use regular farmland", () => {
    const mushroom = getCropById("brown_mushroom")!;
    const tomato = getCropById("tomato")!;
    expect(getFarmlandForCrop(mushroom)).toBe(BLOCK_COMPOST_FARMLAND);
    expect(getFarmlandForCrop(tomato)).toBe(BLOCK_FARMLAND);
  });

  it("wild crops are registered", () => {
    expect(WILD_CROPS.length).toBe(2);
    expect(isWildCropBlock(BLOCK_WILD_BERRY_BUSH)).toBe(true);
    expect(isWildCropBlock(BLOCK_WILD_MUSHROOM)).toBe(true);
    expect(isWildCropBlock(BLOCK_AIR)).toBe(false);
  });

  it("getWildCropByBlock returns correct def", () => {
    const wc = getWildCropByBlock(BLOCK_WILD_BERRY_BUSH);
    expect(wc).not.toBeNull();
    expect(wc!.foodItem).toBe("berries");
    expect(wc!.hungerRestore).toBe(6);
  });

  it("mushroom crops have canSpread=true", () => {
    expect(getCropById("brown_mushroom")!.canSpread).toBe(true);
    expect(getCropById("red_mushroom")!.canSpread).toBe(true);
    expect(getCropById("tomato")!.canSpread).toBe(false);
  });

  it("getAllCrops returns array of all 8 crops", () => {
    expect(getAllCrops().length).toBe(8);
  });

  it("each crop has valid stageTicks (3 entries, positive)", () => {
    for (const crop of Object.values(CROPS)) {
      expect(crop.stageTicks.length).toBe(3);
      for (const t of crop.stageTicks) {
        expect(t).toBeGreaterThan(0);
      }
    }
  });
});
