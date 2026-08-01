// ============================================================================
// Collision System — entity vs entity, entity vs terrain
// ============================================================================

import {
    ENTITY_MASS,
    getPortColliderDims,
    PORT_DATA,
    SHIP_COLLISION_RESTITUTION,
    WILDLIFE_DENSITY,
} from "../../shared/constants";
import { sampleTerrainHeight } from "../../shared/terrain";
import { EntityFlags, EntityType } from "../../shared/types";
import { BoatCellSystem } from "../boat/BoatCellSystem";
import { BoatDesignSystem } from "../boat/BoatDesignSystem";
import { SimEntity, SimPlayer } from "../Simulation";
import type { TerrainSystem } from "../terrain/TerrainSystem";

// Ship entity types
const SHIP_TYPES = new Set<number>([
  EntityType.Ship, EntityType.SmallCraft, EntityType.PirateShip,
]);

// Compute mass for a non-ship entity
function getEntityMass(ent: SimEntity): number {
  if (SHIP_TYPES.has(ent.type)) return 0; // ships handled by Rapier
  const baseMass = ENTITY_MASS[ent.type];
  if (baseMass !== undefined) return baseMass;
  // Wildlife: mass = scale³ × density × 100
  const density = WILDLIFE_DENSITY[ent.type];
  if (density !== undefined) {
    return ent.scale * ent.scale * ent.scale * density * 100;
  }
  // Default: scale² × 100
  return ent.scale * ent.scale * 100;
}

export class CollisionSystem {
  private terrainSystem: TerrainSystem | null = null;

  setTerrainSystem(ts: TerrainSystem): void {
    this.terrainSystem = ts;
  }

  tick(
    dt: number,
    entities: SimEntity[],
    entityCount: number,
    players: SimPlayer[],
    playerCount: number,
    _boatDesignSystem: BoatDesignSystem | null = null,
    _pilotedShipIds: Set<number> | null = null,
    _boatCellSystem: BoatCellSystem | null = null,
    lodDistance: number = 250,
  ): void {
    // Player collision is now handled entirely by Rapier's KinematicCharacterController.
    // Ship collision is handled entirely by Rapier (dynamic bodies with cell cuboid colliders).
    // This system only handles non-ship, non-player entity-vs-entity collisions.

    // Precompute squared LOD distance for distance checks
    const lodDistSq = lodDistance * lodDistance;

    // --- Non-ship entity vs entity collisions (simplified) ---
    // Handles: dynamic-vs-dynamic (wildlife-vs-wildlife) and dynamic-vs-static (wildlife-vs-island/port)
    // Ship collision is handled entirely by Rapier (dynamic bodies with cell cuboid colliders).
    for (let i = 0; i < entityCount; i++) {
      const a = entities[i];
      if (!a) continue;
      if (SHIP_TYPES.has(a.type)) continue; // ships handled above
      if (a.type === EntityType.Player) continue;
      const aStatic = (a.flags & EntityFlags.Static) !== 0;

      // Check if entity A is near any player
      let aNearPlayer = false;
      for (let p = 0; p < playerCount; p++) {
        if (!players[p]?.active) continue;
        const dx = a.position.x - players[p].position.x;
        const dz = a.position.z - players[p].position.z;
        if (dx * dx + dz * dz <= lodDistSq) { aNearPlayer = true; break; }
      }

      for (let j = i + 1; j < entityCount; j++) {
        const b = entities[j];
        if (!b) continue;
        if (SHIP_TYPES.has(b.type)) continue; // ships handled above
        if (b.type === EntityType.Player) continue;
        const bStatic = (b.flags & EntityFlags.Static) !== 0;

        // Skip if both static
        if (aStatic && bStatic) continue;

        // LOD culling: skip pairs where neither entity is near any player
        if (!aNearPlayer) {
          let bNearPlayer = false;
          for (let p = 0; p < playerCount; p++) {
            if (!players[p]?.active) continue;
            const dx = b.position.x - players[p].position.x;
            const dz = b.position.z - players[p].position.z;
            if (dx * dx + dz * dz <= lodDistSq) { bNearPlayer = true; break; }
          }
          if (!bNearPlayer) continue;
        }

        if (aStatic || bStatic) {
          // Dynamic vs static: push only the dynamic entity out
          const dynEnt = aStatic ? b : a;
          const statEnt = aStatic ? a : b;

          if (statEnt.type === EntityType.Port) {
            // Port: AABB collision against dock and pier rectangles
            const portSize = statEnt.data[PORT_DATA.SIZE] ?? 0;
            const cd = getPortColliderDims(portSize, statEnt.scale);
            if (!cd) continue;

            const px = dynEnt.position.x - statEnt.position.x;
            const pz = dynEnt.position.z - statEnt.position.z;
            const dynR = dynEnt.scale;

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

              dynEnt.position.x += pNx * pPen;
              dynEnt.position.z += pNz * pPen;

              const velAlongNormal = dynEnt.velocity.x * pNx + dynEnt.velocity.z * pNz;
              if (velAlongNormal < 0) {
                const j_imp = -(1 + SHIP_COLLISION_RESTITUTION) * velAlongNormal;
                dynEnt.velocity.x += pNx * j_imp;
                dynEnt.velocity.z += pNz * j_imp;
              }
            }
          } else if (statEnt.type === EntityType.Island) {
            // Height-based collision: sample terrain height from voxel field
            // at the wildlife's position relative to the island center.
            const r = statEnt.scale;
            if (r <= 0) continue;
            const dx = dynEnt.position.x - statEnt.position.x;
            const dz = dynEnt.position.z - statEnt.position.z;
            const nx = dx / r;
            const nz = dz / r;
            const distSq2D = nx * nx + nz * nz;
            if (distSq2D > 1.3 * 1.3) continue; // outside island blob extent

            // Sample terrain height from voxel field (shared with TerrainSystem)
            const field = this.terrainSystem?.getVoxelField(statEnt.id);
            if (!field) continue;  // physics field not yet generated — skip collision
            const terrainY = sampleTerrainHeight(field, nx, nz) * r + statEnt.position.y;
            const dynTop = dynEnt.position.y + dynEnt.scale;

            // Only push if the dynamic entity is inside above-water terrain
            if (dynTop < terrainY && terrainY > statEnt.position.y) {
              // Push radially outward to island boundary (horizontal only —
              // don't touch Y so water physics/buoyancy is unaffected)
              const dist2D = Math.sqrt(distSq2D) || 0.001;
              const pNx = nx / dist2D;
              const pNz = nz / dist2D;
              const pen = (1.02 - dist2D) * r; // push to just outside unit circle
              dynEnt.position.x += pNx * pen;
              dynEnt.position.z += pNz * pen;

              // Bounce velocity horizontally
              const velAlongNormal = dynEnt.velocity.x * pNx + dynEnt.velocity.z * pNz;
              if (velAlongNormal < 0) {
                const j_imp = -(1 + SHIP_COLLISION_RESTITUTION) * velAlongNormal;
                dynEnt.velocity.x += pNx * j_imp;
                dynEnt.velocity.z += pNz * j_imp;
              }
            }
          } else {
            // Generic sphere collision for other static entities
            const dx = dynEnt.position.x - statEnt.position.x;
            const dy = dynEnt.position.y - statEnt.position.y;
            const dz = dynEnt.position.z - statEnt.position.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const radius = dynEnt.scale + statEnt.scale;

            if (distSq < radius * radius) {
              const dist = Math.sqrt(distSq) || 0.001;
              const overlap = (radius - dist) / dist;
              dynEnt.position.x += dx * overlap;
              dynEnt.position.y += dy * overlap;
              dynEnt.position.z += dz * overlap;

              // Velocity response — bounce off static entity
              const nx = dx / dist;
              const ny = dy / dist;
              const nz = dz / dist;
              const velAlongNormal = dynEnt.velocity.x * nx + dynEnt.velocity.y * ny + dynEnt.velocity.z * nz;
              if (velAlongNormal < 0) {
                const j_imp = -(1 + SHIP_COLLISION_RESTITUTION) * velAlongNormal;
                dynEnt.velocity.x += nx * j_imp;
                dynEnt.velocity.y += ny * j_imp;
                dynEnt.velocity.z += nz * j_imp;
              }
            }
          }
          continue;
        }

        // Both dynamic: push both apart
        const dx = a.position.x - b.position.x;
        const dy = a.position.y - b.position.y;
        const dz = a.position.z - b.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        const radius = a.scale + b.scale;
        if (distSq < radius * radius) {
          const dist = Math.sqrt(distSq) || 0.001;
          const overlap = (radius - dist) / dist * 0.5;

          a.position.x += dx * overlap;
          a.position.y += dy * overlap;
          a.position.z += dz * overlap;
          b.position.x -= dx * overlap;
          b.position.y -= dy * overlap;
          b.position.z -= dz * overlap;

          const aMass = a.scale * a.scale;
          const bMass = b.scale * b.scale;
          const totalMass = aMass + bMass;

          const avx = (a.velocity.x * (aMass - bMass) + 2 * bMass * b.velocity.x) / totalMass;
          const bvx = (b.velocity.x * (bMass - aMass) + 2 * aMass * a.velocity.x) / totalMass;
          a.velocity.x = avx * 0.8;
          b.velocity.x = bvx * 0.8;
        }
      }
    }
  }
}
