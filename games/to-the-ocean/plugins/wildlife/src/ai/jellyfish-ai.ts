// Jellyfish AI — swarm drift, bioluminescent at night, DoT contact damage
import type { WildlifeEntity, WildlifePlayer, WildlifeConfig } from "../types";

export function tickJellyfishAI(
  ent: WildlifeEntity,
  dt: number,
  players: WildlifePlayer[],
  config: WildlifeConfig,
): void {
  const d = ent.data.data;
  const pulsePhase = d[1] || 0;
  d[1] = pulsePhase + dt * 0.5;

  const driftAngle = d[0];
  const currentSpeed = 0.3;
  ent.velocity.vx = Math.cos(driftAngle) * currentSpeed;
  ent.velocity.vz = Math.sin(driftAngle) * currentSpeed;
  ent.velocity.vy = Math.sin(pulsePhase * 2) * 0.5;

  ent.meta.flags |= config.entityFlags.bioluminescent;

  for (let p = 0; p < players.length; p++) {
    if (!players[p].active) continue;
    const dx = players[p].x - ent.transform.x;
    const dy = players[p].y - ent.transform.y;
    const dz = players[p].z - ent.transform.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < 2) {
      players[p].health -= config.jellyfishDotDamage * dt;
    }
  }

  if (Math.random() < 0.001) {
    d[0] = Math.random() * Math.PI * 2;
  }
}
