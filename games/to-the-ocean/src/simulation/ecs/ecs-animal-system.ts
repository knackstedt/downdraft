// ============================================================================
// ECS Animal System — first system migrated from array-based to query-based
//
// Demonstrates the migration pattern:
// 1. Queries ECS entities with Transform + EntityMeta + Health + EntityData
// 2. Filters by EntityType.Livestock in the loop body
// 3. Reads/writes through ECS components (not legacy arrays)
// 4. Changes are written back to legacy arrays by SimEcsWorld.writeBackEntities
//
// SoA components (SimEntityMeta, SimHealth) are accessed via [row].
// AoS components (SimEntityData) are accessed as regular objects.
// ============================================================================

import { hmrSwap, Stage, system, type SystemContext } from "@downdraft/core";
import { EntityType } from "@shared/types";
import { SimEntityData, type SimEntityMetaSoA, type SimHealthSoA } from "./components";

interface LivestockData {
  species: string;
  age: number;
  growthStage: number;
  hunger: number;
  productTimer: number;
  productType: string;
  isTamed: boolean;
  isPenned: boolean;
  breedCooldown: number;
}

const livestock = new Map<number, LivestockData>();

export function createEcsAnimalSystem(query: import("@downdraft/core").Query) {
  return system(
    "ecs-animal-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;
      query.iterate(ctx.tick, (_entity, comps, row) => {
        const meta = comps[0] as unknown as SimEntityMetaSoA;
        const health = comps[1] as unknown as SimHealthSoA;
        const data = comps[2] as ReturnType<typeof SimEntityData.create>;

        if (meta.type[row] !== EntityType.Livestock) return;

        const entityId = meta.id[row]!;
        let ls = livestock.get(entityId);
        if (!ls) {
          ls = {
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
          livestock.set(entityId, ls);
        }

        ls.age += dt;
        if (ls.growthStage < 2 && ls.age > (ls.growthStage + 1) * 120) {
          ls.growthStage++;
        }

        ls.hunger = Math.max(0, ls.hunger - 0.5 * dt);

        if (ls.growthStage >= 2 && ls.hunger > 20) {
          ls.productTimer -= dt;
          if (ls.productTimer <= 0) {
            ls.productTimer = 120;
            data.data[0] = 1;
            data.data[1] = ls.productType === "egg" ? 1 : ls.productType === "milk" ? 2 : 3;
          }
        }

        if (ls.breedCooldown > 0) ls.breedCooldown -= dt;

        if (ls.hunger <= 0) {
          health.health[row] -= 2 * dt;
        } else if (ls.hunger > 50 && health.health[row]! < health.maxHealth[row]!) {
          health.health[row] += 0.5 * dt;
        }
      });
    },
    { queries: [query] },
  );
}

export { livestock as ecsLivestockMap };
export type { LivestockData };

if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    if (newMod) hmrSwap("ecs-animal-system", newMod);
  });
}
