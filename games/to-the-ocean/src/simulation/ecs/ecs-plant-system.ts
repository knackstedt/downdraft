// ============================================================================
// ECS Plant System — migrated from array-based PlantSystem
//
// Query: entities with EntityMeta + EntityData
// Filters by EntityType.Plant in loop body
//
// SoA component (SimEntityMeta) via [row].
// AoS component (SimEntityData) as regular object.
// ============================================================================

import { hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { EntityType } from "@shared/types";
import { SimEntityData, type SimEntityMetaSoA } from "./components";

interface PlantData {
  species: string;
  growthStage: number;
  growthTimer: number;
  waterLevel: number;
  isHydroponic: boolean;
  yield: number;
}

const STAGE_DURATIONS = [30, 60, 120, 300];

const plants = new Map<number, PlantData>();

export function createEcsPlantSystem(query: Query) {
  return system(
    "ecs-plant-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;
      query.iterate(ctx.tick, (_entity, comps, row) => {
        const meta = comps[0] as unknown as SimEntityMetaSoA;
        const data = comps[1] as ReturnType<typeof SimEntityData.create>;

        if (meta.type[row] !== EntityType.Plant) return;

        const entityId = meta.id[row]!;
        let pd = plants.get(entityId);
        if (!pd) {
          pd = {
            species: "kelp",
            growthStage: 0,
            growthTimer: 0,
            waterLevel: 100,
            isHydroponic: false,
            yield: 1,
          };
          plants.set(entityId, pd);
        }

        pd.waterLevel = Math.max(0, pd.waterLevel - 0.3 * dt);

        if (pd.waterLevel > 10 && pd.growthStage < 4) {
          pd.growthTimer += dt;
          const duration = STAGE_DURATIONS[pd.growthStage] ?? 300;
          if (pd.growthTimer >= duration) {
            pd.growthStage++;
            pd.growthTimer = 0;
          }
        }

        data.data[0] = pd.growthStage;
        data.data[1] = pd.waterLevel;
        data.data[2] = pd.growthTimer / (STAGE_DURATIONS[pd.growthStage] ?? 300);
      });
    },
    { queries: [query] },
  );
}

export { plants as ecsPlantsMap };
export type { PlantData };

if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    if (newMod) hmrSwap("ecs-plant-system", newMod);
  });
}
