// ============================================================================
// Plant System — crop growth, hydroponics, seed → sprout → mature → harvest
// ============================================================================

import { SimEntity } from "../Simulation";
import { EntityType } from "../../shared/types";

export interface PlantData {
  species: string;       // "tomato", "kelp", "rice", etc.
  growthStage: number;  // 0=seed, 1=sprout, 2=growing, 3=mature, 4=overripe
  growthTimer: number;  // seconds in current stage
  waterLevel: number;   // 0-100
  isHydroponic: boolean;
  yield: number;        // amount to harvest
}

const STAGE_DURATIONS = [30, 60, 120, 300]; // seconds per stage

export class PlantSystem {
  private plants = new Map<number, PlantData>();

  tick(dt: number, entities: SimEntity[], count: number): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.Plant) continue;

      let data = this.plants.get(ent.id);
      if (!data) {
        data = {
          species: "kelp",
          growthStage: 0,
          growthTimer: 0,
          waterLevel: 100,
          isHydroponic: false,
          yield: 1,
        };
        this.plants.set(ent.id, data);
      }

      // Water decreases
      data.waterLevel = Math.max(0, data.waterLevel - 0.3 * dt);

      // Growth requires water
      if (data.waterLevel > 10 && data.growthStage < 4) {
        data.growthTimer += dt;
        const duration = STAGE_DURATIONS[data.growthStage] ?? 300;
        if (data.growthTimer >= duration) {
          data.growthStage++;
          data.growthTimer = 0;
        }
      }

      // Store growth info in entity data for renderer
      ent.data[0] = data.growthStage;
      ent.data[1] = data.waterLevel;
      ent.data[2] = data.growthTimer / (STAGE_DURATIONS[data.growthStage] ?? 300);
    }
  }

  // Plant a seed
  plant(entityId: number, species: string, isHydroponic: boolean): void {
    this.plants.set(entityId, {
      species,
      growthStage: 0,
      growthTimer: 0,
      waterLevel: 100,
      isHydroponic,
      yield: 1,
    });
  }

  // Water a plant
  water(entityId: number): boolean {
    const data = this.plants.get(entityId);
    if (!data) return false;
    data.waterLevel = 100;
    return true;
  }

  // Harvest a mature plant
  harvest(entityId: number): { species: string; yield: number } | null {
    const data = this.plants.get(entityId);
    if (!data || data.growthStage < 3) return null;
    const result = { species: data.species, yield: data.yield };
    // Reset to seed
    data.growthStage = 0;
    data.growthTimer = 0;
    data.waterLevel = 100;
    return result;
  }

  getPlantData(entityId: number): PlantData | null {
    return this.plants.get(entityId) ?? null;
  }
}
