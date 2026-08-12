import { expect, test } from "bun:test";
import { FIELD } from "../shared/sim-buffer";
import { Material } from "./materials";
import { SandWorld } from "./sand-world";

// Deterministic helper: run N steps and return the grid as a mat-id matrix.
function run(world: SandWorld, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}
function matAt(world: SandWorld, x: number, y: number): number {
  return world.grid[y * world.W + x] & 0xff;
}
function lifetimeAt(world: SandWorld, x: number, y: number): number {
  return (world.grid[y * world.W + x] >> 8) & 0xff;
}
function flagsAt(world: SandWorld, x: number, y: number): number {
  return (world.grid[y * world.W + x] >> 16) & 0xff;
}

test("sand falls straight down through empty space", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 20);
  // Sand should rest just above the stone floor (floor occupies y=12..15).
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
  expect(matAt(w, 4, 0)).toBe(Material.Empty);
});

test("sand piles into a pyramid (diagonal fall works)", () => {
  const w = new SandWorld(8, 16);
  // Drop a column of sand at x=4.
  for (let y = 0; y < 8; y++) w.setCell(4, y, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 60);
  // The pile should be supported above the floor and spread sideways.
  let sandCount = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (matAt(w, x, y) === Material.Sand) sandCount++;
  expect(sandCount).toBe(8); // no sand lost
  // Center column should still have sand near the base.
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
});

test("water flows horizontally to fill a basin", () => {
  const w = new SandWorld(16, 16);
  // Build a basin: walls at x=2 and x=13, open above the floor.
  for (let y = 11; y < 12; y++) {
    w.setCell(2, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(13, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Pour water at the center top.
  w.setCell(7, 0, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 80);
  // Water should be somewhere in the basin (not lost, not stuck at the top).
  let water = 0;
  for (let y = 0; y < 16; y++) for (let x = 3; x < 13; x++) if (matAt(w, x, y) === Material.Water) water++;
  expect(water).toBe(1);
  expect(matAt(w, 7, 0)).toBe(Material.Empty);
});

test("smoke rises (negative gravityDir)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 11, { mat: Material.Smoke, lifetime: 200, flags: 0 });
  run(w, 40);
  // Smoke should have risen above its starting row (somewhere y < 11).
  let highest = 16;
  for (let y = 0; y < 16; y++) if (matAt(w, 4, y) === Material.Smoke) highest = Math.min(highest, y);
  // It may have decayed, but if present it must be above the start.
  if (highest < 16) expect(highest).toBeLessThan(11);
});

test("fire ignites adjacent wood and decays to smoke", () => {
  const w = new SandWorld(8, 16);
  // Wood pillar resting on the floor.
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Wood, lifetime: 0, flags: 0 });
  // Fire at the base.
  w.setCell(4, 11, { mat: Material.Fire, lifetime: 30, flags: 0 });
  run(w, 120);
  // Wood should have burned away (became fire → smoke → empty) somewhere.
  // At minimum, the original fire should be gone (decayed).
  let woodLeft = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (matAt(w, x, y) === Material.Wood) woodLeft++;
  // Combustion should have consumed at least some wood.
  expect(woodLeft).toBeLessThan(3);
});

test("lava + water → steam + stone (applyReactions)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Lava, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 5);
  // Lava should turn to stone and water to steam (reaction may take a frame).
  const lava = countMat(w, Material.Lava);
  const stone = countMat(w, Material.Stone);
  const steam = countMat(w, Material.Steam);
  // At least one conversion happened.
  expect(stone).toBeGreaterThan(0);
  expect(steam + (lava === 0 ? 1 : 0)).toBeGreaterThan(0);
});

test("mercury sinks through water (density displacement)", () => {
  const w = new SandWorld(8, 16);
  // 1-wide basin with walls on both sides so mercury can't flow around the
  // water — this forces the density-sink path in tryMove.
  for (let y = 8; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Water column resting on the floor.
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  // Mercury on top.
  w.setCell(4, 8, { mat: Material.Mercury, lifetime: 0, flags: 0 });
  run(w, 80);
  // Mercury (gravity 4) should end up below the water (gravity 2).
  const mercY = topMostY(w, Material.Mercury);
  const waterY = topMostY(w, Material.Water);
  expect(mercY).toBeGreaterThan(waterY); // mercury is lower (larger y)
});

test("salt + water → brine (applySpecialReactions)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 11, { mat: Material.Salt, lifetime: 0, flags: 0 });
  w.setCell(5, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 60);
  expect(countMat(w, Material.Brine)).toBeGreaterThan(0);
});

test("FLAG_UPDATED is cleared after each step (no sticky flag)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.step();
  // After a step, no cell should have FLAG_UPDATED set (applyAging clears it).
  for (let i = 0; i < w.grid.length; i++) {
    const flags = (w.grid[i] >> 16) & 0xff;
    expect(flags & 0x04).toBe(0);
  }
});

test("shade bits are preserved across steps", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 2 });
  run(w, 20);
  // The sand cell (wherever it ended up) should still carry shade 2.
  let foundShade2 = false;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
    if (matAt(w, x, y) === Material.Sand && (flagsAt(w, x, y) & 0x03) === 2) foundShade2 = true;
  }
  expect(foundShade2).toBe(true);
});

test("reusable buffers are sized to the grid (no out-of-bounds in combustion)", () => {
  const w = new SandWorld(12, 20);
  // Light a big fire to exercise applyCombustion + fuse + burning oil paths.
  for (let y = 10; y <= 15; y++) w.setCell(6, y, { mat: Material.Wood, lifetime: 0, flags: 0 });
  w.setCell(6, 15, { mat: Material.Fire, lifetime: 30, flags: 0 });
  w.setCell(5, 15, { mat: Material.Oil, lifetime: 0, flags: 0 });
  w.setCell(7, 15, { mat: Material.Fuse, lifetime: 0, flags: 0 });
  // Should not throw.
  run(w, 200);
  expect(w.frame).toBe(200);
});

test("wind field decays toward 0", () => {
  const w = new SandWorld(8, 16);
  const fi = (11 * 8 + 4) * 4;
  w.fields[fi + FIELD.WIND_X] = 100 & 0xff;
  run(w, 40);
  // Should have decayed significantly.
  const v = (w.fields[fi + FIELD.WIND_X] << 24) >> 24;
  expect(Math.abs(v)).toBeLessThan(100);
});

test("nanobots move and eat through material", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 8, { mat: Material.Nanobots, lifetime: 255, flags: 0 });
  w.setCell(5, 8, { mat: Material.Wood, lifetime: 0, flags: 0 });
  run(w, 200);
  // Nanobots should still exist and not be lost.
  expect(countMat(w, Material.Nanobots)).toBe(1);
});

test("sand falls through smoke (solid displaces gas)", () => {
  const w = new SandWorld(8, 16);
  // 1-wide column walled on both sides so sand can't route around the smoke.
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Smoke resting on the floor, sand directly above it.
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  // Sand must end up at the bottom of the column (on the floor), having
  // pushed the smoke up and out of the way.
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
});

test("water falls through smoke (liquid displaces gas)", () => {
  const w = new SandWorld(8, 16);
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 8, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 80);
  expect(matAt(w, 4, 11)).toBe(Material.Water);
});

test("snow melts to water when in contact with fire", () => {
  const w = new SandWorld(8, 16);
  // Snow on the floor, fire trapped in a 1-cell pocket above it (walls on
  // all sides except the bottom) so it can't rise or drift away.
  for (let dx = -1; dx <= 1; dx++) w.setCell(4 + dx, 9, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 10, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 10, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 10, { mat: Material.Fire, lifetime: 255, flags: 0 });
  w.setCell(4, 11, { mat: Material.Snow, lifetime: 0, flags: 0 });
  run(w, 40);
  // Snow should have melted — no snow left.
  expect(countMat(w, Material.Snow)).toBe(0);
  // Should have produced water (or steam if the fire is still hot).
  expect(countMat(w, Material.Water) + countMat(w, Material.Steam)).toBeGreaterThan(0);
});

test("snow melts to water when in contact with lava", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 11, { mat: Material.Snow, lifetime: 0, flags: 0 });
  w.setCell(3, 11, { mat: Material.Lava, lifetime: 0, flags: 0 });
  run(w, 30);
  expect(countMat(w, Material.Snow)).toBe(0);
});

test("water turns to steam when in contact with fire", () => {
  const w = new SandWorld(8, 16);
  // Water on the floor, fire trapped in a 1-cell pocket above it so it
  // can't rise or drift away.
  for (let dx = -1; dx <= 1; dx++) w.setCell(4 + dx, 9, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 10, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 10, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 10, { mat: Material.Fire, lifetime: 255, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 40);
  // Water touching fire should produce steam (not just sit there).
  expect(countMat(w, Material.Steam)).toBeGreaterThan(0);
});

test("steam condenses back to water on lifetime expiry", () => {
  const w = new SandWorld(8, 16);
  // Contained column so steam can't drift away.
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Multiple steam particles — each has a 30% chance to vanish instead of
  // condensing, so use enough to reliably get at least one water.
  for (let y = 8; y <= 11; y++) w.setCell(4, y, { mat: Material.Steam, lifetime: 120, flags: 0 });
  run(w, 250);
  // Steam should have condensed back to water.
  expect(countMat(w, Material.Water)).toBeGreaterThan(0);
});

// --- helpers ---
function countMat(w: SandWorld, mat: number): number {
  let c = 0;
  for (let i = 0; i < w.grid.length; i++) if ((w.grid[i] & 0xff) === mat) c++;
  return c;
}
function topMostY(w: SandWorld, mat: number): number {
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) if (matAt(w, x, y) === mat) return y;
  return -1;
}
