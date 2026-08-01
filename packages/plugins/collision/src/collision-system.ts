// ============================================================================
// Collision System — ECS-native entity-vs-entity collision detection
//
// Queries:
//   allEntitiesQuery: [Transform, Velocity, EntityMeta, EntityData] (all entities)
//   playersQuery:     [PlayerState] (for LOD culling)
//
// Pre-collects non-ship, non-player entities into arrays, then does O(n²)
// pairwise collision detection with LOD culling based on player proximity.
//
// Replaces legacy CollisionSystem.tick().
// ============================================================================

import { Stage, system, type Query, type SystemContext } from "@downdraft/core";
import type {
  CollisionConfig, CollisionDeps,
  CollisionTransform, CollisionVelocity, CollisionEntityMeta, CollisionEntityData,
  CollisionPlayerState, VoxelFieldLike, PortColliderDims,
} from "./types.ts";

// Pre-allocated arrays for entity collection (avoid GC pressure)
interface CollisionEntity {
  transform: CollisionTransform;
  velocity: CollisionVelocity;
  meta: CollisionEntityMeta;
  data: CollisionEntityData;
  isStatic: boolean;
  nearPlayer: boolean;
}

const MAX_COLLISION_ENTITIES = 4096;

export function createCollisionSystem(
  allEntitiesQuery: Query,
  playersQuery: Query,
  deps: CollisionDeps,
  config: CollisionConfig,
) {
  // Pre-allocated buffer for collected entities
  const entities: CollisionEntity[] = [];
  for (let i = 0; i < MAX_COLLISION_ENTITIES; i++) {
    entities.push({
      transform: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, rotW: 1, scale: 1 },
      velocity: { vx: 0, vy: 0, vz: 0, angVx: 0, angVy: 0, angVz: 0 },
      meta: { id: 0, type: 0, flags: 0, parentId: 0, chunkX: 0, chunkZ: 0 },
      data: { data: new Float32Array(0) },
      isStatic: false,
      nearPlayer: false,
    });
  }

  // Pre-allocated player positions for LOD culling
  const playerPositions: Float64Array = new Float64Array(MAX_COLLISION_ENTITIES * 2); // x, z pairs
  let playerPosCount = 0;

  const shipTypes = new Set<number>([
    config.entityTypes.ship, config.entityTypes.smallCraft, config.entityTypes.pirateShip,
  ]);

  return system(
    "collision-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const lodDistance = config.defaultLodDistance;
      const lodDistSq = lodDistance * lodDistance;

      // --- Phase 1: Collect players for LOD culling ---
      playerPosCount = 0;
      playersQuery.iterate(ctx.tick, (_entity, comps) => {
        const state = comps[0] as CollisionPlayerState;
        if (!state.active) return;
        playerPositions[playerPosCount * 2] = state.x;
        playerPositions[playerPosCount * 2 + 1] = state.z;
        playerPosCount++;
      });

      // --- Phase 2: Collect non-ship, non-player entities ---
      let entityCount = 0;
      allEntitiesQuery.iterate(ctx.tick, (_entity, comps) => {
        if (entityCount >= MAX_COLLISION_ENTITIES) return;
        const transform = comps[0] as CollisionTransform;
        const vel = comps[1] as CollisionVelocity;
        const meta = comps[2] as CollisionEntityMeta;
        const data = comps[3] as CollisionEntityData;

        if (shipTypes.has(meta.type)) return;
        if (meta.type === config.entityTypes.player) return;

        const ent = entities[entityCount];
        ent.transform.x = transform.x;
        ent.transform.y = transform.y;
        ent.transform.z = transform.z;
        ent.transform.scale = transform.scale;
        ent.velocity.vx = vel.vx;
        ent.velocity.vy = vel.vy;
        ent.velocity.vz = vel.vz;
        ent.meta.id = meta.id;
        ent.meta.type = meta.type;
        ent.meta.flags = meta.flags;
        ent.data.data = data.data;
        ent.isStatic = (meta.flags & config.entityFlags.static) !== 0;

        // Check if near any player
        ent.nearPlayer = false;
        for (let p = 0; p < playerPosCount; p++) {
          const dx = transform.x - playerPositions[p * 2];
          const dz = transform.z - playerPositions[p * 2 + 1];
          if (dx * dx + dz * dz <= lodDistSq) { ent.nearPlayer = true; break; }
        }

        entityCount++;
      });

      // --- Phase 3: O(n²) pairwise collision detection ---
      for (let i = 0; i < entityCount; i++) {
        const a = entities[i];

        for (let j = i + 1; j < entityCount; j++) {
          const b = entities[j];

          // Skip if both static
          if (a.isStatic && b.isStatic) continue;

          // LOD culling: skip pairs where neither entity is near any player
          if (!a.nearPlayer && !b.nearPlayer) continue;

          if (a.isStatic || b.isStatic) {
            // Dynamic vs static collision
            const dynEnt = a.isStatic ? b : a;
            const statEnt = a.isStatic ? a : b;

            if (statEnt.meta.type === config.entityTypes.port) {
              collidePort(dynEnt, statEnt, config, deps);
            } else if (statEnt.meta.type === config.entityTypes.island) {
              collideIsland(dynEnt, statEnt, config, deps);
            } else {
              collideGenericStatic(dynEnt, statEnt, config);
            }
            continue;
          }

          // Both dynamic: push both apart
          collideDynamicPair(a, b, config);
        }
      }
    },
    { queries: [allEntitiesQuery, playersQuery] },
  );
}

// --- Collision handlers ---

function collidePort(
  dyn: CollisionEntity,
  stat: CollisionEntity,
  config: CollisionConfig,
  deps: CollisionDeps,
): void {
  const portSize = stat.data.data[config.portDataIndex] ?? 0;
  const cd = deps.getPortColliderDims(portSize, stat.transform.scale);
  if (!cd) return;

  const px = dyn.transform.x - stat.transform.x;
  const pz = dyn.transform.z - stat.transform.z;
  const dynR = dyn.transform.scale;

  const portRects = [
    { halfW: cd.dock.halfW, halfD: cd.dock.halfD, cx: 0, cz: 0 },
    { halfW: cd.pier.halfW, halfD: cd.pier.halfL, cx: 0, cz: cd.pier.centerZ },
  ];

  for (let r = 0; r < portRects.length; r++) {
    const rect = portRects[r];
    const localX = px - rect.cx;
    const localZ = pz - rect.cz;

    const closestX = Math.max(-rect.halfW, Math.min(rect.halfW, localX));
    const closestZ = Math.max(-rect.halfD, Math.min(rect.halfD, localZ));
    const ddx = localX - closestX;
    const ddz = localZ - closestZ;
    const distSq2D = ddx * ddx + ddz * ddz;

    if (distSq2D >= dynR * dynR) continue;

    let pNx, pNz, pPen;
    if (distSq2D < 1e-6) {
      const penX = rect.halfW - Math.abs(localX);
      const penZ = rect.halfD - Math.abs(localZ);
      if (penX < penZ) {
        pNx = Math.sign(localX || 1);
        pNz = 0;
        pPen = penX + dynR;
      } else {
        pNx = 0;
        pNz = Math.sign(localZ || 1);
        pPen = penZ + dynR;
      }
    } else {
      const dist2D = Math.sqrt(distSq2D);
      pNx = ddx / dist2D;
      pNz = ddz / dist2D;
      pPen = dynR - dist2D;
    }

    dyn.transform.x += pNx * pPen;
    dyn.transform.z += pNz * pPen;

    const velAlongNormal = dyn.velocity.vx * pNx + dyn.velocity.vz * pNz;
    if (velAlongNormal < 0) {
      const j_imp = -(1 + config.shipCollisionRestitution) * velAlongNormal;
      dyn.velocity.vx += pNx * j_imp;
      dyn.velocity.vz += pNz * j_imp;
    }
  }
}

function collideIsland(
  dyn: CollisionEntity,
  stat: CollisionEntity,
  config: CollisionConfig,
  deps: CollisionDeps,
): void {
  const r = stat.transform.scale;
  if (r <= 0) return;
  const dx = dyn.transform.x - stat.transform.x;
  const dz = dyn.transform.z - stat.transform.z;
  const nx = dx / r;
  const nz = dz / r;
  const distSq2D = nx * nx + nz * nz;
  if (distSq2D > 1.3 * 1.3) return;

  const field = deps.getVoxelField(stat.meta.id);
  if (!field) return;
  const terrainY = deps.sampleTerrainHeight(field, nx, nz) * r + stat.transform.y;
  const dynTop = dyn.transform.y + dyn.transform.scale;

  if (dynTop < terrainY && terrainY > stat.transform.y) {
    const dist2D = Math.sqrt(distSq2D) || 0.001;
    const pNx = nx / dist2D;
    const pNz = nz / dist2D;
    const pen = (1.02 - dist2D) * r;
    dyn.transform.x += pNx * pen;
    dyn.transform.z += pNz * pen;

    const velAlongNormal = dyn.velocity.vx * pNx + dyn.velocity.vz * pNz;
    if (velAlongNormal < 0) {
      const j_imp = -(1 + config.shipCollisionRestitution) * velAlongNormal;
      dyn.velocity.vx += pNx * j_imp;
      dyn.velocity.vz += pNz * j_imp;
    }
  }
}

function collideGenericStatic(
  dyn: CollisionEntity,
  stat: CollisionEntity,
  config: CollisionConfig,
): void {
  const dx = dyn.transform.x - stat.transform.x;
  const dy = dyn.transform.y - stat.transform.y;
  const dz = dyn.transform.z - stat.transform.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const radius = dyn.transform.scale + stat.transform.scale;

  if (distSq < radius * radius) {
    const dist = Math.sqrt(distSq) || 0.001;
    const overlap = (radius - dist) / dist;
    dyn.transform.x += dx * overlap;
    dyn.transform.y += dy * overlap;
    dyn.transform.z += dz * overlap;

    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const velAlongNormal = dyn.velocity.vx * nx + dyn.velocity.vy * ny + dyn.velocity.vz * nz;
    if (velAlongNormal < 0) {
      const j_imp = -(1 + config.shipCollisionRestitution) * velAlongNormal;
      dyn.velocity.vx += nx * j_imp;
      dyn.velocity.vy += ny * j_imp;
      dyn.velocity.vz += nz * j_imp;
    }
  }
}

function collideDynamicPair(
  a: CollisionEntity,
  b: CollisionEntity,
  _config: CollisionConfig,
): void {
  const dx = a.transform.x - b.transform.x;
  const dy = a.transform.y - b.transform.y;
  const dz = a.transform.z - b.transform.z;
  const distSq = dx * dx + dy * dy + dz * dz;

  const radius = a.transform.scale + b.transform.scale;
  if (distSq < radius * radius) {
    const dist = Math.sqrt(distSq) || 0.001;
    const overlap = (radius - dist) / dist * 0.5;

    a.transform.x += dx * overlap;
    a.transform.y += dy * overlap;
    a.transform.z += dz * overlap;
    b.transform.x -= dx * overlap;
    b.transform.y -= dy * overlap;
    b.transform.z -= dz * overlap;

    const aMass = a.transform.scale * a.transform.scale;
    const bMass = b.transform.scale * b.transform.scale;
    const totalMass = aMass + bMass;

    const avx = (a.velocity.vx * (aMass - bMass) + 2 * bMass * b.velocity.vx) / totalMass;
    const bvx = (b.velocity.vx * (bMass - aMass) + 2 * aMass * a.velocity.vx) / totalMass;
    a.velocity.vx = avx * 0.8;
    b.velocity.vx = bvx * 0.8;
  }
}
