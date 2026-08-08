// ============================================================================
// Buoyancy System — ECS-native hull-based boat buoyancy + gravity + integration
//
// Queries:
//   shipsQuery:       [Transform, Velocity, EntityMeta, EntityData] (ships + small craft)
//   allEntitiesQuery: [Transform, Velocity, EntityMeta, EntityData] (all non-player entities)
//
// Replaces legacy BuoyancySystem.tick() (inline path).
// Parallel path (tickParallel) is not migrated — async dispatch can't run
// inside the synchronous ECS step. Inline path is sufficient for correctness.
// ============================================================================

import { hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import type {
    BoatCell,
    BuoyancyConfig, BuoyancyDeps,
    BuoyancyEntityData,
    BuoyancyEntityMeta,
    BuoyancyTransform, BuoyancyVelocity
} from "./types";

export function createBuoyancySystem(
  shipsQuery: Query,
  allEntitiesQuery: Query,
  deps: BuoyancyDeps,
  config: BuoyancyConfig,
) {
  return system(
    "buoyancy-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;
      const cfg = config;
      const d = deps;
      const phy = cfg.physics;

      // --- Phase 1: Ship buoyancy ---
      shipsQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as BuoyancyTransform;
        const vel = comps[1] as BuoyancyVelocity;
        const meta = comps[2] as BuoyancyEntityMeta;
        const data = comps[3] as BuoyancyEntityData;

        if (meta.type !== cfg.entityTypes.ship && meta.type !== cfg.entityTypes.smallCraft) return;

        applyBuoyancy(transform, vel, meta, data, dt, d, cfg);
      });

      // --- Phase 2: Gravity + position integration for all non-player entities ---
      allEntitiesQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as BuoyancyTransform;
        const vel = comps[1] as BuoyancyVelocity;
        const meta = comps[2] as BuoyancyEntityMeta;

        if (meta.type === cfg.entityTypes.player) return;

        // Apply gravity to non-static entities (but not ships — they use buoyancy only)
        if (!(meta.flags & cfg.entityFlags.static)) {
          if (meta.type !== cfg.entityTypes.ship && meta.type !== cfg.entityTypes.smallCraft) {
            vel.vy -= phy.gravity * dt;
          }
        }

        // Apply velocity to position
        transform.x += vel.vx * dt;
        transform.y += vel.vy * dt;
        transform.z += vel.vz * dt;

        // Seabed collision
        if (transform.y < cfg.seabedHeight) {
          transform.y = cfg.seabedHeight;
          vel.vy = Math.max(0, vel.vy);
        }
      });
    },
    { queries: [shipsQuery, allEntitiesQuery] },
  );
}

// --- Buoyancy computation ---

function applyBuoyancy(
  transform: BuoyancyTransform,
  vel: BuoyancyVelocity,
  meta: BuoyancyEntityMeta,
  data: BuoyancyEntityData,
  dt: number,
  deps: BuoyancyDeps,
  config: BuoyancyConfig,
): void {
  const cells = deps.getBoatCells(meta.id);
  if (cells && cells.length > 0) {
    applyCellBuoyancy(transform, vel, meta, data, dt, cells, deps, config);
    return;
  }
  applySimpleBuoyancy(transform, vel, data, dt, deps, config);
}

function applyCellBuoyancy(
  transform: BuoyancyTransform,
  vel: BuoyancyVelocity,
  meta: BuoyancyEntityMeta,
  data: BuoyancyEntityData,
  dt: number,
  cells: BoatCell[],
  deps: BuoyancyDeps,
  config: BuoyancyConfig,
): void {
  const mp = deps.getMassProperties(meta.id);
  const shipMass = mp.mass;
  const heading = data.data[config.shipData.heading] ?? 0;
  const pitch = data.data[config.shipData.pitch] ?? 0;
  const roll = data.data[config.shipData.roll] ?? 0;

  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  const cellArea = config.boatCellWorldSize * config.boatCellWorldSize;

  let totalForceY = 0;
  let totalTorqueX = 0;
  let totalTorqueZ = 0;
  let hullCellCount = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!config.isHullShellCell(cell.type)) continue;
    hullCellCount++;

    const ext = config.getCellVerticalExtent(cell.type);
    const cellHeight = ext.y1 - ext.y0;
    const localX = cell.gridX * config.boatCellWorldSize;
    const localY = cell.gridY * config.boatLayerHeight + (ext.y0 + ext.y1) / 2;
    const localZ = cell.gridZ * config.boatCellWorldSize;

    const armX = localX - mp.centerX;
    const armY = localY - mp.centerY;
    const armZ = localZ - mp.centerZ;

    const yawX = armX * cosH + armZ * sinH;
    const yawZ = -armX * sinH + armZ * cosH;
    const sampleX = transform.x + yawX;
    const sampleZ = transform.z + yawZ;

    const pY = armY * cosP - armZ * sinP;
    const rY = armX * sinR + pY * cosR;
    const worldY = transform.y + rY;

    const waterHeight = deps.sampleWaterAt(sampleX, sampleZ);
    const cellBottom = worldY - cellHeight / 2;
    if (waterHeight <= cellBottom) continue;

    const submersionDepth = Math.min(waterHeight - cellBottom, cellHeight);
    const submergedVolume = cellArea * submersionDepth;
    const buoyancyForce = config.physics.waterDensity * submergedVolume * config.physics.gravity;

    totalForceY += buoyancyForce;
    totalTorqueX += -armZ * buoyancyForce;
    totalTorqueZ += armX * buoyancyForce;
  }

  if (hullCellCount === 0) {
    applySimpleBuoyancy(transform, vel, data, dt, deps, config);
    return;
  }

  integrateBuoyancy(vel, data, dt, shipMass, totalForceY, totalTorqueX, totalTorqueZ, mp.Ixx, mp.Izz, config);
}

function integrateBuoyancy(
  vel: BuoyancyVelocity,
  data: BuoyancyEntityData,
  dt: number,
  shipMass: number,
  totalForceY: number,
  totalTorqueX: number,
  totalTorqueZ: number,
  Ixx: number,
  Izz: number,
  config: BuoyancyConfig,
): void {
  const phy = config.physics;
  const gravityForce = shipMass * phy.gravity;
  const netForceY = totalForceY - gravityForce;
  vel.vy += (netForceY / shipMass) * dt;
  vel.vy *= Math.max(0, 1 - phy.verticalDamping * dt);

  const pitch = data.data[config.shipData.pitch] ?? 0;
  const roll = data.data[config.shipData.roll] ?? 0;

  if (Ixx > 0) vel.angVx += (totalTorqueX / Ixx) * dt;
  if (Izz > 0) vel.angVz += (totalTorqueZ / Izz) * dt;

  vel.angVx -= pitch * phy.restoringStiffness * dt;
  vel.angVz -= roll * phy.restoringStiffness * dt;

  vel.angVx *= Math.max(0, 1 - phy.angularDamping * dt);
  vel.angVz *= Math.max(0, 1 - phy.angularDamping * dt);

  if (!Number.isFinite(vel.vx)) vel.vx = 0;
  if (!Number.isFinite(vel.vy)) vel.vy = 0;
  if (!Number.isFinite(vel.vz)) vel.vz = 0;
  if (!Number.isFinite(vel.angVx)) vel.angVx = 0;
  if (!Number.isFinite(vel.angVz)) vel.angVz = 0;

  let newPitch = pitch + vel.angVx * dt;
  let newRoll = roll + vel.angVz * dt;

  if (!Number.isFinite(newPitch)) newPitch = 0;
  if (!Number.isFinite(newRoll)) newRoll = 0;

  if (newPitch > phy.maxTilt) { newPitch = phy.maxTilt; vel.angVx = 0; }
  else if (newPitch < -phy.maxTilt) { newPitch = -phy.maxTilt; vel.angVx = 0; }
  if (newRoll > phy.maxTilt) { newRoll = phy.maxTilt; vel.angVz = 0; }
  else if (newRoll < -phy.maxTilt) { newRoll = -phy.maxTilt; vel.angVz = 0; }

  data.data[config.shipData.pitch] = newPitch;
  data.data[config.shipData.roll] = newRoll;
}

function applySimpleBuoyancy(
  transform: BuoyancyTransform,
  vel: BuoyancyVelocity,
  data: BuoyancyEntityData,
  dt: number,
  deps: BuoyancyDeps,
  config: BuoyancyConfig,
): void {
  const phy = config.physics;
  const halfLength = 4;
  const halfWidth = 2;

  const wh0 = deps.sampleWaterAt(transform.x + halfLength, transform.z);
  const wh1 = deps.sampleWaterAt(transform.x - halfLength, transform.z);
  const wh2 = deps.sampleWaterAt(transform.x, transform.z + halfWidth);
  const wh3 = deps.sampleWaterAt(transform.x, transform.z - halfWidth);

  // Skip force application this frame if any water sample is NaN/Inf
  if (!Number.isFinite(wh0) || !Number.isFinite(wh1) || !Number.isFinite(wh2) || !Number.isFinite(wh3)) {
    return;
  }

  if (!Number.isFinite(vel.vx)) vel.vx = 0;
  if (!Number.isFinite(vel.vy)) vel.vy = 0;
  if (!Number.isFinite(vel.vz)) vel.vz = 0;

  const avgWaterHeight = (wh0 + wh1 + wh2 + wh3) / 4;
  const dy = avgWaterHeight - transform.y;
  vel.vy += dy * 20 * dt;
  vel.vy *= Math.max(0, 1 - 8 * dt);

  const pitchForce = (wh1 - wh0) / (halfLength * 2);
  const rollForce = (wh3 - wh2) / (halfWidth * 2);

  vel.angVx += pitchForce * 5 * dt;
  vel.angVz += rollForce * 5 * dt;
  vel.angVx *= Math.max(0, 1 - phy.angularDamping * dt);
  vel.angVz *= Math.max(0, 1 - phy.angularDamping * dt);

  let newPitch = (data.data[config.shipData.pitch] ?? 0) + vel.angVx * dt;
  let newRoll = (data.data[config.shipData.roll] ?? 0) + vel.angVz * dt;

  if (newPitch > phy.maxTilt) { newPitch = phy.maxTilt; vel.angVx = 0; }
  else if (newPitch < -phy.maxTilt) { newPitch = -phy.maxTilt; vel.angVx = 0; }
  if (newRoll > phy.maxTilt) { newRoll = phy.maxTilt; vel.angVz = 0; }
  else if (newRoll < -phy.maxTilt) { newRoll = -phy.maxTilt; vel.angVz = 0; }
  data.data[config.shipData.pitch] = newPitch;
  data.data[config.shipData.roll] = newRoll;
}

if (import.meta.hot) {
  import.meta.hot.accept((newMod: any) => {
    if (newMod) hmrSwap("buoyancy-system", newMod);
  });
}
