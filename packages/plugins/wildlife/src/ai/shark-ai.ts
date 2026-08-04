// Shark AI — patrol, investigate, attack states
import type { WildlifeConfig, WildlifeDeps, WildlifeEntity, WildlifePlayer, WildlifeShip } from "../types";

enum SharkState { Patrol, Investigate, Attack, Flee }

export function tickSharkAI(
  ent: WildlifeEntity,
  dt: number,
  players: WildlifePlayer[],
  ships: WildlifeShip[],
  deps: WildlifeDeps,
  config: WildlifeConfig,
): void {
  const d = ent.data.data;
  let state = d[2] as SharkState;
  let stateTimer = d[4];

  stateTimer -= dt;

  // Find nearest detectable player
  let nearestDist = Infinity;
  let nearestIdx = -1;
  for (let p = 0; p < players.length; p++) {
    const player = players[p];
    if (!player.active) continue;
    const inWater = (player.flags & config.playerFlags.swimming) !== 0;
    const onBoat = (player.flags & config.playerFlags.onboard) !== 0;
    let detectable = inWater;
    if (!detectable && onBoat) {
      const shipId = deps.getOnboardShipId(player.playerId);
      if (shipId !== 0) {
        const ship = ships.find(s => s.id === shipId);
        if (ship) {
          const shipSpeed = Math.abs(ship.data[config.shipDataSpeedIndex] ?? 0);
          if (shipSpeed > config.sharkDetectBoatSpeed) {
            detectable = true;
          }
        }
      }
    }
    if (!detectable) continue;
    const dx = player.x - ent.transform.x;
    const dz = player.z - ent.transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = p;
    }
  }

  // State machine
  switch (state) {
    case SharkState.Patrol:
      if (stateTimer <= 0) {
        d[0] = Math.random() * Math.PI * 2;
        d[4] = 5 + Math.random() * 10;
      }
      if (nearestDist < 30 && nearestIdx >= 0) {
        state = SharkState.Investigate;
        d[2] = state;
        d[3] = nearestIdx;
        d[4] = 5;
      }
      break;

    case SharkState.Investigate:
      if (nearestIdx >= 0) {
        const player = players[nearestIdx];
        const dx = player.x - ent.transform.x;
        const dz = player.z - ent.transform.z;
        d[0] = Math.atan2(dz, dx);
        if (nearestDist < 10) {
          state = SharkState.Attack;
          d[2] = state;
          d[4] = 3;
        }
        if (nearestDist > 50 || stateTimer <= 0) {
          state = SharkState.Patrol;
          d[2] = state;
          d[4] = 0;
        }
      }
      break;

    case SharkState.Attack:
      if (nearestIdx >= 0) {
        const player = players[nearestIdx];
        const dx = player.x - ent.transform.x;
        const dz = player.z - ent.transform.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        d[0] = Math.atan2(dz, dx);
        d[1] = 8;

        if (dist < 3 && (player.flags & config.playerFlags.swimming) !== 0) {
          player.health -= config.sharkAttackDamage * dt;
        }

        if (stateTimer <= 0 || nearestDist > 60) {
          state = SharkState.Patrol;
          d[2] = state;
          d[4] = 0;
          d[1] = 3;
        }
      }
      break;

    case SharkState.Flee:
      if (nearestIdx >= 0) {
        const player = players[nearestIdx];
        const dx = ent.transform.x - player.x;
        const dz = ent.transform.z - player.z;
        d[0] = Math.atan2(dz, dx);
      }
      if (stateTimer <= 0) {
        state = SharkState.Patrol;
        d[2] = state;
        d[4] = 0;
      }
      break;
  }

  // Move
  const heading = d[0];
  const speed = d[1] || 3;
  ent.velocity.vx = Math.cos(heading) * speed;
  ent.velocity.vz = Math.sin(heading) * speed;
  const targetY = -3;
  ent.velocity.vy = (targetY - ent.transform.y) * 0.5;
}
