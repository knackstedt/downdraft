// ============================================================================
// ECS Structure Integrity System — migrated from array-based StructureIntegrity
//
// Query: shipsWithHealth (Transform + EntityMeta + EntityData + Health)
// Filters by EntityType.Ship in loop body
// BoatCellSystem passed via closure for stability calculation
//
// SoA components (SimEntityMeta, SimHealth) via [row].
// ============================================================================

import { hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { EntityFlags, EntityType } from "@shared/types";
import { SHIP_LEAK_THRESHOLD } from "../../shared/constants";
import type { BoatCellSystem } from "../boat/boat-cell-system";
import { type SimEntityMetaSoA, type SimHealthSoA } from "./components";

export function createEcsStructureIntegritySystem(
  shipsQuery: Query,
  getBoatCellSystem: () => BoatCellSystem | undefined,
) {
  return system(
    "ecs-structure-integrity-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;
      const boatCellSystem = getBoatCellSystem();

      shipsQuery.iterate(ctx.tick, (_entity, comps, row) => {
        const meta = comps[1] as unknown as SimEntityMetaSoA;
        const health = comps[3] as unknown as SimHealthSoA;

        if (meta.type[row] !== EntityType.Ship) return;

        const integrityRatio = health.health[row]! / health.maxHealth[row]!;

        if (integrityRatio < SHIP_LEAK_THRESHOLD / 100) {
          meta.flags[row] |= EntityFlags.Underwater;
          health.health[row] -= 0.5 * dt;

          if (health.health[row]! <= 0) {
            health.health[row] = 0;
            meta.flags[row] |= EntityFlags.Dead;
          }
        } else {
          meta.flags[row] &= ~EntityFlags.Underwater;
        }

        // Stability check
        const stabilityFactor = calculateStability(meta.id[row]!, boatCellSystem);
        if (stabilityFactor < 0.3) {
          health.health[row] -= 0.1 * dt;
        }
      });
    },
    { queries: [shipsQuery] },
  );
}

function calculateStability(entityId: number, boatCellSystem?: BoatCellSystem): number {
  if (boatCellSystem) {
    const massProps = boatCellSystem.getMassProperties(entityId);
    if (massProps.mass > 0) {
      const offsetX = Math.abs(massProps.centerX - massProps.bboxCenterX);
      const offsetZ = Math.abs(massProps.centerZ - massProps.bboxCenterZ);
      const maxOffset = Math.max(massProps.halfWidth, massProps.halfLength);
      if (maxOffset < 0.001) return 1;
      const offsetRatio = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / maxOffset;
      return Math.max(0, 1 - offsetRatio * 2);
    }
    return 1;
  }
  return 1;
}

if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    if (newMod) hmrSwap("ecs-structure-integrity-system", newMod);
  });
}
