// ============================================================================
// ECS Components — mirrors SimEntity/SimPlayer fields for core ECS migration
//
// These components map 1:1 to the fields in SimEntity and SimPlayer.
// The SimEcsBridge keeps the ECS World in sync with the legacy arrays,
// enabling incremental system migration from array-based to query-based.
//
// Hot numeric components (SimTransform, SimVelocity, SimHealth, SimEntityMeta)
// use SoA TypedArray storage for zero-GC iteration. Complex/reference-type
// components (SimEntityData, SimPlayerState, SimPlayerInventory) remain AoS.
// ============================================================================

import { Component, soaComponent } from "@downdraft/core";
import type { EntityId, PlayerId } from "@shared/types";
import { CameraMode } from "@shared/types";
import type { InventoryGrid } from "@to-the-ocean/plugin-inventory";

// --- Entity Components (SoA — hot path, numeric fields) ---

export const SimTransform = soaComponent("SimTransform", {
  x: "f32", y: "f32", z: "f32",
  rotX: "f32", rotY: "f32", rotZ: "f32", rotW: "f32",
  scale: "f32",
});
export type SimTransformData = typeof SimTransform.defaults;
/** SoA column view for SimTransform — fields are TypedArrays indexed by row. */
export type SimTransformSoA = { x: Float32Array; y: Float32Array; z: Float32Array; rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array; scale: Float32Array };

export const SimVelocity = soaComponent("SimVelocity", {
  vx: "f32", vy: "f32", vz: "f32",
  angVx: "f32", angVy: "f32", angVz: "f32",
});
export type SimVelocityData = typeof SimVelocity.defaults;
/** SoA column view for SimVelocity. */
export type SimVelocitySoA = { vx: Float32Array; vy: Float32Array; vz: Float32Array; angVx: Float32Array; angVy: Float32Array; angVz: Float32Array };

export const SimHealth = soaComponent("SimHealth", {
  health: "f32",
  maxHealth: "f32",
});
export type SimHealthData = typeof SimHealth.defaults;
/** SoA column view for SimHealth. */
export type SimHealthSoA = { health: Float32Array; maxHealth: Float32Array };

export const SimEntityMeta = soaComponent("SimEntityMeta", {
  id: "u32",
  type: "u32",
  flags: "u32",
  parentId: "u32",
  chunkX: "i32",
  chunkZ: "i32",
});
export type SimEntityMetaData = typeof SimEntityMeta.defaults;
/** SoA column view for SimEntityMeta. */
export type SimEntityMetaSoA = { id: Uint32Array; type: Uint32Array; flags: Uint32Array; parentId: Uint32Array; chunkX: Int32Array; chunkZ: Int32Array };

// --- Entity Components (AoS — reference types, not on hot path) ---

export const SimEntityData = Component.register("SimEntityData", {
  data: new Float32Array(10),
});

// --- Player Components (AoS — complex types, only 8 players) ---

export const SimPlayerState = Component.register("SimPlayerState", {
  playerId: 0 as PlayerId,
  entityId: 0 as EntityId,
  name: "",
  active: true,
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  heading: 0,
  bodyHeading: 0,
  pitch: 0,
  rotX: 0, rotY: 0, rotZ: 0, rotW: 1,
  health: 100,
  maxHealth: 100,
  hunger: 100,
  thirst: 100,
  oxygen: 100,
  maxOxygen: 100,
  temperature: 37,
  cameraMode: CameraMode.FirstPerson as number,
  activeSlot: 0,
  flags: 0,
  viewportX: 0, viewportY: 0, viewportW: 1, viewportH: 1,
  bedEntityId: 0,
  thirdPersonDistance: 12,
  gold: 100,
});

export const SimPlayerInventory = Component.register("SimPlayerInventory", {
  inventory: null as InventoryGrid | null,
  licenses: [] as number[],
});

// --- Component ID shortcuts (for query construction) ---

export const ComponentIds = {
  Transform: SimTransform.id,
  Velocity: SimVelocity.id,
  Health: SimHealth.id,
  EntityMeta: SimEntityMeta.id,
  EntityData: SimEntityData.id,
  PlayerState: SimPlayerState.id,
  PlayerInventory: SimPlayerInventory.id,
};
