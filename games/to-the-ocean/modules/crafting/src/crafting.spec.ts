import { addItem, countItem, createGrid, removeItemById } from "@to-the-ocean/module-inventory";
import { describe, expect, it } from "bun:test";
import { canCraft, executeCraft } from "./crafting";
import { RECIPES } from "./recipes";

describe("executeCraft re-validation", () => {
  it("returns false and does not consume items when ingredients are missing", () => {
    const grid = createGrid(10, 6);
    const recipe = RECIPES.find((r) => r.id === "wood_plank")!;
    expect(recipe).toBeDefined();

    const result = executeCraft(recipe, grid);
    expect(result).toBe(false);
    expect(countItem(grid, "planks")).toBe(0);
  });

  it("re-validates ingredients before executing craft", () => {
    const grid = createGrid(10, 6);
    const recipe = RECIPES.find((r) => r.id === "wood_plank")!;
    addItem(grid, "wood", 1);

    expect(canCraft(recipe, grid)).toBe(true);
    const result = executeCraft(recipe, grid);
    expect(result).toBe(true);
    expect(countItem(grid, "wood")).toBe(0);
    expect(countItem(grid, "planks")).toBe(2);
  });

  it("fails gracefully if ingredients removed between canCraft and executeCraft", () => {
    const grid = createGrid(10, 6);
    const recipe = RECIPES.find((r) => r.id === "wood_plank")!;
    addItem(grid, "wood", 1);

    expect(canCraft(recipe, grid)).toBe(true);

    removeItemById(grid, "wood", 1);

    const result = executeCraft(recipe, grid);
    expect(result).toBe(false);
    expect(countItem(grid, "planks")).toBe(0);
  });
});
