// Eel AI — electric shock on proximity, territorial behavior
import type { WildlifeEntity, WildlifePlayer, WildlifeConfig } from "../types";

export function tickEelAI(
  ent: WildlifeEntity,
  dt: number,
  players: WildlifePlayer[],
  config: WildlifeConfig,
): void {
  const d = ent.data.data;
  const heading = d[0];
  const speed = d[1] || 1;
  let shockCooldown = d[2];
  shockCooldown -= dt;

  // Wander slowly
  if (d[4] <= 0) {
    d[0] = Math.random() * Math.PI * 2;
    d[4] = 3 + Math.random() * 5;
  }
  d[4] -= dt;

  // Check for nearby players to shock
  for (let p = 0; p < players.length; p++) {
    if (!players[p].active) continue;
    const dx = players[p].x - ent.transform.x;
    const dy = players[p].y - ent.transform.y;
    const dz = players[p].z - ent.transform.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < 5 && shockCooldown <= 0) {
      players[p].health -= config.eelShockDamage;
      shockCooldown = 3;
    }
  }

  d[2] = shockCooldown;

  ent.velocity.vx = Math.cos(heading) * speed;
  ent.velocity.vz = Math.sin(heading) * speed;
  ent.velocity.vy = Math.sin(performance.now() / 500) * 0.3;
}
