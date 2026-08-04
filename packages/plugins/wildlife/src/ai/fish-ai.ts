// Fish AI — schooling, flocking, biome-specific species, flee from predators
import type { WildlifeEntity } from "../types";

export function tickFishAI(
  ent: WildlifeEntity,
  allFish: WildlifeEntity[],
  sharkPositions: { x: number; z: number }[],
): void {
  const d = ent.data.data;
  const heading = d[0];
  const speed = d[1];

  if (d[2] === 0) d[2] = speed;
  const baseSpeed = d[2];

  // Find nearby fish for schooling
  let avgX = 0, avgZ = 0, alignX = 0, alignZ = 0, sepX = 0, sepZ = 0;
  let neighborCount = 0;

  for (let i = 0; i < allFish.length; i++) {
    const other = allFish[i];
    if (other === ent) continue;
    const dx = other.transform.x - ent.transform.x;
    const dz = other.transform.z - ent.transform.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < 100 && distSq > 0) {
      avgX += other.transform.x;
      avgZ += other.transform.z;
      alignX += Math.cos(other.data.data[0]);
      alignZ += Math.sin(other.data.data[0]);
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
    const cohesionX = (avgX - ent.transform.x) * 0.01;
    const cohesionZ = (avgZ - ent.transform.z) * 0.01;
    const targetHeading = Math.atan2(alignZ + cohesionZ + sepX, alignX + cohesionX + sepZ);
    let diff = targetHeading - heading;
    if (!Number.isFinite(diff)) diff = 0;
    else diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    d[0] = heading + diff * 0.05;
  }

  // Flee from sharks
  let fleeing = false;
  for (let i = 0; i < sharkPositions.length; i++) {
    const dx = sharkPositions[i].x - ent.transform.x;
    const dz = sharkPositions[i].z - ent.transform.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < 400) {
      const fleeAngle = Math.atan2(-dz, -dx);
      d[0] = fleeAngle;
      fleeing = true;
      break;
    }
  }

  const finalSpeed = fleeing ? baseSpeed * 2 : baseSpeed;
  d[1] = finalSpeed;

  const finalHeading = d[0];
  ent.velocity.vx = Math.cos(finalHeading) * finalSpeed;
  ent.velocity.vz = Math.sin(finalHeading) * finalSpeed;
  ent.velocity.vy = Math.sin(performance.now() / 1000 + ent.transform.x * 0.01) * 0.2;
}
