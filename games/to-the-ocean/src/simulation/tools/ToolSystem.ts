// ============================================================================
// ToolSystem — handles Gun and Shovel tools for terrain destruction
// Runs in the sim worker. Processes player clicks when gun/shovel is active.
// ============================================================================

import { InputBufferReader } from "../../shared/input-buffer";
import { SimEntity, SimPlayer } from "../Simulation";
import { EntityType } from "../../shared/types";
import { PLR_FLAG } from "../../shared/sim-buffer";
import {
  HOTBAR_TOOLS, PLAYER_EYE_HEIGHT,
} from "../../shared/constants";
import { TerrainSystem } from "../terrain/TerrainSystem";

// Tool parameters
const GUN_RANGE = 60;            // max raycast distance
const GUN_DEFORM_RADIUS = 4;     // terrain deformation radius
const GUN_DEFORM_STRENGTH = -1.5;// negative = remove terrain (strong enough to push below iso level)
const GUN_COOLDOWN = 0.15;       // seconds between shots
const GUN_DAMAGE = 25;           // damage to entities

const SHOVEL_RANGE = 8;          // max reach
const SHOVEL_DEFORM_RADIUS = 5;  // larger area than gun
const SHOVEL_DEFORM_STRENGTH = -1.0;
const SHOVEL_COOLDOWN = 0.3;     // seconds between digs

interface PlayerToolState {
  cooldown: number;
  prevMouseLeft: boolean;
}

export class ToolSystem {
  private states = new Map<number, PlayerToolState>();
  private terrainSystem: TerrainSystem;

  constructor(terrainSystem: TerrainSystem) {
    this.terrainSystem = terrainSystem;
  }

  tick(
    dt: number,
    input: InputBufferReader,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;
      if (p.flags & PLR_FLAG.SLEEPING) continue;

      // Only process if gun or shovel is the active tool
      const tool = HOTBAR_TOOLS[p.activeSlot];
      if (!tool) continue;
      if (tool.action !== "gun" && tool.action !== "shovel") continue;

      let state = this.states.get(p.playerId);
      if (!state) {
        state = { cooldown: 0, prevMouseLeft: false };
        this.states.set(p.playerId, state);
      }

      if (state.cooldown > 0) state.cooldown -= dt;

      // Edge-detect mouse left click
      const mouseLeft = input.isMouseDown(i, 0);
      const clicked = mouseLeft && !state.prevMouseLeft;
      state.prevMouseLeft = mouseLeft;

      if (!clicked || state.cooldown > 0) continue;

      // Compute eye position and look direction
      const eyeX = p.position.x;
      const eyeY = p.position.y + PLAYER_EYE_HEIGHT;
      const eyeZ = p.position.z;

      console.log(`[ToolSystem] Player ${p.playerId} using ${tool.action}, slot=${p.activeSlot}, eye=(${eyeX.toFixed(1)},${eyeY.toFixed(1)},${eyeZ.toFixed(1)})`);

      const heading = p.heading;
      const pitch = p.pitch ?? 0;
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const dirX = Math.sin(heading) * cp;
      const dirY = sp;
      const dirZ = -Math.cos(heading) * cp;

      if (tool.action === "gun") {
        state.cooldown = GUN_COOLDOWN;
        this.fireGun(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, entities, entityCount);
      } else if (tool.action === "shovel") {
        state.cooldown = SHOVEL_COOLDOWN;
        this.digShovel(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, entities, entityCount);
      }
    }
  }

  private fireGun(
    eyeX: number, eyeY: number, eyeZ: number,
    dirX: number, dirY: number, dirZ: number,
    entities: SimEntity[], entityCount: number,
  ): void {
    // Raycast against island/port terrain to find closest hit
    const hit = this.raycastTerrain(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, GUN_RANGE, entities, entityCount);
    console.log(`[ToolSystem] Gun raycast hit:`, hit);
    if (hit) {
      this.terrainSystem.deformAt(
        hit.entityId,
        hit.x, hit.y, hit.z,
        GUN_DEFORM_RADIUS,
        GUN_DEFORM_STRENGTH,
      );
    }

    // Also damage entities along the ray (simple sphere intersection)
    this.damageEntitiesAlongRay(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, GUN_RANGE, GUN_DAMAGE, entities, entityCount);
  }

  private digShovel(
    eyeX: number, eyeY: number, eyeZ: number,
    dirX: number, dirY: number, dirZ: number,
    entities: SimEntity[], entityCount: number,
  ): void {
    const hit = this.raycastTerrain(eyeX, eyeY, eyeZ, dirX, dirY, dirZ, SHOVEL_RANGE, entities, entityCount);
    console.log(`[ToolSystem] Shovel raycast hit:`, hit);
    if (hit) {
      this.terrainSystem.deformAt(
        hit.entityId,
        hit.x, hit.y, hit.z,
        SHOVEL_DEFORM_RADIUS,
        SHOVEL_DEFORM_STRENGTH,
      );
    }
  }

  // Raycast against all registered island/port terrain by marching through voxel fields.
  // Samples density along the ray and returns the first point where density crosses the iso level.
  private raycastTerrain(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    entities: SimEntity[], entityCount: number,
  ): { entityId: number; x: number; y: number; z: number } | null {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return null;
    const ndx = dx / len;
    const ndy = dy / len;
    const ndz = dz / len;

    let bestT = maxDist;
    let bestEntityId = 0;
    let bestX = 0, bestY = 0, bestZ = 0;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Island && ent.type !== EntityType.Port) continue;
      if (!this.terrainSystem.hasTerrain(ent.id)) continue;

      const field = this.terrainSystem.getVoxelField(ent.id);
      if (!field) continue;

      // Convert ray origin to entity-local space
      const localOx = ox - ent.position.x;
      const localOy = oy - ent.position.y;
      const localOz = oz - ent.position.z;

      // Convert to voxel grid space: voxel index = (local - origin) / voxelSize
      const vs = field.voxelSize;
      const gridOx = (localOx - field.originX) / vs;
      const gridOy = (localOy - field.originY) / vs;
      const gridOz = (localOz - field.originZ) / vs;
      // Direction in voxel grid space (not normalized — magnitude = voxels per world unit)
      const gridDx = ndx / vs;
      const gridDy = ndy / vs;
      const gridDz = ndz / vs;

      // Quick AABB check in voxel grid space
      // Handle axis-aligned rays (gridD == 0) by checking if origin is inside bounds
      let tMinX: number, tMaxX: number;
      if (Math.abs(gridDx) < 1e-8) {
        tMinX = -Infinity; tMaxX = Infinity;
        if (gridOx < 0 || gridOx > field.dimX - 1) continue; // ray parallel and outside
      } else {
        tMinX = Math.min((0 - gridOx) / gridDx, (field.dimX - 1 - gridOx) / gridDx);
        tMaxX = Math.max((0 - gridOx) / gridDx, (field.dimX - 1 - gridOx) / gridDx);
      }
      let tMinY: number, tMaxY: number;
      if (Math.abs(gridDy) < 1e-8) {
        tMinY = -Infinity; tMaxY = Infinity;
        if (gridOy < 0 || gridOy > field.dimY - 1) continue;
      } else {
        tMinY = Math.min((0 - gridOy) / gridDy, (field.dimY - 1 - gridOy) / gridDy);
        tMaxY = Math.max((0 - gridOy) / gridDy, (field.dimY - 1 - gridOy) / gridDy);
      }
      let tMinZ: number, tMaxZ: number;
      if (Math.abs(gridDz) < 1e-8) {
        tMinZ = -Infinity; tMaxZ = Infinity;
        if (gridOz < 0 || gridOz > field.dimZ - 1) continue;
      } else {
        tMinZ = Math.min((0 - gridOz) / gridDz, (field.dimZ - 1 - gridOz) / gridDz);
        tMaxZ = Math.max((0 - gridOz) / gridDz, (field.dimZ - 1 - gridOz) / gridDz);
      }

      const tEnter = Math.max(tMinX, tMinY, tMinZ, 0);
      const tExit = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);

      if (tEnter >= tExit) continue;

      // March through the voxel grid in world-unit steps (~0.4 voxels with vs=2.5)
      const stepWorld = 1.0;

      let prevDensity = this.sampleVoxel(field, gridOx + gridDx * tEnter, gridOy + gridDy * tEnter, gridOz + gridDz * tEnter);
      const iso = field.isoLevel;

      for (let gt = tEnter + stepWorld; gt <= tExit; gt += stepWorld) {
        const density = this.sampleVoxel(field, gridOx + gridDx * gt, gridOy + gridDy * gt, gridOz + gridDz * gt);

        // Check for surface crossing: density goes from above iso to below (entering terrain)
        // or from below to above (exiting terrain — hitting surface from inside)
        if ((prevDensity > iso && density <= iso) || (prevDensity <= iso && density > iso)) {
          // Linear interpolation for more precise hit
          const frac = (iso - prevDensity) / (density - prevDensity);
          const hitT = gt - stepWorld + stepWorld * frac;

          if (hitT > bestT) break;

          // Compute world-space hit position (t is already in world units)
          const hitX = ox + ndx * hitT;
          const hitY = oy + ndy * hitT;
          const hitZ = oz + ndz * hitT;

          // Skip hits below water level — these are underwater shelf crossings
          // that aren't visible. Continue marching to find the above-water surface.
          if (hitY < -2) {
            prevDensity = density;
            continue;
          }

          bestT = hitT;
          bestEntityId = ent.id;
          bestX = hitX;
          bestY = hitY;
          bestZ = hitZ;
          break; // First above-water hit on this entity is the closest
        }
        prevDensity = density;
      }
    }

    if (bestEntityId === 0) {
      // Debug: list islands with terrain for diagnosis
      for (let i = 0; i < entityCount; i++) {
        const ent = entities[i];
        if (!ent) continue;
        if (ent.type !== EntityType.Island && ent.type !== EntityType.Port) continue;
        if (!this.terrainSystem.hasTerrain(ent.id)) continue;
        const dx = ent.position.x - ox;
        const dy = ent.position.y - oy;
        const dz = ent.position.z - oz;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        console.log(`[ToolSystem] Missed island id=${ent.id} scale=${ent.scale.toFixed(1)} pos=(${ent.position.x.toFixed(1)},${ent.position.y.toFixed(1)},${ent.position.z.toFixed(1)}) dist=${dist.toFixed(1)} dir=(${ndx.toFixed(2)},${ndy.toFixed(2)},${ndz.toFixed(2)})`);
      }
      return null;
    }
    return { entityId: bestEntityId, x: bestX, y: bestY, z: bestZ };
  }

  // Trilinearly sample a voxel field at fractional grid coordinates
  private sampleVoxel(field: { data: Float32Array; dimX: number; dimY: number; dimZ: number }, gx: number, gy: number, gz: number): number {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const z1 = z0 + 1;

    if (x0 < 0 || x1 >= field.dimX || y0 < 0 || y1 >= field.dimY || z0 < 0 || z1 >= field.dimZ) {
      return -9999; // outside grid — treat as empty (below iso)
    }

    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    const dimY = field.dimY;
    const dimZ = field.dimZ;
    const data = field.data;

    const idx = (x: number, y: number, z: number) => x * dimY * dimZ + y * dimZ + z;

    const c000 = data[idx(x0, y0, z0)];
    const c100 = data[idx(x1, y0, z0)];
    const c010 = data[idx(x0, y1, z0)];
    const c110 = data[idx(x1, y1, z0)];
    const c001 = data[idx(x0, y0, z1)];
    const c101 = data[idx(x1, y0, z1)];
    const c011 = data[idx(x0, y1, z1)];
    const c111 = data[idx(x1, y1, z1)];

    const c00 = c000 * (1 - fx) + c100 * fx;
    const c01 = c001 * (1 - fx) + c101 * fx;
    const c10 = c010 * (1 - fx) + c110 * fx;
    const c11 = c011 * (1 - fx) + c111 * fx;

    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;

    return c0 * (1 - fz) + c1 * fz;
  }

  // Damage entities along the ray using sphere intersection (for wildlife, etc.)
  private damageEntitiesAlongRay(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    damage: number,
    entities: SimEntity[], entityCount: number,
  ): void {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return;
    const ndx = dx / len;
    const ndy = dy / len;
    const ndz = dz / len;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      // Skip islands, ports, ships, players — only damage living entities
      if (ent.type === EntityType.Island || ent.type === EntityType.Port) continue;
      if (ent.type === EntityType.Ship || ent.type === EntityType.Player) continue;
      if (ent.type === EntityType.Placeable || ent.type === EntityType.RainCollector) continue;
      if (ent.health <= 0) continue;

      // Approximate entity radius from scale
      const radius = Math.max(0.5, ent.scale * 0.5);

      const ocx = ox - ent.position.x;
      const ocy = oy - ent.position.y;
      const ocz = oz - ent.position.z;
      const b = ocx * ndx + ocy * ndy + ocz * ndz;
      const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
      const disc = b * b - c;

      if (disc < 0) continue;

      const t = -b - Math.sqrt(disc);
      if (t < 0 || t > maxDist) continue;

      ent.health -= damage;
    }
  }
}
