// Eel AI — electric shock on proximity, territorial behavior
import { SimEntity, SimPlayer } from "../Simulation";
import { EEL_SHOCK_DAMAGE } from "../../shared/constants";

export class EelAI {
  tick(ent: SimEntity, dt: number, players: SimPlayer[], playerCount: number): void {
    // data[0] = heading, data[1] = speed, data[2] = shock cooldown
    const heading = ent.data[0];
    const speed = ent.data[1] || 1;
    let shockCooldown = ent.data[2];
    shockCooldown -= dt;

    // Territorial — stay near spawn point (stored in data[3], data[4] as x, z offset)
    const homeX = ent.position.x + Math.cos(ent.data[5] || 0) * 20;
    const homeZ = ent.position.z + Math.sin(ent.data[5] || 0) * 20;

    // Wander slowly
    if (ent.data[4] <= 0) {
      ent.data[0] = Math.random() * Math.PI * 2;
      ent.data[4] = 3 + Math.random() * 5;
    }
    ent.data[4] -= dt;

    // Check for nearby players to shock
    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      const dx = players[p].position.x - ent.position.x;
      const dy = players[p].position.y - ent.position.y;
      const dz = players[p].position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 5 && shockCooldown <= 0) {
        // Electric shock
        players[p].health -= EEL_SHOCK_DAMAGE;
        shockCooldown = 3; // cooldown
        // Visual: set flag for bioluminescent flash
      }
    }

    ent.data[2] = shockCooldown;

    // Move
    ent.velocity.x = Math.cos(heading) * speed;
    ent.velocity.z = Math.sin(heading) * speed;
    ent.velocity.y = Math.sin(performance.now() / 500) * 0.3;
  }
}
