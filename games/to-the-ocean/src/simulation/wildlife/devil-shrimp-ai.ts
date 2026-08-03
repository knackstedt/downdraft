// Devil Shrimp AI — ambush predator, biome/depth gated, attacks mothership
import { SimEntity, SimPlayer } from "../simulation";
import { EntityType, EntityFlags } from "../../shared/types";
import { DEVIL_SHRIP_ATTACK_DAMAGE } from "../../shared/constants";

enum DevilShrimpState { Ambush, Hunt, AttackShip, AttackPlayer, Retreat }

export class DevilShrimpAI {
  tick(
    ent: SimEntity,
    dt: number,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    let state = ent.data[2] as DevilShrimpState;
    let stateTimer = ent.data[4];
    stateTimer -= dt;

    // Find nearest ship
    let nearestShip: SimEntity | null = null;
    let nearestShipDist = Infinity;
    for (let i = 0; i < entityCount; i++) {
      const e = entities[i];
      if (!e || e.type !== EntityType.Ship) continue;
      const dx = e.position.x - ent.position.x;
      const dz = e.position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestShipDist) {
        nearestShipDist = dist;
        nearestShip = e;
      }
    }

    // Find nearest player
    let nearestPlayerDist = Infinity;
    let nearestPlayerIdx = -1;
    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      const dx = players[p].position.x - ent.position.x;
      const dz = players[p].position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestPlayerDist) {
        nearestPlayerDist = dist;
        nearestPlayerIdx = p;
      }
    }

    switch (state) {
      case DevilShrimpState.Ambush:
        // Stay still, wait for prey
        ent.velocity.x *= 0.9;
        ent.velocity.z *= 0.9;
        if (nearestShipDist < 40 || nearestPlayerDist < 30) {
          state = DevilShrimpState.Hunt;
          stateTimer = 30;
        }
        break;

      case DevilShrimpState.Hunt:
        // Move toward nearest target (ship preferred)
        if (nearestShip && nearestShipDist < 60) {
          const dx = nearestShip.position.x - ent.position.x;
          const dz = nearestShip.position.z - ent.position.z;
          ent.data[0] = Math.atan2(dz, dx);
          if (nearestShipDist < 10) {
            state = DevilShrimpState.AttackShip;
            stateTimer = 10;
          }
        } else if (nearestPlayerIdx >= 0) {
          const player = players[nearestPlayerIdx];
          const dx = player.position.x - ent.position.x;
          const dz = player.position.z - ent.position.z;
          ent.data[0] = Math.atan2(dz, dx);
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
          nearestShip.health -= DEVIL_SHRIP_ATTACK_DAMAGE * dt;
          if (stateTimer <= 0 || nearestShip.health <= 0) {
            state = DevilShrimpState.Retreat;
            stateTimer = 5;
          }
        } else {
          state = DevilShrimpState.Ambush;
        }
        break;

      case DevilShrimpState.AttackPlayer:
        if (nearestPlayerIdx >= 0) {
          players[nearestPlayerIdx].health -= DEVIL_SHRIP_ATTACK_DAMAGE * 0.5 * dt;
          if (stateTimer <= 0) {
            state = DevilShrimpState.Retreat;
            stateTimer = 5;
          }
        } else {
          state = DevilShrimpState.Ambush;
        }
        break;

      case DevilShrimpState.Retreat:
        // Move away from targets
        if (nearestShip) {
          const dx = ent.position.x - nearestShip.position.x;
          const dz = ent.position.z - nearestShip.position.z;
          ent.data[0] = Math.atan2(dz, dx);
        }
        if (stateTimer <= 0) {
          state = DevilShrimpState.Ambush;
        }
        break;
    }

    ent.data[2] = state;
    ent.data[4] = stateTimer;

    // Move
    const heading = ent.data[0];
    const speed = state === DevilShrimpState.Ambush ? 0 : 5;
    ent.velocity.x = Math.cos(heading) * speed;
    ent.velocity.z = Math.sin(heading) * speed;
    // Stay near seabed
    ent.velocity.y = (-20 - ent.position.y) * 0.3;
  }
}
