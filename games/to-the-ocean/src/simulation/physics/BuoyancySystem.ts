// ============================================================================
// Buoyancy System — hull-based boat buoyancy with per-cell forces & torques
// ============================================================================

import { WaterBufferWriter, WATER_GRID } from "../../shared/water-buffer";
import { SimEntity } from "../Simulation";
import { BoatCellSystem } from "../boat/BoatCellSystem";
import { BoatDesignSystem } from "../boat/BoatDesignSystem";
import {
  BOAT_CELL_WORLD_SIZE,
  BOAT_LAYER_HEIGHT,
  SHIP_DATA,
  isHullShellCell,
} from "../../shared/constants";
import { EntityType, EntityFlags } from "../../shared/types";
import { collectShoreSources, shoreDamping, shoreDisplacement, waterCutout, ShoreSource } from "../../shared/shore-damping";

// Physics constants
const GRAVITY = 9.8;
const WATER_DENSITY = 1000; // kg/m³
const MAX_TILT = Math.PI / 6; // 30° max pitch/roll
const RESTORING_STIFFNESS = 20.0; // spring constant for pitch/roll self-righting
const VERTICAL_DAMPING = 5.0;
const ANGULAR_DAMPING = 4.0; // moderate damping for natural settling without stair-stepping
const ANGULAR_DEADZONE = 0.008; // below this angular velocity (rad/s), snap to zero to settle
const TILT_SETTLE_THRESHOLD = 0.009; // slightly above deadzone — catches residual tilt after angVel snap

// All foundational cells displace water for buoyancy (hull, walls, floors, decks, bridges, pontoons, etc.)

export class BuoyancySystem {
  private waterWriter: WaterBufferWriter;
  private boatCellSystem: BoatCellSystem | null = null;
  private boatDesignSystem: BoatDesignSystem | null = null;
  private shoreSources: ShoreSource[] = [];
  private shoreCount = 0;
  private simTime = 0;

  constructor(waterWriter: WaterBufferWriter) {
    this.waterWriter = waterWriter;
  }

  setBoatCellSystem(bcs: BoatCellSystem): void {
    this.boatCellSystem = bcs;
  }

  setBoatDesignSystem(bds: BoatDesignSystem): void {
    this.boatDesignSystem = bds;
  }

  tick(dt: number, entities: SimEntity[], count: number): void {
    this.simTime += dt;
    // Collect island/port positions for shore damping in water sampling
    if (this.shoreSources.length < 128) this.shoreSources = [];
    while (this.shoreSources.length < 128) this.shoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
    this.shoreCount = collectShoreSources(entities, count, this.shoreSources);

    const tStart = performance.now();
    let slowEntity = -1;
    let slowMs = 0;
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;

      // Player entities are handled by PlayerManager (vertical physics, water interaction)
      if (ent.type === EntityType.Player) continue;

      // Apply buoyancy to ships and small craft
      if (ent.type === EntityType.Ship || ent.type === EntityType.SmallCraft) {
        const entT0 = performance.now();
        this.applyBuoyancy(ent, dt);
        const entT1 = performance.now();
        if (entT1 - entT0 > slowMs) {
          slowMs = entT1 - entT0;
          slowEntity = ent.id;
        }
      }

      // Apply gravity to non-static entities (but not ships — they use buoyancy only)
      if (!(ent.flags & EntityFlags.Static)) {
        if (ent.type !== EntityType.Ship && ent.type !== EntityType.SmallCraft) {
          ent.velocity.y -= GRAVITY * dt;
        }
      }

      // Apply velocity to position
      ent.position.x += ent.velocity.x * dt;
      ent.position.y += ent.velocity.y * dt;
      ent.position.z += ent.velocity.z * dt;

      // Simple ground collision (seabed)
      const seabedHeight = -50;
      if (ent.position.y < seabedHeight) {
        ent.position.y = seabedHeight;
        ent.velocity.y = Math.max(0, ent.velocity.y);
      }
    }

    const tEnd = performance.now();
    if (tEnd - tStart > 10) {
      console.error(`[BUOY] Slow buoyancy tick: ${(tEnd - tStart).toFixed(1)}ms total, slowest entity=${slowEntity} (${slowMs.toFixed(1)}ms)`);
    }
  }

  private applyBuoyancy(ent: SimEntity, dt: number): void {
    // Prefer cell-based buoyancy when cells exist — the cell grid is the
    // authoritative boat layout. The design system's smooth-hull geometry
    // doesn't match the cell-based layout (e.g. thin pontoon tubes at x=±0.8
    // vs cell pontoons at x=±4), causing asymmetric forces and listing.
    const cells = this.boatCellSystem?.getCells(ent.id);
    if (cells && cells.length > 0) {
      this.applyCellBuoyancy(ent, dt, cells);
      return;
    }

    // Fall back to design system geometry when no cells are present
    const geometry = this.boatDesignSystem?.getGeometry(ent.id);
    if (geometry) {
      const mp = geometry.getMassProperties();
      if (mp.mass <= 0) {
        this.applySimpleBuoyancy(ent, dt);
        return;
      }

      const heading = ent.data[SHIP_DATA.HEADING] ?? 0;
      const pitch = ent.data[SHIP_DATA.PITCH] ?? 0;
      const roll = ent.data[SHIP_DATA.ROLL] ?? 0;

      const sample = geometry.sampleBuoyancy(
        ent.position,
        heading,
        pitch,
        roll,
        (wx, wz) => this.sampleWaterAt(wx, wz),
      );

      this.integrateBuoyancy(ent, dt, mp.mass, sample.totalForceY, sample.totalTorqueX, sample.totalTorqueZ, mp.Ixx, mp.Izz);
      return;
    }

    this.applySimpleBuoyancy(ent, dt);
  }

  private applyCellBuoyancy(
    ent: SimEntity,
    dt: number,
    cells: { type: number; gridX: number; gridY: number; gridZ: number }[],
  ): void {

    // Use cached mass properties for correct center of mass and inertia
    const mp = this.boatCellSystem!.getMassProperties(ent.id);
    const shipMass = mp.mass;

    const heading = ent.data[SHIP_DATA.HEADING] ?? 0;
    const pitch = ent.data[SHIP_DATA.PITCH] ?? 0;
    const roll = ent.data[SHIP_DATA.ROLL] ?? 0;

    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    const cellArea = BOAT_CELL_WORLD_SIZE * BOAT_CELL_WORLD_SIZE;
    const cellHeight = BOAT_LAYER_HEIGHT;

    let totalForceY = 0;
    let totalTorqueX = 0;
    let totalTorqueZ = 0;
    let hullCellCount = 0;

    // Compute buoyancy forces and torques per hull cell
    // Use center of mass from mass properties for lever arms
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!isHullShellCell(cell.type)) continue;
      hullCellCount++;

      // Cell center in local space (relative to grid origin)
      const localX = cell.gridX * BOAT_CELL_WORLD_SIZE;
      const localY = cell.gridY * BOAT_LAYER_HEIGHT + BOAT_LAYER_HEIGHT / 2;
      const localZ = cell.gridZ * BOAT_CELL_WORLD_SIZE;

      // Lever arm relative to center of mass
      const armX = localX - mp.centerX;
      const armY = localY - mp.centerY;
      const armZ = localZ - mp.centerZ;

      // --- Yaw-only horizontal position for water sampling ---
      // This breaks the tilt→sample→more-tilt feedback loop.
      const yawX = armX * cosH - armZ * sinH;
      const yawZ = armX * sinH + armZ * cosH;
      const sampleX = ent.position.x + yawX;
      const sampleZ = ent.position.z + yawZ;

      // --- Full rotation for vertical position (submersion depth) ---
      // Apply pitch (rotation around X): y' = y*cosP - z*sinP, z' = y*sinP + z*cosP
      const pY = armY * cosP - armZ * sinP;
      // Apply roll (rotation around Z): y' = x*sinR + y*cosR
      const rY = armX * sinR + pY * cosR;
      const worldY = ent.position.y + rY;

      // Sample water height at yaw-only position (stable, no feedback)
      const waterHeight = this.sampleWaterAt(sampleX, sampleZ);

      // Cell bottom in world Y (affected by pitch/roll — this is correct)
      const cellBottom = worldY - cellHeight / 2;
      if (waterHeight <= cellBottom) continue; // fully above water

      const submersionDepth = Math.min(waterHeight - cellBottom, cellHeight);
      const submergedVolume = cellArea * submersionDepth;
      const buoyancyForce = WATER_DENSITY * submergedVolume * GRAVITY;

      totalForceY += buoyancyForce;

      // Torque = r × F in boat-local axes.  F = (0, buoyancyForce, 0) is
      // vertical in world space, but the inverse-yaw rotation of the world
      // torque simplifies to using the local lever arms directly:
      //   τx_local = -armZ * Fy   (pitch)
      //   τz_local =  armX * Fy   (roll)
      // This keeps pitch and roll decoupled at every heading.
      totalTorqueX += -armZ * buoyancyForce;
      totalTorqueZ += armX * buoyancyForce;
    }

    if (hullCellCount === 0) {
      this.applySimpleBuoyancy(ent, dt);
      return;
    }

    this.integrateBuoyancy(ent, dt, shipMass, totalForceY, totalTorqueX, totalTorqueZ, mp.Ixx, mp.Izz);
  }

  private integrateBuoyancy(
    ent: SimEntity,
    dt: number,
    shipMass: number,
    totalForceY: number,
    totalTorqueX: number,
    totalTorqueZ: number,
    Ixx: number,
    Izz: number,
  ): void {
    const gravityForce = shipMass * GRAVITY;

    // Net vertical force → acceleration
    const netForceY = totalForceY - gravityForce;
    ent.velocity.y += (netForceY / shipMass) * dt;

    // Vertical damping (water resistance)
    ent.velocity.y *= Math.max(0, 1 - VERTICAL_DAMPING * dt);

    const pitch = ent.data[SHIP_DATA.PITCH] ?? 0;
    const roll = ent.data[SHIP_DATA.ROLL] ?? 0;

    // Apply torque → angular acceleration
    if (Ixx > 0) ent.angularVelocity.x += (totalTorqueX / Ixx) * dt;
    if (Izz > 0) ent.angularVelocity.z += (totalTorqueZ / Izz) * dt;

    // Restoring torque (spring back toward level)
    ent.angularVelocity.x -= pitch * RESTORING_STIFFNESS * dt;
    ent.angularVelocity.z -= roll * RESTORING_STIFFNESS * dt;

    // Angular damping (pitch/roll only — yaw damping is in BoatSystem)
    ent.angularVelocity.x *= Math.max(0, 1 - ANGULAR_DAMPING * dt);
    ent.angularVelocity.z *= Math.max(0, 1 - ANGULAR_DAMPING * dt);

    // NaN guard — prevent runaway rotation from corrupted state
    if (!Number.isFinite(ent.angularVelocity.x)) ent.angularVelocity.x = 0;
    if (!Number.isFinite(ent.angularVelocity.z)) ent.angularVelocity.z = 0;

    // Integrate angular velocity into pitch and roll
    let newPitch = pitch + ent.angularVelocity.x * dt;
    let newRoll = roll + ent.angularVelocity.z * dt;

    // NaN guard on integrated values
    if (!Number.isFinite(newPitch)) newPitch = 0;
    if (!Number.isFinite(newRoll)) newRoll = 0;

    // Clamp to reasonable limits and zero angular velocity at bounds
    if (newPitch > MAX_TILT) { newPitch = MAX_TILT; ent.angularVelocity.x = 0; }
    else if (newPitch < -MAX_TILT) { newPitch = -MAX_TILT; ent.angularVelocity.x = 0; }
    if (newRoll > MAX_TILT) { newRoll = MAX_TILT; ent.angularVelocity.z = 0; }
    else if (newRoll < -MAX_TILT) { newRoll = -MAX_TILT; ent.angularVelocity.z = 0; }

    ent.data[SHIP_DATA.PITCH] = newPitch;
    ent.data[SHIP_DATA.ROLL] = newRoll;
  }

  // Fallback for entities without hull cells (e.g. SmallCraft)
  private applySimpleBuoyancy(ent: SimEntity, dt: number): void {
    const halfLength = 4;
    const halfWidth = 2;

    // Sample at bow, stern, port, starboard
    const wh0 = this.sampleWaterAt(ent.position.x + halfLength, ent.position.z);
    const wh1 = this.sampleWaterAt(ent.position.x - halfLength, ent.position.z);
    const wh2 = this.sampleWaterAt(ent.position.x, ent.position.z + halfWidth);
    const wh3 = this.sampleWaterAt(ent.position.x, ent.position.z - halfWidth);

    const avgWaterHeight = (wh0 + wh1 + wh2 + wh3) / 4;

    const dy = avgWaterHeight - ent.position.y;
    ent.velocity.y += dy * 20 * dt;
    ent.velocity.y *= Math.max(0, 1 - 8 * dt);

    // Simple pitch/roll from water height differential
    const pitchForce = (wh1 - wh0) / (halfLength * 2); // bow vs stern
    const rollForce = (wh3 - wh2) / (halfWidth * 2); // starboard vs port

    ent.angularVelocity.x += pitchForce * 5 * dt;
    ent.angularVelocity.z += rollForce * 5 * dt;
    ent.angularVelocity.x *= Math.max(0, 1 - ANGULAR_DAMPING * dt);
    ent.angularVelocity.z *= Math.max(0, 1 - ANGULAR_DAMPING * dt);

    let newPitch = (ent.data[SHIP_DATA.PITCH] ?? 0) + ent.angularVelocity.x * dt;
    let newRoll = (ent.data[SHIP_DATA.ROLL] ?? 0) + ent.angularVelocity.z * dt;

    if (newPitch > MAX_TILT) { newPitch = MAX_TILT; ent.angularVelocity.x = 0; }
    else if (newPitch < -MAX_TILT) { newPitch = -MAX_TILT; ent.angularVelocity.x = 0; }
    if (newRoll > MAX_TILT) { newRoll = MAX_TILT; ent.angularVelocity.z = 0; }
    else if (newRoll < -MAX_TILT) { newRoll = -MAX_TILT; ent.angularVelocity.z = 0; }
    ent.data[SHIP_DATA.PITCH] = newPitch;
    ent.data[SHIP_DATA.ROLL] = newRoll;
  }

  private sampleWaterAt(x: number, z: number): number {
    // Inside a water cutout zone — no water (return very negative height)
    if (waterCutout(x, z, this.shoreSources, this.shoreCount)) return -1000;
    const patchSize = this.waterWriter.getPatchSize() || 4;
    const origin = this.waterWriter.getOrigin();
    const gx = ((x - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const gz = ((z - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const rawH = this.waterWriter.sampleHeight(gx, gz);
    // Apply shore damping + shore ring waves so buoyancy matches the visual water near islands
    const damping = shoreDamping(x, z, this.shoreSources, this.shoreCount);
    const shore = shoreDisplacement(x, z, this.simTime, this.shoreSources, this.shoreCount);
    return rawH * damping + shore;
  }
}
