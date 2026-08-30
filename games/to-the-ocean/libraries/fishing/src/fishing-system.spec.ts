import { describe, expect, it, spyOn } from "bun:test";
import { FishingSystem } from "./fishing-system";
import { FishingMethod } from "./types";
import type { FishingDeps } from "./fishing-system";
import type { FishingPlayer, FishingInput, WaterProvider, FishingBiomeProvider, FishingWeatherProvider, AddItemFn, FishingEventFn } from "./types";

function makeMockBiome(biome: number): FishingBiomeProvider {
  return { getBiomeAt: () => biome };
}

function makeMockWeather(): FishingWeatherProvider {
  return { getState: () => ({ type: 0, visibility: 1 }) };
}

function makeMockWater(): WaterProvider {
  return {
    getPatchSize: () => 4,
    getOrigin: () => ({ x: 0, z: 0 }),
    sampleHeight: () => 0,
  };
}

function makeMockAddItem(): AddItemFn {
  return () => 0;
}

function makeMockOnEvent(): FishingEventFn {
  return () => {};
}

function makeDeps(overrides?: Partial<FishingDeps>): FishingDeps {
  return {
    biomeProvider: makeMockBiome(7),
    weatherProvider: makeMockWeather(),
    waterProvider: makeMockWater(),
    addItem: makeMockAddItem(),
    onEvent: makeMockOnEvent(),
    ...overrides,
  };
}

function makePlayer(): FishingPlayer {
  return {
    active: true,
    position: { x: 0, y: 5, z: 0 },
    flags: 0,
    inventory: { slots: [], width: 10, height: 6 },
  };
}

function makeInput(): FishingInput {
  return {
    isKeyDown: () => false,
    isMouseDown: () => false,
  };
}

describe("FishingSystem empty catch pool", () => {
  it("handles empty catch pool gracefully without undefined access", () => {
    const deps = makeDeps({
      getCatchPool: () => [],
    });
    const fs = new FishingSystem(deps);
    const player = makePlayer();
    player.flags = 1 << 5;

    fs.startMinigame(0, FishingMethod.LineFishing, 7, 1);
    const mg = fs.getMinigameState(0);
    expect(mg).not.toBe(null);
    if (!mg) return;

    mg.progress = 1;
    fs.tick(1 / 60, makeInput(), [player], 1);

    expect(fs.getMinigameState(0)).toBe(null);
  });
});

describe("FishingSystem seeded RNG", () => {
  it("produces deterministic results with same seed", () => {
    const deps1 = makeDeps();
    const deps2 = makeDeps();
    const fs1 = new FishingSystem(deps1);
    const fs2 = new FishingSystem(deps2);

    fs1.setRngSeed(12345);
    fs2.setRngSeed(12345);

    fs1.startMinigame(0, FishingMethod.LineFishing, 7, 1);
    fs2.startMinigame(0, FishingMethod.LineFishing, 7, 1);

    const mg1 = fs1.getMinigameState(0);
    const mg2 = fs2.getMinigameState(0);
    expect(mg1).not.toBe(null);
    expect(mg2).not.toBe(null);
    if (!mg1 || !mg2) return;

    expect(mg1.fishRarity).toBe(mg2.fishRarity);
    expect(mg1.fishSize).toBe(mg2.fishSize);
  });
});
