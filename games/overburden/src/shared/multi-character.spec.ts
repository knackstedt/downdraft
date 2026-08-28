// Unit tests for multi-character feature: spawn egg item, recipe, inventory.
import { describe, expect, it } from "bun:test";
import { Inventory } from "./inventory";
import { getItemDef } from "./items";
import { getRecipe, recipesForStation } from "./recipes";

describe("Multi-character: spawn egg item", () => {
  it("spawn_egg is a registered material item", () => {
    const def = getItemDef("spawn_egg");
    expect(def).toBeDefined();
    expect(def!.id).toBe("spawn_egg");
    expect(def!.category).toBe("material");
    expect(def!.maxStack).toBe(1);
    expect(def!.placeBlock).toBe(0);
  });

  it("spawn_egg is not a placeable block (placeBlock = 0)", () => {
    const def = getItemDef("spawn_egg");
    expect(def!.placeBlock).toBe(0);
  });
});

describe("Multi-character: spawn egg recipe", () => {
  it("spawn_egg recipe exists at tailor_bench", () => {
    const recipe = getRecipe("spawn_egg");
    expect(recipe).toBeDefined();
    expect(recipe!.station).toBe("tailor_bench");
    expect(recipe!.outputs).toHaveLength(1);
    expect(recipe!.outputs[0].itemId).toBe("spawn_egg");
    expect(recipe!.outputs[0].count).toBe(1);
  });

  it("spawn_egg recipe requires planks + rope + coal", () => {
    const recipe = getRecipe("spawn_egg");
    expect(recipe).toBeDefined();
    const inputIds = recipe!.inputs.map((i) => i.itemId);
    expect(inputIds).toContain("planks");
    expect(inputIds).toContain("rope");
    expect(inputIds).toContain("coal");
  });

  it("tailor_bench station lists spawn_egg recipe", () => {
    const recipes = recipesForStation("tailor_bench");
    const ids = recipes.map((r) => r.id);
    expect(ids).toContain("spawn_egg");
  });
});

describe("Multi-character: inventory supports spawn egg", () => {
  it("can add and remove spawn_egg from inventory", () => {
    const inv = new Inventory();
    const overflow = inv.add("spawn_egg", 1);
    expect(overflow).toBe(0);
    expect(inv.count("spawn_egg")).toBe(1);
    const removed = inv.remove("spawn_egg", 1);
    expect(removed).toBe(true);
    expect(inv.count("spawn_egg")).toBe(0);
  });

  it("spawn_egg respects maxStack of 1 (5 eggs use 5 slots)", () => {
    const inv = new Inventory();
    const overflow = inv.add("spawn_egg", 5);
    expect(overflow).toBe(0); // 54 slots available, 5 fit
    expect(inv.count("spawn_egg")).toBe(5);
  });
});
