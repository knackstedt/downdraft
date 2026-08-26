import { expect, test } from "bun:test";
import { FIELD, Material, SandWorld } from "../index";

// Deterministic helper
function run(world: SandWorld, steps: number): void {
  world.reseed(42);
  for (let i = 0; i < steps; i++) world.step();
}

function countMat(world: SandWorld, mat: number): number {
  let count = 0;
  for (let i = 0; i < world.W * world.H; i++) {
    if ((world.grid[i] & 0xff) === mat) count++;
  }
  return count;
}

// Set temperature in a rectangular region
function setTempRegion(world: SandWorld, x0: number, y0: number, x1: number, y1: number, temp: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x >= 0 && x < world.W && y >= 0 && y < world.H) {
        world.fields[(y * world.W + x) * 4 + FIELD.TEMP] = temp;
      }
    }
  }
}

// --- Rule engine tests ---
// These verify that the data-driven rule system produces the same behavior
// as the old hardcoded applyReactions() for the migrated reactions.

test("rule: water + lava → steam + stone", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Lava, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 5);
  expect(countMat(w, Material.Stone)).toBeGreaterThan(0);
  expect(countMat(w, Material.Steam)).toBeGreaterThan(0);
  expect(countMat(w, Material.Lava)).toBe(0);
});

test("rule: water + fire → steam + smoke", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Fire, lifetime: 30, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 30);
  expect(countMat(w, Material.Steam)).toBeGreaterThan(0);
});

test("rule: water + high temp → steam (evaporation)", () => {
  const w = new SandWorld(8, 16);
  // Wall in the water so it can't flow away from the hot zone
  w.setCell(3, 11, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 11, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  // Set high temperature in a wide region
  setTempRegion(w, 3, 8, 5, 12, 240);
  run(w, 100);
  // The water should have evaporated to steam (it may condense elsewhere,
  // but the original position should no longer be water)
  expect((w.grid[11 * 8 + 4] & 0xff)).not.toBe(Material.Water);
  expect(countMat(w, Material.Steam)).toBeGreaterThan(0);
});

test("rule: water + low temp → ice (freezing)", () => {
  const w = new SandWorld(8, 16);
  // Fill a column with water so it can't fall away from the cold zone
  for (let y = 10; y <= 11; y++) {
    w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  }
  // Set low temperature in a wide region
  setTempRegion(w, 3, 8, 5, 12, 30);
  run(w, 500);
  expect(countMat(w, Material.Ice)).toBeGreaterThan(0);
});

test("rule: ice + hot neighbor → water (melts)", () => {
  const w = new SandWorld(8, 16);
  // Place ice on the stone floor (can't fall)
  w.setCell(4, 11, { mat: Material.Ice, lifetime: 0, flags: 0 });
  // Place fire above it (fire is IS_HOT)
  w.setCell(4, 10, { mat: Material.Fire, lifetime: 60, flags: 0 });
  run(w, 50);
  // Ice should have melted to water at some point
  expect(countMat(w, Material.Water) + countMat(w, Material.Steam)).toBeGreaterThan(0);
});

test("rule: fire + low temp → smoke (dies faster in cold)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Fire, lifetime: 30, flags: 0 });
  setTempRegion(w, 3, 8, 5, 12, 40);
  run(w, 50);
  // Fire should have turned to smoke or decayed
  const fire = countMat(w, Material.Fire);
  expect(fire).toBe(0);
});

test("rule: water + plant → plant (growth)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Plant, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 200);
  expect(countMat(w, Material.Plant)).toBeGreaterThan(1);
});
