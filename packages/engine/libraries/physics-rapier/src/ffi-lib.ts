// ============================================================================
// ffi-lib.ts — PhysicsLib implementation backed by the native Rapier cdylib
// (packages/engine/libraries/physics-native/native) via bun:ffi.
//
// Replaces the WASM @dimforge/rapier3d-compat path on the native runtime.
// Same PhysicsLib contract as rapier-backend.ts — RapierPhysicsBackend keeps
// all JS-side bookkeeping (BodyState cache, contacts extraction) unchanged.
//
// Semantic parity notes vs the WASM lib:
//  - Entity resolution is done JS-side: native code returns game bodyIds,
//    we map them back to Entity via a per-realm map populated in createBody.
//  - Contact points are WORLD-space (Rapier SolverContact), whereas the WASM
//    path returns manifold.localContactPoint1 (collider1-local). Callers that
//    render contact markers should treat these as world positions.
//  - raycast() returns the real surface normal (WASM hardcodes [0,1,0]).
//  - serializeRealm/deserializeRealm are stubs — the cdylib builds without
//    Rapier's serde feature. Snapshots need a serde-enabled build.
// ============================================================================

import type {
    ContactManifold,
    Entity,
    IntersectionPair,
    IslandInfo
} from "@downdraft/engine";
import { dlopen, ptr, type CFunction } from "@downdraft/platform-native";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PhysicsLib } from "./rapier-backend";

const _dirname =
  typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : dirname(fileURLToPath(import.meta.url));

function findPhysicsLibrary(): string {
  const envPath = process.env.DOWNDRAFT_PHYSICS_LIB ?? process.env.PHYSICS_NATIVE_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(`DOWNDRAFT_PHYSICS_LIB is set to "${envPath}" but the file does not exist.`);
  }
  const base =
    process.platform === "win32" ? "downdraft_physics.dll"
    : process.platform === "darwin" ? "libdowndraft_physics.dylib"
    : "libdowndraft_physics.so";
  const candidates = [
    // Dev builds — release first, then debug.
    join(_dirname, "..", "..", "physics-native", "native", "target", "release", base),
    join(_dirname, "..", "..", "physics-native", "native", "target", "debug", base),
    join(_dirname, "..", "..", "physics-native", "native", base),
    // Packaged layout — native/ dir next to the compiled binary.
    join(dirname(process.execPath), "native", base),
    join("/usr/local/lib", base),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `${base} not found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
    `Build with: cd packages/engine/libraries/physics-native/native && cargo build --release`,
  );
}

// ── FFI symbol table ──

const PHYSICS_SPEC: Record<string, CFunction> = {
  dd_create_realm: { args: ["i32", "f32", "f32", "f32"], returns: "i32" },
  dd_destroy_realm: { args: ["i32"], returns: "i32" },

  dd_create_body: { args: ["i32", "i32", "ptr", "ptr"], returns: "i32" },
  dd_destroy_body: { args: ["i32", "i32"], returns: "i32" },
  dd_set_body_type: { args: ["i32", "i32", "i32"], returns: "i32" },
  dd_set_translation: { args: ["i32", "i32", "f32", "f32", "f32", "i32"], returns: "i32" },
  dd_set_rotation: { args: ["i32", "i32", "f32", "f32", "f32", "f32", "i32"], returns: "i32" },
  dd_get_translation: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_get_rotation: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_set_linvel: { args: ["i32", "i32", "f32", "f32", "f32", "i32"], returns: "i32" },
  dd_set_angvel: { args: ["i32", "i32", "f32", "f32", "f32", "i32"], returns: "i32" },
  dd_get_linvel: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_get_angvel: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_get_body_transform: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_is_sleeping: { args: ["i32", "i32"], returns: "i32" },
  dd_wake_up: { args: ["i32", "i32"], returns: "i32" },
  dd_set_ccd: { args: ["i32", "i32", "i32"], returns: "i32" },

  dd_apply_force: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_apply_torque: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_apply_impulse: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_apply_torque_impulse: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_apply_impulse_at_point: { args: ["i32", "i32", "f32", "f32", "f32", "f32", "f32", "f32"], returns: "i32" },
  dd_apply_body_writes: { args: ["i32", "ptr", "ptr", "usize", "i32"], returns: "i32" },
  dd_apply_impulses: { args: ["i32", "ptr", "ptr", "usize"], returns: "i32" },

  dd_add_collider: { args: ["i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  dd_remove_collider: { args: ["i32", "i32"], returns: "i32" },
  dd_swap_collider_shape: { args: ["i32", "i32", "ptr", "usize", "ptr", "usize"], returns: "i32" },
  dd_set_collider_position: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_get_collider_position: { args: ["i32", "i32", "ptr"], returns: "i32" },
  dd_collider_shape_type: { args: ["i32", "i32"], returns: "i32" },
  dd_collider_count: { args: ["i32", "i32"], returns: "i32" },
  dd_test_convex_hull: { args: ["ptr", "usize"], returns: "i32" },

  dd_step: { args: ["i32", "f32"], returns: "i32" },
  dd_set_integration_dt: { args: ["i32", "f32"], returns: "i32" },
  dd_set_solver_iterations: { args: ["i32", "i32"], returns: "i32" },
  dd_set_min_island_size: { args: ["i32", "i32"], returns: "i32" },
  dd_step_and_read_awake: { args: ["i32", "f32", "ptr", "ptr", "usize"], returns: "i32" },
  dd_read_awake: { args: ["i32", "ptr", "ptr", "usize"], returns: "i32" },

  dd_raycast: { args: ["i32", "f32", "f32", "f32", "f32", "f32", "f32", "f32", "u32", "i32", "ptr"], returns: "i32" },
  dd_shape_cast: { args: ["i32", "i32", "ptr", "f32", "u32", "i32", "ptr"], returns: "i32" },
  dd_get_contacts: { args: ["i32", "ptr", "ptr", "ptr", "usize"], returns: "i32" },
  dd_get_intersections: { args: ["i32", "ptr", "usize"], returns: "i32" },

  dd_char_create: { args: ["i32", "i32", "ptr", "ptr"], returns: "i32" },
  dd_char_destroy: { args: ["i32", "i32"], returns: "i32" },
  dd_char_set_collider_pos: { args: ["i32", "i32", "f32", "f32", "f32"], returns: "i32" },
  dd_char_move: { args: ["i32", "i32", "f32", "f32", "f32", "f32", "ptr", "ptr", "usize"], returns: "i32" },

  dd_create_joint: { args: ["i32", "i32", "i32", "i32", "i32", "ptr"], returns: "i32" },
  dd_destroy_joint: { args: ["i32", "i32"], returns: "i32" },

  dd_destroy: { args: [], returns: "i32" },
};

// ── Descriptor packing (layouts must match native/src/*.rs) ──

const BODY_F32_LEN = 17;
const BODY_I32_LEN = 2;
const COLLIDER_I32_LEN = 9;
const COLLIDER_F32_LEN = 14;
const CHAR_F32_LEN = 11;
const CHAR_I32_LEN = 6;
const JOINT_F32_LEN = 19;

const BODY_TYPE: Record<string, number> = { static: 0, kinematic: 1, dynamic: 2 };
const SHAPE_TYPE: Record<string, number> = { sphere: 0, box: 1, capsule: 2, convex: 3, mesh: 4, heightfield: 5 };
const JOINT_TYPE: Record<string, number> = { fixed: 0, "cone-twist": 1, revolute: 2, prismatic: 3 };

export interface FfiPhysicsLib extends PhysicsLib {
  /**
   * Fused step + awake-body readback — one FFI call. `idsOut[i] = bodyId`,
   * `out[i*10..+9] = [pos3, quat4, linvel3]`. Returns awake count.
   */
  stepAndReadAwake(realmId: number, dt: number, idsOut: Uint32Array, out: Float32Array, maxCount: number): number;
  /** Batched full-state write: 13 floats per body [pos3, quat4, linvel3, angvel3]. */
  applyBodyWrites(realmId: number, ids: Int32Array, states: Float32Array, count: number, wake: boolean): void;
  /** Batched impulses: 6 floats per body [lin3, ang3]. */
  applyImpulses(realmId: number, ids: Int32Array, impulses: Float32Array, count: number): void;
}

let cachedLib: FfiPhysicsLib | null = null;

export function loadFfiPhysicsLib(): Promise<FfiPhysicsLib> {
  if (cachedLib) return Promise.resolve(cachedLib);
  cachedLib = buildLib();
  return Promise.resolve(cachedLib);
}

function buildLib(): FfiPhysicsLib {
  const lib = dlopen(findPhysicsLibrary(), PHYSICS_SPEC);
  const s = lib.symbols;

  // Per-realm game-bodyId → Entity (native returns bodyIds; entities never
  // cross the FFI boundary).
  const entityByBodyId = new Map<number, Map<number, Entity>>();
  // Reverse: entity.index → bodyId (O(1) excludeEntity lookup in queries).
  const bodyIdByEntityIndex = new Map<number, Map<number, number>>();

  // Scratch descriptor buffers — reused across calls (FFI calls are
  // synchronous; no reentrancy hazard).
  const bodyF = new Float32Array(BODY_F32_LEN);
  const bodyI = new Int32Array(BODY_I32_LEN);
  const collMeta = new Int32Array(COLLIDER_I32_LEN);
  const collF = new Float32Array(COLLIDER_F32_LEN);
  const charF = new Float32Array(CHAR_F32_LEN);
  const charI = new Int32Array(CHAR_I32_LEN);
  const jointF = new Float32Array(JOINT_F32_LEN);
  const out3 = new Float32Array(3);
  const out4 = new Float32Array(4);
  const out7 = new Float32Array(7);
  const rayOut = new Float32Array(8);
  const charOutF = new Float32Array(5);
  const charOutI = new Int32Array(17); // groundBodyId + up to 16 collision bodyIds

  // Contacts/intersections extraction buffers — grow on demand.
  let contactsI = new Int32Array(4096 * 3);
  let contactsF = new Float32Array(4096 * 4);
  let contactsPts = new Float32Array(4096 * 12);
  let intersectI = new Int32Array(2048 * 2);

  function entities(realmId: number): Map<number, Entity> {
    let m = entityByBodyId.get(realmId);
    if (!m) {
      m = new Map();
      entityByBodyId.set(realmId, m);
    }
    return m;
  }

  function entityFor(realmId: number, bodyId: number): Entity {
    return entityByBodyId.get(realmId)?.get(bodyId) ?? { index: 0, generation: 0 };
  }

  function excludeBodyId(realmId: number, entity?: Entity): number {
    if (!entity) return -1;
    return bodyIdByEntityIndex.get(realmId)?.get(entity.index) ?? -1;
  }

  const ffiLib: FfiPhysicsLib = {
    createRealm(id, gravity) {
      s.dd_create_realm(id, gravity[0], gravity[1], gravity[2]);
      entityByBodyId.set(id, new Map());
      bodyIdByEntityIndex.set(id, new Map());
    },
    destroyRealm(id) {
      s.dd_destroy_realm(id);
      entityByBodyId.delete(id);
      bodyIdByEntityIndex.delete(id);
    },

    createBody(realmId, bodyId, desc, entity) {
      bodyF[0] = desc.position[0]; bodyF[1] = desc.position[1]; bodyF[2] = desc.position[2];
      bodyF[3] = desc.rotation[0]; bodyF[4] = desc.rotation[1]; bodyF[5] = desc.rotation[2]; bodyF[6] = desc.rotation[3];
      const lv = desc.linearVelocity ?? [0, 0, 0];
      const av = desc.angularVelocity ?? [0, 0, 0];
      bodyF[7] = lv[0]; bodyF[8] = lv[1]; bodyF[9] = lv[2];
      bodyF[10] = av[0]; bodyF[11] = av[1]; bodyF[12] = av[2];
      bodyF[13] = desc.mass ?? 0;
      bodyF[14] = desc.linearDamping ?? 0;
      bodyF[15] = desc.angularDamping ?? 0;
      bodyF[16] = desc.gravityScale ?? 1;

      let flags = 0;
      if (desc.ccdEnabled) flags |= 1 << 0;
      if (desc.canSleep !== false) flags |= 1 << 1;
      if (desc.sleeping) flags |= 1 << 2;
      const lt = desc.lockedAxes?.translation;
      if (lt?.[0]) flags |= 1 << 3;
      if (lt?.[1]) flags |= 1 << 4;
      if (lt?.[2]) flags |= 1 << 5;
      const lr = desc.lockedAxes?.rotation;
      if (lr?.[0]) flags |= 1 << 6;
      if (lr?.[1]) flags |= 1 << 7;
      if (lr?.[2]) flags |= 1 << 8;
      if (desc.mass) flags |= 1 << 9;
      if (desc.linearDamping) flags |= 1 << 10;
      if (desc.angularDamping) flags |= 1 << 11;
      if (desc.gravityScale !== undefined) flags |= 1 << 12;

      bodyI[0] = BODY_TYPE[desc.type] ?? 2;
      bodyI[1] = flags;
      s.dd_create_body(realmId, bodyId, ptr(bodyF), ptr(bodyI));
      entities(realmId).set(bodyId, entity);
      bodyIdByEntityIndex.get(realmId)?.set(entity.index, bodyId);
    },
    destroyBody(realmId, bodyId) {
      s.dd_destroy_body(realmId, bodyId);
      const ent = entityByBodyId.get(realmId)?.get(bodyId);
      if (ent) bodyIdByEntityIndex.get(realmId)?.delete(ent.index);
      entityByBodyId.get(realmId)?.delete(bodyId);
    },
    setBodyType(realmId, bodyId, type) {
      s.dd_set_body_type(realmId, bodyId, BODY_TYPE[type] ?? 2);
    },

    addCollider(realmId, bodyId, colliderId, desc) {
      const shape = desc.shape;
      collMeta.fill(0);
      collF.fill(0);
      collMeta[0] = SHAPE_TYPE[shape.type] ?? 0;
      collMeta[1] = desc.sensor ? 1 : 0;
      collMeta[2] = desc.collisionGroups ?? 0;
      collMeta[3] = desc.solverGroups ?? 0;

      let flags = 0;
      let verts: Float32Array | null = null;
      let indices: Uint32Array | null = null;
      if (shape.type === "sphere") {
        collF[0] = shape.radius;
      } else if (shape.type === "box") {
        collF[0] = shape.halfExtents[0]; collF[1] = shape.halfExtents[1]; collF[2] = shape.halfExtents[2];
      } else if (shape.type === "capsule") {
        collF[0] = shape.halfHeight; collF[1] = shape.radius;
      } else if (shape.type === "convex") {
        verts = shape.vertices as Float32Array;
        collMeta[4] = shape.vertices.length / 3;
      } else if (shape.type === "mesh") {
        verts = shape.vertices as Float32Array;
        indices = shape.indices as Uint32Array;
        collMeta[4] = shape.vertices.length / 3;
        collMeta[5] = shape.indices.length;
      } else if (shape.type === "heightfield") {
        // Native heightfield works (unlike WASM rapier 0.19 which panics).
        verts = shape.heights as Float32Array;
        collMeta[4] = shape.nrows * shape.ncols;
        collMeta[7] = shape.nrows;
        collMeta[8] = shape.ncols;
        collF[0] = shape.scale[0]; collF[1] = shape.scale[1]; collF[2] = shape.scale[2];
      }
      if (desc.friction !== undefined) { flags |= 1 << 0; collF[4] = desc.friction; }
      if (desc.restitution !== undefined) { flags |= 1 << 1; collF[5] = desc.restitution; }
      if (desc.density !== undefined) { flags |= 1 << 2; collF[6] = desc.density; }
      if (desc.translation) { flags |= 1 << 3; collF[7] = desc.translation[0]; collF[8] = desc.translation[1]; collF[9] = desc.translation[2]; }
      if (desc.rotation) { flags |= 1 << 4; collF[10] = desc.rotation[0]; collF[11] = desc.rotation[1]; collF[12] = desc.rotation[2]; collF[13] = desc.rotation[3]; }
      if (desc.collisionGroups !== undefined) flags |= 1 << 5;
      if (desc.solverGroups !== undefined) flags |= 1 << 6;
      collMeta[6] = flags;

      s.dd_add_collider(
        realmId, bodyId, colliderId,
        ptr(collMeta), ptr(collF),
        verts ? ptr(verts) : 0,
        indices ? ptr(indices) : 0,
      );
    },
    removeCollider(realmId, _bodyId, colliderId) {
      s.dd_remove_collider(realmId, colliderId);
    },
    setColliderPosition(realmId, colliderId, pos) {
      s.dd_set_collider_position(realmId, colliderId, pos[0], pos[1], pos[2]);
    },
    getColliderPosition(realmId, colliderId) {
      if (s.dd_get_collider_position(realmId, colliderId, ptr(out3)) !== 1) return [0, 0, 0];
      return [out3[0], out3[1], out3[2]];
    },
    swapColliderShapeRaw(realmId, colliderId, vertices, indices) {
      return s.dd_swap_collider_shape(
        realmId, colliderId,
        ptr(vertices), vertices.length / 3,
        ptr(indices), indices.length,
      ) === 1;
    },
    testConvexHull(vertices) {
      return s.dd_test_convex_hull(ptr(vertices), vertices.length / 3) === 1;
    },
    getColliderShapeType(realmId, colliderId) {
      return s.dd_collider_shape_type(realmId, colliderId);
    },
    getColliderCount(realmId, bodyId) {
      return s.dd_collider_count(realmId, bodyId);
    },

    applyForce(realmId, bodyId, f) { s.dd_apply_force(realmId, bodyId, f[0], f[1], f[2]); },
    applyImpulse(realmId, bodyId, f) { s.dd_apply_impulse(realmId, bodyId, f[0], f[1], f[2]); },
    applyTorque(realmId, bodyId, f) { s.dd_apply_torque(realmId, bodyId, f[0], f[1], f[2]); },
    applyTorqueImpulse(realmId, bodyId, f) { s.dd_apply_torque_impulse(realmId, bodyId, f[0], f[1], f[2]); },
    applyImpulseAtPoint(realmId, bodyId, imp, pt) {
      s.dd_apply_impulse_at_point(realmId, bodyId, imp[0], imp[1], imp[2], pt[0], pt[1], pt[2]);
    },

    setLinearVelocity(realmId, bodyId, v) { s.dd_set_linvel(realmId, bodyId, v[0], v[1], v[2], 1); },
    setAngularVelocity(realmId, bodyId, v) { s.dd_set_angvel(realmId, bodyId, v[0], v[1], v[2], 1); },
    setPosition(realmId, bodyId, p) { s.dd_set_translation(realmId, bodyId, p[0], p[1], p[2], 1); },
    setRotation(realmId, bodyId, r) { s.dd_set_rotation(realmId, bodyId, r[0], r[1], r[2], r[3], 1); },
    wakeUp(realmId, bodyId) { s.dd_wake_up(realmId, bodyId); },

    setTranslationRaw(realmId, bodyId, x, y, z, wake) {
      s.dd_set_translation(realmId, bodyId, x, y, z, wake ? 1 : 0);
    },
    setRotationRaw(realmId, bodyId, x, y, z, w, wake) {
      s.dd_set_rotation(realmId, bodyId, x, y, z, w, wake ? 1 : 0);
    },
    getTranslationRaw(realmId, bodyId, out) {
      s.dd_get_translation(realmId, bodyId, ptr(out3));
      out[0] = out3[0]; out[1] = out3[1]; out[2] = out3[2];
    },
    getRotationRaw(realmId, bodyId, out) {
      s.dd_get_rotation(realmId, bodyId, ptr(out4));
      out[0] = out4[0]; out[1] = out4[1]; out[2] = out4[2]; out[3] = out4[3];
    },
    getLinearVelocityRaw(realmId, bodyId, out) {
      s.dd_get_linvel(realmId, bodyId, ptr(out3));
      out[0] = out3[0]; out[1] = out3[1]; out[2] = out3[2];
    },
    setLinearVelocityRaw(realmId, bodyId, x, y, z, wake) {
      s.dd_set_linvel(realmId, bodyId, x, y, z, wake ? 1 : 0);
    },
    setAngularVelocityRaw(realmId, bodyId, x, y, z, wake) {
      s.dd_set_angvel(realmId, bodyId, x, y, z, wake ? 1 : 0);
    },
    isSleepingRaw(realmId, bodyId) {
      return s.dd_is_sleeping(realmId, bodyId) === 1;
    },
    readAwakeBodyStates(realmId, idsOut, out, maxCount) {
      return s.dd_read_awake(realmId, ptr(idsOut), ptr(out), maxCount);
    },
    stepAndReadAwake(realmId, dt, idsOut, out, maxCount) {
      return s.dd_step_and_read_awake(realmId, dt, ptr(idsOut), ptr(out), maxCount);
    },
    applyBodyWrites(realmId, ids, states, count, wake) {
      s.dd_apply_body_writes(realmId, ptr(ids), ptr(states), count, wake ? 1 : 0);
    },
    applyImpulses(realmId, ids, impulses, count) {
      s.dd_apply_impulses(realmId, ptr(ids), ptr(impulses), count);
    },

    reserveMemory() { /* native heap — nothing to reserve */ },
    setIntegrationDt(realmId, dt) { s.dd_set_integration_dt(realmId, dt); },
    setSleepThresholds() { /* not exposed in rapier 0.22 — same as WASM no-op */ },
    setSolverIterations(realmId, n) { s.dd_set_solver_iterations(realmId, n); },
    setMinIslandSize(realmId, size) { s.dd_set_min_island_size(realmId, size); },
    setCCDEnabled(realmId, bodyId, enabled) { s.dd_set_ccd(realmId, bodyId, enabled ? 1 : 0); },

    // WASM parity: step() uses the stored integration dt (setIntegrationDt),
    // so pass 0 to avoid overriding it.
    step(realmId, _dt) { s.dd_step(realmId, 0); },

    getBodyTransform(realmId, bodyId) {
      if (s.dd_get_body_transform(realmId, bodyId, ptr(out7)) !== 1) return null;
      return {
        position: [out7[0], out7[1], out7[2]],
        rotation: [out7[3], out7[4], out7[5], out7[6]],
      };
    },

    raycast(realmId, origin, direction, maxDistance, filter) {
      const groups = filter?.collisionGroups ?? 0;
      const excl = excludeBodyId(realmId, filter?.excludeEntity);
      if (s.dd_raycast(realmId, origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], maxDistance, groups, excl, ptr(rayOut)) !== 1) {
        return null;
      }
      return {
        entity: entityFor(realmId, rayOut[7] | 0),
        point: [rayOut[0], rayOut[1], rayOut[2]],
        normal: [rayOut[3], rayOut[4], rayOut[5]],
        distance: rayOut[6],
      };
    },
    raycastMulti(realmId, origin, direction, maxDistance, filter) {
      // WASM parity: the WASM raycastMulti returns only the single closest hit.
      const hit = this.raycast(realmId, origin, direction, maxDistance, filter);
      return hit ? [hit] : [];
    },
    shapeCast(realmId, shape, origin, rotation, direction, maxDistance, filter) {
      // f: [shape params (3), origin3, quat4, dir3]
      const f = new Float32Array(13);
      const st = SHAPE_TYPE[shape.type] ?? 0;
      if (shape.type === "sphere") {
        f[0] = shape.radius;
      } else if (shape.type === "box") {
        f[0] = shape.halfExtents[0]; f[1] = shape.halfExtents[1]; f[2] = shape.halfExtents[2];
      } else if (shape.type === "capsule") {
        f[0] = shape.halfHeight; f[1] = shape.radius;
      } else {
        f[0] = 0.5; // fallback ball (WASM parity)
      }
      const nativeType = st <= 2 ? st : 0;
      f[3] = origin[0]; f[4] = origin[1]; f[5] = origin[2];
      f[6] = rotation[0]; f[7] = rotation[1]; f[8] = rotation[2]; f[9] = rotation[3];
      f[10] = direction[0]; f[11] = direction[1]; f[12] = direction[2];
      const groups = filter?.collisionGroups ?? 0;
      const excl = excludeBodyId(realmId, filter?.excludeEntity);
      if (s.dd_shape_cast(realmId, nativeType, ptr(f), maxDistance, groups, excl, ptr(rayOut)) !== 1) {
        return null;
      }
      return {
        entity: entityFor(realmId, rayOut[7] | 0),
        point: [rayOut[0], rayOut[1], rayOut[2]],
        normal: [rayOut[3], rayOut[4], rayOut[5]],
        distance: rayOut[6],
        hitFraction: rayOut[6],
      };
    },

    getContacts(realmId) {
      let n = s.dd_get_contacts(realmId, ptr(contactsI), ptr(contactsF), ptr(contactsPts), contactsI.length / 3);
      if (n >= contactsI.length / 3) {
        contactsI = new Int32Array(n * 2 * 3);
        contactsF = new Float32Array(n * 2 * 4);
        contactsPts = new Float32Array(n * 2 * 12);
        n = s.dd_get_contacts(realmId, ptr(contactsI), ptr(contactsF), ptr(contactsPts), n * 2);
      }
      const contacts: ContactManifold[] = [];
      for (let k = 0; k < n; k++) {
        const nPts = contactsI[k * 3 + 2];
        const points: Array<[number, number, number]> = [];
        for (let p = 0; p < nPts; p++) {
          const base = k * 12 + p * 3;
          points.push([contactsPts[base], contactsPts[base + 1], contactsPts[base + 2]]);
        }
        contacts.push({
          entityA: entityFor(realmId, contactsI[k * 3]),
          entityB: entityFor(realmId, contactsI[k * 3 + 1]),
          normal: [contactsF[k * 4], contactsF[k * 4 + 1], contactsF[k * 4 + 2]],
          points,
          penetrationDepth: contactsF[k * 4 + 3],
        });
      }
      return contacts;
    },
    getIntersections(realmId) {
      let n = s.dd_get_intersections(realmId, ptr(intersectI), intersectI.length / 2);
      if (n >= intersectI.length / 2) {
        intersectI = new Int32Array(n * 2 * 2);
        n = s.dd_get_intersections(realmId, ptr(intersectI), n * 2);
      }
      const pairs: IntersectionPair[] = [];
      for (let k = 0; k < n; k++) {
        pairs.push({
          entityA: entityFor(realmId, intersectI[k * 2]),
          entityB: entityFor(realmId, intersectI[k * 2 + 1]),
        });
      }
      return pairs;
    },

    createCharacterController(realmId, desc, handle) {
      charF[0] = desc.offset[1]; // WASM parity: offset[1] is the absolute gap
      charF[1] = desc.radius;
      charF[2] = desc.halfHeight;
      charF[3] = desc.maxSlope;
      charF[4] = desc.minSlopeSlide;
      charF[5] = desc.snapToGround;
      charF[6] = desc.autostep.minWidth;
      charF[7] = desc.autostep.maxHeight;
      const p = desc.parentless?.position ?? [0, 0, 0];
      charF[8] = p[0]; charF[9] = p[1]; charF[10] = p[2];

      charI[0] = desc.slide ? 1 : 0;
      charI[1] = desc.autostep.enabled ? 1 : 0;
      charI[2] = desc.applyImpulsesToDynamicBodies ? 1 : 0;
      charI[3] = desc.parentless ? 1 : 0;
      charI[4] = desc.parentless?.collisionGroups ?? desc.collisionGroups ?? 0;
      // WASM parity: non-parentless controllers look up the body by
      // handle.entity.index (bodyId === entity.index for those callers).
      charI[5] = handle.entity.index;

      s.dd_char_create(realmId, handle.controllerId, ptr(charF), ptr(charI));
    },
    destroyCharacterController(realmId, controllerId) {
      s.dd_char_destroy(realmId, controllerId);
    },
    setCharacterColliderPosition(realmId, controllerId, pos) {
      s.dd_char_set_collider_pos(realmId, controllerId, pos[0], pos[1], pos[2]);
    },
    characterMove(realmId, controllerId, desiredMovement, dt) {
      const maxColl = charOutI.length - 1;
      const n = s.dd_char_move(
        realmId, controllerId,
        desiredMovement[0], desiredMovement[1], desiredMovement[2], dt,
        ptr(charOutF), ptr(charOutI), maxColl,
      );
      if (n < 0) {
        return {
          grounded: false, groundNormal: [0, 1, 0], groundEntity: null,
          slid: false, stepped: false, effectiveMovement: [0, 0, 0], collisions: [],
        };
      }
      const grounded = charOutF[0] !== 0;
      const collisions = [];
      for (let k = 0; k < n; k++) {
        const bid = charOutI[1 + k];
        collisions.push({ entity: bid >= 0 ? entityFor(realmId, bid) : null });
      }
      const groundId = charOutI[0];
      return {
        grounded,
        groundNormal: [0, 1, 0],
        groundEntity: groundId >= 0 ? entityFor(realmId, groundId) : null,
        slid: charOutF[4] !== 0,
        stepped: false,
        effectiveMovement: [charOutF[1], charOutF[2], charOutF[3]],
        collisions,
      };
    },

    createJoint(realmId, parentBodyId, childBodyId, jointId, desc) {
      jointF.fill(0);
      jointF[0] = desc.anchorA[0]; jointF[1] = desc.anchorA[1]; jointF[2] = desc.anchorA[2];
      jointF[3] = desc.anchorB[0]; jointF[4] = desc.anchorB[1]; jointF[5] = desc.anchorB[2];
      const axis = desc.axis ?? [0, 1, 0];
      jointF[6] = axis[0]; jointF[7] = axis[1]; jointF[8] = axis[2];
      jointF[9] = desc.limits?.min ?? 0;
      jointF[10] = desc.limits?.max ?? 0;
      // frames: identity quats (x,y,z,w)
      jointF[14] = 1;
      jointF[18] = 1;
      s.dd_create_joint(realmId, jointId, parentBodyId, childBodyId, JOINT_TYPE[desc.type] ?? 0, ptr(jointF));
    },
    destroyJoint(realmId, jointId) {
      s.dd_destroy_joint(realmId, jointId);
    },

    getIslands(realmId) {
      // IslandManager internals aren't exposed over FFI — one island per
      // known body (same shape as the WASM approximation).
      const m = entityByBodyId.get(realmId);
      if (!m) return [];
      const islands: IslandInfo[] = [];
      for (const bodyId of m.keys()) {
        s.dd_get_linvel(realmId, bodyId, ptr(out3));
        islands.push({
          bodyIds: [bodyId],
          maxImportance: 0,
          avgVelocity: Math.sqrt(out3[0] ** 2 + out3[1] ** 2 + out3[2] ** 2),
        });
      }
      return islands;
    },

    serializeRealm() {
      // Requires a serde-enabled rapier build — not wired yet.
      return new Uint8Array(0);
    },
    deserializeRealm() { /* see serializeRealm */ },

    destroy() {
      s.dd_destroy();
      entityByBodyId.clear();
      bodyIdByEntityIndex.clear();
    },
  };

  return ffiLib;
}
