// ============================================================================
// Wildlife System — ECS-native spawning, despawning, and AI dispatch
//
// Queries:
//   wildlifeQuery:    [Transform, Velocity, EntityMeta, EntityData, Health]
//   playersQuery:     [PlayerState]
//   shipsQuery:       [Transform, EntityMeta, EntityData, Health]
//   allEntitiesQuery: [Transform, EntityMeta]
//
// All game-specific values provided via WildlifeConfig.
// ============================================================================

import { BroadPhaseGrid, hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { tickDevilShrimpAI } from "./ai/devil-shrimp-ai";
import { tickEelAI } from "./ai/eel-ai";
import { tickFishAI } from "./ai/fish-ai";
import { tickJellyfishAI } from "./ai/jellyfish-ai";
import { tickPassiveAI } from "./ai/passive-ai";
import { tickSharkAI } from "./ai/shark-ai";
import type {
    WildlifeConfig, WildlifeDeps, WildlifeEntity,
    WildlifeEntityData,
    WildlifeEntityMeta,
    WildlifeHealth,
    WildlifePlayer,
    WildlifePlayerState,
    WildlifeShip,
    WildlifeTransform, WildlifeVelocity,
} from "./types";

// Reusable obstacle list interface for spawn clearance.
interface ObstacleEntry { x: number; z: number; clearance: number; }

/**
 * No-op shutdown function for backward compatibility.
 * State is now instance-scoped (inside createWildlifeSystem closure)
 * and will be garbage collected when the system is discarded.
 */
export function shutdownWildlife(): void {
  // State is instance-scoped — no module-level state to clear.
}

export function createWildlifeSystem(
  wildlifeQuery: Query,
  playersQuery: Query,
  shipsQuery: Query,
  allEntitiesQuery: Query,
  deps: WildlifeDeps,
  config: WildlifeConfig,
) {
  // Instance-scoped state (moved from module level to support multiple instances)
  const spawnedIds = new Set<number>();
  let spawnTimer = 0;

  // Reusable biome counts map — cleared per spawn cycle instead of reallocated.
  const biomeCounts = new Map<number, number>();

  // Reusable obstacle list for spawn clearance — built once per spawn cycle.
  const obstacleList: ObstacleEntry[] = [];

  // Spatial grid for fish schooling (cellSize = schooling radius 10).
  // Reused across ticks via clear(). Stores fish indices into fishList.
  const fishGrid = new BroadPhaseGrid(10);
  const fishNeighborOut: number[] = [];

  return system(
    "wildlife-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      // --- Pre-collect players ---
      const players: WildlifePlayer[] = [];
      playersQuery.iterate(ctx.tick, (_entity, comps) => {
        const ps = comps[0] as ReturnType<typeof Object.create> as WildlifePlayerState;
        if (!ps.active) return;
        players.push({
          playerId: ps.playerId,
          active: ps.active,
          x: ps.x, y: ps.y, z: ps.z,
          flags: ps.flags,
          health: ps.health,
        });
      });

      // --- Pre-collect ships (with health refs for DevilShrimp damage) ---
      const ships: WildlifeShip[] = [];
      const shipMap: Map<number, WildlifeShip> = new Map();
      shipsQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as WildlifeTransform;
        const meta = comps[1] as WildlifeEntityMeta;
        const data = comps[2] as WildlifeEntityData;
        const health = comps[3] as WildlifeHealth;
        if (meta.type !== config.entityTypes.ship) return;
        const ship: WildlifeShip = {
          id: meta.id,
          x: transform.x, y: transform.y, z: transform.z,
          data: data.data,
          health,
        };
        ships.push(ship);
        shipMap.set(ship.id, ship);
      });

      // --- Pre-collect all wildlife entities ---
      const wildlifeList: WildlifeEntity[] = [];
      wildlifeQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as WildlifeTransform;
        const velocity = comps[1] as WildlifeVelocity;
        const meta = comps[2] as WildlifeEntityMeta;
        const data = comps[3] as WildlifeEntityData;
        const health = comps[4] as WildlifeHealth;
        if (!isWildlifeType(meta.type, config)) return;
        wildlifeList.push({ transform, velocity, meta, data, health });
      });

      // Filter fish and sharks for FishAI
      const fishList: WildlifeEntity[] = [];
      const sharkPositions: { x: number; z: number }[] = [];
      for (const w of wildlifeList) {
        if (w.meta.type === config.entityTypes.fish) fishList.push(w);
        else if (w.meta.type === config.entityTypes.shark) {
          sharkPositions.push({ x: w.transform.x, z: w.transform.z });
        }
      }

      // Build spatial grid for fish schooling (cellSize = 10, the schooling radius).
      // Grid stores indices into fishList. Reused across ticks via clear().
      fishGrid.clear();
      for (let i = 0; i < fishList.length; i++) {
        const f = fishList[i]!;
        fishGrid.insert(i, f.transform.x, f.transform.z);
      }

      // --- Run AI for each wildlife entity ---
      for (const w of wildlifeList) {
        const type = w.meta.type;
        if (type === config.entityTypes.fish) {
          tickFishAI(w, fishList, fishGrid, fishNeighborOut, sharkPositions);
        } else if (type === config.entityTypes.shark) {
          tickSharkAI(w, dt, players, ships, shipMap, deps, config);
        } else if (type === config.entityTypes.eel) {
          tickEelAI(w, dt, players, config);
        } else if (type === config.entityTypes.jellyfish) {
          tickJellyfishAI(w, dt, players, config);
        } else if (type === config.entityTypes.devilShrimp) {
          tickDevilShrimpAI(w, dt, players, ships, config);
        } else {
          tickPassiveAI(w, dt, players, config);
        }
      }

      // --- Spawn wildlife periodically ---
      spawnTimer += dt;
      if (spawnTimer > 2) {
        spawnTimer = 0;
        // Build obstacle list once per spawn cycle (ships already collected;
        // ports/islands scanned once here instead of per spawn attempt).
        buildObstacleList(obstacleList, ships, allEntitiesQuery, ctx.tick, config);
        trySpawnWildlife(wildlifeList, players, obstacleList, deps, config, biomeCounts, spawnedIds);
      }

      // --- Despawn distant wildlife ---
      despawnDistantWildlife(wildlifeList, players, deps, config, spawnedIds);
    },
    { queries: [wildlifeQuery, playersQuery, shipsQuery, allEntitiesQuery] },
  );
}

// --- Helper functions ---

function isWildlifeType(type: number, config: WildlifeConfig): boolean {
  const et = config.entityTypes;
  return type === et.fish || type === et.shark || type === et.eel ||
         type === et.jellyfish || type === et.devilShrimp ||
         type === et.whale || type === et.dolphin || type === et.turtle ||
         type === et.crustacean || type === et.coral || type === et.moose;
}

function trySpawnWildlife(
  wildlifeList: WildlifeEntity[],
  players: WildlifePlayer[],
  obstacles: ObstacleEntry[],
  deps: WildlifeDeps,
  config: WildlifeConfig,
  biomeCounts: Map<number, number>,
  spawnedIds: Set<number>,
): void {
  if (players.length === 0) return;

  // Count wildlife per biome (reusable instance-scoped map)
  biomeCounts.clear();
  for (const w of wildlifeList) {
    const biome = deps.getBiomeAt(w.transform.x, w.transform.z);
    biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
  }

  // Spawn near random player
  const player = players[Math.floor(Math.random() * players.length)];
  if (!player?.active) return;

  const biome = deps.getBiomeAt(player.x, player.z);
  const currentCount = biomeCounts.get(biome) ?? 0;
  if (currentCount >= config.maxPerBiome) return;

  const spawnType = rollSpawnType(biome, config);
  const et = config.entityTypes;

  if (spawnType === et.fish) {
    const schoolSize = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < schoolSize; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 20 + Math.random() * config.spawnRadius;
      const x = player.x + Math.cos(angle) * dist;
      const z = player.z + Math.sin(angle) * dist;
      if (!isPositionClearOfObstacles(x, z, obstacles)) continue;
      const y = -5 - Math.random() * 15;
      const id = deps.spawnEntity(et.fish, {
        position: { x, y, z },
        scale: 0.3 + Math.random() * 0.3,
        health: 10, maxHealth: 10,
        data: new Float32Array([Math.random() * Math.PI * 2, 1 + Math.random() * 2, 0, 0, 0, 0]),
      });
      if (id !== 0) spawnedIds.add(id);
    }
  } else {
    let x = 0, z = 0;
    let found = false;
    for (let attempt = 0; attempt < config.maxSpawnAttempts; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * config.spawnRadius;
      x = player.x + Math.cos(angle) * dist;
      z = player.z + Math.sin(angle) * dist;
      if (isPositionClearOfObstacles(x, z, obstacles)) {
        found = true;
        break;
      }
    }
    if (!found) return;
    const y = getYForType(spawnType, config);
    const stats = getStatsForType(spawnType, config);
    const id = deps.spawnEntity(spawnType, {
      position: { x, y, z },
      scale: stats.scale,
      flags: spawnType === et.coral ? config.entityFlags.static : 0,
      health: stats.hp, maxHealth: stats.hp,
      data: new Float32Array([Math.random() * Math.PI * 2, 0, 0, 0, 0, 0, 0, 0]),
    });
    if (id !== 0) spawnedIds.add(id);
  }
}

// Build the obstacle list once per spawn cycle. Ships are already collected;
// ports and islands are scanned from allEntitiesQuery once (not per spawn attempt).
function buildObstacleList(
  out: ObstacleEntry[],
  ships: WildlifeShip[],
  allEntitiesQuery: Query,
  tick: number,
  config: WildlifeConfig,
): void {
  out.length = 0;
  const et = config.entityTypes;
  // Add ships (already collected with positions)
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i]!;
    let clearance = config.shipClearance;
    // pirateShips are in the ships query too (they have the ship type);
    // if the config distinguishes pirateShipClearance, we'd need the type here.
    // For now, use shipClearance for all ships in the ships query.
    out.push({ x: ship.x, z: ship.z, clearance });
  }
  // Scan ports and islands once
  allEntitiesQuery.iterate(tick, (_entity, comps) => {
    const transform = comps[0] as WildlifeTransform;
    const meta = comps[1] as WildlifeEntityMeta;
    if (meta.type === et.port) {
      out.push({ x: transform.x, z: transform.z, clearance: transform.scale + config.portClearanceMargin });
    } else if (meta.type === et.island) {
      out.push({ x: transform.x, z: transform.z, clearance: transform.scale + config.islandClearanceMargin });
    }
  });
}

function isPositionClearOfObstacles(
  x: number, z: number,
  obstacles: ObstacleEntry[],
): boolean {
  for (let i = 0; i < obstacles.length; i++) {
    const obs = obstacles[i]!;
    const dx = x - obs.x;
    const dz = z - obs.z;
    if (dx * dx + dz * dz < obs.clearance * obs.clearance) return false;
  }
  return true;
}

function despawnDistantWildlife(
  wildlifeList: WildlifeEntity[],
  players: WildlifePlayer[],
  deps: WildlifeDeps,
  config: WildlifeConfig,
  spawnedIds: Set<number>,
): void {
  for (const w of wildlifeList) {
    if (!spawnedIds.has(w.meta.id)) continue;

    let minDist = Infinity;
    for (const p of players) {
      if (!p.active) continue;
      const dx = w.transform.x - p.x;
      const dz = w.transform.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) minDist = dist;
    }

    if (minDist > config.despawnRadius) {
      spawnedIds.delete(w.meta.id);
      deps.removeEntity(w.meta.id);
    }
  }
}

function rollSpawnType(biome: number, config: WildlifeConfig): number {
  const roll = Math.random();
  const b = config.biomes;
  const et = config.entityTypes;

  switch (biome) {
    case b.ocean:
    case b.tropical:
    case b.subTropical:
      if (roll < 0.6) return et.fish;
      if (roll < 0.75) return et.shark;
      if (roll < 0.85) return et.jellyfish;
      if (roll < 0.92) return et.dolphin;
      return et.whale;
    case b.deepOcean:
      if (roll < 0.4) return et.fish;
      if (roll < 0.55) return et.shark;
      if (roll < 0.70) return et.jellyfish;
      if (roll < 0.80) return et.eel;
      if (roll < 0.90) return et.whale;
      return et.turtle;
    case b.coralReef:
      if (roll < 0.5) return et.fish;
      if (roll < 0.65) return et.coral;
      if (roll < 0.75) return et.jellyfish;
      if (roll < 0.85) return et.crustacean;
      return et.turtle;
    case b.kelpForest:
      if (roll < 0.4) return et.fish;
      if (roll < 0.55) return et.crustacean;
      if (roll < 0.70) return et.eel;
      if (roll < 0.85) return et.turtle;
      return et.coral;
    case b.volcanic:
    case b.hell:
      if (roll < 0.3) return et.fish;
      if (roll < 0.55) return et.eel;
      if (roll < 0.85) return et.devilShrimp;
      return et.jellyfish;
    case b.arctic:
      if (roll < 0.4) return et.fish;
      if (roll < 0.60) return et.crustacean;
      if (roll < 0.80) return et.turtle;
      return et.whale;
    case b.garbagePatch:
      if (roll < 0.5) return et.fish;
      if (roll < 0.70) return et.jellyfish;
      if (roll < 0.85) return et.crustacean;
      return et.shark;
    default:
      if (roll < 0.7) return et.fish;
      if (roll < 0.85) return et.turtle;
      return et.crustacean;
  }
}

function getStatsForType(type: number, config: WildlifeConfig): { hp: number; scale: number } {
  const et = config.entityTypes;
  const map: Record<number, { hp: number; scale: number }> = {
    [et.shark]: { hp: 80, scale: 2 },
    [et.eel]: { hp: 30, scale: 1 },
    [et.jellyfish]: { hp: 15, scale: 0.8 },
    [et.devilShrimp]: { hp: 120, scale: 1.5 },
    [et.whale]: { hp: 200, scale: 8 },
    [et.dolphin]: { hp: 60, scale: 2 },
    [et.turtle]: { hp: 50, scale: 1.5 },
    [et.crustacean]: { hp: 20, scale: 0.5 },
    [et.coral]: { hp: 10, scale: 1 },
    [et.moose]: { hp: 150, scale: 2.5 },
  };
  return map[type] ?? { hp: 30, scale: 1 };
}

function getYForType(type: number, config: WildlifeConfig): number {
  const et = config.entityTypes;
  if (type === et.shark) return -3;
  if (type === et.eel) return -10;
  if (type === et.jellyfish) return -2 - Math.random() * 8;
  if (type === et.devilShrimp) return -20;
  if (type === et.whale) return -2;
  if (type === et.dolphin) return -1;
  if (type === et.turtle) return -5;
  if (type === et.crustacean) return -15;
  if (type === et.coral) return -10;
  if (type === et.moose) return -30;
  return -5;
}

if (import.meta.hot) {
  import.meta.hot.accept((newMod: any) => {
    if (newMod) hmrSwap("wildlife-system", newMod);
  });
}
