// ============================================================================
// ECS Components — mirrors SimEntity/SimPlayer fields for core ECS migration
//
// These components map 1:1 to the fields in SimEntity and SimPlayer.
// The SimEcsBridge keeps the ECS World in sync with the legacy arrays,
// enabling incremental system migration from array-based to query-based.
// ============================================================================

import { Component } from "@downdraft/core";
import type { EntityId, PlayerId } from "@shared/types";
import { CameraMode, EntityType } from "@shared/types";
import type { InventoryGrid } from "../inventory/inventory-system";

// --- Entity Components ---

export const SimTransform = Component.register("SimTransform", {
  x: 0, y: 0, z: 0,
  rotX: 0, rotY: 0, rotZ: 0, rotW: 1,
  scale: 1,
});

export const SimVelocity = Component.register("SimVelocity", {
  vx: 0, vy: 0, vz: 0,
  angVx: 0, angVy: 0, angVz: 0,
});

export const SimHealth = Component.register("SimHealth", {
  health: 100,
  maxHealth: 100,
});

export const SimEntityMeta = Component.register("SimEntityMeta", {
  id: 0 as EntityId,
  type: EntityType.Player as number,
  flags: 0,
  parentId: 0,
  chunkX: 0,
  chunkZ: 0,
});

export const SimEntityData = Component.register("SimEntityData", {
  data: new Float32Array(10),
});

// --- Player Components ---

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
