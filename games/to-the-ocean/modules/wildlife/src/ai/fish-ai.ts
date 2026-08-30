// Fish AI — schooling, flocking, biome-specific species, flee from predators
import { BroadPhaseGrid } from "@downdraft/core";
import type { WildlifeEntity } from "../types";

export function tickFishAI(
  ent: WildlifeEntity,
  allFish: WildlifeEntity[],
  fishGrid: BroadPhaseGrid,
  neighborOut: number[],
  sharkPositions: { x: number; z: number }[],
): void {
  const d = ent.data.data;
  const heading = d[0];
  const speed = d[1];

  if (d[2] === 0) d[2] = speed;
  const baseSpeed = d[2];

  const row = ent.row;
  const tx = ent.transform.x[row]!;
  const tz = ent.transform.z[row]!;

  // Find nearby fish for schooling via spatial grid (O(k) instead of O(N))
  let avgX = 0, avgZ = 0, alignX = 0, alignZ = 0, sepX = 0, sepZ = 0;
  let neighborCount = 0;

  // Query the 3x3 neighborhood around this fish. neighborOut is caller-owned
  // and reused across calls; we must clear it before querying.
  neighborOut.length = 0;
  fishGrid.queryNeighbors(tx, tz, neighborOut);

  for (let n = 0; n < neighborOut.length; n++) {
    const i = neighborOut[n]!;
    const other = allFish[i];
    if (other === ent) continue;
    const dx = other.transform.x[other.row]! - tx;
    const dz = other.transform.z[other.row]! - tz;
    const distSq = dx * dx + dz * dz;
    if (distSq < 100 && distSq > 0) {
      avgX += other.transform.x[other.row]!;
      avgZ += other.transform.z[other.row]!;
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
    const cohesionX = (avgX - tx) * 0.01;
    const cohesionZ = (avgZ - tz) * 0.01;
    const targetHeading = Math.atan2(alignZ + cohesionZ + sepX, alignX + cohesionX + sepZ);
    let diff = targetHeading - heading;
    if (!Number.isFinite(diff)) diff = 0;
    else diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    d[0] = heading + diff * 0.05;
  }

  // Flee from sharks
  let fleeing = false;
  for (let i = 0; i < sharkPositions.length; i++) {
    const dx = sharkPositions[i].x - tx;
    const dz = sharkPositions[i].z - tz;
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
  ent.velocity.vx[row] = Math.cos(finalHeading) * finalSpeed;
  ent.velocity.vz[row] = Math.sin(finalHeading) * finalSpeed;
  ent.velocity.vy[row] = Math.sin(performance.now() / 1000 + tx * 0.01) * 0.2;
}
