// ============================================================================
// Structure Integrity — hull integrity, leak detection, stability/ballast
// ============================================================================

import { SimEntity } from "../simulation";
import { EntityType, EntityFlags } from "../../shared/types";
import { SHIP_LEAK_THRESHOLD } from "../../shared/constants";
import type { BoatCellSystem } from "../boat/boat-cell-system";

export class StructureIntegrity {
  tick(dt: number, entities: SimEntity[], count: number, boatCellSystem?: BoatCellSystem): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent) continue;

      if (ent.type !== EntityType.Ship) continue;

      // Check hull integrity
      const integrityRatio = ent.health / ent.maxHealth;

      // Leaking if below threshold
      if (integrityRatio < SHIP_LEAK_THRESHOLD / 100) {
        ent.flags |= EntityFlags.Underwater; // mark as taking water

        // Progressive damage from leaking
        ent.health -= 0.5 * dt;

        // If health is very low, ship sinks
        if (ent.health <= 0) {
          ent.health = 0;
          ent.flags |= EntityFlags.Dead;
        }
      } else {
        ent.flags &= ~EntityFlags.Underwater;
      }

      // Stability check — use actual center-of-mass offset from bounding box center
      // A large offset means weight is distributed unevenly, causing listing
      const stabilityFactor = this.calculateStability(ent, boatCellSystem);
      if (stabilityFactor < 0.3) {
        ent.health -= 0.1 * dt; // slow damage from instability
      }
    }
  }

  private calculateStability(ent: SimEntity, boatCellSystem?: BoatCellSystem): number {
    if (boatCellSystem) {
      const massProps = boatCellSystem.getMassProperties(ent.id);
      if (massProps.mass > 0) {
        // Stability = how close center of mass is to the geometric center of the bounding box
        const offsetX = Math.abs(massProps.centerX - massProps.bboxCenterX);
        const offsetZ = Math.abs(massProps.centerZ - massProps.bboxCenterZ);
        const maxOffset = Math.max(massProps.halfWidth, massProps.halfLength);
        if (maxOffset < 0.001) return 1;
        const offsetRatio = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / maxOffset;
        // 0 offset = perfectly stable (1.0), max offset at edge = unstable (0.0)
        return Math.max(0, 1 - offsetRatio * 2);
      }
      return 1; // no cells = stable (empty ship)
    }
    // Fallback if no boat cell system
    return Math.min(1, ent.scale / 10);
  }

  // Calculate max module count for a hull of given size
  static calculateMaxModules(scale: number): number {
    return Math.floor(scale * scale * 0.5);
  }

  // Calculate hull volume
  static calculateVolume(scale: number): number {
    return scale * scale * scale * 3; // simplified
  }
}
