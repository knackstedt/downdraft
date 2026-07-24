import type { BodyDesc, BodyType, ColliderDesc, PhysicsRealmConfig, RaycastResult, ShapeCastResult, ColliderShape } from "@downdraft/core";
import type { Entity } from "@downdraft/core";

export interface PhysicsLib {
  createRealm(id: number, gravity: [number, number, number]): void;
  destroyRealm(id: number): void;
  createBody(realmId: number, bodyId: number, desc: BodyDesc): void;
  destroyBody(realmId: number, bodyId: number): void;
  setBodyType(realmId: number, bodyId: number, type: BodyType): void;
  addCollider(realmId: number, bodyId: number, colliderId: number, desc: ColliderDesc): void;
  removeCollider(realmId: number, bodyId: number, colliderId: number): void;
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
    console.warn("[physics-rapier] Failed to load native library:", err);
  }

  console.warn("[physics-rapier] Native library not available. Using JS fallback physics.");
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
      createBody(realmId, bodyId, desc) {
        const buf = new Float32Array(8);
        buf[0] = desc.position[0]; buf[1] = desc.position[1]; buf[2] = desc.position[2];
        buf[3] = desc.rotation[0]; buf[4] = desc.rotation[1]; buf[5] = desc.rotation[2]; buf[6] = desc.rotation[3];
        buf[7] = desc.mass ?? 1;
        lib.symbols.dd_create_body(realmId, bodyId, desc.type === "static" ? 0 : desc.type === "kinematic" ? 1 : 2, ptr(buf), buf[7]);
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
      destroy() {
        lib.symbols.dd_destroy();
      },
    };
  } catch {
    return null;
  }
}
