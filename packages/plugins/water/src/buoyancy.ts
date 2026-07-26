// ============================================================================
// Buoyancy System — applies water height-based forces to ships/entities
// Ported from to-the-ocean/src/simulation/physics/BuoyancySystem.ts
// ============================================================================

import type { WaterPhysics } from "./water-physics.ts";

export interface BuoyancyEntity {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  pitch: number;
  roll: number;
  angularVelX: number;
  angularVelZ: number;
  speed: number;
  mass: number;
}

const GRAVITY = 9.8;
const WATER_DENSITY = 1000;
const BUOYANCY_SPRING = 20;
const BUOYANCY_DAMPING = 8;
const ANGULAR_DAMPING = 3;
const MAX_TILT = 0.5;
const SHIP_HALF_LENGTH = 4;
const SHIP_HALF_WIDTH = 2;

export class BuoyancySystem {
  private physics: WaterPhysics;

  constructor(physics: WaterPhysics) {
    this.physics = physics;
  }

  applyBuoyancy(ent: BuoyancyEntity, dt: number): void {
    // Sample water height at bow, stern, port, starboard
    const cosH = Math.cos(ent.heading);
    const sinH = Math.sin(ent.heading);

    const bowX = ent.x + sinH * SHIP_HALF_LENGTH;
    const bowZ = ent.z + cosH * SHIP_HALF_LENGTH;
    const sternX = ent.x - sinH * SHIP_HALF_LENGTH;
    const sternZ = ent.z - cosH * SHIP_HALF_LENGTH;
    const portX = ent.x - cosH * SHIP_HALF_WIDTH;
    const portZ = ent.z + sinH * SHIP_HALF_WIDTH;
    const starX = ent.x + cosH * SHIP_HALF_WIDTH;
    const starZ = ent.z - sinH * SHIP_HALF_WIDTH;

    const whBow = this.physics.sampleWaterAt(bowX, bowZ);
    const whStern = this.physics.sampleWaterAt(sternX, sternZ);
    const whPort = this.physics.sampleWaterAt(portX, portZ);
    const whStar = this.physics.sampleWaterAt(starX, starZ);

    const avgWaterHeight = (whBow + whStern + whPort + whStar) / 4;

    // Vertical buoyancy: spring toward water surface
    const dy = avgWaterHeight - ent.y;
    ent.vy += dy * BUOYANCY_SPRING * dt;
    ent.vy *= Math.max(0, 1 - BUOYANCY_DAMPING * dt);

    // Pitch from bow vs stern differential
    const pitchForce = (whStern - whBow) / (SHIP_HALF_LENGTH * 2);
    // Roll from port vs starboard differential
    const rollForce = (whStar - whPort) / (SHIP_HALF_WIDTH * 2);

    ent.angularVelX += pitchForce * 5 * dt;
    ent.angularVelZ += rollForce * 5 * dt;
    ent.angularVelX *= Math.max(0, 1 - ANGULAR_DAMPING * dt);
    ent.angularVelZ *= Math.max(0, 1 - ANGULAR_DAMPING * dt);

    let newPitch = ent.pitch + ent.angularVelX * dt;
    let newRoll = ent.roll + ent.angularVelZ * dt;

    if (newPitch > MAX_TILT) { newPitch = MAX_TILT; ent.angularVelX = 0; }
    else if (newPitch < -MAX_TILT) { newPitch = -MAX_TILT; ent.angularVelX = 0; }
    if (newRoll > MAX_TILT) { newRoll = MAX_TILT; ent.angularVelZ = 0; }
    else if (newRoll < -MAX_TILT) { newRoll = -MAX_TILT; ent.angularVelZ = 0; }

    ent.pitch = newPitch;
    ent.roll = newRoll;

    // Apply gravity
    ent.vy -= GRAVITY * dt;

    // Integrate position
    ent.y += ent.vy * dt;

    // Clamp to prevent falling through
    if (ent.y < avgWaterHeight - 5) {
      ent.y = avgWaterHeight - 5;
      ent.vy = Math.max(0, ent.vy);
    }
  }

  sampleWaterAt(x: number, z: number): number {
    return this.physics.sampleWaterAt(x, z);
  }
}
