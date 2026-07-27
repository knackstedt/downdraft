// ============================================================================
// Anchor System — spring-force constraint when a ship is anchored
// ============================================================================
// When deployed, the anchor creates a distance constraint between the ship
// and a fixed world point. The ship can drift freely within the rope length,
// but a spring force pulls it back when it exceeds that radius.
// This produces realistic "swinging on anchor" behavior without fighting
// the BuoyancySystem (which is the authority for vertical motion).

import { SimEntity } from "../Simulation";
import { EntityType } from "../../shared/types";
import {
  SHIP_DATA,
  ANCHOR_ROPE_LENGTH,
  ANCHOR_STIFFNESS,
  ANCHOR_DAMPING,
  ANCHOR_BOW_OFFSET,
  ANCHOR_DRAG,
} from "../../shared/constants";

export class AnchorSystem {
  private ropeLength = ANCHOR_ROPE_LENGTH;

  // Drop anchor at the ship's bow position
  dropAnchor(ent: SimEntity): void {
    const heading = ent.data[SHIP_DATA.HEADING] ?? 0;
    // Bow faces -Z in local space: forward = (-sin(heading), 0, -cos(heading))
    const bowX = ent.position.x + (-Math.sin(heading)) * ANCHOR_BOW_OFFSET;
    const bowZ = ent.position.z + (-Math.cos(heading)) * ANCHOR_BOW_OFFSET;
    ent.data[SHIP_DATA.ANCHOR_X] = bowX;
    ent.data[SHIP_DATA.ANCHOR_Z] = bowZ;
  }

  // Raise anchor — clear anchor state
  raiseAnchor(ent: SimEntity): void {
    ent.data[SHIP_DATA.ANCHOR_X] = NaN;
    ent.data[SHIP_DATA.ANCHOR_Z] = NaN;
  }

  // Check if a ship has an active anchor
  isAnchored(ent: SimEntity): boolean {
    return Number.isFinite(ent.data[SHIP_DATA.ANCHOR_X] ?? NaN);
  }

  // Apply spring force constraint to anchored ships.
  // Should run after buoyancy (which integrates position) and before Rapier physics.
  tick(dt: number, entities: SimEntity[], count: number): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Ship && ent.type !== EntityType.SmallCraft) continue;

      const ax = ent.data[SHIP_DATA.ANCHOR_X] ?? NaN;
      const az = ent.data[SHIP_DATA.ANCHOR_Z] ?? NaN;
      if (!Number.isFinite(ax) || !Number.isFinite(az)) continue;

      // Distance from ship to anchor point (horizontal only — anchor is on seabed)
      const dx = ent.position.x - ax;
      const dz = ent.position.z - az;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > this.ropeLength) {
        // Ship has exceeded rope length — apply spring force toward anchor
        const excess = dist - this.ropeLength;
        const invDist = 1 / dist;
        const dirX = -dx * invDist;
        const dirZ = -dz * invDist;

        // Spring force proportional to excess distance
        const force = excess * ANCHOR_STIFFNESS;
        ent.velocity.x += dirX * force * dt;
        ent.velocity.z += dirZ * force * dt;

        // Damping to prevent oscillation (only when at rope limit)
        const dampFactor = Math.max(0, 1 - ANCHOR_DAMPING * dt);
        ent.velocity.x *= dampFactor;
        ent.velocity.z *= dampFactor;
      } else {
        // Within rope radius — strong drag to simulate water resistance on anchored ship
        const dragFactor = Math.max(0, 1 - ANCHOR_DRAG * dt);
        ent.velocity.x *= dragFactor;
        ent.velocity.z *= dragFactor;
      }

      // Zero out throttle when anchored so the ship can't propel itself
      ent.data[SHIP_DATA.THROTTLE] = 0;

      // Guard against NaN/Infinity from extreme forces
      if (!Number.isFinite(ent.velocity.x)) ent.velocity.x = 0;
      if (!Number.isFinite(ent.velocity.z)) ent.velocity.z = 0;
      // Clamp velocity to sane range
      const maxVel = 50;
      if (ent.velocity.x > maxVel) ent.velocity.x = maxVel;
      else if (ent.velocity.x < -maxVel) ent.velocity.x = -maxVel;
      if (ent.velocity.z > maxVel) ent.velocity.z = maxVel;
      else if (ent.velocity.z < -maxVel) ent.velocity.z = -maxVel;
    }
  }
}
