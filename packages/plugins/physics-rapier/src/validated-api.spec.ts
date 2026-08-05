import { UniversalPhysicsAPI } from "./api";
import { RapierPhysicsBackend } from "./backend";
import type { PhysicsPluginConfig } from "@downdraft/core";

const config: PhysicsPluginConfig = {
  gravity: [0, -9.81, 0],
  fixedDt: 1 / 60,
  maxCatchUpSteps: 5,
  stepBudgetMs: 12,
  maxEntities: 100,
  realmConfigs: {
    near: { tickFrequency: 1, solverIterations: 4, promoteThreshold: 50, demoteThreshold: 60, demoteDwellTime: 1 },
    mid: { tickFrequency: 2, solverIterations: 2, promoteThreshold: 120, demoteThreshold: 150, demoteDwellTime: 2 },
    far: { tickFrequency: 6, solverIterations: 1, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 5 },
  },
  nanSweepInterval: 10,
  nanSweepVelocityThreshold: 0.1,
  ccdTunnelingRatio: 0.5,
  snapshotInterval: 30,
  predictionMode: "server-authoritative",
  workerCount: 0,
  devMode: true,
  duplicateStatics: true,
};

async function makeAPI(): Promise<UniversalPhysicsAPI> {
  const backend = new RapierPhysicsBackend();
  await backend.init();
  return new UniversalPhysicsAPI(backend, config);
}

describe("UniversalPhysicsAPI (validated-api)", () => {
  it("should create and destroy a body", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(body.id).toBeGreaterThan(0);
    api.destroyBody(body);
    api.destroy();
  });

  it("should reject NaN position in dev mode", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(() => api.setPosition(body, [NaN, 0, 0])).toThrow();
    api.destroy();
  });

  it("should reject NaN velocity in dev mode", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(() => api.setLinearVelocity(body, [NaN, 0, 0])).toThrow();
    api.destroy();
  });

  it("should reject degenerate quaternion in dev mode", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(() => api.setRotation(body, [0, 0, 0, 0])).toThrow();
    api.destroy();
  });

  it("should reject non-positive mass for dynamic body", async () => {
    const api = await makeAPI();
    expect(() => api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 0 })).toThrow();
    api.destroy();
  });

  it("should reject NaN in raycast origin", async () => {
    const api = await makeAPI();
    expect(() => api.raycast([NaN, 0, 0], [0, 1, 0], 100)).toThrow();
    api.destroy();
  });

  it("should reject NaN in applyImpulse", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(() => api.applyImpulse(body, [NaN, 0, 0])).toThrow();
    api.destroy();
  });

  it("should return realm tier for a body", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    const tier = api.getRealmTier(body);
    expect(tier).toBeDefined();
    api.destroy();
  });

  it("should set and get position", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    api.setPosition(body, [1, 2, 3]);
    expect(api.getPosition(body)).toEqual([1, 2, 3]);
    api.destroy();
  });

  it("should set and get linear velocity", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    api.setLinearVelocity(body, [1, 2, 3]);
    expect(api.getLinearVelocity(body)).toEqual([1, 2, 3]);
    api.destroy();
  });

  it("should return stats", async () => {
    const api = await makeAPI();
    api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    const stats = api.getStats();
    expect(stats.bodyCount).toBeGreaterThan(0);
    expect(stats.realmCounts).toBeDefined();
    expect(typeof stats.overBudget).toBe("boolean");
    api.destroy();
  });

  it("should snapshot and restore", async () => {
    const api = await makeAPI();
    api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    const snapshots = api.snapshot();
    expect(snapshots.size).toBe(3);
    expect(() => api.restore(snapshots)).not.toThrow();
    api.destroy();
  });

  it("should never expose raw Rapier handles", async () => {
    const api = await makeAPI();
    const body = api.createBody({ index: 0, generation: 0 }, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    // PhysicsBody should only have id, realmId, entity — no raw handle
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("realmId");
    expect(body).toHaveProperty("entity");
    expect(body).not.toHaveProperty("handle");
    api.destroy();
  });
});
