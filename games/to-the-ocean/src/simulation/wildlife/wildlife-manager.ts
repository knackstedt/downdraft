// ============================================================================
// Wildlife Manager — spawns/despawns and manages all wildlife AI
// ============================================================================

import { ChunkManager } from "../world/chunk-manager";
import { BiomeSystem } from "../world/biome-system";
import { SimEntity, SimPlayer } from "../simulation";
import { EntityType, EntityFlags, EntityId, BiomeType } from "../../shared/types";
import {
  WILDLIFE_SPAWN_RADIUS, WILDLIFE_MAX_PER_BIOME, WILDLIFE_DESPAWN_RADIUS,
  SHARK_ATTACK_DAMAGE, EEL_SHOCK_DAMAGE, JELLYFISH_DOT_DAMAGE, DEVIL_SHRIP_ATTACK_DAMAGE,
} from "../../shared/constants";
import { FishAI } from "./fish-ai";
import { SharkAI } from "./shark-ai";
import { EelAI } from "./eel-ai";
import { JellyfishAI } from "./jellyfish-ai";
import { DevilShrimpAI } from "./devil-shrimp-ai";
import { PassiveAI } from "./passive-ai";
import { BoatSystem } from "../boat/boat-system";

type SpawnEntityFn = (type: EntityType, opts: {
  position: { x: number; y: number; z: number };
  scale?: number;
  flags?: number;
  health?: number;
  maxHealth?: number;
  data?: Float32Array;
}) => EntityId;
type RemoveEntityFn = (id: EntityId) => void;

export class WildlifeManager {
  private chunkManager: ChunkManager;
  private biomeSystem: BiomeSystem;
  private boatSystem: BoatSystem;
  private fishAI: FishAI;
  private sharkAI: SharkAI;
  private eelAI: EelAI;
  private jellyfishAI: JellyfishAI;
  private devilShrimpAI: DevilShrimpAI;
  private passiveAI: PassiveAI;
  private spawnTimer = 0;
  private spawnedIds = new Set<EntityId>();

  // Clearance radii (meters) to keep creatures from spawning inside obstacles
  private static readonly SHIP_CLEARANCE = 32;       // BOAT_GRID_MAX * BOAT_CELL_WORLD_SIZE
  private static readonly PIRATE_SHIP_CLEARANCE = 25;
  private static readonly PORT_CLEARANCE_MARGIN = 10;
  private static readonly ISLAND_CLEARANCE_MARGIN = 15;
  private static readonly MAX_SPAWN_ATTEMPTS = 5;

  constructor(chunkManager: ChunkManager, biomeSystem: BiomeSystem, boatSystem: BoatSystem) {
    this.chunkManager = chunkManager;
    this.biomeSystem = biomeSystem;
    this.boatSystem = boatSystem;
    this.fishAI = new FishAI();
    this.sharkAI = new SharkAI();
    this.eelAI = new EelAI();
    this.jellyfishAI = new JellyfishAI();
    this.devilShrimpAI = new DevilShrimpAI();
    this.passiveAI = new PassiveAI();
  }

  tick(
    dt: number,
    entities: SimEntity[],
    count: number,
    players: SimPlayer[],
    playerCount: number,
    spawnEntity: SpawnEntityFn,
    removeEntity: RemoveEntityFn,
  ): void {
    // Spawn wildlife periodically
    this.spawnTimer += dt;
    if (this.spawnTimer > 2) {
      this.spawnTimer = 0;
      this.trySpawnWildlife(entities, count, players, playerCount, spawnEntity);
    }

    // Run AI for each wildlife entity
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;

      switch (ent.type) {
        case EntityType.Fish:
          this.fishAI.tick(ent, dt, entities, count);
          break;
        case EntityType.Shark:
          this.sharkAI.tick(ent, dt, players, playerCount, entities, count, this.boatSystem);
          break;
        case EntityType.Eel:
          this.eelAI.tick(ent, dt, players, playerCount);
          break;
        case EntityType.Jellyfish:
          this.jellyfishAI.tick(ent, dt, players, playerCount);
          break;
        case EntityType.DevilShrimp:
          this.devilShrimpAI.tick(ent, dt, players, playerCount, entities, count);
          break;
        case EntityType.Whale:
        case EntityType.Dolphin:
        case EntityType.Turtle:
        case EntityType.Crustacean:
        case EntityType.Coral:
        case EntityType.Moose:
          this.passiveAI.tick(ent, dt, players, playerCount);
          break;
      }
    }

    // Despawn wildlife too far from players
    this.despawnDistantWildlife(entities, count, players, playerCount, removeEntity);
  }

  private isPositionClearOfObstacles(x: number, z: number, entities: SimEntity[], count: number): boolean {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;

      let clearance = 0;
      switch (ent.type) {
        case EntityType.Ship:
          clearance = WildlifeManager.SHIP_CLEARANCE;
          break;
        case EntityType.PirateShip:
          clearance = WildlifeManager.PIRATE_SHIP_CLEARANCE;
          break;
        case EntityType.Port:
          clearance = ent.scale + WildlifeManager.PORT_CLEARANCE_MARGIN;
          break;
        case EntityType.Island:
          clearance = ent.scale + WildlifeManager.ISLAND_CLEARANCE_MARGIN;
          break;
        default:
          continue;
      }

      const dx = x - ent.position.x;
      const dz = z - ent.position.z;
      if (dx * dx + dz * dz < clearance * clearance) return false;
    }
    return true;
  }

  private trySpawnWildlife(entities: SimEntity[], count: number, players: SimPlayer[], playerCount: number, spawnEntity: SpawnEntityFn): void {
    if (playerCount === 0) return;

    // Count wildlife per biome
    const biomeCounts = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (this.isWildlife(ent.type)) {
        const biome = this.chunkManager.getBiomeAt(ent.position.x, ent.position.z);
        biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
      }
    }

    // Spawn near random player
    const player = players[Math.floor(Math.random() * playerCount)];
    if (!player?.active) return;

    const biome = this.chunkManager.getBiomeAt(player.position.x, player.position.z);
    const currentCount = biomeCounts.get(biome) ?? 0;
    if (currentCount >= WILDLIFE_MAX_PER_BIOME) return;

    // Determine what to spawn based on biome
    const spawnType = this.rollSpawnType(biome);
    if (spawnType === EntityType.Fish) {
      // Spawn a school of fish
      const schoolSize = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < schoolSize; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * WILDLIFE_SPAWN_RADIUS;
        const x = player.position.x + Math.cos(angle) * dist;
        const z = player.position.z + Math.sin(angle) * dist;
        if (!this.isPositionClearOfObstacles(x, z, entities, count)) continue;
        const y = -5 - Math.random() * 15;
        const id = spawnEntity(EntityType.Fish, {
          position: { x, y, z },
          scale: 0.3 + Math.random() * 0.3,
          health: 10,
          maxHealth: 10,
          data: new Float32Array([Math.random() * Math.PI * 2, 1 + Math.random() * 2, 0, 0, 0, 0]),
        });
        if (id !== 0) this.spawnedIds.add(id);
      }
    } else {
      let x = 0, z = 0;
      let found = false;
      for (let attempt = 0; attempt < WildlifeManager.MAX_SPAWN_ATTEMPTS; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 30 + Math.random() * WILDLIFE_SPAWN_RADIUS;
        x = player.position.x + Math.cos(angle) * dist;
        z = player.position.z + Math.sin(angle) * dist;
        if (this.isPositionClearOfObstacles(x, z, entities, count)) {
          found = true;
          break;
        }
      }
      if (!found) return;
      const y = this.getYForType(spawnType);
      const stats = this.getStatsForType(spawnType);
      const id = spawnEntity(spawnType, {
        position: { x, y, z },
        scale: stats.scale,
        flags: spawnType === EntityType.Coral ? EntityFlags.Static : 0,
        health: stats.hp,
        maxHealth: stats.hp,
        data: new Float32Array([Math.random() * Math.PI * 2, 0, 0, 0, 0, 0, 0, 0]),
      });
      if (id !== 0) this.spawnedIds.add(id);
    }
  }

  private rollSpawnType(biome: number): EntityType {
    const roll = Math.random();
    switch (biome) {
      case BiomeType.Ocean:
      case BiomeType.Tropical:
      case BiomeType.SubTropical:
        if (roll < 0.6) return EntityType.Fish;
        if (roll < 0.75) return EntityType.Shark;
        if (roll < 0.85) return EntityType.Jellyfish;
        if (roll < 0.92) return EntityType.Dolphin;
        return EntityType.Whale;
      case BiomeType.DeepOcean:
        if (roll < 0.4) return EntityType.Fish;
        if (roll < 0.55) return EntityType.Shark;
        if (roll < 0.70) return EntityType.Jellyfish;
        if (roll < 0.80) return EntityType.Eel;
        if (roll < 0.90) return EntityType.Whale;
        return EntityType.Turtle;
      case BiomeType.CoralReef:
        if (roll < 0.5) return EntityType.Fish;
        if (roll < 0.65) return EntityType.Coral;
        if (roll < 0.75) return EntityType.Jellyfish;
        if (roll < 0.85) return EntityType.Crustacean;
        return EntityType.Turtle;
      case BiomeType.KelpForest:
        if (roll < 0.4) return EntityType.Fish;
        if (roll < 0.55) return EntityType.Crustacean;
        if (roll < 0.70) return EntityType.Eel;
        if (roll < 0.85) return EntityType.Turtle;
        return EntityType.Coral;
      case BiomeType.Volcanic:
      case BiomeType.Hell:
        if (roll < 0.3) return EntityType.Fish;
        if (roll < 0.55) return EntityType.Eel;
        if (roll < 0.85) return EntityType.DevilShrimp;
        return EntityType.Jellyfish;
      case BiomeType.Arctic:
        if (roll < 0.4) return EntityType.Fish;
        if (roll < 0.60) return EntityType.Crustacean;
        if (roll < 0.80) return EntityType.Turtle;
        return EntityType.Whale;
      case BiomeType.GarbagePatch:
        if (roll < 0.5) return EntityType.Fish;
        if (roll < 0.70) return EntityType.Jellyfish;
        if (roll < 0.85) return EntityType.Crustacean;
        return EntityType.Shark;
      default:
        if (roll < 0.7) return EntityType.Fish;
        if (roll < 0.85) return EntityType.Turtle;
        return EntityType.Crustacean;
    }
  }

  private getStatsForType(type: EntityType): { hp: number; scale: number } {
    const healthMap: Record<number, { hp: number; scale: number }> = {
      [EntityType.Shark]: { hp: 80, scale: 2 },
      [EntityType.Eel]: { hp: 30, scale: 1 },
      [EntityType.Jellyfish]: { hp: 15, scale: 0.8 },
      [EntityType.DevilShrimp]: { hp: 120, scale: 1.5 },
      [EntityType.Whale]: { hp: 200, scale: 8 },
      [EntityType.Dolphin]: { hp: 60, scale: 2 },
      [EntityType.Turtle]: { hp: 50, scale: 1.5 },
      [EntityType.Crustacean]: { hp: 20, scale: 0.5 },
      [EntityType.Coral]: { hp: 10, scale: 1 },
      [EntityType.Moose]: { hp: 150, scale: 2.5 },
    };
    return healthMap[type] ?? { hp: 30, scale: 1 };
  }

  private getYForType(type: EntityType): number {
    switch (type) {
      case EntityType.Shark: return -3;
      case EntityType.Eel: return -10;
      case EntityType.Jellyfish: return -2 - Math.random() * 8;
      case EntityType.DevilShrimp: return -20;
      case EntityType.Whale: return -2;
      case EntityType.Dolphin: return -1;
      case EntityType.Turtle: return -5;
      case EntityType.Crustacean: return -15;
      case EntityType.Coral: return -10;
      case EntityType.Moose: return -30;
      default: return -5;
    }
  }

  private isWildlife(type: EntityType): boolean {
    return type === EntityType.Fish || type === EntityType.Shark || type === EntityType.Eel ||
           type === EntityType.Jellyfish || type === EntityType.DevilShrimp ||
           type === EntityType.Whale || type === EntityType.Dolphin || type === EntityType.Turtle ||
           type === EntityType.Crustacean || type === EntityType.Coral || type === EntityType.Moose;
  }

  private despawnDistantWildlife(entities: SimEntity[], count: number, players: SimPlayer[], playerCount: number, removeEntity: RemoveEntityFn): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || !this.isWildlife(ent.type)) continue;
      if (!this.spawnedIds.has(ent.id)) continue;

      let minDist = Infinity;
      for (let p = 0; p < playerCount; p++) {
        if (!players[p]?.active) continue;
        const dx = ent.position.x - players[p].position.x;
        const dz = ent.position.z - players[p].position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDist) minDist = dist;
      }

      if (minDist > WILDLIFE_DESPAWN_RADIUS) {
        this.spawnedIds.delete(ent.id);
        removeEntity(ent.id);
        // removeEntity may swap entities, so re-scan from current index
        i--;
      }
    }
  }

  shutdown(): void {
    this.spawnedIds.clear();
  }
}
