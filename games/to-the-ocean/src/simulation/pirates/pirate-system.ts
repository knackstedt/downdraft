// ============================================================================
// Pirate System — 13+ races, difficulty scaling, loot, treasure maps
// ============================================================================

import { SimEntity, SimPlayer } from "../simulation";
import { EntityType, EntityFlags, SecurityLevel, PirateRace } from "../../shared/types";
import { ChunkManager } from "../world/chunk-manager";
import {
  PIRATE_SPAWN_BASE_RATE, PIRATE_SPAWN_SAFE_MULT, PIRATE_SPAWN_EXTREME_MULT,
  PIRATE_TREASURE_MAP_CHANCE,
} from "../../shared/constants";

enum PirateState { Patrol, Chase, Attack, Board, Flee }

interface PirateEntity {
  entityId: number;
  race: PirateRace;
  state: PirateState;
  difficulty: number;
  targetId: number;
  stateTimer: number;
  health: number;
  maxHealth: number;
}

const ALL_PIRATE_RACES: PirateRace[] = [
  PirateRace.Swashbuckler, PirateRace.Mafia, PirateRace.Corsair,
  PirateRace.Smuggler, PirateRace.Raider, PirateRace.Marauder,
  PirateRace.Buccaneer, PirateRace.Privateer, PirateRace.Reaver,
  PirateRace.Dreadnought, PirateRace.KrakenCult, PirateRace.GhostFleet,
  PirateRace.AbyssalOrder,
];

export class PirateSystem {
  private chunkManager: ChunkManager;
  private pirates = new Map<number, PirateEntity>();
  private spawnTimer = 0;

  constructor(chunkManager: ChunkManager) {
    this.chunkManager = chunkManager;
  }

  tick(
    dt: number,
    entities: SimEntity[],
    count: number,
    players: SimPlayer[],
    playerCount: number,
    chunkManager: ChunkManager,
  ): void {
    // Spawn check
    this.spawnTimer += dt;
    if (this.spawnTimer > 5) {
      this.spawnTimer = 0;
      this.trySpawnPirates(entities, count, players, playerCount);
    }

    // Update pirate AI
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Pirate && ent.type !== EntityType.PirateShip) continue;

      const pirate = this.pirates.get(ent.id);
      if (!pirate) continue;

      this.updatePirateAI(ent, pirate, dt, players, playerCount, entities, count);
    }

    // Remove dead pirates
    for (const [id, pirate] of this.pirates) {
      if (pirate.health <= 0) {
        // Drop loot
        this.dropLoot(pirate);
        this.pirates.delete(id);
      }
    }
  }

  private trySpawnPirates(entities: SimEntity[], count: number, players: SimPlayer[], playerCount: number): void {
    if (playerCount === 0) return;

    for (let p = 0; p < playerCount; p++) {
      const player = players[p];
      if (!player?.active) continue;

      const security = this.chunkManager.getSecurityLevelAt(player.position.x, player.position.z);
      let spawnMult = 1;
      switch (security) {
        case SecurityLevel.Safe: spawnMult = PIRATE_SPAWN_SAFE_MULT; break;
        case SecurityLevel.Moderate: spawnMult = 0.5; break;
        case SecurityLevel.High: spawnMult = 2.0; break;
        case SecurityLevel.Extreme: spawnMult = PIRATE_SPAWN_EXTREME_MULT; break;
      }

      const rulesMult = 1; // could be modified by game rules
      const spawnChance = PIRATE_SPAWN_BASE_RATE * spawnMult * rulesMult * 5; // per 5-second check

      if (Math.random() < spawnChance) {
        // Spawn pirate ship near player
        const angle = Math.random() * Math.PI * 2;
        const dist = 100 + Math.random() * 200;
        const x = player.position.x + Math.cos(angle) * dist;
        const z = player.position.z + Math.sin(angle) * dist;

        const race = ALL_PIRATE_RACES[Math.floor(Math.random() * ALL_PIRATE_RACES.length)];
        const difficulty = 1 + security * 0.5 + Math.random();

        // Find free entity slot
        for (let i = 0; i < entities.length; i++) {
          if (!entities[i]) {
            const id = 0; // will be assigned
            entities[i] = {
              id,
              type: EntityType.PirateShip,
              flags: EntityFlags.Hostile,
              position: { x, y: 0, z },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: 2 + difficulty * 0.5,
              velocity: { x: 0, y: 0, z: 0 },
              angularVelocity: { x: 0, y: 0, z: 0 },
              health: 50 * difficulty,
              maxHealth: 50 * difficulty,
              parentId: 0,
              chunkX: Math.floor(x / 256),
              chunkZ: Math.floor(z / 256),
              data: new Float32Array([Math.random() * Math.PI * 2, 3, PirateState.Patrol, 0, 0, difficulty]),
            };
            this.pirates.set(id, {
              entityId: id,
              race,
              state: PirateState.Patrol,
              difficulty,
              targetId: -1,
              stateTimer: 0,
              health: 50 * difficulty,
              maxHealth: 50 * difficulty,
            });
            break;
          }
        }
      }
    }
  }

  private updatePirateAI(
    ent: SimEntity,
    pirate: PirateEntity,
    dt: number,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    count: number,
  ): void {
    pirate.stateTimer -= dt;

    // Find nearest player
    let nearestDist = Infinity;
    let nearestIdx = -1;
    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      const dx = players[p].position.x - ent.position.x;
      const dz = players[p].position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = p;
      }
    }

    switch (pirate.state) {
      case PirateState.Patrol:
        if (pirate.stateTimer <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          pirate.stateTimer = 10;
        }
        if (nearestDist < 80 && nearestIdx >= 0) {
          pirate.state = PirateState.Chase;
          pirate.targetId = nearestIdx;
          pirate.stateTimer = 30;
        }
        break;

      case PirateState.Chase:
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          const dx = player.position.x - ent.position.x;
          const dz = player.position.z - ent.position.z;
          ent.data[0] = Math.atan2(dz, dx);
          if (nearestDist < 15) {
            pirate.state = PirateState.Attack;
            pirate.stateTimer = 10;
          }
          if (nearestDist > 120 || pirate.stateTimer <= 0) {
            pirate.state = PirateState.Patrol;
            pirate.stateTimer = 0;
          }
        }
        break;

      case PirateState.Attack:
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          // Deal damage to player
          player.health -= 10 * pirate.difficulty * dt;
          // Also damage player's ship if nearby
          if (pirate.stateTimer <= 0) {
            pirate.state = PirateState.Flee;
            pirate.stateTimer = 10;
          }
        }
        break;

      case PirateState.Flee:
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          const dx = ent.position.x - player.position.x;
          const dz = ent.position.z - player.position.z;
          ent.data[0] = Math.atan2(dz, dx);
        }
        if (pirate.stateTimer <= 0) {
          pirate.state = PirateState.Patrol;
          pirate.stateTimer = 0;
        }
        break;
    }

    // Move
    const heading = ent.data[0];
    const speed = pirate.state === PirateState.Chase ? 5 :
                  pirate.state === PirateState.Flee ? 6 : 2;
    ent.velocity.x = Math.cos(heading) * speed;
    ent.velocity.z = Math.sin(heading) * speed;

    // Update health tracking
    pirate.health = ent.health;
  }

  private dropLoot(pirate: PirateEntity): void {
    // In full implementation, would spawn loot items and possibly treasure map
    if (Math.random() < PIRATE_TREASURE_MAP_CHANCE) {
      // Spawn treasure map item
    }
    // Spawn gold/loot based on difficulty
  }

  shutdown(): void {
    this.pirates.clear();
  }
}
