import { describe, expect, it } from "bun:test";
import {
    BLOCK_AIR,
    BLOCK_COMPOST_FARMLAND,
    BLOCK_CROP_MATURE_BROWN_MUSHROOM,
    BLOCK_CROP_MATURE_TOMATO, BLOCK_CROP_SEED_BROWN_MUSHROOM,
    BLOCK_CROP_SEED_TOMATO, BLOCK_CROP_SPROUT_TOMATO,
    BLOCK_GRASS,
    BLOCK_WILD_BERRY_BUSH, BLOCK_WILD_MUSHROOM,
} from "../shared/constants";
import { getCropById, getWildCropByBlock } from "../shared/crops";
import {
    clearCropTracking,
    recordCropPlant, recordWildHarvest,
    stepCropGrowth,
} from "./crop-growth";

const W = 16, H = 16;

function makeGrid(): { fg: Uint16Array; bg: Uint16Array; light: Uint8Array } {
  return {
    fg: new Uint16Array(W * H),
    bg: new Uint16Array(W * H),
    light: new Uint8Array(W * H),
  };
}

describe("crop-growth", () => {
  it("does nothing before the growth interval", () => {
    clearCropTracking();
    const g = makeGrid();
    g.fg[5 * W + 5] = BLOCK_CROP_SEED_TOMATO;
    recordCropPlant(5, 5, 0);
    // Tick 10 is not a multiple of 60, so nothing happens
    const changed = stepCropGrowth(g.fg, g.bg, g.light, 10, "spring", W, H);
    expect(changed).toBe(false);
    expect(g.fg[5 * W + 5]).toBe(BLOCK_CROP_SEED_TOMATO);
  });

  it("advances a crop to the next stage after enough ticks", () => {
    clearCropTracking();
    const g = makeGrid();
    g.fg[5 * W + 5] = BLOCK_CROP_SEED_TOMATO;
    g.light[5 * W + 5] = 15; // full daylight
    recordCropPlant(5, 5, 0);
    const crop = getCropById("tomato")!;
    const required = crop.stageTicks[0];
    // Tick at the growth interval that's >= required
    const tick = Math.ceil(required / 60) * 60;
    const changed = stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    expect(changed).toBe(true);
    expect(g.fg[5 * W + 5]).toBe(BLOCK_CROP_SPROUT_TOMATO);
  });

  it("advances through all stages to mature", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 3, y = 3;
    g.fg[y * W + x] = BLOCK_CROP_SEED_TOMATO;
    g.light[y * W + x] = 15;
    recordCropPlant(x, y, 0);
    const crop = getCropById("tomato")!;
    const total = crop.stageTicks[0] + crop.stageTicks[1] + crop.stageTicks[2];
    // Tick past all stages
    let tick = 0;
    while (tick < total + 120) {
      tick += 60;
      stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    }
    expect(g.fg[y * W + x]).toBe(BLOCK_CROP_MATURE_TOMATO);
  });

  it("does not grow crops without light (non-mushroom)", () => {
    clearCropTracking();
    const g = makeGrid();
    g.fg[5 * W + 5] = BLOCK_CROP_SEED_TOMATO;
    g.light[5 * W + 5] = 0; // pitch dark
    recordCropPlant(5, 5, 0);
    const crop = getCropById("tomato")!;
    const tick = Math.ceil(crop.stageTicks[0] / 60) * 60;
    const changed = stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    expect(changed).toBe(false);
    expect(g.fg[5 * W + 5]).toBe(BLOCK_CROP_SEED_TOMATO);
  });

  it("mushrooms grow without light", () => {
    clearCropTracking();
    const g = makeGrid();
    g.fg[5 * W + 5] = BLOCK_CROP_SEED_BROWN_MUSHROOM;
    g.light[5 * W + 5] = 0; // dark — mushrooms prefer this
    recordCropPlant(5, 5, 0);
    const crop = getCropById("brown_mushroom")!;
    const tick = Math.ceil(crop.stageTicks[0] / 60) * 60;
    const changed = stepCropGrowth(g.fg, g.bg, g.light, tick, "winter", W, H);
    expect(changed).toBe(true);
    // Should have advanced to sprout
    expect(g.fg[5 * W + 5]).not.toBe(BLOCK_CROP_SEED_BROWN_MUSHROOM);
  });

  it("crops don't grow outside their growSeasons", () => {
    clearCropTracking();
    const g = makeGrid();
    // Use a crop that is cold-tolerant enough to survive winter but still
    // can't grow in winter. Potato has coldTolerance 0.5, so it won't be
    // killed by winter (the kill check requires coldTolerance < 0.5).
    // But potato's growSeasons are spring/summer/autumn, so it won't grow
    // in winter.
    const { BLOCK_CROP_SEED_POTATO } = require("../shared/constants");
    g.fg[5 * W + 5] = BLOCK_CROP_SEED_POTATO;
    g.light[5 * W + 5] = 15;
    // Shelter the crop so winter kill doesn't trigger
    g.fg[4 * W + 5] = BLOCK_GRASS;
    recordCropPlant(5, 5, 0);
    const crop = getCropById("potato")!;
    const tick = Math.ceil(crop.stageTicks[0] / 60) * 60;
    const changed = stepCropGrowth(g.fg, g.bg, g.light, tick, "winter", W, H);
    expect(changed).toBe(false);
    expect(g.fg[5 * W + 5]).toBe(BLOCK_CROP_SEED_POTATO);
  });

  it("winter can kill cold-sensitive unsheltered crops", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    g.fg[y * W + x] = BLOCK_CROP_SEED_TOMATO;
    g.light[y * W + x] = 15;
    // No block above (y-1 is air) → not sheltered
    recordCropPlant(x, y, 0);
    // Run many winter ticks — the crop should eventually die
    let died = false;
    for (let tick = 60; tick < 6000; tick += 60) {
      stepCropGrowth(g.fg, g.bg, g.light, tick, "winter", W, H);
      if (g.fg[y * W + x] === BLOCK_AIR) {
        died = true;
        break;
      }
    }
    expect(died).toBe(true);
  });

  it("sheltered crops survive winter (block above)", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    g.fg[y * W + x] = BLOCK_CROP_SEED_TOMATO;
    g.light[y * W + x] = 15;
    // Place a block above to provide shelter
    g.fg[(y - 1) * W + x] = BLOCK_GRASS;
    recordCropPlant(x, y, 0);
    // Run many winter ticks — the crop should NOT die (sheltered)
    for (let tick = 60; tick < 6000; tick += 60) {
      stepCropGrowth(g.fg, g.bg, g.light, tick, "winter", W, H);
    }
    // Crop should still be there (either seed or died from bad luck, but
    // sheltered means WINTER_KILL_CHANCE doesn't apply)
    expect(g.fg[y * W + x]).not.toBe(BLOCK_AIR);
  });

  it("mature mushrooms can spread to adjacent compost farmland", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    // Mature mushroom at (x, y)
    g.fg[y * W + x] = BLOCK_CROP_MATURE_BROWN_MUSHROOM;
    // Place compost farmland below ALL adjacent cells so any spread direction works
    // Adjacent cells: (x, y-1), (x+1, y), (x-1, y), (x, y+1)
    // Below (x, y-1) is (x, y) which is the mushroom — not compost. So skip up.
    // Below (x+1, y) is (x+1, y+1)
    g.fg[(y + 1) * W + (x + 1)] = BLOCK_COMPOST_FARMLAND;
    // Below (x-1, y) is (x-1, y+1)
    g.fg[(y + 1) * W + (x - 1)] = BLOCK_COMPOST_FARMLAND;
    // Below (x, y+1) is (x, y+2)
    g.fg[(y + 2) * W + x] = BLOCK_COMPOST_FARMLAND;
    // Run many ticks — the mushroom should eventually spread
    let spread = false;
    for (let tick = 60; tick < 10000; tick += 60) {
      stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
      // Check all adjacent cells
      if (g.fg[y * W + (x + 1)] !== BLOCK_AIR ||
          g.fg[y * W + (x - 1)] !== BLOCK_AIR ||
          g.fg[(y + 1) * W + x] !== BLOCK_AIR) {
        spread = true;
        break;
      }
    }
    expect(spread).toBe(true);
  });

  it("clearCropTracking resets all tracking", () => {
    recordCropPlant(1, 2, 100);
    recordWildHarvest(3, 4, 200, BLOCK_WILD_BERRY_BUSH, 6000);
    clearCropTracking();
    // After clearing, a crop planted at tick 100 should now be treated as
    // freshly planted at whatever tick we pass to stepCropGrowth.
    const g = makeGrid();
    g.fg[2 * W + 1] = BLOCK_CROP_SEED_TOMATO;
    g.light[2 * W + 1] = 15;
    // With no recorded plant tick, the crop's age = 0 at tick 60, so it
    // shouldn't have grown yet (tomato stage 0 needs 600 ticks).
    const changed = stepCropGrowth(g.fg, g.bg, g.light, 60, "spring", W, H);
    expect(changed).toBe(false);
  });

  it("wild berry bush regrows as the same type after harvest", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    // Grass below the harvested cell
    g.fg[(y + 1) * W + x] = BLOCK_GRASS;
    const wc = getWildCropByBlock(BLOCK_WILD_BERRY_BUSH)!;
    recordWildHarvest(x, y, 0, BLOCK_WILD_BERRY_BUSH, wc.regrowTicks);
    // Advance past regrowTicks (6000) — should regrow as berry bush
    const tick = Math.ceil(wc.regrowTicks / 60) * 60;
    stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    expect(g.fg[y * W + x]).toBe(BLOCK_WILD_BERRY_BUSH);
  });

  it("wild mushroom regrows as the same type (not berry bush) after harvest", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    g.fg[(y + 1) * W + x] = BLOCK_GRASS;
    const wc = getWildCropByBlock(BLOCK_WILD_MUSHROOM)!;
    recordWildHarvest(x, y, 0, BLOCK_WILD_MUSHROOM, wc.regrowTicks);
    // Mushroom regrows at 4000 ticks (faster than berry bush 6000)
    const tick = Math.ceil(wc.regrowTicks / 60) * 60;
    stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    // Must be a mushroom, NOT a berry bush (the old bug regrew the wrong type)
    expect(g.fg[y * W + x]).toBe(BLOCK_WILD_MUSHROOM);
    expect(g.fg[y * W + x]).not.toBe(BLOCK_WILD_BERRY_BUSH);
  });

  it("wild crop does not regrow before its regrowTicks", () => {
    clearCropTracking();
    const g = makeGrid();
    const x = 5, y = 5;
    g.fg[(y + 1) * W + x] = BLOCK_GRASS;
    const wc = getWildCropByBlock(BLOCK_WILD_BERRY_BUSH)!;
    recordWildHarvest(x, y, 0, BLOCK_WILD_BERRY_BUSH, wc.regrowTicks);
    // Advance to just before regrowTicks
    const tick = Math.ceil((wc.regrowTicks - 60) / 60) * 60;
    stepCropGrowth(g.fg, g.bg, g.light, tick, "spring", W, H);
    expect(g.fg[y * W + x]).toBe(BLOCK_AIR); // not yet regrown
  });
});
