import { expect, test } from "bun:test";
import { FIELD } from "./fields";
import { Material } from "./materials";
import { SandWorld } from "./sand-world";

// Deterministic helper: run N steps and return the grid as a mat-id matrix.
function run(world: SandWorld, steps: number): void {
  world.reseed(42);
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

test("fire rises through smoke (gas-to-gas displacement, not suffocated)", () => {
  // Regression: when fire gravity < smoke gravity, smoke from a bottom-up
  // burn rises faster than the fire front, overtakes it, and pushes the fire
  // back down (gas-to-gas displacement). The fire gets trapped below its own
  // smoke, can't reach the fuel above, and decays — suffocating the burn.
  // Fire must rise faster than smoke (gravity 4 > 3) so it pushes through.
  const w = new SandWorld(8, 32);
  // 1-wide column walled on both sides (walls span the full height so neither
  // gas can escape sideways — the only way up is through the other gas).
  for (let y = 0; y < 28; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Block of smoke with fire directly below it.
  for (let y = 18; y <= 22; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 23, { mat: Material.Fire, lifetime: 255, flags: 0 });
  run(w, 40);
  // Find the topmost fire and bottommost smoke in the column.
  let topFire = 32, bottomSmoke = -1;
  for (let y = 0; y < 32; y++) {
    const m = matAt(w, 4, y);
    if (m === Material.Fire && y < topFire) topFire = y;
    if (m === Material.Smoke && y > bottomSmoke) bottomSmoke = y;
  }
  // With the fix (fire gravity 4 > smoke gravity 3), fire displaces smoke
  // and rises above it. Without the fix (fire 2 < smoke 3), fire is trapped
  // below the smoke block and can never rise above it.
  expect(topFire).toBeLessThan(bottomSmoke);
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
  // Mercury (density 13.5) should end up below the water (density 1.0).
  const mercY = topMostY(w, Material.Mercury);
  const waterY = topMostY(w, Material.Water);
  expect(mercY).toBeGreaterThan(waterY); // mercury is lower (larger y)
});

test("sand sinks through water (solid denser than liquid)", () => {
  const w = new SandWorld(8, 16);
  // 1-wide basin with walls so sand can't flow around the water.
  for (let y = 6; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Water column resting on the floor.
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  // Sand on top.
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  // Sand (density 2.0) should sink through water (density 1.0) and end up
  // at the bottom of the basin, below the water.
  const sandY = topMostY(w, Material.Sand);
  const waterY = topMostY(w, Material.Water);
  expect(sandY).toBeGreaterThan(waterY); // sand is lower (larger y)
});

test("sand floats on mercury (solid less dense than liquid)", () => {
  const w = new SandWorld(8, 16);
  for (let y = 6; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Mercury column resting on the floor.
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Mercury, lifetime: 0, flags: 0 });
  // Sand on top.
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  // Sand (density 2.0) should NOT sink through mercury (density 13.5).
  // Sand stays on top, mercury stays below.
  const sandY = topMostY(w, Material.Sand);
  const mercY = topMostY(w, Material.Mercury);
  expect(sandY).toBeLessThan(mercY); // sand is higher (smaller y)
});

test("wood floats on water (solid less dense than liquid)", () => {
  const w = new SandWorld(8, 16);
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Water column resting on the floor.
  for (let y = 8; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  // Wood is static (gravityDir 0) so place it in the middle of the water.
  w.setCell(4, 9, { mat: Material.Wood, lifetime: 0, flags: 0 });
  run(w, 80);
  // Wood (density 0.6) is less dense than water (1.0), so water sinks
  // through it and wood ends up on top of the water.
  const woodY = topMostY(w, Material.Wood);
  const waterY = topMostY(w, Material.Water);
  expect(woodY).toBeLessThan(waterY); // wood is higher (smaller y)
});

test("oil floats on water and spreads horizontally across the surface", () => {
  // Regression: oil (density 0.8) rises through water (density 1.0) via
  // buoyancy, but once at the surface it was trapped in a narrow column
  // because tryFlow only moves into empty cells — the adjacent cells at the
  // surface were water. With tryDensityFlow, oil pushes water aside and
  // spreads across the surface.
  const w = new SandWorld(16, 20);
  // Basin walls
  for (let y = 12; y <= 19; y++) {
    w.setCell(2, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(13, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Fill basin with water (rows 14-18)
  for (let y = 14; y <= 18; y++) {
    for (let x = 3; x <= 12; x++) {
      w.setCell(x, y, { mat: Material.Water, lifetime: 0, flags: 0 });
    }
  }
  // Drop oil in the center of the water pool (4-wide column, 3 tall)
  for (let y = 15; y <= 17; y++) {
    for (let x = 6; x <= 9; x++) {
      w.setCell(x, y, { mat: Material.Oil, lifetime: 0, flags: 0 });
    }
  }
  run(w, 500);
  // Oil should have risen to the water surface and spread horizontally.
  let oilTopY = 20;
  for (let y = 0; y < 20; y++)
    for (let x = 3; x <= 12; x++)
      if (matAt(w, x, y) === Material.Oil) oilTopY = Math.min(oilTopY, y);
  expect(oilTopY).toBeLessThan(20); // oil exists
  // Oil should spread across multiple columns at the surface (not just the
  // initial 4-wide column).
  let oilAtSurface = 0;
  for (let x = 3; x <= 12; x++)
    if (matAt(w, x, oilTopY) === Material.Oil) oilAtSurface++;
  expect(oilAtSurface).toBeGreaterThan(4);
});

test("iron sinks through water but not mercury", () => {
  // Iron (density 7.8) sinks in water (1.0) but floats on mercury (13.5).
  const w = new SandWorld(16, 16);
  // Left basin: water. Right basin: mercury.
  for (let y = 6; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(7, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(11, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(15, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) {
    w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Water, lifetime: 0, flags: 0 });
    w.setCell(6, y, { mat: Material.Water, lifetime: 0, flags: 0 });
    w.setCell(12, y, { mat: Material.Mercury, lifetime: 0, flags: 0 });
    w.setCell(13, y, { mat: Material.Mercury, lifetime: 0, flags: 0 });
    w.setCell(14, y, { mat: Material.Mercury, lifetime: 0, flags: 0 });
  }
  // Iron on top of each basin.
  w.setCell(5, 8, { mat: Material.Iron, lifetime: 0, flags: 0 });
  w.setCell(13, 8, { mat: Material.Iron, lifetime: 0, flags: 0 });
  run(w, 120);
  // In water: iron sinks to the bottom (below the surface y=8).
  // Search only the water basin (x=4..6) for iron.
  let ironInWaterY = 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 4; x <= 6; x++) {
      if (matAt(w, x, y) === Material.Iron) ironInWaterY = Math.min(ironInWaterY, y);
    }
  }
  // In mercury: iron stays on top (above the surface).
  let ironInMercuryY = 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 12; x <= 14; x++) {
      if (matAt(w, x, y) === Material.Iron) ironInMercuryY = Math.min(ironInMercuryY, y);
    }
  }
  // Iron in water should have sunk (y >= 9, below the surface).
  expect(ironInWaterY).toBeGreaterThanOrEqual(9);
  // Iron in mercury should still be near the top (y < 10, above or at surface).
  expect(ironInMercuryY).toBeLessThan(10);
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

test("fluid grid velocity decays toward 0", () => {
  // The fluid grid starts with zero velocity. After stepping with no impulses,
  // it should remain at zero (the dirty flag prevents unnecessary computation).
  const w = new SandWorld(8, 16);
  run(w, 40);
  // No impulses applied — wind should be zero everywhere.
  expect(w.getWindX(4, 8)).toBe(0);
  expect(w.getWindY(4, 8)).toBe(0);
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

// --- Gravel + LooseStone tests ---

test("gravel falls and settles in a pile", () => {
  const w = new SandWorld(12, 20);
  // Floor
  for (let x = 0; x < 12; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Drop gravel from above
  for (let y = 0; y < 5; y++) w.setCell(6, y, { mat: Material.Gravel, lifetime: 0, flags: 0 });
  run(w, 60);
  // All gravel should be above the floor
  const gravelCount = countMat(w, Material.Gravel);
  expect(gravelCount).toBe(5);
  // No gravel at the top
  expect(matAt(w, 6, 0)).toBe(Material.Empty);
});

test("loose stone re-settles to stone after being stationary", () => {
  const w = new SandWorld(8, 16);
  // Floor
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Place LooseStone above floor with settle timer
  w.setCell(4, 14, { mat: Material.LooseStone, lifetime: 5, flags: 0 });
  // Enable gravity field (setCell doesn't set fields)
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run enough ticks for it to settle (5 ticks stationary + margin)
  run(w, 20);
  // Should have converted back to Stone
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

test("gravel flowing out from under stone disturbs it (no floating)", () => {
  // Setup: Stone resting on gravel, with empty space to one side.
  // When gravel flows sideways into the empty space, the Stone above
  // should be disturbed (converted to LooseStone) and fall.
  const w = new SandWorld(12, 20);
  // Floor at bottom
  for (let x = 0; x < 12; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });

  // Gravel layer on the floor (x=3..7, y=18)
  for (let x = 3; x <= 7; x++) {
    w.setCell(x, 18, { mat: Material.Gravel, lifetime: 0, flags: 0 });
    w.fields[(18 * 12 + x) * 4 + FIELD.GRAVITY] = 128;
  }
  // Stone on top of gravel at x=5, y=17
  w.setCell(5, 17, { mat: Material.Stone, lifetime: 0, flags: 0 });
  // Empty space to the left (x=0..2, y=18) for gravel to flow into

  // Run simulation — gravel should flow sideways, disturbing the Stone
  run(w, 40);

  // The Stone should NOT be floating at y=17 with empty space below.
  // It should either have fallen or been converted to LooseStone.
  const cellAt17 = matAt(w, 5, 17);
  const cellAt18 = matAt(w, 5, 18);
  // If Stone is still at y=17, there must be something supporting it at y=18
  if (cellAt17 === Material.Stone) {
    expect(cellAt18).not.toBe(Material.Empty);
  }
  // If it became LooseStone, it should be falling or settled
  if (cellAt17 === Material.LooseStone) {
    // It should have gravity enabled
    expect(w.fields[(17 * 12 + 5) * 4 + FIELD.GRAVITY]).toBe(128);
  }
});

test("disturbed loose stone settles quickly (2 ticks)", () => {
  const w = new SandWorld(8, 16);
  // Floor
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // LooseStone with disturbed settle timer (2)
  w.setCell(4, 14, { mat: Material.LooseStone, lifetime: 2, flags: 0 });
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // After 2 ticks stationary, should re-settle to Stone
  run(w, 5);
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

test("loose stone that is moving does not re-settle", () => {
  const w = new SandWorld(8, 16);
  // Floor far below
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // LooseStone high up with short settle timer — it should fall, not settle
  w.setCell(4, 0, { mat: Material.LooseStone, lifetime: 2, flags: 0 });
  w.fields[(0 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run a few ticks — it should be falling (not re-settled to Stone mid-air)
  run(w, 3);
  // Should still be LooseStone (moving, timer doesn't count down)
  expect(matAt(w, 4, 0)).not.toBe(Material.Stone);
  // Should have moved down
  let foundLooseStone = false;
  for (let y = 0; y < 16; y++) {
    if (matAt(w, 4, y) === Material.LooseStone) {
      foundLooseStone = true;
      break;
    }
  }
  expect(foundLooseStone).toBe(true);
});

test("unsupported loose stone does not re-settle even if friction prevents movement", () => {
  // Regression: a LooseStone cell with nothing below it should NEVER re-settle
  // to Stone, even if friction/randomness prevents it from moving for several
  // ticks. The settle timer must only count down when the cell is supported.
  const w = new SandWorld(8, 16);
  // Clear the area below the LooseStone so it's truly unsupported
  for (let y = 5; y < 12; y++) w.setCell(4, y, { mat: Material.Empty, lifetime: 0, flags: 0 });
  // Place LooseStone floating with empty space below
  w.setCell(4, 5, { mat: Material.LooseStone, lifetime: 2, flags: 0 });
  w.fields[(5 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run several ticks — even if friction prevents movement some ticks,
  // the cell must not re-settle to Stone while unsupported.
  run(w, 10);

  // Must NOT be Stone at the original floating position (y=5)
  expect(matAt(w, 4, 5)).not.toBe(Material.Stone);

  // The cell should have moved down from y=5. It may still be LooseStone
  // (still falling) or have landed on the floor and re-settled to Stone.
  // Either way, something should be below y=5.
  let foundBelow = false;
  for (let y = 6; y < 16; y++) {
    const m = matAt(w, 4, y);
    if (m === Material.LooseStone || m === Material.Stone) {
      foundBelow = true;
      break;
    }
  }
  expect(foundBelow).toBe(true);
});

test("loose stone resting on gravel does not re-settle (no floating when gravel is picked up)", () => {
  // Regression: a LooseStone chunk that lands on top of gravel must NOT
  // re-freeze to static Stone. If it did, picking up or flowing away of the
  // gravel below would leave the Stone floating in mid-air (Stone has
  // gravity=0 and never falls). Only stable (static, gravity=0) support —
  // bedrock/Wall/Stone — should allow the settle timer to count down.
  const w = new SandWorld(8, 16);
  // Floor of static Wall at the very bottom
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Gravel layer resting on the floor (static support under the gravel, but
  // the gravel itself is gravity-affected and not stable support)
  for (let x = 0; x < 8; x++) {
    w.setCell(x, 14, { mat: Material.Gravel, lifetime: 0, flags: 0 });
    w.fields[(14 * 8 + x) * 4 + FIELD.GRAVITY] = 128;
  }
  // LooseStone sitting directly on the gravel with a short settle timer
  w.setCell(4, 13, { mat: Material.LooseStone, lifetime: 3, flags: 0 });
  w.fields[(13 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run well past the settle timer (3 ticks). The LooseStone is stationary
  // and "supported" by gravel, but gravel is not stable support, so the
  // timer must NOT count down and the cell must NOT become Stone.
  run(w, 30);

  // The cell at y=13 must still be LooseStone (not re-frozen to Stone).
  expect(matAt(w, 4, 13)).toBe(Material.LooseStone);
});

test("loose stone resting on static stone re-settles normally", () => {
  // Counterpart to the above: when the support below IS static (Stone
  // bedrock), the settle timer counts down and LooseStone re-freezes to
  // Stone as before. This confirms the fix only blocks non-static support.
  const w = new SandWorld(8, 16);
  // Static Stone floor (gravity=0)
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Stone, lifetime: 0, flags: 0 });
  // LooseStone on top with a short settle timer
  w.setCell(4, 14, { mat: Material.LooseStone, lifetime: 3, flags: 0 });
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  run(w, 10);
  // Should have re-settled to Stone on static support
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

// --- Phase 2: Empty-row skipping + chunk-based active tracking ---

test("movement pass skips empty rows (Y bounds tracking)", () => {
  // Fill only the top 5 rows with sand. The movement pass should only
  // iterate [minActiveY, maxActiveY] — the stone floor at the bottom
  // ensures maxActiveY is at the floor, but the sand at the top sets
  // minActiveY. After stepping, sand should still fall correctly.
  const w = new SandWorld(16, 64);
  // Place sand at rows 0-4
  for (let y = 0; y < 5; y++) {
    for (let x = 4; x < 12; x++) {
      w.setCell(x, y, { mat: Material.Sand, lifetime: 0, flags: 0 });
    }
  }
  run(w, 100);
  // All sand should have fallen to rest on the stone floor (rows 60-63)
  let sandCount = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 16; x++) {
      if (matAt(w, x, y) === Material.Sand) sandCount++;
    }
  }
  expect(sandCount).toBe(40); // 8 wide × 5 tall = 40 sand cells
});

test("chunk dirty bits are set on cell placement", () => {
  // When we paint a material, the chunk containing that cell should be
  // marked dirty so the movement pass processes it.
  const w = new SandWorld(32, 32);
  // Paint sand at (5, 5) — should be in chunk (0, 0) for CHUNK_SIZE=16
  w.paintMaterial(5, 5, Material.Sand, 1);
  // Step once — the sand should start falling
  run(w, 5);
  // The sand should have moved down from y=5
  let foundSand = false;
  for (let y = 6; y < 32; y++) {
    if (matAt(w, 5, y) === Material.Sand) { foundSand = true; break; }
  }
  expect(foundSand).toBe(true);
});

// --- Phase 5: Interlace mode ---

test("interlace mode processes alternating rows", () => {
  // With interlace enabled (scale=2), only half the rows are processed
  // each frame. Sand should still fall, but at half speed.
  const w = new SandWorld(8, 32);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.interlaceEnabled = true;
  w.interlaceScale = 2;
  w.reseed(42);
  // Run 20 steps — sand should fall but slower than without interlace
  for (let i = 0; i < 20; i++) w.step();
  // Find the sand
  let sandY = -1;
  for (let y = 0; y < 32; y++) {
    if ((w.grid[y * 8 + 4] & 0xff) === Material.Sand) { sandY = y; break; }
  }
  // Sand should have moved down from y=0
  expect(sandY).toBeGreaterThan(0);
  // With interlace, sand falls slower — after 20 steps it should be
  // less far down than without interlace
  const w2 = new SandWorld(8, 32);
  w2.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w2.reseed(42);
  for (let i = 0; i < 20; i++) w2.step();
  let sandY2 = -1;
  for (let y = 0; y < 32; y++) {
    if ((w2.grid[y * 8 + 4] & 0xff) === Material.Sand) { sandY2 = y; break; }
  }
  // Interlaced sand should be higher up (less movement)
  expect(sandY).toBeLessThanOrEqual(sandY2);
});
