// ============================================================================
// Animal System — livestock capture/tame/pen, feed, breed, harvest
// ============================================================================

import { SimEntity } from "../Simulation";
import { EntityType, EntityFlags } from "../../shared/types";

export interface LivestockData {
  species: string;       // "chicken", "cow", "goat", "sheep", etc.
  age: number;           // seconds alive
  growthStage: number;   // 0=baby, 1=juvenile, 2=adult
  hunger: number;        // 0-100, 100 = full
  productTimer: number;  // seconds until next product
  productType: string;   // "egg", "milk", "wool", etc.
  isTamed: boolean;
  isPenned: boolean;
  breedCooldown: number;
}

export class AnimalSystem {
  private livestock = new Map<number, LivestockData>();

  tick(dt: number, entities: SimEntity[], count: number): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.Livestock) continue;

      let data = this.livestock.get(ent.id);
      if (!data) {
        data = {
          species: "chicken",
          age: 0,
          growthStage: 0,
          hunger: 100,
          productTimer: 60,
          productType: "egg",
          isTamed: false,
          isPenned: false,
          breedCooldown: 0,
        };
        this.livestock.set(ent.id, data);
      }

      // Age
      data.age += dt;
      if (data.growthStage < 2 && data.age > (data.growthStage + 1) * 120) {
        data.growthStage++;
      }

      // Hunger decreases
      data.hunger = Math.max(0, data.hunger - 0.5 * dt);

      // Product timer (only adults)
      if (data.growthStage >= 2 && data.hunger > 20) {
        data.productTimer -= dt;
        if (data.productTimer <= 0) {
          data.productTimer = 120; // reset
          // Product ready (stored in entity data for renderer pickup)
          ent.data[0] = 1; // product ready flag
          ent.data[1] = data.productType === "egg" ? 1 : data.productType === "milk" ? 2 : 3;
        }
      }

      // Breeding cooldown
      if (data.breedCooldown > 0) data.breedCooldown -= dt;

      // Health affected by hunger
      if (data.hunger <= 0) {
        ent.health -= 2 * dt;
      } else if (data.hunger > 50 && ent.health < ent.maxHealth) {
        ent.health += 0.5 * dt;
      }
    }
  }

  // Tame a wild animal
  tame(entityId: number): boolean {
    const data = this.livestock.get(entityId);
    if (!data || data.isTamed) return false;
    data.isTamed = true;
    return true;
  }

  // Feed an animal
  feed(entityId: number): boolean {
    const data = this.livestock.get(entityId);
    if (!data) return false;
    data.hunger = Math.min(100, data.hunger + 30);
    return true;
  }

  // Harvest product from animal
  harvest(entityId: number): string | null {
    const data = this.livestock.get(entityId);
    if (!data || data.growthStage < 2) return null;
    if (data.productTimer > 0) return null;
    data.productTimer = 120;
    return data.productType;
  }

  // Breed two animals
  breed(id1: number, id2: number): boolean {
    const d1 = this.livestock.get(id1);
    const d2 = this.livestock.get(id2);
    if (!d1 || !d2) return false;
    if (d1.growthStage < 2 || d2.growthStage < 2) return false;
    if (d1.breedCooldown > 0 || d2.breedCooldown > 0) return false;
    if (d1.hunger < 30 || d2.hunger < 30) return false;
    d1.breedCooldown = 300;
    d2.breedCooldown = 300;
    return true;
  }

  // Create a new livestock entity
  createLivestock(species: string, productType: string): LivestockData {
    return {
      species,
      age: 0,
      growthStage: 0,
      hunger: 100,
      productTimer: 60,
      productType,
      isTamed: true,
      isPenned: false,
      breedCooldown: 0,
    };
  }

  getLivestockData(entityId: number): LivestockData | null {
    return this.livestock.get(entityId) ?? null;
  }
}
