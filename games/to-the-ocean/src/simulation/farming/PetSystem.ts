// ============================================================================
// Pet System — 6 pet types with distinct behaviors
// ============================================================================

import { SimEntity, SimPlayer } from "../Simulation";
import { EntityType, PetType } from "../../shared/types";

export interface PetData {
  type: PetType;
  ownerId: number;        // player ID
  happiness: number;       // 0-100
  hunger: number;          // 0-100
  cooldown: number;        // action cooldown
  mischiefLevel: number;   // for crow, raccoon
  scoutTarget: { x: number; z: number } | null; // for crow
  stolenItem: string | null; // for raccoon
}

export class PetSystem {
  private pets = new Map<number, PetData>();

  tick(dt: number, entities: SimEntity[], count: number, players: SimPlayer[], playerCount: number): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.Pet) continue;

      let data = this.pets.get(ent.id);
      if (!data) continue;

      data.cooldown -= dt;
      data.hunger = Math.max(0, data.hunger - 0.3 * dt);

      // Find owner
      let owner: SimPlayer | null = null;
      for (let p = 0; p < playerCount; p++) {
        if (players[p]?.playerId === data.ownerId) {
          owner = players[p];
          break;
        }
      }

      switch (data.type) {
        case PetType.Cat:
          this.tickCat(ent, data, dt, owner);
          break;
        case PetType.Dog:
          this.tickDog(ent, data, dt, owner);
          break;
        case PetType.Parrot:
          this.tickParrot(ent, data, dt, owner);
          break;
        case PetType.Crow:
          this.tickCrow(ent, data, dt, owner);
          break;
        case PetType.Raccoon:
          this.tickRaccoon(ent, data, dt, owner);
          break;
        case PetType.Shark:
          this.tickShark(ent, data, dt, players, playerCount, entities, count);
          break;
      }
    }
  }

  private tickCat(ent: SimEntity, data: PetData, dt: number, owner: SimPlayer | null): void {
    // Cat: meow, play with yarn, sleep on laps
    if (!owner) return;
    const dx = owner.position.x - ent.position.x;
    const dz = owner.position.z - ent.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > 3) {
      // Follow owner
      ent.data[0] = Math.atan2(dz, dx);
      ent.velocity.x = Math.cos(ent.data[0]) * 2;
      ent.velocity.z = Math.sin(ent.data[0]) * 2;
    } else {
      // Sit near owner (sleep on lap)
      ent.velocity.x *= 0.8;
      ent.velocity.z *= 0.8;
      data.happiness = Math.min(100, data.happiness + 0.5 * dt);
    }

    // Occasional meow (cooldown)
    if (data.cooldown <= 0 && Math.random() < 0.01) {
      data.cooldown = 10;
      ent.data[2] = 1; // meow flag for renderer
    }
  }

  private tickDog(ent: SimEntity, data: PetData, dt: number, owner: SimPlayer | null): void {
    // Dog: bark, generally be annoying
    if (!owner) return;
    const dx = owner.position.x - ent.position.x;
    const dz = owner.position.z - ent.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Dog follows more energetically, runs around
    if (dist > 2) {
      ent.data[0] = Math.atan2(dz, dx);
      ent.velocity.x = Math.cos(ent.data[0]) * 4;
      ent.velocity.z = Math.sin(ent.data[0]) * 4;
    } else {
      // Run in circles around owner (annoying)
      const angle = performance.now() / 500;
      ent.velocity.x = Math.cos(angle) * 3;
      ent.velocity.z = Math.sin(angle) * 3;
    }

    // Bark frequently
    if (data.cooldown <= 0 && Math.random() < 0.05) {
      data.cooldown = 3;
      ent.data[2] = 1; // bark flag
    }
  }

  private tickParrot(ent: SimEntity, data: PetData, dt: number, owner: SimPlayer | null): void {
    // Parrot: mimic sounds, squawk, give items
    if (!owner) return;
    const dx = owner.position.x - ent.position.x;
    const dz = owner.position.z - ent.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Fly to owner's shoulder area
    const targetY = owner.position.y + 2;
    if (dist > 5) {
      ent.data[0] = Math.atan2(dz, dx);
      ent.velocity.x = Math.cos(ent.data[0]) * 3;
      ent.velocity.z = Math.sin(ent.data[0]) * 3;
      ent.velocity.y = (targetY - ent.position.y) * 0.5;
    } else {
      ent.velocity.x *= 0.7;
      ent.velocity.z *= 0.7;
      ent.velocity.y = (targetY - ent.position.y) * 0.3;
    }

    // Squawk and mimic
    if (data.cooldown <= 0 && Math.random() < 0.02) {
      data.cooldown = 8;
      ent.data[2] = 1; // squawk flag
    }

    // Occasionally give items (rare)
    if (data.cooldown <= 0 && Math.random() < 0.001) {
      data.cooldown = 300;
      ent.data[3] = 1; // gift item flag
    }
  }

  private tickCrow(ent: SimEntity, data: PetData, dt: number, owner: SimPlayer | null): void {
    // Crow: fly around and scout, cause minor mischief
    if (data.cooldown <= 0) {
      // Pick a new scout target
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 50;
      data.scoutTarget = {
        x: (owner?.position.x ?? 0) + Math.cos(angle) * dist,
        z: (owner?.position.z ?? 0) + Math.sin(angle) * dist,
      };
      data.cooldown = 15;
    }

    if (data.scoutTarget) {
      const dx = data.scoutTarget.x - ent.position.x;
      const dz = data.scoutTarget.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 2) {
        ent.data[0] = Math.atan2(dz, dx);
        ent.velocity.x = Math.cos(ent.data[0]) * 6;
        ent.velocity.z = Math.sin(ent.data[0]) * 6;
        ent.velocity.y = 3; // fly high
      } else {
        data.scoutTarget = null;
      }
    }

    // Minor mischief: occasionally knock items over
    if (Math.random() < 0.005) {
      data.mischiefLevel++;
      ent.data[2] = 1; // mischief flag
    }
  }

  private tickRaccoon(ent: SimEntity, data: PetData, dt: number, owner: SimPlayer | null): void {
    // Raccoon: steal items, cause mischief
    if (!owner) return;
    const dx = owner.position.x - ent.position.x;
    const dz = owner.position.z - ent.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Follow owner but wander off to steal
    if (data.stolenItem) {
      // Return to owner with stolen item
      if (dist > 2) {
        ent.data[0] = Math.atan2(dz, dx);
        ent.velocity.x = Math.cos(ent.data[0]) * 3;
        ent.velocity.z = Math.sin(ent.data[0]) * 3;
      } else {
        // Give stolen item to owner
        ent.data[3] = 1; // deliver item flag
        data.stolenItem = null;
      }
    } else {
      // Wander and look for items to steal
      if (data.cooldown <= 0) {
        if (Math.random() < 0.3 && dist < 50) {
          // Go steal something
          data.stolenItem = "random_junk";
          ent.data[2] = 1; // steal flag
        } else {
          // Random wander
          ent.data[0] = Math.random() * Math.PI * 2;
          data.cooldown = 5 + Math.random() * 10;
        }
      }
      data.cooldown -= dt;
      ent.velocity.x = Math.cos(ent.data[0]) * 2;
      ent.velocity.z = Math.sin(ent.data[0]) * 2;
    }

    // Mischief
    if (Math.random() < 0.01) {
      data.mischiefLevel++;
    }
  }

  private tickShark(
    ent: SimEntity,
    data: PetData,
    dt: number,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    // Shark: swim around and attack any nearby player, animal, NPC or craft
    // Find nearest target (not owner)
    let nearestDist = Infinity;
    let nearestX = 0, nearestZ = 0;
    let foundTarget = false;

    for (let p = 0; p < playerCount; p++) {
      if (!players[p]?.active) continue;
      if (players[p].playerId === data.ownerId) continue; // don't attack owner
      const dx = players[p].position.x - ent.position.x;
      const dz = players[p].position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestX = players[p].position.x;
        nearestZ = players[p].position.z;
        foundTarget = true;
      }
    }

    // Also target nearby wildlife and small craft
    for (let i = 0; i < entityCount; i++) {
      const e = entities[i];
      if (!e || e === ent) continue;
      if (e.type !== EntityType.Fish && e.type !== EntityType.SmallCraft && e.type !== EntityType.Livestock) continue;
      const dx = e.position.x - ent.position.x;
      const dz = e.position.z - ent.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestX = e.position.x;
        nearestZ = e.position.z;
        foundTarget = true;
        // Damage on contact
        if (dist < 3) {
          e.health -= 20 * dt;
        }
      }
    }

    if (foundTarget && nearestDist < 40) {
      ent.data[0] = Math.atan2(nearestZ - ent.position.z, nearestX - ent.position.x);
      ent.velocity.x = Math.cos(ent.data[0]) * 5;
      ent.velocity.z = Math.sin(ent.data[0]) * 5;
    } else {
      // Patrol
      if (data.cooldown <= 0) {
        ent.data[0] = Math.random() * Math.PI * 2;
        data.cooldown = 5;
      }
      data.cooldown -= dt;
      ent.velocity.x = Math.cos(ent.data[0]) * 2;
      ent.velocity.z = Math.sin(ent.data[0]) * 2;
    }
    // Stay underwater
    ent.velocity.y = (-3 - ent.position.y) * 0.5;
  }

  registerPet(entityId: number, type: PetType, ownerId: number): void {
    this.pets.set(entityId, {
      type,
      ownerId,
      happiness: 80,
      hunger: 80,
      cooldown: 0,
      mischiefLevel: 0,
      scoutTarget: null,
      stolenItem: null,
    });
  }

  unregisterPet(entityId: number): void {
    this.pets.delete(entityId);
  }

  getPetData(entityId: number): PetData | null {
    return this.pets.get(entityId) ?? null;
  }
}
