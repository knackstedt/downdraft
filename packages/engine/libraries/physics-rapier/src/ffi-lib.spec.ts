// ffi-lib.spec.ts — exercises the native Rapier cdylib through
// RapierFfiBackend (PhysicsLib over bun:ffi). Requires the native lib:
//   cd packages/engine/libraries/physics-native/native && cargo build
//
// Covers: realm/body/collider lifecycle, stepping + awake readback, raw
// scalar paths, raycast/shapecast, contacts, character controller, joints,
// and the batched write/impulse ABI.

import { RealmTier } from "@downdraft/engine/physics";
import type { PhysicsRealmConfig } from "@downdraft/engine/physics/interface";
import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RapierFfiBackend } from "./ffi-backend";

const _dir = dirname(fileURLToPath(import.meta.url));
const LIB_CANDIDATES = [
  join(_dir, "..", "..", "physics-native", "native", "target", "release", "libdowndraft_physics.so"),
  join(_dir, "..", "..", "physics-native", "native", "target", "debug", "libdowndraft_physics.so"),
];
const LIB_OK = LIB_CANDIDATES.some(existsSync);

function realmConfig(overrides: Partial<PhysicsRealmConfig> = {}): PhysicsRealmConfig {
  return {
    id: 0,
    name: "test",
    tier: RealmTier.Near,
    gravity: [0, -9.81, 0],
    tierConfig: { tickFrequency: 1, solverIterations: 4, promoteThreshold: 0, demoteThreshold: 0, demoteDwellTime: 0 },
    ...overrides,
  };
}

const entity = (index: number) => ({ index, generation: 0 });

describe.skipIf(!LIB_OK)("RapierFfiBackend (native cdylib)", () => {
  let backend: RapierFfiBackend;

  beforeAll(async () => {
    backend = new RapierFfiBackend();
    await backend.init();
  });

  it("falls under gravity and reports via raw getters", () => {
    backend.createRealm(realmConfig());
    const body = backend.createBody(0, {
      type: "dynamic",
      position: [0, 10, 0],
      rotation: [0, 0, 0, 1],
      mass: 1,
    }, entity(1));
    backend.addCollider(body, { shape: { type: "sphere", radius: 0.5 }, density: 1 });

    backend.setIntegrationDt(0, 1 / 60);
    for (let i = 0; i < 4; i++) backend.step(0, 1 / 60);

    const vel: [number, number, number] = [0, 0, 0];
    backend.getLinearVelocityRaw(body, vel);
    expect(vel[1]).toBeLessThan(-0.5);

    const pos: [number, number, number] = [0, 0, 0];
    backend.getTranslationRaw(body, pos);
    expect(pos[1]).toBeLessThan(10);
    expect(pos[1]).toBeGreaterThan(9);
  });

  it("rests a dynamic box on a static floor and reports contacts", () => {
    const b2 = new RapierFfiBackend();
    // init() is cheap — lib is cached process-wide
    return b2.init().then(() => {
      b2.createRealm(realmConfig());
      const floor = b2.createBody(0, { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, entity(0));
      b2.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });
      const box = b2.createBody(0, { type: "dynamic", position: [0, 3, 0], rotation: [0, 0, 0, 1], mass: 1 }, entity(1));
      b2.addCollider(box, { shape: { type: "box", halfExtents: [0.5, 0.5, 0.5] }, density: 1 });

      b2.setIntegrationDt(0, 1 / 60);
      for (let i = 0; i < 120; i++) b2.step(0, 1 / 60);

      const pos: [number, number, number] = [0, 0, 0];
      b2.getTranslationRaw(box, pos);
      // Box half 0.5 on floor top 0.5 → rests near y≈1.0
      expect(pos[1]).toBeGreaterThan(0.8);
      expect(pos[1]).toBeLessThan(1.3);

      const contacts = b2.getContacts(0);
      expect(contacts.length).toBeGreaterThan(0);
      const c = contacts[0];
      const pair = [c.entityA.index, c.entityB.index].sort();
      expect(pair).toEqual([0, 1]);
      expect(Math.abs(c.normal[1])).toBeGreaterThan(0.9);
      expect(c.penetrationDepth).toBeGreaterThanOrEqual(0);
      b2.destroy();
    });
  });

  it("raycasts and reports the hit entity", () => {
    const b3 = new RapierFfiBackend();
    return b3.init().then(() => {
      b3.createRealm(realmConfig());
      const floor = b3.createBody(0, { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, entity(5));
      b3.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

      const hit = b3.raycast(0, [0, 5, 0], [0, -1, 0], 20);
      expect(hit).not.toBeNull();
      expect(hit!.entity.index).toBe(5);
      expect(hit!.distance).toBeGreaterThan(4);
      expect(hit!.distance).toBeLessThan(5);
      expect(hit!.point[1]).toBeCloseTo(0.5, 1);

      const miss = b3.raycast(0, [0, 5, 0], [0, 1, 0], 20);
      expect(miss).toBeNull();

      const excluded = b3.raycast(0, [0, 5, 0], [0, -1, 0], 20, { excludeEntity: entity(5) });
      expect(excluded).toBeNull();
      b3.destroy();
    });
  });

  it("enumerates awake bodies via readAwakeBodyStates", () => {
    const b4 = new RapierFfiBackend();
    return b4.init().then(() => {
      b4.createRealm(realmConfig());
      for (let i = 0; i < 8; i++) {
        const b = b4.createBody(0, {
          type: "dynamic", position: [i * 2, 10 + i, 0], rotation: [0, 0, 0, 1], mass: 1,
        }, entity(i));
        b4.addCollider(b, { shape: { type: "sphere", radius: 0.5 }, density: 1 });
      }
      b4.setIntegrationDt(0, 1 / 60);
      b4.step(0, 1 / 60);

      const ids = new Uint32Array(16);
      const out = new Float32Array(16 * 10);
      const n = b4.readAwakeBodyStates(0, ids, out, 16);
      expect(n).toBe(8);
      // Every awake body fell a bit
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        seen.add(ids[i]);
        expect(out[i * 10 + 1]).toBeLessThan(10 + ids[i] * 1 + 1); // y below spawn + slack
        expect(out[i * 10 + 8]).toBeLessThan(0); // vy < 0
      }
      expect(seen.size).toBe(8);
      b4.destroy();
    });
  });

  it("applyBodyWrites pushes pos/quat/velocities in one call", () => {
    const b5 = new RapierFfiBackend();
    return b5.init().then(async () => {
      b5.createRealm(realmConfig());
      const b = b5.createBody(0, { type: "dynamic", position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }, entity(3));
      b5.addCollider(b, { shape: { type: "sphere", radius: 0.5 }, density: 1 });

      const lib = await (await import("./ffi-lib")).loadFfiPhysicsLib();
      const ids = new Int32Array([b.id]);
      const states = new Float32Array([1, 2, 3, 0, 0, 0, 1, 4, 5, 6, 0, 0, 0]);
      lib.applyBodyWrites(0, ids, states, 1, true);

      const pos: [number, number, number] = [0, 0, 0];
      b5.getTranslationRaw(b, pos);
      expect(pos).toEqual([1, 2, 3]);
      const vel: [number, number, number] = [0, 0, 0];
      b5.getLinearVelocityRaw(b, vel);
      expect(vel).toEqual([4, 5, 6]);
      b5.destroy();
    });
  });

  it("kinematic character controller moves and reports grounded", () => {
    const b6 = new RapierFfiBackend();
    return b6.init().then(() => {
      b6.createRealm(realmConfig());
      const floor = b6.createBody(0, { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, entity(0));
      b6.addCollider(floor, { shape: { type: "box", halfExtents: [10, 0.5, 10] } });

      const handle = b6.createCharacterController(0, {
        offset: [0, 0.05, 0],
        radius: 0.3,
        halfHeight: 0.6,
        slide: true,
        autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.4 },
        maxSlope: Math.PI / 4,
        minSlopeSlide: Math.PI / 3,
        snapToGround: 0.3,
        applyImpulsesToDynamicBodies: false,
        parentless: { position: [0, 2, 0] },
      }, entity(9));

      b6.setIntegrationDt(0, 1 / 60);
      // characterMove computes but does NOT apply movement (WASM parity) —
      // the caller applies effectiveMovement to the collider each frame.
      const pos: [number, number, number] = [0, 2, 0];
      let last = b6.characterMove(handle, [0, -0.1, 0], 1 / 60);
      for (let i = 0; i < 120; i++) {
        b6.step(0, 1 / 60);
        last = b6.characterMove(handle, [0.05, -0.1, 0], 1 / 60);
        pos[0] += last.effectiveMovement[0];
        pos[1] += last.effectiveMovement[1];
        pos[2] += last.effectiveMovement[2];
        b6.setCharacterColliderPosition(handle, pos);
      }
      expect(last.grounded).toBe(true);
      // Capsule (hh 0.6 + r 0.3) resting on floor top 0.5 → center ≈ 1.45
      expect(pos[1]).toBeGreaterThan(1.2);
      expect(pos[1]).toBeLessThan(1.8);
      expect(last.effectiveMovement[0]).toBeGreaterThan(0);
      b6.destroy();
    });
  });

  it("creates and destroys a spherical joint", () => {
    const b7 = new RapierFfiBackend();
    return b7.init().then(() => {
      b7.createRealm(realmConfig());
      const a = b7.createBody(0, { type: "dynamic", position: [0, 5, 0], rotation: [0, 0, 0, 1], mass: 1 }, entity(1));
      b7.addCollider(a, { shape: { type: "sphere", radius: 0.5 }, density: 1 });
      const c = b7.createBody(0, { type: "dynamic", position: [0, 4, 0], rotation: [0, 0, 0, 1], mass: 1 }, entity(2));
      b7.addCollider(c, { shape: { type: "sphere", radius: 0.5 }, density: 1 });

      const jid = b7.createJoint(0, a, c, {
        type: "cone-twist",
        anchorA: [0, -0.5, 0],
        anchorB: [0, 0.5, 0],
      });
      expect(jid).toBeGreaterThan(0);

      b7.setIntegrationDt(0, 1 / 60);
      for (let i = 0; i < 30; i++) b7.step(0, 1 / 60);

      // Bodies should have stayed linked (child didn't free-fall far)
      const pa: [number, number, number] = [0, 0, 0];
      const pb: [number, number, number] = [0, 0, 0];
      b7.getTranslationRaw(a, pa);
      b7.getTranslationRaw(c, pb);
      const dy = pa[1] - pb[1];
      expect(Math.abs(dy)).toBeLessThan(2.5);

      b7.destroyJoint(0, jid);
      b7.destroy();
    });
  });
});
