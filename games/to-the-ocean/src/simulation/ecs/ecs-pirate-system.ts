// ============================================================================
// ECS Pirate System — migrated from array-based PirateSystem
//
// Query: pirates (Transform + Velocity + EntityMeta + EntityData + Health)
// Query: players (PlayerState) for targeting
// Spawn uses spawnEntity callback (passed via closure) to properly create
// entities through the Simulation's lifecycle (fixes legacy bypass bug)
// ============================================================================

import { Stage, system, type Query, type SystemContext, type World } from "@downdraft/core";
import { SimEntityData, SimEntityMeta, SimHealth, SimPlayerState, SimTransform, SimVelocity } from "./components.ts";
import { EntityType, EntityFlags, SecurityLevel, PirateRace } from "@shared/types";
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

const pirates = new Map<number, PirateEntity>();
let spawnTimer = 0;

export function createEcsPirateSystem(
  piratesQuery: Query,
  playersQuery: Query,
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
) {
  return system(
    "ecs-pirate-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      // --- Spawn check ---
      spawnTimer += dt;
      if (spawnTimer > 5) {
        spawnTimer = 0;
        trySpawnPirates(playersQuery, ctx.tick, getSecurityLevel, spawnEntity);
      }

      // --- Collect player data for AI targeting ---
      const playerList: { playerId: number; x: number; y: number; z: number; active: boolean }[] = [];
      playersQuery.iterate(ctx.tick, (_entity, comps) => {
        const ps = comps[0] as ReturnType<typeof SimPlayerState.create>;
        playerList.push({ playerId: ps.playerId, x: ps.x, y: ps.y, z: ps.z, active: ps.active });
      });

      // --- Update pirate AI ---
      piratesQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as ReturnType<typeof SimTransform.create>;
        const vel = comps[1] as ReturnType<typeof SimVelocity.create>;
        const meta = comps[2] as ReturnType<typeof SimEntityMeta.create>;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;
        const health = comps[4] as ReturnType<typeof SimHealth.create>;

        if (meta.type !== EntityType.Pirate && meta.type !== EntityType.PirateShip) return;

        const pirate = pirates.get(meta.id);
        if (!pirate) return;

        updatePirateAI(transform, vel, data, health, pirate, dt, playerList, playersQuery, ctx);
      });

      // --- Remove dead pirates ---
      for (const [id, pirate] of pirates) {
        if (pirate.health <= 0) {
          dropLoot(pirate);
          pirates.delete(id);
          removeEntity(id);
        }
      }
    },
    { queries: [piratesQuery] },
  );
}

function trySpawnPirates(
  playersQuery: Query,
  currentTick: number,
  getSecurityLevel: (x: number, z: number) => SecurityLevel,
  spawnEntity: (type: EntityType, opts: {
    position: { x: number; y: number; z: number };
    scale?: number;
    health?: number;
    maxHealth?: number;
    flags?: number;
    data?: Float32Array;
  }) => number,
): void {
  const playerList: { x: number; z: number; active: boolean }[] = [];
  playersQuery.iterate(currentTick, (_entity, comps) => {
    const ps = comps[0] as ReturnType<typeof SimPlayerState.create>;
    playerList.push({ x: ps.x, z: ps.z, active: ps.active });
  });

  if (playerList.length === 0) return;

  for (const player of playerList) {
    if (!player.active) continue;

    const security = getSecurityLevel(player.x, player.z);
    let spawnMult = 1;
    switch (security) {
      case SecurityLevel.Safe: spawnMult = PIRATE_SPAWN_SAFE_MULT; break;
      case SecurityLevel.Moderate: spawnMult = 0.5; break;
      case SecurityLevel.High: spawnMult = 2.0; break;
      case SecurityLevel.Extreme: spawnMult = PIRATE_SPAWN_EXTREME_MULT; break;
    }

    const spawnChance = PIRATE_SPAWN_BASE_RATE * spawnMult * 5;

    if (Math.random() < spawnChance) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * 200;
      const x = player.x + Math.cos(angle) * dist;
      const z = player.z + Math.sin(angle) * dist;

      const race = ALL_PIRATE_RACES[Math.floor(Math.random() * ALL_PIRATE_RACES.length)];
      const difficulty = 1 + security * 0.5 + Math.random();

      const id = spawnEntity(EntityType.PirateShip, {
        position: { x, y: 0, z },
        scale: 2 + difficulty * 0.5,
        health: 50 * difficulty,
        maxHealth: 50 * difficulty,
        flags: EntityFlags.Hostile,
        data: new Float32Array([Math.random() * Math.PI * 2, 3, PirateState.Patrol, 0, 0, difficulty]),
      });

      if (id > 0) {
        pirates.set(id, {
          entityId: id,
          race,
          state: PirateState.Patrol,
          difficulty,
          targetId: -1,
          stateTimer: 0,
          health: 50 * difficulty,
          maxHealth: 50 * difficulty,
        });
      }
    }
  }
}

function updatePirateAI(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  health: ReturnType<typeof SimHealth.create>,
  pirate: PirateEntity,
  dt: number,
  playerList: { playerId: number; x: number; y: number; z: number; active: boolean }[],
  playersQuery: Query,
  ctx: SystemContext,
): void {
  pirate.stateTimer -= dt;

  // Find nearest player
  let nearestDist = Infinity;
  let nearestIdx = -1;
  for (let p = 0; p < playerList.length; p++) {
    if (!playerList[p].active) continue;
    const dx = playerList[p].x - transform.x;
    const dz = playerList[p].z - transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = p;
    }
  }

  switch (pirate.state) {
    case PirateState.Patrol:
      if (pirate.stateTimer <= 0) {
        data.data[0] = Math.random() * Math.PI * 2;
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
        const dx = playerList[nearestIdx].x - transform.x;
        const dz = playerList[nearestIdx].z - transform.z;
        data.data[0] = Math.atan2(dz, dx);
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
        // Damage player through players query
        playersQuery.iterate(ctx.tick, (_entity, comps) => {
          const ps = comps[0] as ReturnType<typeof SimPlayerState.create>;
          if (ps.playerId === playerList[nearestIdx].playerId) {
            ps.health -= 10 * pirate.difficulty * dt;
          }
        });
        if (pirate.stateTimer <= 0) {
          pirate.state = PirateState.Flee;
          pirate.stateTimer = 10;
        }
      }
      break;

    case PirateState.Flee:
      if (nearestIdx >= 0) {
        const dx = transform.x - playerList[nearestIdx].x;
        const dz = transform.z - playerList[nearestIdx].z;
        data.data[0] = Math.atan2(dz, dx);
      }
      if (pirate.stateTimer <= 0) {
        pirate.state = PirateState.Patrol;
        pirate.stateTimer = 0;
      }
      break;
  }

  // Move
  const heading = data.data[0];
  const speed = pirate.state === PirateState.Chase ? 5 :
                pirate.state === PirateState.Flee ? 6 : 2;
  vel.vx = Math.cos(heading) * speed;
  vel.vz = Math.sin(heading) * speed;

  // Update health tracking
  pirate.health = health.health;
}

function dropLoot(pirate: PirateEntity): void {
  if (Math.random() < PIRATE_TREASURE_MAP_CHANCE) {
    // Spawn treasure map item
  }
}

export function shutdownEcsPirates(): void {
  pirates.clear();
  spawnTimer = 0;
}

export { pirates as ecsPiratesMap };
export type { PirateEntity };
