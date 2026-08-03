// Passive AI — whales, dolphins, turtles, crustaceans, coral, moose
import { SimEntity, SimPlayer } from "../simulation";
import { EntityType } from "../../shared/types";

export class PassiveAI {
  tick(ent: SimEntity, dt: number, players: SimPlayer[], playerCount: number): void {
    const heading = ent.data[0];
    const speed = ent.data[1] || 1;

    switch (ent.type) {
      case EntityType.Whale: {
        // Slow patrol with dramatic breaching — whale flies up and out of the water
        // data[5] = breach state: 0=swim, 1=launch, 2=airborne, 3=dive
        // data[6] = breach countdown timer (seconds until next breach)
        const breachState = ent.data[5];

        // Horizontal movement in all states
        if (ent.data[4] <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          ent.data[4] = 10 + Math.random() * 20;
        }
        ent.data[4] -= dt;
        ent.velocity.x = Math.cos(ent.data[0]) * speed;
        ent.velocity.z = Math.sin(ent.data[0]) * speed;

        switch (breachState) {
          case 0: // Swimming — gentle underwater patrol, counting down to breach
            if (ent.data[6] <= 0) {
              ent.data[6] = 10 + Math.random() * 30;
            }
            ent.velocity.y = Math.sin(performance.now() / 3000 + ent.position.x * 0.01) * 0.5;
            ent.data[6] -= dt;
            if (ent.data[6] <= 0) {
              ent.data[5] = 1;
            }
            break;
          case 1: // Launch — explosive upward thrust to breach the surface
            ent.velocity.y = 18;
            ent.data[5] = 2;
            break;
          case 2: // Airborne — let BuoyancySystem gravity create the ballistic arc
            // Only transition to dive once the whale has peaked and fallen back below y=0
            if (ent.position.y <= 0 && ent.velocity.y < 0) {
              ent.data[5] = 3;
              ent.velocity.y = -3;
            }
            break;
          case 3: // Diving — descend to depth after splashdown
            ent.velocity.y = -4;
            if (ent.position.y < -6) {
              ent.data[5] = 0;
              ent.data[6] = 15 + Math.random() * 30;
            }
            break;
        }
        break;
      }

      case EntityType.Dolphin:
        // Playful, bow-ride near ships/players
        if (playerCount > 0) {
          const player = players[0];
          const dx = player.position.x - ent.position.x;
          const dz = player.position.z - ent.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < 30) {
            // Bow-ride: swim alongside
            ent.data[0] = Math.atan2(dz, dx) + Math.PI / 2;
            ent.data[1] = 4;
          } else {
            if (ent.data[4] <= 0) {
              ent.data[0] = Math.random() * Math.PI * 2;
              ent.data[4] = 5;
            }
            ent.data[4] -= dt;
            ent.data[1] = 2;
          }
        }
        ent.velocity.x = Math.cos(ent.data[0]) * ent.data[1];
        ent.velocity.z = Math.sin(ent.data[0]) * ent.data[1];
        // Porpoising
        ent.velocity.y = Math.sin(performance.now() / 1000) * 1.5;
        break;

      case EntityType.Turtle:
        // Slow swimming
        if (ent.data[4] <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          ent.data[4] = 15 + Math.random() * 20;
        }
        ent.data[4] -= dt;
        ent.velocity.x = Math.cos(heading) * speed * 0.3;
        ent.velocity.z = Math.sin(heading) * speed * 0.3;
        ent.velocity.y = Math.sin(performance.now() / 2000) * 0.2;
        break;

      case EntityType.Crustacean:
        // Bottom-walking
        if (ent.data[4] <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          ent.data[4] = 3 + Math.random() * 5;
        }
        ent.data[4] -= dt;
        ent.velocity.x = Math.cos(heading) * speed * 0.5;
        ent.velocity.z = Math.sin(heading) * speed * 0.5;
        ent.velocity.y = 0;
        break;

      case EntityType.Coral:
        // Static, no movement
        ent.velocity.x = 0;
        ent.velocity.y = 0;
        ent.velocity.z = 0;
        break;

      case EntityType.Moose:
        // Gag animal — walks on seabed, eats thrown items
        ent.velocity.x = Math.cos(heading) * speed * 0.2;
        ent.velocity.z = Math.sin(heading) * speed * 0.2;
        ent.velocity.y = (-30 - ent.position.y) * 0.3; // stay on seabed
        if (ent.data[4] <= 0) {
          ent.data[0] = Math.random() * Math.PI * 2;
          ent.data[4] = 20 + Math.random() * 30;
        }
        ent.data[4] -= dt;
        break;
    }
  }
}
