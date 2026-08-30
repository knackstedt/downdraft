// Passive AI — whales, dolphins, turtles, crustaceans, coral, moose
import type { WildlifeConfig, WildlifeEntity, WildlifePlayer } from "../types";

export function tickPassiveAI(
  ent: WildlifeEntity,
  dt: number,
  players: WildlifePlayer[],
  config: WildlifeConfig,
): void {
  const d = ent.data.data;
  const heading = d[0];
  const speed = d[1] || 1;
  const row = ent.row;
  const type = ent.meta.type[row]!;

  const tx = ent.transform.x[row]!;
  const ty = ent.transform.y[row]!;
  const tz = ent.transform.z[row]!;

  // Whale
  if (type === config.entityTypes.whale) {
    const breachState = d[5];

    if (d[4] <= 0) {
      d[0] = Math.random() * Math.PI * 2;
      d[4] = 10 + Math.random() * 20;
    }
    d[4] -= dt;
    ent.velocity.vx[row] = Math.cos(d[0]) * speed;
    ent.velocity.vz[row] = Math.sin(d[0]) * speed;

    switch (breachState) {
      case 0:
        if (d[6] <= 0) d[6] = 10 + Math.random() * 30;
        ent.velocity.vy[row] = Math.sin(performance.now() / 3000 + tx * 0.01) * 0.5;
        d[6] -= dt;
        if (d[6] <= 0) d[5] = 1;
        break;
      case 1:
        ent.velocity.vy[row] = 18;
        d[5] = 2;
        break;
      case 2:
        if (ty <= 0 && ent.velocity.vy[row]! < 0) {
          d[5] = 3;
          ent.velocity.vy[row] = -3;
        }
        break;
      case 3:
        ent.velocity.vy[row] = -4;
        if (ty < -6) {
          d[5] = 0;
          d[6] = 15 + Math.random() * 30;
        }
        break;
    }
    return;
  }

  // Dolphin
  if (type === config.entityTypes.dolphin) {
    if (players.length > 0) {
      const player = players[0];
      const dx = player.x - tx;
      const dz = player.z - tz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 30) {
        d[0] = Math.atan2(dz, dx) + Math.PI / 2;
        d[1] = 4;
      } else {
        if (d[4] <= 0) {
          d[0] = Math.random() * Math.PI * 2;
          d[4] = 5;
        }
        d[4] -= dt;
        d[1] = 2;
      }
    }
    ent.velocity.vx[row] = Math.cos(d[0]) * d[1];
    ent.velocity.vz[row] = Math.sin(d[0]) * d[1];
    ent.velocity.vy[row] = Math.sin(performance.now() / 1000) * 1.5;
    return;
  }

  // Turtle
  if (type === config.entityTypes.turtle) {
    if (d[4] <= 0) {
      d[0] = Math.random() * Math.PI * 2;
      d[4] = 15 + Math.random() * 20;
    }
    d[4] -= dt;
    ent.velocity.vx[row] = Math.cos(heading) * speed * 0.3;
    ent.velocity.vz[row] = Math.sin(heading) * speed * 0.3;
    ent.velocity.vy[row] = Math.sin(performance.now() / 2000) * 0.2;
    return;
  }

  // Crustacean
  if (type === config.entityTypes.crustacean) {
    if (d[4] <= 0) {
      d[0] = Math.random() * Math.PI * 2;
      d[4] = 3 + Math.random() * 5;
    }
    d[4] -= dt;
    ent.velocity.vx[row] = Math.cos(heading) * speed * 0.5;
    ent.velocity.vz[row] = Math.sin(heading) * speed * 0.5;
    ent.velocity.vy[row] = 0;
    return;
  }

  // Coral
  if (type === config.entityTypes.coral) {
    ent.velocity.vx[row] = 0;
    ent.velocity.vy[row] = 0;
    ent.velocity.vz[row] = 0;
    return;
  }

  // Moose
  if (type === config.entityTypes.moose) {
    ent.velocity.vx[row] = Math.cos(heading) * speed * 0.2;
    ent.velocity.vz[row] = Math.sin(heading) * speed * 0.2;
    ent.velocity.vy[row] = (-30 - ty) * 0.3;
    if (d[4] <= 0) {
      d[0] = Math.random() * Math.PI * 2;
      d[4] = 20 + Math.random() * 30;
    }
    d[4] -= dt;
    return;
  }
}
