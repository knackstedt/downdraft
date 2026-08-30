// Devil Shrimp AI — ambush predator, biome/depth gated, attacks mothership
import type { WildlifeConfig, WildlifeEntity, WildlifePlayer, WildlifeShip } from "../types";

enum DevilShrimpState { Ambush, Hunt, AttackShip, AttackPlayer, Retreat }

export function tickDevilShrimpAI(
  ent: WildlifeEntity,
  dt: number,
  players: WildlifePlayer[],
  ships: WildlifeShip[],
  config: WildlifeConfig,
): void {
  const d = ent.data.data;
  let state = d[2] as DevilShrimpState;
  let stateTimer = d[4];
  stateTimer -= dt;

  const row = ent.row;
  const tx = ent.transform.x[row]!;
  const ty = ent.transform.y[row]!;
  const tz = ent.transform.z[row]!;

  // Find nearest ship
  let nearestShip: WildlifeShip | null = null;
  let nearestShipDist = Infinity;
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    const dx = s.x - tx;
    const dz = s.z - tz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestShipDist) {
      nearestShipDist = dist;
      nearestShip = s;
    }
  }

  // Find nearest player
  let nearestPlayerDist = Infinity;
  let nearestPlayerIdx = -1;
  for (let p = 0; p < players.length; p++) {
    if (!players[p].active) continue;
    const dx = players[p].x - tx;
    const dz = players[p].z - tz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestPlayerDist) {
      nearestPlayerDist = dist;
      nearestPlayerIdx = p;
    }
  }

  switch (state) {
    case DevilShrimpState.Ambush:
      ent.velocity.vx[row] *= 0.9;
      ent.velocity.vz[row] *= 0.9;
      if (nearestShipDist < 40 || nearestPlayerDist < 30) {
        state = DevilShrimpState.Hunt;
        stateTimer = 30;
      }
      break;

    case DevilShrimpState.Hunt:
      if (nearestShip && nearestShipDist < 60) {
        const dx = nearestShip.x - tx;
        const dz = nearestShip.z - tz;
        d[0] = Math.atan2(dz, dx);
        if (nearestShipDist < 10) {
          state = DevilShrimpState.AttackShip;
          stateTimer = 10;
        }
      } else if (nearestPlayerIdx >= 0) {
        const player = players[nearestPlayerIdx];
        const dx = player.x - tx;
        const dz = player.z - tz;
        d[0] = Math.atan2(dz, dx);
        if (nearestPlayerDist < 5) {
          state = DevilShrimpState.AttackPlayer;
          stateTimer = 5;
        }
      } else {
        state = DevilShrimpState.Ambush;
        stateTimer = 0;
      }
      break;

    case DevilShrimpState.AttackShip:
      if (nearestShip) {
        nearestShip.health.health[nearestShip.row] = Math.max(0, nearestShip.health.health[nearestShip.row]! - config.devilShrimpAttackDamage * dt);
        if (stateTimer <= 0 || nearestShip.health.health[nearestShip.row]! <= 0) {
          state = DevilShrimpState.Retreat;
          stateTimer = 5;
        }
      } else {
        state = DevilShrimpState.Ambush;
      }
      break;

    case DevilShrimpState.AttackPlayer:
      if (nearestPlayerIdx >= 0) {
        players[nearestPlayerIdx].health = Math.max(0, players[nearestPlayerIdx].health - config.devilShrimpAttackDamage * 0.5 * dt);
        if (stateTimer <= 0) {
          state = DevilShrimpState.Retreat;
          stateTimer = 5;
        }
      } else {
        state = DevilShrimpState.Ambush;
      }
      break;

    case DevilShrimpState.Retreat:
      if (nearestShip) {
        const dx = tx - nearestShip.x;
        const dz = tz - nearestShip.z;
        d[0] = Math.atan2(dz, dx);
      }
      if (stateTimer <= 0) {
        state = DevilShrimpState.Ambush;
      }
      break;
  }

  d[2] = state;
  d[4] = stateTimer;

  const heading = d[0];
  const speed = state === DevilShrimpState.Ambush ? 0 : 5;
  ent.velocity.vx[row] = Math.cos(heading) * speed;
  ent.velocity.vz[row] = Math.sin(heading) * speed;
  ent.velocity.vy[row] = (-20 - ty) * 0.3;
}
