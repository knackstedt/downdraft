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

import { getColumnValue, InputBufferReader, isSoAColumn, ModuleHost, Query, registerHmrSwap, Stage, system, World, type Entity, type System } from "@downdraft/core";
import { devtools } from "@downdraft/module-devtools";
import type { EntityId } from "@shared/types";
import { EntityType, SecurityLevel } from "@shared/types";
import { createBuoyancyModule, type BuoyancyConfig, type BuoyancyDeps } from "@to-the-ocean/module-buoyancy";
import { createCollisionModule, type CollisionConfig, type CollisionDeps } from "@to-the-ocean/module-collision";
import { createWildlifeModule, type WildlifeConfig, type WildlifeDeps } from "@to-the-ocean/module-wildlife";
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
    type SimEntityMetaSoA,
    type SimHealthSoA,
    type SimTransformSoA,
    type SimVelocitySoA,
} from "./components";
import { createEcsAnchorSystem } from "./ecs-anchor-system";
import { createEcsAnimalSystem } from "./ecs-animal-system";
import { createEcsCameraSystem } from "./ecs-camera-system";
import { createEcsDockingSystem } from "./ecs-docking-system";
import { createEcsPetSystem } from "./ecs-pet-system";
import { createEcsPirateSystem, shutdownEcsPirates } from "./ecs-pirate-system";
import { createEcsStructureIntegritySystem } from "./ecs-structure-integrity-system";

type EntityDataData = ReturnType<typeof SimEntityData.create>;
type PlayerStateData = ReturnType<typeof SimPlayerState.create>;
type PlayerInventoryData = ReturnType<typeof SimPlayerInventory.create>;

type SystemRecreator = (newMod: Record<string, unknown>) => System;

export class SimEcsWorld {
  readonly world: World;
  /** Module host for systems migrated to the plugin system. */
  readonly moduleHost: ModuleHost;

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
    this.moduleHost = new ModuleHost(this.world);
    // Inject the devtools singleton so sim plugins can self-register
    // debug panels/data feeds via ctx.devtools.register*(...).
    this.moduleHost.setDevToolsAPI(devtools);

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

    // Register migrated ECS systems (self-accepting HMR via hmrSwap)
    this.addEcsSystem("ecs-animal-system",
      () => createEcsAnimalSystem(this.livestock),
      (mod) => (mod as { createEcsAnimalSystem: typeof createEcsAnimalSystem }).createEcsAnimalSystem(this.livestock),
    );
    this.addEcsSystem("ecs-anchor-system",
      () => createEcsAnchorSystem(this.ships),
      (mod) => (mod as { createEcsAnchorSystem: typeof createEcsAnchorSystem }).createEcsAnchorSystem(this.ships),
    );
    // Note: ecs-plant-system is intentionally NOT registered. Plant growth is
    // driven by the array-based PlantSystem (simulation/farming/plant-system.ts)
    // from the main tick, which is the source of truth. The ECS query `plants`
    // is still used by the debug system.
    this.addEcsSystem("ecs-pet-system",
      () => createEcsPetSystem(this.pets, this.players, this.wildlifeWithHealth),
      (mod) => (mod as { createEcsPetSystem: typeof createEcsPetSystem }).createEcsPetSystem(this.pets, this.players, this.wildlifeWithHealth),
    );
    this.addEcsSystem("ecs-docking-system",
      () => createEcsDockingSystem(this.ships, this.smallCraft),
      (mod) => (mod as { createEcsDockingSystem: typeof createEcsDockingSystem }).createEcsDockingSystem(this.ships, this.smallCraft),
    );
  }

  /**
   * Add a system to the schedule and register an HMR swap callback.
   * The system module self-accepts via import.meta.hot.accept and calls hmrSwap().
   */
  private addEcsSystem(
    name: string,
    factory: () => System,
    recreator: SystemRecreator,
  ): void {
    this.world.schedule.addSystem(factory());
    if (import.meta.env.DEV && import.meta.hot) {
      registerHmrSwap(name, (newMod) => {
        this.world.schedule.removeSystem(name);
        this.world.schedule.addSystem(recreator(newMod));
      });
    }
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
    this.addEcsSystem("ecs-pirate-system",
      () => createEcsPirateSystem(
        this.pirates, this.players, getSecurityLevel, spawnEntity, removeEntity,
      ),
      (mod) => (mod as { createEcsPirateSystem: typeof createEcsPirateSystem }).createEcsPirateSystem(
        this.pirates, this.players, getSecurityLevel, spawnEntity, removeEntity,
      ),
    );
  }

  shutdownPirates(): void {
    shutdownEcsPirates();
  }

  registerCameraSystem(getInput: () => InputBufferReader): void {
    this.addEcsSystem("ecs-camera-system",
      () => createEcsCameraSystem(this.players, getInput),
      (mod) => (mod as { createEcsCameraSystem: typeof createEcsCameraSystem }).createEcsCameraSystem(this.players, getInput),
    );
  }

  registerStructureIntegritySystem(getBoatCellSystem: () => BoatCellSystem | undefined): void {
    this.addEcsSystem("ecs-structure-integrity-system",
      () => createEcsStructureIntegritySystem(this.shipsWithHealth, getBoatCellSystem),
      (mod) => (mod as { createEcsStructureIntegritySystem: typeof createEcsStructureIntegritySystem }).createEcsStructureIntegritySystem(this.shipsWithHealth, getBoatCellSystem),
    );
  }

  registerWildlifeSystem(deps: WildlifeDeps, config: WildlifeConfig): void {
    const plugin = createWildlifeModule({
      wildlifeQuery: this.wildlifeAI,
      playersQuery: this.players,
      shipsQuery: this.shipsWithHealth,
      allEntitiesQuery: this.allEntities,
      deps, config,
    });
    this.moduleHost.registerModule(plugin);
    if (import.meta.env.DEV && import.meta.hot) {
      registerHmrSwap("wildlife-system", () => {
        this.moduleHost.unloadModule("wildlife");
        this.moduleHost.registerModule(createWildlifeModule({
          wildlifeQuery: this.wildlifeAI,
          playersQuery: this.players,
          shipsQuery: this.shipsWithHealth,
          allEntitiesQuery: this.allEntities,
          deps, config,
        }));
      });
    }
  }

  shutdownWildlife(): void {
    this.moduleHost.unloadModule("wildlife");
  }

  registerBuoyancySystem(deps: BuoyancyDeps, config: BuoyancyConfig): void {
    const plugin = createBuoyancyModule({
      shipsQuery: this.ships,
      allEntitiesQuery: this.allEntitiesWithVelocity,
      deps, config,
    });
    this.moduleHost.registerModule(plugin);
    if (import.meta.env.DEV && import.meta.hot) {
      registerHmrSwap("buoyancy-system", () => {
        this.moduleHost.unloadModule("buoyancy");
        this.moduleHost.registerModule(createBuoyancyModule({
          shipsQuery: this.ships,
          allEntitiesQuery: this.allEntitiesWithVelocity,
          deps, config,
        }));
      });
    }
  }

  registerCollisionSystem(deps: CollisionDeps, config: CollisionConfig): void {
    const plugin = createCollisionModule({
      allEntitiesQuery: this.allEntitiesWithVelocity,
      playersQuery: this.players,
      deps, config,
    });
    this.moduleHost.registerModule(plugin);
    if (import.meta.env.DEV && import.meta.hot) {
      registerHmrSwap("collision-system", () => {
        this.moduleHost.unloadModule("collision");
        this.moduleHost.registerModule(createCollisionModule({
          allEntitiesQuery: this.allEntitiesWithVelocity,
          playersQuery: this.players,
          deps, config,
        }));
      });
    }
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

      // SoA components — write via TypedArray[row]
      // SoA columns are SoAColumn objects with an .arrays property (TypedArray record).
      const transformCol = arch.columns.get(ComponentIds.Transform);
      if (transformCol && isSoAColumn(transformCol)) {
        const t = transformCol.arrays as unknown as SimTransformSoA;
        t.x[row] = ent.position.x;
        t.y[row] = ent.position.y;
        t.z[row] = ent.position.z;
        t.rotX[row] = ent.rotation.x;
        t.rotY[row] = ent.rotation.y;
        t.rotZ[row] = ent.rotation.z;
        t.rotW[row] = ent.rotation.w;
        t.scale[row] = ent.scale;
      }

      const velCol = arch.columns.get(ComponentIds.Velocity);
      if (velCol && isSoAColumn(velCol)) {
        const v = velCol.arrays as unknown as SimVelocitySoA;
        v.vx[row] = ent.velocity.x;
        v.vy[row] = ent.velocity.y;
        v.vz[row] = ent.velocity.z;
        v.angVx[row] = ent.angularVelocity.x;
        v.angVy[row] = ent.angularVelocity.y;
        v.angVz[row] = ent.angularVelocity.z;
      }

      const healthCol = arch.columns.get(ComponentIds.Health);
      if (healthCol && isSoAColumn(healthCol)) {
        const h = healthCol.arrays as unknown as SimHealthSoA;
        h.health[row] = ent.health;
        h.maxHealth[row] = ent.maxHealth;
      }

      const metaCol = arch.columns.get(ComponentIds.EntityMeta);
      if (metaCol && isSoAColumn(metaCol)) {
        const m = metaCol.arrays as unknown as SimEntityMetaSoA;
        m.id[row] = ent.id;
        m.type[row] = ent.type;
        m.flags[row] = ent.flags;
        m.parentId[row] = ent.parentId;
        m.chunkX[row] = ent.chunkX;
        m.chunkZ[row] = ent.chunkZ;
      }

      // AoS component — write via object at row
      const dataCol = arch.columns.get(ComponentIds.EntityData);
      const data = dataCol ? getColumnValue(dataCol, row) as EntityDataData | undefined : undefined;
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

      const stateCol = arch.columns.get(ComponentIds.PlayerState);
      const state = stateCol ? getColumnValue(stateCol, row) as PlayerStateData | undefined : undefined;
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

      const invCol = arch.columns.get(ComponentIds.PlayerInventory);
      const inv = invCol ? getColumnValue(invCol, row) as PlayerInventoryData | undefined : undefined;
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

      // SoA components — read via TypedArray[row]
      const transformCol = arch.columns.get(ComponentIds.Transform);
      if (transformCol && isSoAColumn(transformCol)) {
        const t = transformCol.arrays as unknown as SimTransformSoA;
        ent.position.x = t.x[row]!;
        ent.position.y = t.y[row]!;
        ent.position.z = t.z[row]!;
        ent.rotation.x = t.rotX[row]!;
        ent.rotation.y = t.rotY[row]!;
        ent.rotation.z = t.rotZ[row]!;
        ent.rotation.w = t.rotW[row]!;
        ent.scale = t.scale[row]!;
      }

      const velCol = arch.columns.get(ComponentIds.Velocity);
      if (velCol && isSoAColumn(velCol)) {
        const v = velCol.arrays as unknown as SimVelocitySoA;
        ent.velocity.x = v.vx[row]!;
        ent.velocity.y = v.vy[row]!;
        ent.velocity.z = v.vz[row]!;
        ent.angularVelocity.x = v.angVx[row]!;
        ent.angularVelocity.y = v.angVy[row]!;
        ent.angularVelocity.z = v.angVz[row]!;
      }

      const healthCol = arch.columns.get(ComponentIds.Health);
      if (healthCol && isSoAColumn(healthCol)) {
        const h = healthCol.arrays as unknown as SimHealthSoA;
        ent.health = h.health[row]!;
        ent.maxHealth = h.maxHealth[row]!;
      }

      const metaCol = arch.columns.get(ComponentIds.EntityMeta);
      if (metaCol && isSoAColumn(metaCol)) {
        const m = metaCol.arrays as unknown as SimEntityMetaSoA;
        ent.id = m.id[row]!;
        ent.type = m.type[row]!;
        ent.flags = m.flags[row]!;
        ent.parentId = m.parentId[row]!;
        ent.chunkX = m.chunkX[row]!;
        ent.chunkZ = m.chunkZ[row]!;
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

      const stateCol = arch.columns.get(ComponentIds.PlayerState);
      const state = stateCol ? getColumnValue(stateCol, row) as PlayerStateData | undefined : undefined;
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
