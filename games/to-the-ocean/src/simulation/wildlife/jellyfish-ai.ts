// Jellyfish AI — swarm drift, bioluminescent at night, DoT contact damage
import { SimEntity, SimPlayer } from "../simulation";
import { JELLYFISH_DOT_DAMAGE } from "../../shared/constants";
import { EntityFlags } from "../../shared/types";

export class JellyfishAI {
  tick(ent: SimEntity, dt: number, players: SimPlayer[], playerCount: number): void {
    // data[0] = drift angle, data[1] = pulse phase
    const pulsePhase = ent.data[1] || 0;
    ent.data[1] = pulsePhase + dt * 0.5;

    // Slow drift with current
    const driftAngle = ent.data[0];
    const currentSpeed = 0.3;
    ent.velocity.x = Math.cos(driftAngle) * currentSpeed;
    ent.velocity.z = Math.sin(driftAngle) * currentSpeed;

    // Vertical bobbing (pulse)
    ent.velocity.y = Math.sin(pulsePhase * 2) * 0.5;

    // Bioluminescent glow (set flag)
    ent.flags |= EntityFlags.Bioluminescent;

    // Contact damage to nearby players
    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      const dx = players[p].position.x - ent.position.x;
      const dy = players[p].position.y - ent.position.y;
      const dz = players[p].position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 2) {
        players[p].health -= JELLYFISH_DOT_DAMAGE * dt;
      }
    }

    // Occasionally change drift direction
    if (Math.random() < 0.001) {
      ent.data[0] = Math.random() * Math.PI * 2;
    }
  }
}
