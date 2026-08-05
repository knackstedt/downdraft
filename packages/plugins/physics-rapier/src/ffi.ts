import type { BodyDesc, BodyType, CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, ColliderDesc, ColliderShape, Entity, IslandInfo, JointDesc, RaycastResult, ShapeCastResult } from "@downdraft/core";
import { createLogger } from "@downdraft/core";

const log = createLogger();

export interface PhysicsLib {
  createRealm(id: number, gravity: [number, number, number]): void;
  destroyRealm(id: number): void;
  createBody(realmId: number, bodyId: number, desc: BodyDesc, entity: Entity): void;
  destroyBody(realmId: number, bodyId: number): void;
  setBodyType(realmId: number, bodyId: number, type: BodyType): void;
  addCollider(realmId: number, bodyId: number, colliderId: number, desc: ColliderDesc): void;
  removeCollider(realmId: number, bodyId: number, colliderId: number): void;
  setColliderPosition?(realmId: number, colliderId: number, pos: [number, number, number]): void;
  getColliderPosition?(realmId: number, colliderId: number): [number, number, number];
  applyForce(realmId: number, bodyId: number, force: [number, number, number]): void;
  applyImpulse(realmId: number, bodyId: number, impulse: [number, number, number]): void;
  applyTorque(realmId: number, bodyId: number, torque: [number, number, number]): void;
  applyTorqueImpulse(realmId: number, bodyId: number, impulse: [number, number, number]): void;
  applyImpulseAtPoint(realmId: number, bodyId: number, impulse: [number, number, number], point: [number, number, number]): void;
  setLinearVelocity(realmId: number, bodyId: number, vel: [number, number, number]): void;
  setAngularVelocity(realmId: number, bodyId: number, vel: [number, number, number]): void;
  setPosition(realmId: number, bodyId: number, pos: [number, number, number]): void;
  setRotation(realmId: number, bodyId: number, rot: [number, number, number, number]): void;
  wakeUp(realmId: number, bodyId: number): void;
  // Raw fast paths (optional — wasm-fallback implements, native FFI stubs)
  setTranslationRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  setRotationRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, w: number, wakeUp: boolean): void;
  getTranslationRaw?(realmId: number, bodyId: number, out: [number, number, number]): void;
  getLinearVelocityRaw?(realmId: number, bodyId: number, out: [number, number, number]): void;
  setLinearVelocityRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  setAngularVelocityRaw?(realmId: number, bodyId: number, x: number, y: number, z: number, wakeUp: boolean): void;
  isSleepingRaw?(realmId: number, bodyId: number): boolean;
  swapColliderShapeRaw?(realmId: number, colliderId: number, vertices: Float32Array, indices: Uint32Array): boolean;
  reserveMemory?(bytes: number): void;
  setIntegrationDt?(realmId: number, dt: number): void;
  step(realmId: number, dt: number): void;
  getBodyTransform(realmId: number, bodyId: number): { position: [number, number, number]; rotation: [number, number, number, number] } | null;
  raycast(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null;
  raycastMulti(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[];
  shapeCast(
    realmId: number,
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null;
  createCharacterController(
    realmId: number,
    desc: CharacterControllerDesc,
    handle: CharacterControllerHandle,
  ): void;
  destroyCharacterController(realmId: number, controllerId: number): void;
  characterMove(
    realmId: number,
    controllerId: number,
    desiredMovement: [number, number, number],
    dt: number,
  ): CharacterMoveResult;
  setCharacterColliderPosition?(realmId: number, controllerId: number, pos: [number, number, number]): void;
  createJoint(
    realmId: number,
    parentBodyId: number,
    childBodyId: number,
    jointId: number,
    desc: JointDesc,
  ): void;
  destroyJoint(realmId: number, jointId: number): void;
  setSolverIterations(realmId: number, iterations: number): void;
  setSleepThresholds(realmId: number, linearThreshold: number, angularThreshold: number): void;
  setCCDEnabled(realmId: number, bodyId: number, enabled: boolean): void;
  getIslands(realmId: number): IslandInfo[];
  serializeRealm(realmId: number): Uint8Array;
  deserializeRealm(realmId: number, data: Uint8Array): void;
  destroy(): void;
}

let cachedLib: PhysicsLib | null = null;
let loadAttempted = false;

export async function loadPhysicsLib(): Promise<PhysicsLib> {
  if (cachedLib) return cachedLib;
  if (loadAttempted) return null as unknown as PhysicsLib;
  loadAttempted = true;

  try {
    const lib = await tryLoadNative();
    if (lib) {
      cachedLib = lib;
      return lib;
    }
  } catch (err) {
    log.warn("physics-rapier", `Failed to load native library: ${err}`);
  }

  try {
    const { loadWasmRapier } = await import("./wasm-fallback");
    const wasmLib = await loadWasmRapier();
    if (wasmLib) {
      log.info("physics-rapier", "Using WASM Rapier fallback.");
      cachedLib = wasmLib;
      return wasmLib;
    }
  } catch (err) {
    log.warn("physics-rapier", `Failed to load WASM fallback: ${err}`);
  }

  log.warn("physics-rapier", "No physics library available. Using JS fallback physics.");
  return null as unknown as PhysicsLib;
}

async function tryLoadNative(): Promise<PhysicsLib | null> {
  const platform = process.platform;
  const ext = platform === "win32" ? ".dll" : platform === "darwin" ? ".dylib" : ".so";
  const libName = `libdowndraft_physics${ext}`;

  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");

    const lib = dlopen(libName, {
      dd_create_realm: { args: [FFIType.i32, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
      dd_destroy_realm: { args: [FFIType.i32], returns: FFIType.i32 },
      dd_create_body: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
      dd_destroy_body: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      dd_step: { args: [FFIType.i32, FFIType.f32], returns: FFIType.i32 },
      dd_step_batched: { args: [FFIType.i32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      dd_set_body_type: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      dd_add_box_collider: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
      dd_add_sphere_collider: { args: [FFIType.i32, FFIType.i32, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
      dd_remove_collider: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      dd_raycast: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.f32, FFIType.ptr], returns: FFIType.i32 },
      dd_destroy: { args: [], returns: FFIType.i32 },
    });

    return {
      createRealm(id, gravity) {
        lib.symbols.dd_create_realm(id, gravity[0], gravity[1], gravity[2]);
      },
      destroyRealm(id) {
        lib.symbols.dd_destroy_realm(id);
      },
      createBody(realmId, bodyId, desc, _entity) {
        const buf = new Float32Array(8);
        buf[0] = desc.position[0]; buf[1] = desc.position[1]; buf[2] = desc.position[2];
        buf[3] = desc.rotation[0]; buf[4] = desc.rotation[1]; buf[5] = desc.rotation[2]; buf[6] = desc.rotation[3];
        buf[7] = desc.mass ?? 1;
        (lib.symbols.dd_create_body as any)(realmId, bodyId, desc.type === "static" ? 0 : desc.type === "kinematic" ? 1 : 2, ptr(buf.buffer), buf[7]);
      },
      destroyBody(realmId, bodyId) {
        lib.symbols.dd_destroy_body(realmId, bodyId);
      },
      setBodyType() {},
      addCollider() {},
      removeCollider() {},
      applyForce() {},
      applyImpulse() {},
      applyTorque() {},
      applyTorqueImpulse() {},
      applyImpulseAtPoint() {},
      setLinearVelocity() {},
      setAngularVelocity() {},
      setPosition() {},
      setRotation() {},
      wakeUp() {},
      step(realmId, dt) {
        lib.symbols.dd_step(realmId, dt);
      },
      getBodyTransform() { return null; },
      raycast() { return null; },
      raycastMulti() { return []; },
      shapeCast() { return null; },
      createCharacterController() {},
      destroyCharacterController() {},
      characterMove() { return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0], collisions: [] }; },
      createJoint() {},
      destroyJoint() {},
      setSolverIterations() {},
      setSleepThresholds() {},
      setCCDEnabled() {},
      getIslands() { return []; },
      serializeRealm() { return new Uint8Array(0); },
      deserializeRealm() {},
      destroy() {
        lib.symbols.dd_destroy();
      },
    };
  } catch {
    return null;
  }
}
