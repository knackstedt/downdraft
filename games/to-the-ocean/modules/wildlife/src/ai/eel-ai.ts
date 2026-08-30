// Eel AI — electric shock on proximity, territorial behavior
import { createRng } from "@to-the-ocean/util/rng";
import type { WildlifeConfig, WildlifeEntity, WildlifePlayer } from "../types";

const rng = createRng(0xE15001);

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

  const row = ent.row;
  const tx = ent.transform.x[row]!;
  const ty = ent.transform.y[row]!;
  const tz = ent.transform.z[row]!;

  // Wander slowly
  if (d[4] <= 0) {
    d[0] = rng() * Math.PI * 2;
    d[4] = 3 + rng() * 5;
  }
  d[4] -= dt;

  // Check for nearby players to shock
  for (let p = 0; p < players.length; p++) {
    if (!players[p].active) continue;
    const dx = players[p].x - tx;
    const dy = players[p].y - ty;
    const dz = players[p].z - tz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < 5 && shockCooldown <= 0) {
      players[p].health = Math.max(0, players[p].health - config.eelShockDamage);
      shockCooldown = 3;
    }
  }

  d[2] = shockCooldown;

  ent.velocity.vx[row] = Math.cos(heading) * speed;
  ent.velocity.vz[row] = Math.sin(heading) * speed;
  ent.velocity.vy[row] = Math.sin(performance.now() / 500) * 0.3;
}
