// Fish AI — schooling, flocking, biome-specific species, flee from predators
import { SimEntity } from "../simulation";
import { EntityType } from "../../shared/types";

export class FishAI {
  tick(ent: SimEntity, dt: number, entities: SimEntity[], count: number): void {
    // data[0] = heading, data[1] = current speed, data[2] = base speed (cached)
    const heading = ent.data[0];
    const speed = ent.data[1];

    // Cache base speed on first tick (data[2] is 0 at spawn)
    if (ent.data[2] === 0) ent.data[2] = speed;
    const baseSpeed = ent.data[2];

    // Find nearby fish for schooling
    let avgX = 0, avgZ = 0, alignX = 0, alignZ = 0, sepX = 0, sepZ = 0;
    let neighborCount = 0;

    for (let i = 0; i < count; i++) {
      const other = entities[i];
      if (!other || other === ent || other.type !== EntityType.Fish) continue;
      const dx = other.position.x - ent.position.x;
      const dz = other.position.z - ent.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 100 && distSq > 0) {
        avgX += other.position.x;
        avgZ += other.position.z;
        alignX += Math.cos(other.data[0]);
        alignZ += Math.sin(other.data[0]);
        if (distSq < 9) {
          sepX -= dx;
          sepZ -= dz;
        }
        neighborCount++;
      }
    }

    if (neighborCount > 0) {
      avgX /= neighborCount;
      avgZ /= neighborCount;
      alignX /= neighborCount;
      alignZ /= neighborCount;
      // Cohesion + alignment + separation
      const cohesionX = (avgX - ent.position.x) * 0.01;
      const cohesionZ = (avgZ - ent.position.z) * 0.01;
      const targetHeading = Math.atan2(alignZ + cohesionZ + sepX, alignX + cohesionX + sepZ);
      // Smoothly turn toward target (safe for Infinity/NaN)
      let diff = targetHeading - heading;
      if (!Number.isFinite(diff)) diff = 0;
      else diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      ent.data[0] = heading + diff * 0.05;
    }

    // Check for predators nearby and flee
    let fleeing = false;
    for (let i = 0; i < count; i++) {
      const other = entities[i];
      if (!other || other.type !== EntityType.Shark) continue;
      const dx = other.position.x - ent.position.x;
      const dz = other.position.z - ent.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 400) {
        // Flee away from shark
        const fleeAngle = Math.atan2(-dz, -dx);
        ent.data[0] = fleeAngle;
        fleeing = true;
      }
    }

    // Set speed: burst when fleeing, normal otherwise (no compounding)
    const finalSpeed = fleeing ? baseSpeed * 2 : baseSpeed;
    ent.data[1] = finalSpeed;

    // Move in heading direction (after flee check so direction is correct this tick)
    const finalHeading = ent.data[0];
    ent.velocity.x = Math.cos(finalHeading) * finalSpeed;
    ent.velocity.z = Math.sin(finalHeading) * finalSpeed;
    // Gentle vertical bob
    ent.velocity.y = Math.sin(performance.now() / 1000 + ent.position.x * 0.01) * 0.2;
  }
}
