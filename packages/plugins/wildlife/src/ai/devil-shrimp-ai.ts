// Devil Shrimp AI — ambush predator, biome/depth gated, attacks mothership
import type { WildlifeConfig, WildlifeEntity, WildlifePlayer, WildlifeShip } from "../types.ts";

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

  // Find nearest ship
  let nearestShip: WildlifeShip | null = null;
  let nearestShipDist = Infinity;
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    const dx = s.x - ent.transform.x;
    const dz = s.z - ent.transform.z;
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
    const dx = players[p].x - ent.transform.x;
    const dz = players[p].z - ent.transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestPlayerDist) {
      nearestPlayerDist = dist;
      nearestPlayerIdx = p;
    }
  }

  switch (state) {
    case DevilShrimpState.Ambush:
      ent.velocity.vx *= 0.9;
      ent.velocity.vz *= 0.9;
      if (nearestShipDist < 40 || nearestPlayerDist < 30) {
        state = DevilShrimpState.Hunt;
        stateTimer = 30;
      }
      break;

    case DevilShrimpState.Hunt:
      if (nearestShip && nearestShipDist < 60) {
        const dx = nearestShip.x - ent.transform.x;
        const dz = nearestShip.z - ent.transform.z;
        d[0] = Math.atan2(dz, dx);
        if (nearestShipDist < 10) {
          state = DevilShrimpState.AttackShip;
          stateTimer = 10;
        }
      } else if (nearestPlayerIdx >= 0) {
        const player = players[nearestPlayerIdx];
        const dx = player.x - ent.transform.x;
        const dz = player.z - ent.transform.z;
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
        nearestShip.health.health -= config.devilShrimpAttackDamage * dt;
        if (stateTimer <= 0 || nearestShip.health.health <= 0) {
          state = DevilShrimpState.Retreat;
          stateTimer = 5;
        }
      } else {
        state = DevilShrimpState.Ambush;
      }
      break;

    case DevilShrimpState.AttackPlayer:
      if (nearestPlayerIdx >= 0) {
        players[nearestPlayerIdx].health -= config.devilShrimpAttackDamage * 0.5 * dt;
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
        const dx = ent.transform.x - nearestShip.x;
        const dz = ent.transform.z - nearestShip.z;
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
  ent.velocity.vx = Math.cos(heading) * speed;
  ent.velocity.vz = Math.sin(heading) * speed;
  ent.velocity.vy = (-20 - ent.transform.y) * 0.3;
}
