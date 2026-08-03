// Shark AI — patrol, investigate, attack states
import { SimEntity, SimPlayer } from "../simulation";
import { EntityType, EntityFlags } from "../../shared/types";
import { SHARK_ATTACK_DAMAGE, SHARK_DETECT_BOAT_SPEED, SHIP_DATA } from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";

interface BoatSystemLike {
  getOnboardShipId(playerId: number): number;
}

enum SharkState { Patrol, Investigate, Attack, Flee }

export class SharkAI {
  tick(ent: SimEntity, dt: number, players: SimPlayer[], playerCount: number, entities: SimEntity[], entityCount: number, boatSystem: BoatSystemLike): void {
    let state = ent.data[2] as SharkState;
    let target = ent.data[3]; // target entity/player id
    let stateTimer = ent.data[4];

    stateTimer -= dt;

    // Find nearest detectable player
    // Shark only detects players who are in the water or on a boat moving > SHARK_DETECT_BOAT_SPEED
    let nearestDist = Infinity;
    let nearestIdx = -1;
    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      const player = players[p];
      const inWater = (player.flags & PLR_FLAG.SWIMMING) !== 0;
      const onBoat = (player.flags & PLR_FLAG.ONBOARD) !== 0;
      let detectable = inWater;
      if (!detectable && onBoat) {
        const shipId = boatSystem.getOnboardShipId(player.playerId);
        if (shipId !== 0) {
          for (let e = 0; e < entityCount; e++) {
            const shipEnt = entities[e];
            if (shipEnt && shipEnt.id === shipId) {
              const shipSpeed = Math.abs(shipEnt.data[SHIP_DATA.SPEED] ?? 0);
              if (shipSpeed > SHARK_DETECT_BOAT_SPEED) {
                detectable = true;
              }
              break;
            }
          }
        }
      }
      if (!detectable) continue;
      const dx = player.position.x - ent.position.x;
      const dz = player.position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = p;
      }
    }

    // State machine
    switch (state) {
      case SharkState.Patrol:
        // Random wander
        if (stateTimer <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          ent.data[4] = 5 + Math.random() * 10;
        }
        // If player nearby, investigate
        if (nearestDist < 30 && nearestIdx >= 0) {
          state = SharkState.Investigate;
          ent.data[2] = state;
          ent.data[3] = nearestIdx;
          ent.data[4] = 5;
        }
        break;

      case SharkState.Investigate:
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          const dx = player.position.x - ent.position.x;
          const dz = player.position.z - ent.position.z;
          ent.data[0] = Math.atan2(dz, dx);
          if (nearestDist < 10) {
            state = SharkState.Attack;
            ent.data[2] = state;
            ent.data[4] = 3;
          }
          if (nearestDist > 50 || stateTimer <= 0) {
            state = SharkState.Patrol;
            ent.data[2] = state;
            ent.data[4] = 0;
          }
        }
        break;

      case SharkState.Attack:
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          const dx = player.position.x - ent.position.x;
          const dz = player.position.z - ent.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          ent.data[0] = Math.atan2(dz, dx);
          ent.data[1] = 8; // attack speed

          // Deal damage on contact — only if player is in the water
          if (dist < 3 && (player.flags & PLR_FLAG.SWIMMING) !== 0) {
            player.health -= SHARK_ATTACK_DAMAGE * dt;
          }

          if (stateTimer <= 0 || nearestDist > 60) {
            state = SharkState.Patrol;
            ent.data[2] = state;
            ent.data[4] = 0;
            ent.data[1] = 3;
          }
        }
        break;

      case SharkState.Flee:
        // Flee from player
        if (nearestIdx >= 0) {
          const player = players[nearestIdx];
          const dx = ent.position.x - player.position.x;
          const dz = ent.position.z - player.position.z;
          ent.data[0] = Math.atan2(dz, dx);
        }
        if (stateTimer <= 0) {
          state = SharkState.Patrol;
          ent.data[2] = state;
          ent.data[4] = 0;
        }
        break;
    }

    // Move
    const heading = ent.data[0];
    const speed = ent.data[1] || 3;
    ent.velocity.x = Math.cos(heading) * speed;
    ent.velocity.z = Math.sin(heading) * speed;
    // Keep at depth
    const targetY = -3;
    ent.velocity.y = (targetY - ent.position.y) * 0.5;
  }
}
