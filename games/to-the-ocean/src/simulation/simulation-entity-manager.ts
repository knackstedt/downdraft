// Entity & player lifecycle management — extracted from Simulation.ts

import { PLR_FLAG, SimBufferWriter } from "@downdraft/core";
import { InventoryGrid, createGrid } from "@to-the-ocean/module-inventory";
import {
    MAX_ENTITIES, MAX_PLAYERS,
    NIGHT_END_FRAC, NIGHT_START_FRAC,
    PLAYER_HEIGHT,
    PLAYER_INV_HEIGHT,
    PLAYER_INV_WIDTH,
    PLAYER_MAX_HEALTH, PLAYER_MAX_HUNGER,
    PLAYER_MAX_OXYGEN, PLAYER_MAX_TEMPERATURE,
    PLAYER_MAX_THIRST,
    SHIP_DATA,
    SHIP_DATA_SLOTS,
} from "../shared/constants";
import { CameraMode, EntityId, EntityType } from "../shared/types";
import { BoatCellSystem } from "./boat/boat-cell-system";
import { BoatDesignSystem } from "./boat/boat-design-system";
import { SimEcsWorld } from "./ecs/sim-ecs-world";
import { GameModeManager } from "./gamemode/game-mode-manager";
import { RapierPhysicsSystem } from "./physics/rapier-physics-system";
import type { SimEntity, SimPlayer } from "./simulation";
import { SurvivalSystem } from "./survival/survival-system";
import { TerrainSystem } from "./terrain/terrain-system";

export interface SimulationEntityManagerAccess {
  entities: SimEntity[];
  entityCount: number;
  nextEntityId: number;
  freeSlots: number[];
  generations: Uint32Array;
  entityIndex: Map<EntityId, { slot: number; gen: number }>;
  typeIndex: Map<EntityType, number[]>;
  players: SimPlayer[];
  playerCount: number;
  simWriter: SimBufferWriter;
  inputReader: unknown;
  ecs: SimEcsWorld | null;
  physics: RapierPhysicsSystem | null;
  boatCellSystem: BoatCellSystem;
  boatDesignSystem: BoatDesignSystem;
  terrainSystem: TerrainSystem;
  survivalSystem: SurvivalSystem;
  gameModeManager: GameModeManager;
  reportedDead: Set<number>;
  shipInventories: Map<number, InventoryGrid>;
  onDesignRemoved: ((entityId: number) => void) | null;
  timeOfDay: number;
}

export function spawnEntity(
  sim: SimulationEntityManagerAccess,
  type: EntityType,
  opts: {
    position: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number; w: number };
    scale?: number;
    health?: number;
    maxHealth?: number;
    parentId?: number;
    flags?: number;
    data?: Float32Array;
  },
): EntityId {
  const slot = sim.freeSlots.pop() ?? sim.entityCount;
  if (slot >= MAX_ENTITIES) {
    console.error("[Sim] Max entities reached");
    return 0;
  }

  if (sim.entities[slot]) {
    console.error(`[Sim] spawnEntity: slot ${slot} still has entity ${sim.entities[slot].id} (type ${sim.entities[slot].type}) — freeSlots corruption!`);
  }

  const id = sim.nextEntityId++;
  const gen = sim.generations[slot];
  sim.entities[slot] = {
    id,
    type,
    flags: opts.flags ?? 0,
    position: opts.position,
    rotation: opts.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: opts.scale ?? 1,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    health: opts.health ?? 100,
    maxHealth: opts.maxHealth ?? 100,
    parentId: opts.parentId ?? 0,
    chunkX: Math.floor(opts.position.x / 256),
    chunkZ: Math.floor(opts.position.z / 256),
    data: opts.data ?? new Float32Array(SHIP_DATA_SLOTS),
  };

  // Initialize anchor slots to NaN (no anchor deployed) for ship-type entities
  if (type === EntityType.Ship || type === EntityType.SmallCraft) {
    sim.entities[slot]!.data[SHIP_DATA.ANCHOR_X] = NaN;
    sim.entities[slot]!.data[SHIP_DATA.ANCHOR_Z] = NaN;
  }

  if (slot === sim.entityCount) sim.entityCount++;
  sim.entityIndex.set(id, { slot, gen });

  // Track slot in the per-type index
  let typeSlots = sim.typeIndex.get(type);
  if (!typeSlots) {
    typeSlots = [];
    sim.typeIndex.set(type, typeSlots);
  }
  typeSlots.push(slot);

  // Sync to ECS bridge
  sim.ecs?.onSpawn(slot, sim.entities[slot]!);

  // Mark SAB slot dirty so the renderer sees the new entity
  sim.simWriter.markEntityDirty(slot);

  // Register island terrain for volumetric deformation
  if (type === EntityType.Island) {
    sim.terrainSystem.registerIsland(sim.entities[slot]!);
  }
  // Register port terrain for volumetric deformation + caves
  if (type === EntityType.Port) {
    sim.terrainSystem.registerPort(sim.entities[slot]!);
  }

  return id;
}

export function removeEntity(sim: SimulationEntityManagerAccess, id: EntityId): void {
  const idx = getEntitySlot(sim, id);
  if (idx < 0) return;
  const ent = sim.entities[idx];
  if (!ent) return;
  if (ent.type === EntityType.Ship) {
    sim.boatCellSystem.removeBoat(id);
    sim.boatDesignSystem.removeBoat(id);
    sim.shipInventories.delete(id);
    sim.onDesignRemoved?.(id);
  }
  if (ent.type === EntityType.Island || ent.type === EntityType.Port) {
    sim.terrainSystem.unregisterIsland(id);
  }
  // Remove physics body
  sim.physics?.removeEntityBody(idx);
  // Increment generation at idx — invalidates any stale handles pointing here
  sim.generations[idx]++;
  // If the last entity is different from the one being removed, swap and remap
  const lastIdx = sim.entityCount - 1;
  if (lastIdx !== idx) {
    const lastEnt = sim.entities[lastIdx]!;
    sim.entities[idx] = lastEnt;
    sim.entityIndex.set(lastEnt.id, { slot: idx, gen: sim.generations[idx] });
    sim.physics?.remapEntityBody(lastIdx, idx);
    // Increment generation at lastIdx (the now-freed slot)
    sim.generations[lastIdx]++;
    // Update type index: replace lastIdx with idx in the swapped entity's type array
    const swappedTypeSlots = sim.typeIndex.get(lastEnt.type);
    if (swappedTypeSlots) {
      const swappedPos = swappedTypeSlots.indexOf(lastIdx);
      if (swappedPos >= 0) swappedTypeSlots[swappedPos] = idx;
    }
  }
  sim.entities[lastIdx] = undefined as any;
  sim.entityIndex.delete(id);
  sim.entityCount--;
  sim.freeSlots.push(lastIdx);

  // Remove idx from its type's array (swap-remove within the type array)
  const removedTypeSlots = sim.typeIndex.get(ent.type);
  if (removedTypeSlots) {
    const pos = removedTypeSlots.indexOf(idx);
    if (pos >= 0) removedTypeSlots.splice(pos, 1);
  }

  // Sync to ECS bridge
  sim.ecs?.onRemove(idx, id);
  if (lastIdx !== idx) {
    sim.ecs?.onRemap(lastIdx, idx);
  }

  // Mark SAB slots dirty: the removed slot (now empty or swapped) and the freed slot
  sim.simWriter.markEntityDirty(idx);
  if (lastIdx !== idx) sim.simWriter.markEntityDirty(lastIdx);
}

export function getEntity(sim: SimulationEntityManagerAccess, id: EntityId): SimEntity | undefined {
  const idx = getEntitySlot(sim, id);
  if (idx < 0) return undefined;
  return sim.entities[idx];
}

export function getEntitySlot(sim: SimulationEntityManagerAccess, id: EntityId): number {
  const entry = sim.entityIndex.get(id);
  if (entry === undefined) return -1;
  if (sim.generations[entry.slot] !== entry.gen) return -1;
  return entry.slot;
}

// Returns slot indices for all entities of the given type. O(1) lookup.
// The returned array is the live internal array — do not mutate.
export function getEntitiesByType(sim: SimulationEntityManagerAccess, type: EntityType): readonly number[] {
  return sim.typeIndex.get(type) ?? EMPTY_SLOTS;
}
const EMPTY_SLOTS: number[] = [];

// Alias for getEntity — reads more naturally at call sites that check existence by id.
export function getEntityById(sim: SimulationEntityManagerAccess, id: EntityId): SimEntity | undefined {
  return getEntity(sim, id);
}

export function addPlayer(sim: SimulationEntityManagerAccess, playerId: number, name: string): void {
  if (sim.playerCount >= MAX_PLAYERS) {
    console.error("[Sim] Max players reached");
    return;
  }

  // Spawn player entity (beside the ship at origin)
  const entityId = spawnEntity(sim, EntityType.Player, {
    position: { x: 3, y: 2, z: 5 },
    scale: PLAYER_HEIGHT,
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
  });

  const idx = sim.playerCount++;
  sim.players[idx] = {
    playerId,
    entityId,
    name,
    active: true,
    position: { x: 3, y: 2, z: 5 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    bodyHeading: 0,
    pitch: 0,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    hunger: PLAYER_MAX_HUNGER,
    thirst: PLAYER_MAX_THIRST,
    oxygen: PLAYER_MAX_OXYGEN,
    maxOxygen: PLAYER_MAX_OXYGEN,
    temperature: PLAYER_MAX_TEMPERATURE,
    cameraMode: CameraMode.FirstPerson,
    activeSlot: 0,
    flags: 0,
    viewport: { x: 0, y: 0, w: 1, h: 1 },
    inventory: createGrid(PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT),
    licenses: [],
    bedEntityId: 0,
    thirdPersonDistance: 12,
    gold: 100,
  };

  sim.inputReader && sim.simWriter.setPlayerCount(sim.playerCount);

  // Sync to ECS bridge
  sim.ecs?.onAddPlayer(idx, sim.players[idx]!);

  // Mark SAB player slot dirty
  sim.simWriter.markPlayerDirty(idx);
}

export function removePlayer(sim: SimulationEntityManagerAccess, playerId: number): void {
  for (let i = 0; i < sim.playerCount; i++) {
    if (sim.players[i]?.playerId === playerId) {
      removeEntity(sim, sim.players[i].entityId);
      sim.physics?.removeCharacter(i);
      const lastIdx = sim.playerCount - 1;
      if (lastIdx !== i) {
        sim.players[i] = sim.players[lastIdx]!;
        sim.physics?.remapCharacter(lastIdx, i);
      }
      sim.players[lastIdx] = undefined as any;
      sim.playerCount--;
      sim.simWriter.setPlayerCount(sim.playerCount);

      // Sync to ECS bridge
      sim.ecs?.onRemovePlayer(i);
      if (lastIdx !== i) {
        sim.ecs?.onRemapPlayer(lastIdx, i);
      }

      // Mark SAB player slots dirty
      sim.simWriter.markPlayerDirty(i);
      if (lastIdx !== i) sim.simWriter.markPlayerDirty(lastIdx);
      return;
    }
  }
}

export function determineCauseOfDeath(p: SimPlayer): string {
  if (p.oxygen <= 0) return "drowning";
  if (p.hunger <= 0) return "starvation";
  if (p.thirst <= 0) return "dehydration";
  if (p.temperature <= 0 || p.temperature >= 100) return "exposure";
  return "unknown";
}

export function respawnPlayer(sim: SimulationEntityManagerAccess, playerId: number): void {
  const p = sim.players.find(pl => pl?.playerId === playerId);
  if (!p) return;
  const bedPos = { x: 0, y: 5, z: 0 };
  sim.survivalSystem.respawn(p, bedPos);
  sim.reportedDead.delete(playerId);
}

export function checkNightSkip(sim: SimulationEntityManagerAccess): void {
  const isNight = sim.timeOfDay > NIGHT_START_FRAC || sim.timeOfDay < NIGHT_END_FRAC;
  if (!isNight || sim.playerCount === 0) return;

  const sleepingCount = sim.players.filter(p => p.active && (p.flags & PLR_FLAG.SLEEPING)).length;
  const threshold = sim.gameModeManager.rules.nightSkipThreshold as number;
  if (sleepingCount / sim.playerCount >= threshold) {
    // Skip to morning
    sim.timeOfDay = NIGHT_END_FRAC;
  }
}

export function getPlayerCenterX(sim: SimulationEntityManagerAccess): number {
  if (sim.playerCount === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sim.playerCount; i++) sum += sim.players[i].position.x;
  return sum / sim.playerCount;
}

export function getPlayerCenterZ(sim: SimulationEntityManagerAccess): number {
  if (sim.playerCount === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sim.playerCount; i++) sum += sim.players[i].position.z;
  return sum / sim.playerCount;
}
