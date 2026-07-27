// ─── ECS Components & Queries ──────────────────────────────

import { Component, createLogger, query, type Entity, type World } from "@downdraft/core";
import { GridInventory } from "../plugins/inventory-plugin.ts";
import {
  ANIMAL_PRODUCT_TIME,
  AnimalStage,
  BiomeType,
  CameraMode,
  HEALTH_REGEN_RATE, HUNGER_DECAY_RATE,
  PetType,
  PIRATE_HEALTH,
  PirateState, PlantStage,
  PLAYER_MAX_HEALTH, PLAYER_MAX_HUNGER,
  PLAYER_MAX_OXYGEN,
  PLAYER_MAX_THIRST,
  PLAYER_TEMP_NORM,
  SHARK_SPEED,
  THIRST_DECAY_RATE,
  WildlifeState,
  XP_MAX_LEVEL,
  XP_PER_LEVEL,
} from "./constants.ts";
import type { LodMesh, VoxelField, WaterVoxelField } from "./terrain.ts";

const log = createLogger();

// ─── Components ───────────────────────────────────────────

export const Health = Component.register("Health", {
  current: PLAYER_MAX_HEALTH,
  max: PLAYER_MAX_HEALTH,
  regenRate: HEALTH_REGEN_RATE,
});

export const Hunger = Component.register("Hunger", {
  current: PLAYER_MAX_HUNGER,
  max: PLAYER_MAX_HUNGER,
  decayRate: HUNGER_DECAY_RATE,
});

export const Thirst = Component.register("Thirst", {
  current: PLAYER_MAX_THIRST,
  max: PLAYER_MAX_THIRST,
  decayRate: THIRST_DECAY_RATE,
});

export const Oxygen = Component.register("Oxygen", {
  current: PLAYER_MAX_OXYGEN,
  max: PLAYER_MAX_OXYGEN,
});

export const Temperature = Component.register("Temperature", {
  current: PLAYER_TEMP_NORM,
});

export const Player = Component.register("Player", {
  x: 0, y: 1, z: 0,
  vx: 0, vy: 0, vz: 0,
  heading: 0, pitch: 0,
  onShip: false,
  isUnderwater: false,
  isSwimming: false,
  isSleeping: false,
  isDead: false,
  isNoclip: false,
  isRunning: false,
  isGrounded: true,
  isClimbing: false,
  isDiving: false,
  bodyHeading: 0,
  cameraMode: CameraMode.ThirdPerson,
  hotbarSlot: 0,
  fallStartY: 0,
  mouseSmoothingX: 0,
  mouseSmoothingY: 0,
});

export const Ship = Component.register("Ship", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  heading: 0,
  throttle: 0,
  steering: 0,
  speed: 0,
  integrity: 100,
  maxIntegrity: 100,
  anchorX: NaN,
  anchorZ: NaN,
});

export const Wildlife = Component.register("Wildlife", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  type: "shark" as string,
  state: WildlifeState.Patrol,
  speed: SHARK_SPEED,
  attackCooldown: 0,
  health: 50,
});

export const Debris = Component.register("Debris", {
  type: "wood" as string,
  x: 0, y: 0, z: 0,
  collected: false,
});

export const Island = Component.register("Island", {
  x: 0, z: 0,
  radius: 10,
  height: 5,
  hasTrees: true,
  hasRocks: true,
  visited: false,
  biome: BiomeType.Tropical,
  chunkX: 0,
  chunkZ: 0,
  voxelField: null as VoxelField | null,
  meshData: null as { verts: Float32Array; indices: Uint16Array | Uint32Array; vertexCount: number; indexCount: number } | null,
  lodMeshes: null as LodMesh[] | null,
  waterVoxelField: null as WaterVoxelField | null,
  waterMeshData: null as { verts: Float32Array; indices: Uint16Array | Uint32Array; vertexCount: number; indexCount: number } | null,
  waterLodMeshes: null as LodMesh[] | null,
});

export const Buildable = Component.register("Buildable", {
  type: "campfire" as string,
  x: 0, y: 0, z: 0,
  health: 100,
});

export const FishingLine = Component.register("FishingLine", {
  cast: false,
  timer: 0,
  waitTime: 0,
  hooked: false,
});

export const Pirate = Component.register("Pirate", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  heading: 0,
  state: PirateState.Patrol,
  health: PIRATE_HEALTH,
  maxHealth: PIRATE_HEALTH,
  attackCooldown: 0,
  difficulty: 1,
  targetEntity: 0,
  stateTimer: 0,
});

export const Port = Component.register("Port", {
  x: 0, z: 0,
  islandEntity: 0,
  name: "Port" as string,
  listings: [] as { item: string; buyPrice: number; sellPrice: number; supply: number; priceModifier: number }[],
});

export const Plant = Component.register("Plant", {
  x: 0, y: 0, z: 0,
  species: "kelp" as string,
  stage: PlantStage.Seed,
  growthTimer: 0,
  waterLevel: 100,
  yield: 1,
  islandEntity: 0,
});

export const Animal = Component.register("Animal", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  species: "chicken" as string,
  stage: AnimalStage.Baby,
  age: 0,
  hunger: 100,
  productTimer: ANIMAL_PRODUCT_TIME,
  productType: "egg" as string,
  islandEntity: 0,
});

export const Pet = Component.register("Pet", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  type: PetType.Cat,
  ownerId: 0,
  happiness: 50,
  hunger: 100,
  cooldown: 0,
});

export const Progression = Component.register("Progression", {
  level: 1,
  xp: 0,
  craftingTier: 0,
  hullTier: 0,
  unlockedRecipes: [] as string[],
});

// ─── Queries ──────────────────────────────────────────────

export const playerQuery = query(Player.id, Health.id, Hunger.id, Thirst.id, Oxygen.id, Temperature.id);
export const playerInvQuery = query(Player.id, GridInventory.id);
export const playerProgQuery = query(Player.id, Progression.id);
export const shipQuery = query(Ship.id);
export const wildlifeQuery = query(Wildlife.id);
export const debrisQuery = query(Debris.id);
export const islandQuery = query(Island.id);
export const buildableQuery = query(Buildable.id);
export const fishingQuery = query(FishingLine.id);
export const pirateQuery = query(Pirate.id);
export const portQuery = query(Port.id);
export const plantQuery = query(Plant.id);
export const animalQuery = query(Animal.id);
export const petQuery = query(Pet.id);

// ─── XP / Progression helpers ─────────────────────────────

export function addXP(world: World, entity: Entity, amount: number) {
  const prog = world.getComponent<typeof Progression.defaults>(entity, Progression.id);
  if (!prog) return;
  prog.xp += amount;
  while (prog.xp >= XP_PER_LEVEL * prog.level && prog.level < XP_MAX_LEVEL) {
    prog.xp -= XP_PER_LEVEL * prog.level;
    prog.level++;
    prog.craftingTier = Math.floor(prog.level / 5);
    log.info("progression", `Level up! Now level ${prog.level} (crafting tier ${prog.craftingTier})`);
  }
}
