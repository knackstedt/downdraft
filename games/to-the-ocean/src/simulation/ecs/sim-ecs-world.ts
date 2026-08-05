// ============================================================================
// SimEcsWorld — bridge between legacy SimEntity[] arrays and core ECS World
//
// The Simulation class uses flat arrays with slot-index-based entity management.
// This bridge creates a parallel ECS World with components mirroring SimEntity
// and SimPlayer fields, kept in sync each tick.
//
// Systems can be migrated incrementally from array iteration to query-based
// iteration. The bridge handles:
//   - Creating/destroying ECS entities on spawn/remove
//   - Syncing component data from legacy arrays before queries are used
//   - Mapping slot indices ↔ ECS entities
// ============================================================================

import { Query, Stage, system, World, type Entity } from "@downdraft/core";
import { createBuoyancySystem, type BuoyancyConfig, type BuoyancyDeps } from "@downdraft/plugin-buoyancy";
import { createCollisionSystem, type CollisionConfig, type CollisionDeps } from "@downdraft/plugin-collision";
import { createWildlifeSystem, shutdownWildlife, type WildlifeConfig, type WildlifeDeps } from "@downdraft/plugin-wildlife";
import type { EntityId } from "@shared/types";
import { EntityType, SecurityLevel } from "@shared/types";
import { InputBufferReader } from "../../shared/input-buffer";
import type { BoatCellSystem } from "../boat/boat-cell-system";
import type { SimEntity, SimPlayer } from "../simulation";
import {
    ComponentIds,
    SimEntityData,
    SimEntityMeta,
    SimHealth,
    SimPlayerInventory,
    SimPlayerState,
    SimTransform,
    SimVelocity,
} from "./components";
import { createEcsAnchorSystem } from "./ecs-anchor-system";
import { createEcsAnimalSystem } from "./ecs-animal-system";
import { createEcsCameraSystem } from "./ecs-camera-system";
import { createEcsDockingSystem } from "./ecs-docking-system";
import { createEcsPetSystem } from "./ecs-pet-system";
import { createEcsPirateSystem, shutdownEcsPirates } from "./ecs-pirate-system";
import { createEcsPlantSystem } from "./ecs-plant-system";
import { createEcsStructureIntegritySystem } from "./ecs-structure-integrity-system";

type TransformData = ReturnType<typeof SimTransform.create>;
type VelocityData = ReturnType<typeof SimVelocity.create>;
type HealthData = ReturnType<typeof SimHealth.create>;
type EntityMetaData = ReturnType<typeof SimEntityMeta.create>;
type EntityDataData = ReturnType<typeof SimEntityData.create>;
type PlayerStateData = ReturnType<typeof SimPlayerState.create>;
type PlayerInventoryData = ReturnType<typeof SimPlayerInventory.create>;

export class SimEcsWorld {
  readonly world: World;

  // Mapping: legacy slot index → ECS entity
  private slotToEntity: Map<number, Entity> = new Map();
  // Mapping: ECS entity → legacy slot index
  private entityToSlot: Map<string, number> = new Map();
  // Mapping: legacy entity ID → ECS entity
  private idToEntity: Map<number, Entity> = new Map();

  // Pre-built queries for common iteration patterns
  readonly allEntities: Query;
  readonly ships: Query;
  readonly wildlife: Query;
  readonly islands: Query;
  readonly ports: Query;
  readonly players: Query;
  readonly livestock: Query;
  readonly plants: Query;
  readonly pets: Query;
  readonly wildlifeWithHealth: Query;
  readonly pirates: Query;
  readonly smallCraft: Query;
  readonly wildlifeAI: Query;
  readonly shipsWithHealth: Query;
  readonly allEntitiesWithVelocity: Query;

  constructor() {
    this.world = new World();

    // Query: all entities with Transform + EntityMeta (every SimEntity)
    this.allEntities = new Query([ComponentIds.Transform, ComponentIds.EntityMeta]);

    // Query: ships only (type = Ship or SmallCraft)
    // Note: type filtering is done at iteration time since Query doesn't support
    // value-based filtering — systems check ent.type in the loop body.
    // Includes Velocity so buoyancy and anchor systems can read/write ship velocities.
    this.ships = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData]);
    this.wildlife = new Query([ComponentIds.Transform, ComponentIds.EntityMeta, ComponentIds.Health]);
    this.islands = new Query([ComponentIds.Transform, ComponentIds.EntityMeta]);
    this.ports = new Query([ComponentIds.Transform, ComponentIds.EntityMeta]);
    this.players = new Query([ComponentIds.PlayerState]);
    this.livestock = new Query([ComponentIds.EntityMeta, ComponentIds.Health, ComponentIds.EntityData]);
    this.plants = new Query([ComponentIds.EntityMeta, ComponentIds.EntityData]);
    this.pets = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData]);
    this.wildlifeWithHealth = new Query([ComponentIds.EntityMeta, ComponentIds.Transform, ComponentIds.Health]);
    this.pirates = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData, ComponentIds.Health]);
    this.smallCraft = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData]);
    this.wildlifeAI = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData, ComponentIds.Health]);
    this.shipsWithHealth = new Query([ComponentIds.Transform, ComponentIds.EntityMeta, ComponentIds.EntityData, ComponentIds.Health]);
    this.allEntitiesWithVelocity = new Query([ComponentIds.Transform, ComponentIds.Velocity, ComponentIds.EntityMeta, ComponentIds.EntityData]);

    // Register queries with the schedule so they get archetype updates
    this.world.schedule.add(system(
      "ecs-bridge-queries",
      Stage.Input,
      () => {},
      { queries: [this.allEntities, this.ships, this.wildlife, this.islands, this.ports, this.players, this.livestock, this.plants, this.pets, this.wildlifeWithHealth, this.pirates, this.smallCraft, this.wildlifeAI, this.shipsWithHealth, this.allEntitiesWithVelocity] },
    ));

    // Register migrated ECS systems
    this.world.schedule.add(createEcsAnimalSystem(this.livestock));
    this.world.schedule.add(createEcsAnchorSystem(this.ships));
    this.world.schedule.add(createEcsPlantSystem(this.plants));
    this.world.schedule.add(createEcsPetSystem(this.pets, this.players, this.wildlifeWithHealth));
    this.world.schedule.add(createEcsDockingSystem(this.ships, this.smallCraft));
  }

  // --- Late registration (needs Simulation callbacks) ---

  registerPirateSystem(
    getSecurityLevel: (x: number, z: number) => SecurityLevel,
    spawnEntity: (type: EntityType, opts: {
      position: { x: number; y: number; z: number };
      scale?: number;
      health?: number;
      maxHealth?: number;
      flags?: number;
      data?: Float32Array;
    }) => number,
    removeEntity: (id: number) => void,
  ): void {
    this.world.schedule.add(createEcsPirateSystem(
      this.pirates, this.players, getSecurityLevel, spawnEntity, removeEntity,
    ));
  }

  shutdownPirates(): void {
    shutdownEcsPirates();
  }

  registerCameraSystem(getInput: () => InputBufferReader): void {
    this.world.schedule.add(createEcsCameraSystem(this.players, getInput));
  }

  registerStructureIntegritySystem(getBoatCellSystem: () => BoatCellSystem | undefined): void {
    this.world.schedule.add(createEcsStructureIntegritySystem(this.shipsWithHealth, getBoatCellSystem));
  }

  registerWildlifeSystem(deps: WildlifeDeps, config: WildlifeConfig): void {
    this.world.schedule.add(createWildlifeSystem(
      this.wildlifeAI, this.players, this.shipsWithHealth, this.allEntities, deps, config,
    ));
  }

  shutdownWildlife(): void {
    shutdownWildlife();
  }

  registerBuoyancySystem(deps: BuoyancyDeps, config: BuoyancyConfig): void {
    this.world.schedule.add(createBuoyancySystem(
      this.ships, this.allEntitiesWithVelocity, deps, config,
    ));
  }

  registerCollisionSystem(deps: CollisionDeps, config: CollisionConfig): void {
    this.world.schedule.add(createCollisionSystem(
      this.allEntitiesWithVelocity, this.players, deps, config,
    ));
  }

  // --- Entity lifecycle (called by Simulation) ---

  onSpawn(slot: number, ent: SimEntity): void {
    const components = new Map<number, unknown>([
      [ComponentIds.Transform, SimTransform.create({
        x: ent.position.x, y: ent.position.y, z: ent.position.z,
        rotX: ent.rotation.x, rotY: ent.rotation.y, rotZ: ent.rotation.z, rotW: ent.rotation.w,
        scale: ent.scale,
      })],
      [ComponentIds.Velocity, SimVelocity.create({
        vx: ent.velocity.x, vy: ent.velocity.y, vz: ent.velocity.z,
        angVx: ent.angularVelocity.x, angVy: ent.angularVelocity.y, angVz: ent.angularVelocity.z,
      })],
      [ComponentIds.Health, SimHealth.create({
        health: ent.health, maxHealth: ent.maxHealth,
      })],
      [ComponentIds.EntityMeta, SimEntityMeta.create({
        id: ent.id, type: ent.type, flags: ent.flags,
        parentId: ent.parentId, chunkX: ent.chunkX, chunkZ: ent.chunkZ,
      })],
      [ComponentIds.EntityData, SimEntityData.create({
        data: ent.data as Float32Array<ArrayBuffer>,
      })],
    ]);

    const entity = this.world.spawn(components);
    this.slotToEntity.set(slot, entity);
    this.entityToSlot.set(`${entity.index}:${entity.generation}`, slot);
    this.idToEntity.set(ent.id, entity);
  }

  onRemove(slot: number, entityId: EntityId): void {
    const entity = this.slotToEntity.get(slot);
    if (entity) {
      this.world.despawn(entity);
      this.entityToSlot.delete(`${entity.index}:${entity.generation}`);
    }
    this.slotToEntity.delete(slot);
    this.idToEntity.delete(entityId);
  }

  onRemap(oldSlot: number, newSlot: number): void {
    const entity = this.slotToEntity.get(oldSlot);
    if (entity) {
      this.slotToEntity.delete(oldSlot);
      this.slotToEntity.set(newSlot, entity);
      this.entityToSlot.set(`${entity.index}:${entity.generation}`, newSlot);
    }
  }

  // --- Player lifecycle ---

  onAddPlayer(slot: number, player: SimPlayer): void {
    const components = new Map<number, unknown>([
      [ComponentIds.PlayerState, SimPlayerState.create({
        playerId: player.playerId,
        entityId: player.entityId,
        name: player.name,
        active: player.active,
        x: player.position.x, y: player.position.y, z: player.position.z,
        vx: player.velocity.x, vy: player.velocity.y, vz: player.velocity.z,
        heading: player.heading,
        bodyHeading: player.bodyHeading,
        pitch: player.pitch,
        rotX: player.rotation.x, rotY: player.rotation.y, rotZ: player.rotation.z, rotW: player.rotation.w,
        health: player.health, maxHealth: player.maxHealth,
        hunger: player.hunger, thirst: player.thirst,
        oxygen: player.oxygen, maxOxygen: player.maxOxygen,
        temperature: player.temperature,
        cameraMode: player.cameraMode,
        activeSlot: player.activeSlot,
        flags: player.flags,
        viewportX: player.viewport.x, viewportY: player.viewport.y,
        viewportW: player.viewport.w, viewportH: player.viewport.h,
        bedEntityId: player.bedEntityId,
        thirdPersonDistance: player.thirdPersonDistance,
        gold: player.gold,
      })],
      [ComponentIds.PlayerInventory, SimPlayerInventory.create({
        inventory: player.inventory,
        licenses: player.licenses,
      })],
    ]);

    const entity = this.world.spawn(components);
    this.slotToEntity.set(-1 - slot, entity); // negative slots for players to avoid collision
  }

  onRemovePlayer(slot: number): void {
    const key = -1 - slot;
    const entity = this.slotToEntity.get(key);
    if (entity) {
      this.world.despawn(entity);
      this.slotToEntity.delete(key);
    }
  }

  onRemapPlayer(oldSlot: number, newSlot: number): void {
    const entity = this.slotToEntity.get(-1 - oldSlot);
    if (entity) {
      this.slotToEntity.delete(-1 - oldSlot);
      this.slotToEntity.set(-1 - newSlot, entity);
    }
  }

  // --- Sync (called before systems that use queries) ---

  syncEntities(entities: SimEntity[], entityCount: number): void {
    const world = this.world;
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      const entity = this.slotToEntity.get(i);
      if (!entity) continue;

      const ar = world.getArchetypeAndRow(entity);
      if (!ar) continue;
      const { arch, row } = ar;

      const transform = arch.columns.get(ComponentIds.Transform)?.[row] as TransformData | undefined;
      if (transform) {
        transform.x = ent.position.x;
        transform.y = ent.position.y;
        transform.z = ent.position.z;
        transform.rotX = ent.rotation.x;
        transform.rotY = ent.rotation.y;
        transform.rotZ = ent.rotation.z;
        transform.rotW = ent.rotation.w;
        transform.scale = ent.scale;
      }

      const vel = arch.columns.get(ComponentIds.Velocity)?.[row] as VelocityData | undefined;
      if (vel) {
        vel.vx = ent.velocity.x;
        vel.vy = ent.velocity.y;
        vel.vz = ent.velocity.z;
        vel.angVx = ent.angularVelocity.x;
        vel.angVy = ent.angularVelocity.y;
        vel.angVz = ent.angularVelocity.z;
      }

      const health = arch.columns.get(ComponentIds.Health)?.[row] as HealthData | undefined;
      if (health) {
        health.health = ent.health;
        health.maxHealth = ent.maxHealth;
      }

      const meta = arch.columns.get(ComponentIds.EntityMeta)?.[row] as EntityMetaData | undefined;
      if (meta) {
        meta.id = ent.id;
        meta.type = ent.type;
        meta.flags = ent.flags;
        meta.parentId = ent.parentId;
        meta.chunkX = ent.chunkX;
        meta.chunkZ = ent.chunkZ;
      }

      const data = arch.columns.get(ComponentIds.EntityData)?.[row] as EntityDataData | undefined;
      if (data) {
        data.data = ent.data as Float32Array<ArrayBuffer>;
      }
    }
  }

  syncPlayers(players: SimPlayer[], playerCount: number): void {
    const world = this.world;
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p) continue;
      const entity = this.slotToEntity.get(-1 - i);
      if (!entity) continue;

      const ar = world.getArchetypeAndRow(entity);
      if (!ar) continue;
      const { arch, row } = ar;

      const state = arch.columns.get(ComponentIds.PlayerState)?.[row] as PlayerStateData | undefined;
      if (state) {
        state.playerId = p.playerId;
        state.entityId = p.entityId;
        state.name = p.name;
        state.active = p.active;
        state.x = p.position.x;
        state.y = p.position.y;
        state.z = p.position.z;
        state.vx = p.velocity.x;
        state.vy = p.velocity.y;
        state.vz = p.velocity.z;
        state.heading = p.heading;
        state.bodyHeading = p.bodyHeading;
        state.pitch = p.pitch;
        state.rotX = p.rotation.x;
        state.rotY = p.rotation.y;
        state.rotZ = p.rotation.z;
        state.rotW = p.rotation.w;
        state.health = p.health;
        state.maxHealth = p.maxHealth;
        state.hunger = p.hunger;
        state.thirst = p.thirst;
        state.oxygen = p.oxygen;
        state.maxOxygen = p.maxOxygen;
        state.temperature = p.temperature;
        state.cameraMode = p.cameraMode;
        state.activeSlot = p.activeSlot;
        state.flags = p.flags;
        state.viewportX = p.viewport.x;
        state.viewportY = p.viewport.y;
        state.viewportW = p.viewport.w;
        state.viewportH = p.viewport.h;
        state.bedEntityId = p.bedEntityId;
        state.thirdPersonDistance = p.thirdPersonDistance;
        state.gold = p.gold;
      }

      const inv = arch.columns.get(ComponentIds.PlayerInventory)?.[row] as PlayerInventoryData | undefined;
      if (inv) {
        inv.inventory = p.inventory;
        inv.licenses = p.licenses;
      }
    }
  }

  // --- Write-back (called after systems that modify ECS components) ---

  writeBackEntities(entities: SimEntity[], entityCount: number): void {
    const world = this.world;
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      const entity = this.slotToEntity.get(i);
      if (!entity) continue;

      const ar = world.getArchetypeAndRow(entity);
      if (!ar) continue;
      const { arch, row } = ar;

      const transform = arch.columns.get(ComponentIds.Transform)?.[row] as TransformData | undefined;
      if (transform) {
        ent.position.x = transform.x;
        ent.position.y = transform.y;
        ent.position.z = transform.z;
        ent.rotation.x = transform.rotX;
        ent.rotation.y = transform.rotY;
        ent.rotation.z = transform.rotZ;
        ent.rotation.w = transform.rotW;
        ent.scale = transform.scale;
      }

      const vel = arch.columns.get(ComponentIds.Velocity)?.[row] as VelocityData | undefined;
      if (vel) {
        ent.velocity.x = vel.vx;
        ent.velocity.y = vel.vy;
        ent.velocity.z = vel.vz;
        ent.angularVelocity.x = vel.angVx;
        ent.angularVelocity.y = vel.angVy;
        ent.angularVelocity.z = vel.angVz;
      }

      const health = arch.columns.get(ComponentIds.Health)?.[row] as HealthData | undefined;
      if (health) {
        ent.health = health.health;
        ent.maxHealth = health.maxHealth;
      }

      const meta = arch.columns.get(ComponentIds.EntityMeta)?.[row] as EntityMetaData | undefined;
      if (meta) {
        ent.id = meta.id;
        ent.type = meta.type;
        ent.flags = meta.flags;
        ent.parentId = meta.parentId;
        ent.chunkX = meta.chunkX;
        ent.chunkZ = meta.chunkZ;
      }
    }
  }

  writeBackPlayers(players: SimPlayer[], playerCount: number): void {
    const world = this.world;
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p) continue;
      const entity = this.slotToEntity.get(-1 - i);
      if (!entity) continue;

      const ar = world.getArchetypeAndRow(entity);
      if (!ar) continue;
      const { arch, row } = ar;

      const state = arch.columns.get(ComponentIds.PlayerState)?.[row] as PlayerStateData | undefined;
      if (state) {
        p.playerId = state.playerId;
        p.entityId = state.entityId;
        p.name = state.name;
        p.active = state.active;
        p.position.x = state.x;
        p.position.y = state.y;
        p.position.z = state.z;
        p.velocity.x = state.vx;
        p.velocity.y = state.vy;
        p.velocity.z = state.vz;
        p.heading = state.heading;
        p.bodyHeading = state.bodyHeading;
        p.pitch = state.pitch;
        p.rotation.x = state.rotX;
        p.rotation.y = state.rotY;
        p.rotation.z = state.rotZ;
        p.rotation.w = state.rotW;
        p.health = state.health;
        p.maxHealth = state.maxHealth;
        p.hunger = state.hunger;
        p.thirst = state.thirst;
        p.oxygen = state.oxygen;
        p.maxOxygen = state.maxOxygen;
        p.temperature = state.temperature;
        p.cameraMode = state.cameraMode;
        p.activeSlot = state.activeSlot;
        p.flags = state.flags;
        p.viewport.x = state.viewportX;
        p.viewport.y = state.viewportY;
        p.viewport.w = state.viewportW;
        p.viewport.h = state.viewportH;
        p.bedEntityId = state.bedEntityId;
        p.thirdPersonDistance = state.thirdPersonDistance;
        p.gold = state.gold;
      }
    }
  }

  // --- Lookup ---

  getEntityByLegacyId(id: EntityId): Entity | undefined {
    return this.idToEntity.get(id);
  }

  getSlotForEntity(entity: Entity): number | undefined {
    return this.entityToSlot.get(`${entity.index}:${entity.generation}`);
  }

  clearAll(): void {
    this.world.clearAllEntities();
    this.slotToEntity.clear();
    this.entityToSlot.clear();
    this.idToEntity.clear();
  }

  // --- ECS step (flushes commands, runs schedule) ---

  step(dt: number): void {
    this.world.step(dt);
  }
}
