import { describe, expect, it } from "bun:test";
import { BiomeType, EntityType } from "../../shared/types";
import { getCrop, type CropId } from "../../shared/data/crops";
import { PlantSystem, PLANT_DATA_SLOTS, type PlantTickContext, type PlantData } from "./plant-system";

// Minimal SimEntity shape for tests.
interface TestEntity {
  id: number;
  type: EntityType;
  position: { x: number; y: number; z: number };
  data: Float32Array;
}
function makeEntity(id: number, type: EntityType = EntityType.Plant, x = 0, z = 0): TestEntity {
  return { id, type, position: { x, y: 0, z }, data: new Float32Array(PLANT_DATA_SLOTS) };
}

function makeCtx(overrides: Partial<PlantTickContext> = {}): PlantTickContext {
  return {
    dt: 1,
    biomeAt: () => BiomeType.SubTropical,
    coldStress: () => 0,
    heatStress: () => 0,
    isSheltered: () => false,
    spawnPlant: () => 0,
    removeEntity: () => {},
    ...overrides,
  };
}

describe("PlantSystem", () => {
  it("plant() accepts a known crop and water/harvest flow works", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(1);
    expect(ps.plant(1, "tomato")).toBe(true);

    // Water
    expect(ps.water(1)).toBe(true);

    // Not harvestable at stage 0
    expect(ps.harvest(1)).toBeNull();

    // Fast-forward to mature by ticking past all stage durations.
    const crop = getCrop("tomato")!;
    const total = crop.stageDurations[0] + crop.stageDurations[1] + crop.stageDurations[2] + 1;
    const ctx = makeCtx({ dt: total });
    ps.tick(ctx, [ent], 1);
    const pd = ps.getPlantData(1)!;
    expect(pd.growthStage).toBe(3);

    // Harvest
    const result = ps.harvest(1);
    expect(result).not.toBeNull();
    expect(result!.cropItemId).toBe("tomato");
    expect(result!.quantity).toBeGreaterThanOrEqual(1);

    // After harvest, non-bush resets to seed
    const after = ps.getPlantData(1)!;
    expect(after.growthStage).toBe(0);
  });

  it("bushes regrow fruit instead of resetting", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(2);
    ps.plant(2, "blueberry");
    const crop = getCrop("blueberry")!;
    const total = crop.stageDurations[0] + crop.stageDurations[1] + crop.stageDurations[2] + 1;
    ps.tick(makeCtx({ dt: total }), [ent], 1);
    expect(ps.getPlantData(2)!.growthStage).toBe(3);

    const result = ps.harvest(2);
    expect(result).not.toBeNull();
    expect(result!.cropItemId).toBe("blueberry");

    // Bush should now be regrowing (regrowTimer > 0), not reset to seed
    const after = ps.getPlantData(2)!;
    expect(after.regrowTimer).toBeGreaterThan(0);
    expect(after.growthStage).toBe(3); // stays mature, just no fruit

    // Can't harvest again while regrowing
    expect(ps.harvest(2)).toBeNull();

    // Tick past regrowTime
    ps.tick(makeCtx({ dt: crop.regrowTime + 1 }), [ent], 1);
    expect(ps.getPlantData(2)!.regrowTimer).toBe(0);
    // Now harvestable again
    const result2 = ps.harvest(2);
    expect(result2).not.toBeNull();
  });

  it("cold stress kills a tropical crop in winter", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(3);
    ps.plant(3, "tomato"); // coldTolerance 0.2
    // Simulate harsh winter cold stress of 0.05/s
    const ctx = makeCtx({ coldStress: () => 0.05, dt: 1 });
    for (let i = 0; i < 30; i++) {
      ps.tick(ctx, [ent], 1);
    }
    const pd = ps.getPlantData(3)!;
    expect(pd.alive).toBe(false);
    // Dead entity id should be in drainDead
    const dead = ps.drainDead();
    expect(dead).toContain(3);
  });

  it("sheltered plants survive cold stress", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(4);
    ps.plant(4, "tomato");
    const ctx = makeCtx({
      coldStress: (_tol, _cold, sheltered) => (sheltered ? 0 : 0.05),
      isSheltered: () => true,
      dt: 1,
    });
    for (let i = 0; i < 30; i++) {
      ps.tick(ctx, [ent], 1);
    }
    expect(ps.getPlantData(4)!.alive).toBe(true);
  });

  it("mushrooms can spread when mature", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(5);
    ps.plant(5, "brown_mushroom");
    const crop = getCrop("brown_mushroom")!;
    const total = crop.stageDurations[0] + crop.stageDurations[1] + crop.stageDurations[2] + 1;
    ps.tick(makeCtx({ dt: total }), [ent], 1);
    expect(ps.getPlantData(5)!.growthStage).toBeGreaterThanOrEqual(3);

    // Force spread: high spreadChance, spawnPlant returns a new id.
    let spawned = 0;
    const ctx = makeCtx({
      dt: 1,
      spawnPlant: (cropId, _x, _y, _z, isWild) => {
        spawned++;
        const newId = 100 + spawned;
        const newEnt = makeEntity(newId);
        ps.plant(newId, cropId as CropId, { isWild });
        // We need the new entity in the array for subsequent ticks; not needed here.
        void newEnt;
        return newId;
      },
    });
    // Override spreadChance by ticking many times with the system's own rate.
    // brown_mushroom.spreadChance = 0.003; per-tick prob = 0.003 * dt * 60 = 0.18
    // Over 100 ticks, P(at least one spread) is very high.
    let didSpread = false;
    for (let i = 0; i < 200; i++) {
      ps.tick(ctx, [ent], 1);
      if (spawned > 0) { didSpread = true; break; }
    }
    expect(didSpread).toBe(true);
  });

  it("growth pauses without water", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(6);
    ps.plant(6, "carrot");
    // Drain water to 0
    const pd = ps.getPlantData(6)!;
    pd.waterLevel = 0;
    ps.tick(makeCtx({ dt: 1000 }), [ent], 1);
    expect(ps.getPlantData(6)!.growthStage).toBe(0);
  });

  it("serialize/deserialize round-trips plant state", () => {
    const ps = new PlantSystem();
    ps.plant(7, "pumpkin");
    const pd = ps.getPlantData(7)!;
    pd.growthStage = 2;
    pd.waterLevel = 42;
    const rows = ps.serialize();
    const ps2 = new PlantSystem();
    ps2.deserialize(rows);
    const restored = ps2.getPlantData(7)!;
    expect(restored.cropId).toBe("pumpkin");
    expect(restored.growthStage).toBe(2);
    expect(restored.waterLevel).toBe(42);
  });

  it("writeData encodes cropId as a stable f32", () => {
    const ps = new PlantSystem();
    const ent = makeEntity(8);
    ps.plant(8, "corn");
    ps.tick(makeCtx({ dt: 0 }), [ent], 1);
    // data[3] should be a finite number (the hashed cropId as f32)
    expect(Number.isFinite(ent.data[3])).toBe(true);
    // Two plants of same crop should share the same encoded id
    const ent2 = makeEntity(9);
    ps.plant(9, "corn");
    ps.tick(makeCtx({ dt: 0 }), [ent2], 1);
    expect(ent2.data[3]).toBe(ent.data[3]);
  });
});
