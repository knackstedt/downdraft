import { describe, expect, it, spyOn } from "bun:test";
import { createCollisionSystem } from "./collision-system";
import type { CollisionConfig, CollisionDeps, CollisionEntityData, CollisionEntityMeta, CollisionPlayerState, CollisionTransform, CollisionVelocity } from "./types";
import type { Query } from "@downdraft/core";

function makeConfig(): CollisionConfig {
  return {
    entityTypes: {
      player: 1,
      ship: 2,
      smallCraft: 3,
      pirateShip: 4,
      port: 5,
      island: 6,
    },
    entityFlags: {
      static: 1,
    },
    portDataIndex: 0,
    shipCollisionRestitution: 0.5,
    entityMass: {},
    wildlifeDensity: {},
    defaultLodDistance: 100,
    spatialGridCellSize: 10,
  };
}

function makeDeps(): CollisionDeps {
  return {
    getVoxelField: () => null,
    sampleTerrainHeight: () => 0,
    getPortColliderDims: () => null,
  };
}

function makeMockQuery(entities: { transform: CollisionTransform; velocity: CollisionVelocity; meta: CollisionEntityMeta; data: CollisionEntityData }[]): Query {
  return {
    iterate: (_tick, fn) => {
      for (let i = 0; i < entities.length; i++) {
        fn(i as never, [entities[i].transform, entities[i].velocity, entities[i].meta, entities[i].data] as never, i);
      }
    },
  } as unknown as Query;
}

function makeMockPlayerQuery(players: CollisionPlayerState[]): Query {
  return {
    iterate: (_tick, fn) => {
      for (let i = 0; i < players.length; i++) {
        fn(i as never, [players[i]] as never, i);
      }
    },
  } as unknown as Query;
}

function makeEntity(id: number, type: number = 10): { transform: CollisionTransform; velocity: CollisionVelocity; meta: CollisionEntityMeta; data: CollisionEntityData } {
  return {
    transform: { x: id, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, rotW: 1, scale: 1 },
    velocity: { vx: 0, vy: 0, vz: 0, angVx: 0, angVy: 0, angVz: 0 },
    meta: { id, type, flags: 0, parentId: 0, chunkX: 0, chunkZ: 0 },
    data: { data: new Float32Array(0) },
  };
}

describe("collision-system buffer overflow", () => {
  it("warns when MAX_COLLISION_ENTITIES is exceeded and skips extra entities", () => {
    const config = makeConfig();
    const deps = makeDeps();

    const overflowCount = 4100;
    const entities: { transform: CollisionTransform; velocity: CollisionVelocity; meta: CollisionEntityMeta; data: CollisionEntityData }[] = [];
    for (let i = 0; i < overflowCount; i++) {
      entities.push(makeEntity(i));
    }

    const players: CollisionPlayerState[] = [
      { playerId: 0, entityId: 0, active: true, x: 0, y: 0, z: 0, flags: 0 },
    ];

    const allEntitiesQuery = makeMockQuery(entities);
    const playersQuery = makeMockPlayerQuery(players);

    const sys = createCollisionSystem(allEntitiesQuery, playersQuery, deps, config);

    const warnSpy = spyOn(console, "warn");
    const ctx = { world: {} as never, dt: 1 / 60, tick: 0 };
    sys.fn(ctx);

    expect(warnSpy).toHaveBeenCalled();
    const warningMsg = (warnSpy.mock.calls[0] as unknown[])[0] as string;
    expect(warningMsg).toContain("MAX_COLLISION_ENTITIES");
    expect(warningMsg).toContain("4096");

    warnSpy.mockRestore();
  });

  it("does not warn when entity count is within buffer limit", () => {
    const config = makeConfig();
    const deps = makeDeps();

    const entities: { transform: CollisionTransform; velocity: CollisionVelocity; meta: CollisionEntityMeta; data: CollisionEntityData }[] = [];
    for (let i = 0; i < 100; i++) {
      entities.push(makeEntity(i));
    }

    const players: CollisionPlayerState[] = [
      { playerId: 0, entityId: 0, active: true, x: 0, y: 0, z: 0, flags: 0 },
    ];

    const allEntitiesQuery = makeMockQuery(entities);
    const playersQuery = makeMockPlayerQuery(players);

    const sys = createCollisionSystem(allEntitiesQuery, playersQuery, deps, config);

    const warnSpy = spyOn(console, "warn");
    const ctx = { world: {} as never, dt: 1 / 60, tick: 0 };
    sys.fn(ctx);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
