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

import { BroadPhaseGrid, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import type {
    CollisionConfig, CollisionDeps,
    CollisionEntityData,
    CollisionEntityMeta,
    CollisionPlayerState,
    CollisionTransform, CollisionVelocity
} from "./types";

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

  // Spatial grid for dynamic entities (broad phase). Cell size = 2x max wildlife radius.
  // Reused across ticks via clear(). Only near-player dynamic entities are inserted.
  const grid = new BroadPhaseGrid(config.spatialGridCellSize ?? 10);
  // Reusable neighbor query output array (caller-owned, avoids per-query allocation).
  const neighborOut: number[] = [];

  // Separate list for static entities (islands/ports). These are too large for the grid
  // (scale up to ~200, would span hundreds of cells). Each dynamic entity tests against
  // the full static list — with ~50 islands/ports in range this is O(n·50), acceptable.
  const staticEntities: CollisionEntity[] = [];
  let staticCount = 0;

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
      // Dynamic entities go into the entities[] buffer + spatial grid.
      // Static entities (islands/ports) go into a separate small list.
      let entityCount = 0;
      staticCount = 0;
      grid.clear();
      allEntitiesQuery.iterate(ctx.tick, (_entity, comps) => {
        if (entityCount >= MAX_COLLISION_ENTITIES) return;
        const transform = comps[0] as CollisionTransform;
        const vel = comps[1] as CollisionVelocity;
        const meta = comps[2] as CollisionEntityMeta;
        const data = comps[3] as CollisionEntityData;

        if (shipTypes.has(meta.type)) return;
        if (meta.type === config.entityTypes.player) return;

        const isStatic = (meta.flags & config.entityFlags.static) !== 0;

        // Check if near any player (LOD culling)
        let nearPlayer = false;
        for (let p = 0; p < playerPosCount; p++) {
          const dx = transform.x - playerPositions[p * 2];
          const dz = transform.z - playerPositions[p * 2 + 1];
          if (dx * dx + dz * dz <= lodDistSq) { nearPlayer = true; break; }
        }

        if (isStatic) {
          // Static entities go into the separate list (not the grid).
          // Only collect near-player statics to keep the list small.
          if (!nearPlayer) return;
          const statEnt = staticEntities[staticCount] ?? (staticEntities[staticCount] = {
            transform: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, rotW: 1, scale: 1 },
            velocity: { vx: 0, vy: 0, vz: 0, angVx: 0, angVy: 0, angVz: 0 },
            meta: { id: 0, type: 0, flags: 0, parentId: 0, chunkX: 0, chunkZ: 0 },
            data: { data: new Float32Array(0) },
            isStatic: true,
            nearPlayer: true,
          });
          statEnt.transform.x = transform.x;
          statEnt.transform.y = transform.y;
          statEnt.transform.z = transform.z;
          statEnt.transform.scale = transform.scale;
          statEnt.meta.id = meta.id;
          statEnt.meta.type = meta.type;
          statEnt.meta.flags = meta.flags;
          statEnt.data.data = data.data;
          staticCount++;
          return;
        }

        // Dynamic entity: collect into entities[] buffer
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
        ent.isStatic = false;
        ent.nearPlayer = nearPlayer;

        // Only insert near-player dynamic entities into the grid (shrinks broad phase).
        if (nearPlayer) {
          grid.insert(entityCount, transform.x, transform.z);
        }

        entityCount++;
      });

      // --- Phase 3: Broad-phase via spatial grid + narrow-phase collision ---
      // For each near-player dynamic entity, query grid neighbors (3x3 cells) for
      // other dynamic entities, then test against the full static list.
      for (let i = 0; i < entityCount; i++) {
        const a = entities[i];
        if (!a.nearPlayer) continue; // skip far entities entirely

        // Dynamic vs dynamic: query grid neighbors (pair dedup via j > i)
        neighborOut.length = 0;
        grid.queryNeighbors(a.transform.x, a.transform.z, neighborOut);
        for (let n = 0; n < neighborOut.length; n++) {
          const j = neighborOut[n];
          if (j <= i) continue; // pair dedup: only test each pair once
          const b = entities[j];
          if (!b || !b.nearPlayer) continue;
          collideDynamicPair(a, b, config);
        }

        // Dynamic vs static: test against all near-player static entities
        for (let s = 0; s < staticCount; s++) {
          const statEnt = staticEntities[s]!;
          if (statEnt.meta.type === config.entityTypes.port) {
            collidePort(a, statEnt, config, deps);
          } else if (statEnt.meta.type === config.entityTypes.island) {
            collideIsland(a, statEnt, config, deps);
          } else {
            collideGenericStatic(a, statEnt, config);
          }
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
