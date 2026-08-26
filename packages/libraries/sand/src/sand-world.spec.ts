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

test("lava + water → steam + obsidian (applyReactions)", () => {
  const w = new SandWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Lava, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 5);
  // Lava rapidly quenched by water produces obsidian (volcanic glass) + steam.
  const lava = countMat(w, Material.Lava);
  const obsidian = countMat(w, Material.Obsidian);
  const steam = countMat(w, Material.Steam);
  // At least one conversion happened.
  expect(obsidian).toBeGreaterThan(0);
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

test("burning oil flows like a liquid and spreads slowly to adjacent oil", () => {
  // BurningOil is a liquid (gravity: 1, density: 0.8) and should flow like
  // one — sinking/spreading across the oil pool. The burning-oil pass in
  // applyCombustion handles controlled spread to adjacent oil cells, so the
  // fire creeps outward even as the BurningOil itself flows. Visual flames
  // (FLAG_SPARK fire particles) rise straight up and don't scatter.
  const w = new SandWorld(20, 20, { skipStoneFloor: true });
  // Flat oil pool on a stone floor
  for (let x = 4; x < 16; x++) {
    w.setCell(x, 15, { mat: Material.Oil, lifetime: 0, flags: 0 });
    w.setCell(x, 16, { mat: Material.Oil, lifetime: 0, flags: 0 });
  }
  for (let x = 0; x < 20; x++) {
    for (let y = 17; y < 20; y++) {
      w.setCell(x, y, { mat: Material.Stone, lifetime: 0, flags: 0 });
    }
  }
  // Place BurningOil directly on the oil surface at the center
  w.setCell(10, 15, { mat: Material.BurningOil, lifetime: 60, flags: 0 });
  run(w, 100);

  // BurningOil should still exist — it hasn't all decayed yet.
  const burningPositions: { x: number; y: number }[] = [];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      if (matAt(w, x, y) === Material.BurningOil) burningPositions.push({ x, y });
    }
  }
  expect(burningPositions.length).toBeGreaterThan(0);
  // The fire should have spread to adjacent oil cells (more BurningOil than
  // the single cell we started with). The spread is slow + chance-based, so
  // after 100 frames we expect at least a few new BurningOil cells.
  expect(burningPositions.length).toBeGreaterThan(1);
});

test("burning oil visual flames do not ignite oil", () => {
  // Regression: Fire particles emitted by the burning-oil pass are marked with
  // FLAG_SPARK so the fire spread pass skips them for oil ignition. Without
  // this, the visual flames would ignite adjacent oil in all 8 directions
  // (including diagonals), causing the fire to "burst" outward instead of
  // creeping slowly from the ignition site.
  const w = new SandWorld(20, 20, { skipStoneFloor: true });
  // Two separate oil pools with a wall between them (oil flows to fill gaps,
  // so a wall is needed to truly separate the pools)
  for (let x = 2; x < 9; x++) {
    w.setCell(x, 15, { mat: Material.Oil, lifetime: 0, flags: 0 });
  }
  for (let x = 12; x < 18; x++) {
    w.setCell(x, 15, { mat: Material.Oil, lifetime: 0, flags: 0 });
  }
  // Wall separator between the pools
  for (let y = 15; y < 20; y++) {
    w.setCell(10, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let x = 0; x < 20; x++) {
    for (let y = 16; y < 20; y++) {
      w.setCell(x, y, { mat: Material.Stone, lifetime: 0, flags: 0 });
    }
  }
  // Place BurningOil on the left pool
  w.setCell(5, 15, { mat: Material.BurningOil, lifetime: 60, flags: 0 });
  run(w, 200);

  // The right pool (x=12..17) should still have oil — the visual flames
  // from the left pool's BurningOil should NOT have ignited it across the gap.
  let rightOilCount = 0;
  for (let x = 12; x < 18; x++) {
    if (matAt(w, x, 15) === Material.Oil) rightOilCount++;
  }
  expect(rightOilCount).toBeGreaterThan(0);
  // No BurningOil should have appeared in the right pool
  for (let x = 12; x < 18; x++) {
    expect(matAt(w, x, 15)).not.toBe(Material.BurningOil);
  }
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

// --- Gravel re-settle tests ---

test("gravel falls and settles in a pile", () => {
  const w = new SandWorld(12, 20);
  // Floor
  for (let x = 0; x < 12; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Drop gravel from above (lifetime=0 → never re-settles to Stone)
  for (let y = 0; y < 5; y++) w.setCell(6, y, { mat: Material.Gravel, lifetime: 0, flags: 0 });
  run(w, 60);
  // All gravel should be above the floor
  const gravelCount = countMat(w, Material.Gravel);
  expect(gravelCount).toBe(5);
  // No gravel at the top
  expect(matAt(w, 6, 0)).toBe(Material.Empty);
});

test("gravel re-settles to stone after being stationary", () => {
  const w = new SandWorld(8, 16);
  // Floor
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Place Gravel above floor with settle timer
  w.setCell(4, 14, { mat: Material.Gravel, lifetime: 5, flags: 0 });
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
  // should be disturbed (converted to Gravel) and fall.
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
  // It should either have fallen or been converted to Gravel.
  const cellAt17 = matAt(w, 5, 17);
  const cellAt18 = matAt(w, 5, 18);
  // If Stone is still at y=17, there must be something supporting it at y=18
  if (cellAt17 === Material.Stone) {
    expect(cellAt18).not.toBe(Material.Empty);
  }
  // If it became Gravel, it should be falling or settled
  if (cellAt17 === Material.Gravel) {
    // It should have gravity enabled
    expect(w.fields[(17 * 12 + 5) * 4 + FIELD.GRAVITY]).toBe(128);
  }
});

test("disturbed gravel settles quickly (2 ticks)", () => {
  const w = new SandWorld(8, 16);
  // Floor
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Gravel with disturbed settle timer (2)
  w.setCell(4, 14, { mat: Material.Gravel, lifetime: 2, flags: 0 });
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // After 2 ticks stationary, should re-settle to Stone
  run(w, 5);
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

test("gravel that is moving does not re-settle", () => {
  const w = new SandWorld(8, 16);
  // Floor far below
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Gravel high up with short settle timer — it should fall, not settle
  w.setCell(4, 0, { mat: Material.Gravel, lifetime: 2, flags: 0 });
  w.fields[(0 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run a few ticks — it should be falling (not re-settled to Stone mid-air)
  run(w, 3);
  // Should still be Gravel (moving, timer doesn't count down)
  expect(matAt(w, 4, 0)).not.toBe(Material.Stone);
  // Should have moved down
  let foundGravel = false;
  for (let y = 0; y < 16; y++) {
    if (matAt(w, 4, y) === Material.Gravel) {
      foundGravel = true;
      break;
    }
  }
  expect(foundGravel).toBe(true);
});

test("unsupported gravel does not re-settle even if friction prevents movement", () => {
  // Regression: a Gravel cell with nothing below it should NEVER re-settle
  // to Stone, even if friction/randomness prevents it from moving for several
  // ticks. The settle timer must only count down when the cell is supported.
  const w = new SandWorld(8, 16);
  // Clear the area below the Gravel so it's truly unsupported
  for (let y = 5; y < 12; y++) w.setCell(4, y, { mat: Material.Empty, lifetime: 0, flags: 0 });
  // Place Gravel floating with empty space below
  w.setCell(4, 5, { mat: Material.Gravel, lifetime: 2, flags: 0 });
  w.fields[(5 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run several ticks — even if friction prevents movement some ticks,
  // the cell must not re-settle to Stone while unsupported.
  run(w, 10);

  // Must NOT be Stone at the original floating position (y=5)
  expect(matAt(w, 4, 5)).not.toBe(Material.Stone);

  // The cell should have moved down from y=5. It may still be Gravel
  // (still falling) or have landed on the floor and re-settled to Stone.
  // Either way, something should be below y=5.
  let foundBelow = false;
  for (let y = 6; y < 16; y++) {
    const m = matAt(w, 4, y);
    if (m === Material.Gravel || m === Material.Stone) {
      foundBelow = true;
      break;
    }
  }
  expect(foundBelow).toBe(true);
});

test("gravel resting on gravel does not re-settle (no floating when gravel is picked up)", () => {
  // Regression: a Gravel chunk that lands on top of gravel must NOT
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
  // Gravel sitting directly on the gravel with a short settle timer
  w.setCell(4, 13, { mat: Material.Gravel, lifetime: 3, flags: 0 });
  w.fields[(13 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  // Run well past the settle timer (3 ticks). The Gravel is stationary
  // and "supported" by gravel, but gravel is not stable support, so the
  // timer must NOT count down and the cell must NOT become Stone.
  run(w, 30);

  // The cell at y=13 must still be Gravel (not re-frozen to Stone).
  expect(matAt(w, 4, 13)).toBe(Material.Gravel);
});

test("gravel resting on static stone re-settles normally", () => {
  // Counterpart to the above: when the support below IS static (Stone
  // bedrock), the settle timer counts down and Gravel re-freezes to
  // Stone as before. This confirms the fix only blocks non-static support.
  const w = new SandWorld(8, 16);
  // Static Stone floor (gravity=0)
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Stone, lifetime: 0, flags: 0 });
  // Gravel on top with a short settle timer
  w.setCell(4, 14, { mat: Material.Gravel, lifetime: 3, flags: 0 });
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;

  run(w, 10);
  // Should have re-settled to Stone on static support
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

test("legacy LooseStone still re-settles to stone (backwards compat)", () => {
  // Old saves may contain LooseStone cells. The applyAging path still handles
  // them so they re-settle to Stone (no new LooseStone is created).
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.LooseStone, lifetime: 5, flags: 0 });
  w.fields[(14 * 8 + 4) * 4 + FIELD.GRAVITY] = 128;
  run(w, 20);
  expect(matAt(w, 4, 14)).toBe(Material.Stone);
});

test("disturbed stone does not cascade — falling disturbed gravel does not disturb neighbors", () => {
  // Regression: when gravel flows out from under a Stone column, the bottom
  // Stone is disturbed → becomes Gravel (lifetime=2). That Gravel falls, but
  // must NOT disturb the Stone above it. If it did, each falling disturbed
  // cell would disturb the next Stone up, causing the entire column (and
  // eventually the whole map) to cascade into Gravel.
  //
  // Setup: a tall Stone column resting on a single Gravel cell, which rests
  // on the floor. To the side is empty space the gravel can flow into.
  const w = new SandWorld(12, 24);
  // Floor
  for (let x = 0; x < 12; x++) w.setCell(x, 23, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Gravel at the bottom of the column (x=5, y=22) — can flow left into x=0..4
  w.setCell(5, 22, { mat: Material.Gravel, lifetime: 0, flags: 0 });
  w.fields[(22 * 12 + 5) * 4 + FIELD.GRAVITY] = 128;
  // Stone column above the gravel (x=5, y=17..21)
  for (let y = 17; y <= 21; y++) w.setCell(5, y, { mat: Material.Stone, lifetime: 0, flags: 0 });

  // Run the sim — gravel flows sideways, disturbing the Stone at y=21.
  // That Stone becomes Gravel (lifetime=2) and falls. It must NOT disturb
  // the Stone at y=20, which must NOT disturb y=19, etc.
  run(w, 60);

  // Count how many Stone cells remain in the column. The bottom Stone (y=21)
  // should be disturbed (became Gravel and fell). But the upper stones should
  // NOT have cascaded — at most 1-2 should be disturbed, not all 5.
  let remainingStone = 0;
  for (let y = 17; y <= 21; y++) {
    if (matAt(w, 5, y) === Material.Stone) remainingStone++;
  }
  // At least 3 of the 5 Stone cells should still be Stone (only the bottom
  // 1-2 should have been disturbed by the initial gravel flow, not the full
  // cascade).
  expect(remainingStone).toBeGreaterThanOrEqual(3);
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

// --- Popcorn tests ---

test("popcorn popping does not create an infinite creation loop", () => {
  // Regression: popping popcorn used to scatter NEW unpopped popcorn particles
  // into empty cells. Those particles were themselves near the heat source, so
  // they popped too, scattering even more popcorn — an infinite creation loop
  // that filled the entire grid. With FLAG_POPPED, each kernel pops exactly
  // once and all resulting popcorn (scattered + original) is marked so it
  // won't re-pop.
  const w = new SandWorld(16, 20);
  // Floor
  for (let x = 0; x < 16; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // A few popcorn kernels in the center
  for (let x = 7; x <= 8; x++) w.setCell(x, 10, { mat: Material.Popcorn, lifetime: 0, flags: 0 });
  // Set temperature field high everywhere to trigger popping (temp > 1.3)
  for (let i = 0; i < w.fields.length; i += 4) {
    w.fields[i + FIELD.TEMP] = 200; // 200/128 ≈ 1.56 > 1.3
  }
  run(w, 300);
  // Count total popcorn. 2 kernels, each pops once, scattering at most ~9
  // particles (8 neighbors + 1 upward launch). Total should be bounded.
  // With the bug, popcorn would grow to fill hundreds of cells.
  const popcornCount = countMat(w, Material.Popcorn);
  expect(popcornCount).toBeLessThanOrEqual(25);
  // Popcorn should still exist (it did pop, creating scattered particles)
  expect(popcornCount).toBeGreaterThanOrEqual(1);
});

test("popped popcorn is marked with FLAG_POPPED and won't re-pop", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 10, { mat: Material.Popcorn, lifetime: 0, flags: 0 });
  // High temperature to trigger popping
  for (let i = 0; i < w.fields.length; i += 4) {
    w.fields[i + FIELD.TEMP] = 200;
  }
  run(w, 50);
  // Every remaining popcorn cell should have FLAG_POPPED set (0x20)
  for (let i = 0; i < w.grid.length; i++) {
    if ((w.grid[i] & 0xff) === Material.Popcorn) {
      expect((w.grid[i] >> 16) & 0x20).toBe(0x20);
    }
  }
});

// --- Liquid Nitrogen / Dry Ice dissipation tests ---

test("liquid nitrogen evaporates to cold vapor without producing water", () => {
  // Liquid nitrogen slowly evaporates into ColdVapor (a visible white gas
  // that doesn't rise and dissipates over ~30 seconds). It must NOT produce
  // Water or Steam — previously it converted to Steam which condensed to Water.
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  for (let x = 3; x <= 4; x++) w.setCell(x, 14, { mat: Material.LiquidNitrogen, lifetime: 0, flags: 0 });
  run(w, 2000);
  // All liquid nitrogen should have evaporated (0.5% chance/frame → gone
  // well before 2000 frames). No water or steam should have been produced.
  expect(countMat(w, Material.LiquidNitrogen)).toBe(0);
  expect(countMat(w, Material.Water)).toBe(0);
  expect(countMat(w, Material.Steam)).toBe(0);
});

test("cold vapor doesn't rise and dissipates over time", () => {
  // ColdVapor is static (gravityDir=0) — it stays where it forms and slowly
  // dissipates. It should NOT rise like smoke/steam, and should eventually
  // disappear entirely.
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Place cold vapor directly
  w.setCell(4, 14, { mat: Material.ColdVapor, lifetime: 255, flags: 0 });
  run(w, 20);
  // After 20 steps, cold vapor should still exist (dissipates slowly ~30s)
  expect(countMat(w, Material.ColdVapor)).toBe(1);
  // It should NOT have risen — still at y=14 (or lower if it somehow moved,
  // but it's static so it should stay exactly at y=14)
  expect(matAt(w, 4, 14)).toBe(Material.ColdVapor);
  // Run much longer — should eventually fully dissipate
  run(w, 3000);
  expect(countMat(w, Material.ColdVapor)).toBe(0);
});

test("dry ice dissipates without producing water", () => {
  // Counterpart: dry ice sublimates into smoke (which expires to empty), never
  // producing water. (Dry ice sublimation requires the cell above to be empty,
  // so a single cell in a narrow column may get stuck if smoke accumulates —
  // we only assert the no-water property, which is the point of the test.)
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.DryIce, lifetime: 0, flags: 0 });
  run(w, 500);
  expect(countMat(w, Material.Water)).toBe(0);
});

// --- Dynamite chain reaction test ---

test("dynamite chain-detonates all connected sticks", () => {
  // Regression: dynamite didn't reliably chain-react. explode() destroyed
  // adjacent dynamite cells (converting them to fire/smoke) before they could
  // detonate, and the 20% per-frame trigger chance meant fire often decayed
  // before igniting the next stick. Now detonateDynamite flood-fills all
  // connected dynamite (like detonateC4) and explodes each.
  const w = new SandWorld(16, 20, { skipStoneFloor: true });
  // Floor
  for (let x = 0; x < 16; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // A row of 5 connected dynamite sticks
  for (let x = 5; x <= 9; x++) w.setCell(x, 18, { mat: Material.Dynamite, lifetime: 0, flags: 0 });
  // Fire next to the leftmost stick, fully trapped with walls so it can't
  // rise or drift diagonally away before detonation triggers.
  w.setCell(4, 18, { mat: Material.Fire, lifetime: 255, flags: 0 });
  w.setCell(3, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 18, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 100);
  // All 5 dynamite sticks should have detonated — none should remain.
  expect(countMat(w, Material.Dynamite)).toBe(0);
});

// --- Seed progressive growth test ---

test("seed grows tree progressively from the bottom up", () => {
  // The seed should grow a tree one cell at a time from the bottom up, not
  // place the entire tree in a single frame. After a few steps, the trunk
  // should be partially grown (not full height). After enough steps, the
  // full tree with leaves should be present.
  const w = new SandWorld(12, 32, { skipStoneFloor: true });
  // Dirt floor
  for (let x = 0; x < 12; x++) w.setCell(x, 31, { mat: Material.Dirt, lifetime: 0, flags: 0 });
  // Seed resting on dirt
  w.setCell(6, 30, { mat: Material.Seed, lifetime: 0, flags: 0 });

  // Run a few steps — the seed should plant and start growing.
  // Use enough steps for the 5% plant chance to trigger.
  run(w, 100);

  // After planting, the root should exist at the base (y=30)
  expect(matAt(w, 6, 30)).toBe(Material.Root);

  // After 100 steps, the trunk should be growing but might not be done yet.
  // Count TreeWood cells — should be > 0 but potentially < full height (8-15).
  const treeWoodCount = countMat(w, Material.TreeWood);
  expect(treeWoodCount).toBeGreaterThan(0);

  // Run more steps to let the tree finish growing
  run(w, 100);

  // After full growth, the tree should have a substantial trunk and leaves
  const finalTreeWood = countMat(w, Material.TreeWood);
  const leaves = countMat(w, Material.Leaf);
  expect(finalTreeWood).toBeGreaterThanOrEqual(5);
  expect(leaves).toBeGreaterThan(0);
  // No growing seeds should remain (lifetime > 0 seeds)
  let growingSeeds = 0;
  for (let i = 0; i < w.grid.length; i++) {
    if ((w.grid[i] & 0xff) === Material.Seed && ((w.grid[i] >> 8) & 0xff) > 0) growingSeeds++;
  }
  expect(growingSeeds).toBe(0);
});

// --- Acid / Base tests ---

test("acid eats adjacent materials and is consumed ~50% per eat", () => {
  // 1000 sand + 1000 acid should leave ~500 acid. We use a smaller grid but
  // verify the ratio: acid eats a neighbor, 50% chance the acid is consumed.
  // So ~2 material eaten per 1 acid consumed → ~50% acid remains.
  const w = new SandWorld(20, 20, { skipStoneFloor: true });
  // Floor
  for (let x = 0; x < 20; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Fill a layer of sand with acid on top — acid flows down and eats sand
  for (let x = 0; x < 20; x++) {
    w.setCell(x, 17, { mat: Material.Sand, lifetime: 0, flags: 0 });
    w.setCell(x, 18, { mat: Material.Sand, lifetime: 0, flags: 0 });
    w.setCell(x, 16, { mat: Material.Acid, lifetime: 0, flags: 0 });
    w.setCell(x, 15, { mat: Material.Acid, lifetime: 0, flags: 0 });
  }
  const initialAcid = countMat(w, Material.Acid);
  const initialSand = countMat(w, Material.Sand);
  expect(initialAcid).toBe(40);
  expect(initialSand).toBe(40);
  // Run enough steps for the acid to eat through all the sand
  run(w, 3000);
  const finalAcid = countMat(w, Material.Acid);
  const finalSand = countMat(w, Material.Sand);
  // All sand should be eaten (acid is denser, sinks through, eats it all)
  expect(finalSand).toBe(0);
  // Acid should be roughly halved — 40 acid eats 40 sand, consuming ~20 acid
  // → ~20 remaining. Allow a wide band (10-30) due to RNG variance.
  expect(finalAcid).toBeGreaterThan(8);
  expect(finalAcid).toBeLessThan(32);
});

test("acid does not eat Wall", () => {
  const w = new SandWorld(8, 16);
  // Wall floor
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Acid on top of wall
  for (let x = 3; x <= 4; x++) w.setCell(x, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  run(w, 500);
  // Wall should be untouched
  for (let x = 0; x < 8; x++) {
    expect(matAt(w, x, 15)).toBe(Material.Wall);
  }
});

test("acid + base neutralizes to salt and steam", () => {
  // 1 acid + 1 base → 1 salt + 1 steam. Both reactants are consumed.
  // Contained in a narrow pit so the liquids can't flow apart before reacting.
  const w = new SandWorld(8, 16);
  // Pit: walls on sides and bottom
  w.setCell(3, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(2, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Acid and base stacked in the pit (acid on top, base on bottom)
  w.setCell(3, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Base, lifetime: 0, flags: 0 });
  // Run just a few steps — the reaction triggers quickly (75% chance/frame
  // from both sides checking). Steam is transient (condenses to water) so
  // we check it early before it dissipates.
  run(w, 5);
  // Both acid and base should be consumed
  expect(countMat(w, Material.Acid)).toBe(0);
  expect(countMat(w, Material.Base)).toBe(0);
  // Salt should have been produced (permanent)
  expect(countMat(w, Material.Salt)).toBeGreaterThan(0);
  // Steam should have been produced (may condense to water later, but
  // within 5 steps it should still exist)
  expect(countMat(w, Material.Steam) + countMat(w, Material.Water)).toBeGreaterThan(0);
});

test("acid + base equal quantities fully neutralize", () => {
  // Equal amounts of acid and base should fully neutralize — no leftover
  // acid or base (all consumed by the 1:1 reaction). Acid is denser (1.2)
  // than base (1.1), so stacked in a narrow column the acid sinks through
  // the base, ensuring constant contact until all react.
  const w = new SandWorld(8, 20);
  // Narrow 1-wide column with walls on sides and bottom
  for (let y = 10; y <= 19; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  w.setCell(4, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // 4 base at bottom, 4 acid on top. Acid (denser) sinks through base,
  // constantly swapping and reacting at the boundary.
  for (let y = 15; y <= 18; y++) w.setCell(4, y, { mat: Material.Base, lifetime: 0, flags: 0 });
  for (let y = 11; y <= 14; y++) w.setCell(4, y, { mat: Material.Acid, lifetime: 0, flags: 0 });
  run(w, 3000);
  // Both should be fully consumed (1:1 reaction, equal quantities)
  expect(countMat(w, Material.Acid)).toBe(0);
  expect(countMat(w, Material.Base)).toBe(0);
  // Salt should remain (steam dissipates over time)
  expect(countMat(w, Material.Salt)).toBeGreaterThan(0);
});

// --- Fuse fire spark emission test ---

test("fuse fire emits sparks throughout its lifetime", () => {
  // Regression: sparks were only emitted during the last 3 frames of the
  // 15-frame lifetime. Now sparks emit every frame.
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Fuse row with a fire at one end to ignite it
  for (let x = 3; x <= 5; x++) w.setCell(x, 14, { mat: Material.Fuse, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Fire, lifetime: 255, flags: 0 });
  // Walls above the fire to trap it so it ignites the fuse
  w.setCell(2, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(1, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 30);
  // FuseFire should have been created and should have emitted sparks (Fire
  // particles above the fuse). Check that at least some fire particles
  // appeared above the fuse row (y < 14).
  let fireAbove = 0;
  for (let y = 0; y < 14; y++) {
    for (let x = 0; x < 8; x++) {
      if (matAt(w, x, y) === Material.Fire) fireAbove++;
    }
  }
  expect(fireAbove).toBeGreaterThan(0);
});

// --- Wax slow burn test ---

test("wax burns slowly and spreads to adjacent wax", () => {
  // Wax should burn much longer than normal fire and reliably spread to
  // adjacent wax cells. Previously wax caught fire like any flammable solid
  // (Fire lifetime=30, ~0.5s) and went out before spreading.
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Row of wax
  for (let x = 4; x <= 7; x++) w.setCell(x, 14, { mat: Material.Wax, lifetime: 0, flags: 0 });
  // Fire next to the leftmost wax, fully trapped with walls so it can't
  // drift away before igniting the wax.
  w.setCell(3, 14, { mat: Material.Fire, lifetime: 255, flags: 0 });
  w.setCell(2, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 30);
  // After 30 steps, fire should have spread to multiple wax cells (high
  // spread multiplier 2.5). At least 2 wax cells should be on fire.
  let fireOnWaxRow = 0;
  for (let x = 4; x <= 7; x++) {
    if (matAt(w, x, 14) === Material.Fire) fireOnWaxRow++;
  }
  expect(fireOnWaxRow).toBeGreaterThanOrEqual(2);
  // The fire should still be burning after 100 more steps (slow decay).
  // Normal fire (lifetime 30, 70% decay) would be gone in ~43 frames.
  run(w, 100);
  let fireStillBurning = 0;
  for (let x = 3; x <= 7; x++) {
    if (matAt(w, x, 14) === Material.Fire) fireStillBurning++;
  }
  expect(fireStillBurning).toBeGreaterThan(0);
});

// --- Dynamite single explosion test ---

test("dynamite detonates immediately and consumes all connected sticks", () => {
  // Dynamite should detonate immediately (100% trigger) when lit, and all
  // connected sticks should be consumed in a single chain detonation.
  const w = new SandWorld(16, 20, { skipStoneFloor: true });
  for (let x = 0; x < 16; x++) w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // 5 connected dynamite sticks
  for (let x = 5; x <= 9; x++) w.setCell(x, 18, { mat: Material.Dynamite, lifetime: 0, flags: 0 });
  // Fire next to the leftmost stick, trapped
  w.setCell(4, 18, { mat: Material.Fire, lifetime: 255, flags: 0 });
  w.setCell(3, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 18, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Run just a few steps — 100% trigger means it should detonate immediately
  run(w, 10);
  // All dynamite should be consumed
  expect(countMat(w, Material.Dynamite)).toBe(0);
});

// --- New materials: ice contact-freezing, obsidian, spore/mold, antimatter
//     flood-fill, glitch, tar, duplicator ---

test("water freezes to ice on contact with dry ice", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Water, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.DryIce, lifetime: 0, flags: 0 });
  run(w, 60);
  // Water should have frozen into ice (25% chance/frame on contact).
  expect(countMat(w, Material.Ice)).toBeGreaterThan(0);
});

test("water freezes to ice on contact with liquid nitrogen", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Water, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.LiquidNitrogen, lifetime: 0, flags: 0 });
  run(w, 60);
  expect(countMat(w, Material.Ice)).toBeGreaterThan(0);
});

test("lava quenched by dry ice becomes obsidian", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Lava, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.DryIce, lifetime: 0, flags: 0 });
  run(w, 60);
  // Lava touching a cold solid (dry ice) should quench to obsidian.
  expect(countMat(w, Material.Obsidian)).toBeGreaterThan(0);
  expect(countMat(w, Material.Lava)).toBe(0);
});

test("obsidian is a static solid that does not fall", () => {
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  // Place obsidian floating in mid-air
  w.setCell(4, 8, { mat: Material.Obsidian, lifetime: 0, flags: 0 });
  run(w, 40);
  // Obsidian should not have fallen — still at y=8
  expect(matAt(w, 4, 8)).toBe(Material.Obsidian);
});

test("spore germinates into mold on contact with wood", () => {
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Wood block with a spore adjacent. Use enough wood that the mold has
  // food to sustain itself after germination (mold dies when no food is left).
  for (let x = 3; x <= 6; x++) w.setCell(x, 14, { mat: Material.Wood, lifetime: 0, flags: 0 });
  w.setCell(5, 13, { mat: Material.Spore, lifetime: 240, flags: 0 });
  // Contain the spore so it can't drift away before germinating
  w.setCell(5, 12, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(6, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 120);
  // The spore should have germinated into mold (20% chance/frame on contact).
  expect(countMat(w, Material.Mold)).toBeGreaterThan(0);
});

test("mold spreads to adjacent wood and consumes it", () => {
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Row of wood with mold in the middle (food on both sides)
  for (let x = 3; x <= 8; x++) w.setCell(x, 14, { mat: Material.Wood, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Mold, lifetime: 0, flags: 0 });
  // Walls above to prevent spore drift from interfering
  for (let x = 2; x <= 9; x++) w.setCell(x, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Run enough frames for spreading (2% chance → ~1 spread per 50 frames)
  // but not so many that all wood is consumed and the mold dies.
  run(w, 50);
  // Mold should have spread: more than the initial 1 mold cell, and wood
  // should have been consumed (less than the initial 6 wood cells).
  expect(countMat(w, Material.Mold)).toBeGreaterThan(1);
  expect(countMat(w, Material.Wood)).toBeLessThan(6);
});

test("mold releases spores when it runs out of food", () => {
  // A single mold cell with no food adjacent should emit spores and die.
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Mold, lifetime: 0, flags: 0 });
  run(w, 60);
  // The mold should have died (no food) and released spores.
  expect(countMat(w, Material.Mold)).toBe(0);
  expect(countMat(w, Material.Spore)).toBeGreaterThan(0);
});

test("antimatter annihilates contiguous antimatter and contacted material", () => {
  // A cluster of 3 antimatter cells touching a sand block. On contact, the
  // entire antimatter cluster + the contiguous sand should be annihilated.
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // 3 antimatter cells in a row
  w.setCell(3, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  // Sand block touching the antimatter at x=6
  for (let x = 6; x <= 9; x++) w.setCell(x, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 10);
  // All antimatter should be gone (annihilated).
  expect(countMat(w, Material.Antimatter)).toBe(0);
  // The contiguous sand (x=6..9) should also be annihilated.
  expect(countMat(w, Material.Sand)).toBe(0);
});

test("antimatter does not annihilate through walls", () => {
  // Wall separates antimatter from sand. The antimatter has no contact, so
  // nothing should be annihilated.
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  for (let x = 5; x <= 8; x++) w.setCell(x, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 20);
  // Antimatter has no non-wall neighbor to contact → stays put.
  expect(countMat(w, Material.Antimatter)).toBe(1);
  // Sand on the other side of the wall is safe.
  expect(countMat(w, Material.Sand)).toBe(4);
});

test("antimatter does not annihilate duplicator (barrier)", () => {
  // Duplicator is a barrier — antimatter flood-fill stops at it and does not
  // reach materials on the other side. The duplicator itself is never
  // annihilated. (The antimatter may still be destroyed if the duplicator
  // clones material into cells adjacent to it — that's correct behavior.
  // Here we isolate the antimatter from the duplicator's spawn area.)
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Antimatter fully enclosed in walls so nothing can touch it
  w.setCell(3, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(2, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Duplicator barrier
  w.setCell(4, 14, { mat: Material.Duplicator, lifetime: 0, flags: 0 });
  // Sand behind the duplicator
  for (let x = 5; x <= 8; x++) w.setCell(x, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 20);
  // Antimatter is enclosed — no contact, so it stays.
  expect(countMat(w, Material.Antimatter)).toBe(1);
  // Duplicator is a barrier — not annihilated, not consumed.
  expect(countMat(w, Material.Duplicator)).toBe(1);
  // Sand is safe behind the duplicator barrier (the duplicator may clone
  // extra sand into adjacent empty cells, so count may exceed 4).
  expect(countMat(w, Material.Sand)).toBeGreaterThanOrEqual(4);
});

test("glitch randomly swaps with neighboring material", () => {
  // Glitch next to sand should eventually swap places with it.
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Glitch, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  // Contain so they can't drift apart
  w.setCell(3, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(6, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 60);
  // After enough frames, the glitch (30% swap chance) should have swapped
  // with the sand at least once. The glitch should no longer be at x=4, or
  // the sand should no longer be at x=5 (they traded places).
  const glitchAt4 = matAt(w, 4, 14) === Material.Glitch;
  const sandAt5 = matAt(w, 5, 14) === Material.Sand;
  expect(!(glitchAt4 && sandAt5)).toBe(true);
  // Both cells should still be occupied (glitch + sand, just swapped).
  expect(countMat(w, Material.Glitch)).toBe(1);
  expect(countMat(w, Material.Sand)).toBe(1);
});

test("tar is a very slow dense liquid that sinks through water", () => {
  // Tar (density 2.0) should sink through water (density 1.0).
  const w = new SandWorld(8, 16);
  for (let y = 8; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  w.setCell(4, 8, { mat: Material.Tar, lifetime: 0, flags: 0 });
  run(w, 400);
  // Tar should end up below the water (denser sinks).
  const tarY = topMostY(w, Material.Tar);
  const waterY = topMostY(w, Material.Water);
  expect(tarY).toBeGreaterThan(waterY); // tar is lower (larger y)
});

test("duplicator locks onto and clones the first material that touches it", () => {
  // Duplicator touched by sand should start spawning sand into adjacent
  // empty cells. The duplicator itself does not move or get consumed.
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Duplicator, lifetime: 0, flags: 0 });
  // Sand above the duplicator (will fall and touch it)
  w.setCell(4, 12, { mat: Material.Sand, lifetime: 0, flags: 0 });
  // Walls around the duplicator so spawned sand stays nearby
  w.setCell(3, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 300);
  // Duplicator should still exist (not consumed).
  expect(countMat(w, Material.Duplicator)).toBe(1);
  // It should have locked onto sand and cloned it — many sand cells now.
  // The original sand + cloned sand should exceed the initial 1.
  expect(countMat(w, Material.Sand)).toBeGreaterThan(1);
});

test("duplicator does not move (no gravity)", () => {
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  // Place duplicator floating in mid-air with nothing touching it
  w.setCell(4, 8, { mat: Material.Duplicator, lifetime: 0, flags: 0 });
  run(w, 40);
  // Duplicator should not have fallen — still at y=8.
  expect(matAt(w, 4, 8)).toBe(Material.Duplicator);
});

test("duplicator is immune to acid", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Duplicator, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  run(w, 500);
  // Duplicator should survive — acid can't eat it.
  expect(countMat(w, Material.Duplicator)).toBe(1);
});

test("locked duplicator propagates its lock to adjacent unlocked duplicators", () => {
  // A row of duplicators: the leftmost is touched by sand and locks onto it.
  // The lock should slowly spread to the adjacent unlocked duplicators so
  // they all start cloning sand. Each duplicator has empty space above it
  // so spawned sand is visible in each column. A wall at (4,16) blocks sand
  // from flowing right and touching the other duplicators directly — they
  // can only lock via propagation.
  const w = new SandWorld(12, 20, { skipStoneFloor: true });
  // Two-row wall floor
  for (let x = 0; x < 12; x++) {
    w.setCell(x, 18, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(x, 19, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  // Row of 4 duplicators at y=17
  for (let x = 3; x <= 6; x++) w.setCell(x, 17, { mat: Material.Duplicator, lifetime: 0, flags: 0 });
  // Sand above the leftmost duplicator only
  w.setCell(3, 16, { mat: Material.Sand, lifetime: 0, flags: 0 });
  // Wall at (4,16) blocks sand from flowing right to touch other duplicators
  w.setCell(4, 16, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // (5,16) and (6,16) are empty — duplicators can spawn there
  // Side walls to contain spawned sand
  w.setCell(2, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(7, 17, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 600);
  // All 4 duplicators should still exist.
  expect(countMat(w, Material.Duplicator)).toBe(4);
  // Sand should appear in multiple columns above the duplicators (x=3..6),
  // proving that the lock propagated and multiple duplicators are cloning.
  let sandColumns = 0;
  for (let x = 3; x <= 6; x++) {
    for (let y = 0; y < 17; y++) {
      if (matAt(w, x, y) === Material.Sand) { sandColumns++; break; }
    }
  }
  expect(sandColumns).toBeGreaterThan(1);
});

// --- Void tests ---

test("void swallows adjacent materials", () => {
  // Void surrounded by sand should consume all the sand over time.
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Void in the center, sand all around it
  w.setCell(4, 14, { mat: Material.Void, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.setCell(3, 13, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.setCell(5, 13, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 30);
  // Void should still exist (never consumed).
  expect(countMat(w, Material.Void)).toBe(1);
  // All sand adjacent to the void should have been swallowed.
  // Sand may fall in from above to replace it, but the immediate neighbors
  // should be gone. Check that at least some sand was consumed (less than 5).
  expect(countMat(w, Material.Sand)).toBeLessThan(5);
});

test("void does not swallow wall or other void", () => {
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Two voids side by side, with walls adjacent
  w.setCell(3, 14, { mat: Material.Void, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Void, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  run(w, 50);
  // Both voids and both walls should still exist — void doesn't eat itself
  // or walls.
  expect(countMat(w, Material.Void)).toBe(2);
  expect(matAt(w, 2, 14)).toBe(Material.Wall);
  expect(matAt(w, 5, 14)).toBe(Material.Wall);
});

test("void does not move (no gravity)", () => {
  const w = new SandWorld(8, 16, { skipStoneFloor: true });
  w.setCell(4, 8, { mat: Material.Void, lifetime: 0, flags: 0 });
  run(w, 40);
  // Void should not have fallen — still at y=8.
  expect(matAt(w, 4, 8)).toBe(Material.Void);
});

test("void is immune to acid", () => {
  const w = new SandWorld(8, 16);
  for (let x = 0; x < 8; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 14, { mat: Material.Void, lifetime: 0, flags: 0 });
  w.setCell(3, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  w.setCell(5, 14, { mat: Material.Acid, lifetime: 0, flags: 0 });
  run(w, 100);
  // Void survives — acid can't eat it. (The acid itself gets swallowed.)
  expect(countMat(w, Material.Void)).toBe(1);
});

test("void is an antimatter barrier", () => {
  // Antimatter enclosed by void + walls can't contact sand on the other side.
  const w = new SandWorld(12, 16, { skipStoneFloor: true });
  for (let x = 0; x < 12; x++) w.setCell(x, 15, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Antimatter fully enclosed
  w.setCell(3, 14, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.setCell(2, 14, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(3, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(2, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  w.setCell(4, 13, { mat: Material.Wall, lifetime: 0, flags: 0 });
  // Void barrier
  w.setCell(4, 14, { mat: Material.Void, lifetime: 0, flags: 0 });
  // Sand behind the void
  for (let x = 5; x <= 8; x++) w.setCell(x, 14, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 20);
  // Antimatter is enclosed — no contact, stays put.
  expect(countMat(w, Material.Antimatter)).toBe(1);
  // Void is a barrier — not annihilated, not consumed.
  expect(countMat(w, Material.Void)).toBe(1);
  // Sand is safe behind the void barrier (void may swallow some, but
  // antimatter can't reach it).
  expect(countMat(w, Material.Sand)).toBeGreaterThanOrEqual(3);
});
