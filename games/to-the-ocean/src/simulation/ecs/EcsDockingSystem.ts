// ============================================================================
// ECS Docking System — migrated from array-based DockingSystem
//
// Query: ships (Transform + EntityMeta + EntityData) for ship positions
// Query: smallCraft (Transform + Velocity + EntityMeta + EntityData) for craft
// Dock state remains in the shipDocks Map (external state, not per-entity)
// ============================================================================

import { Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { SimEntityData, SimEntityMeta, SimTransform, SimVelocity } from "./components.ts";
import { EntityType, EntityFlags } from "@shared/types";

enum DockState { Approach, Align, Locking, Docked, Released }

interface DockSlot {
  index: number;
  occupied: boolean;
  craftId: number;
  state: DockState;
  alignProgress: number;
}

const shipDocks = new Map<number, DockSlot[]>();

export function addDock(shipEntityId: number): boolean {
  if (!shipDocks.has(shipEntityId)) {
    shipDocks.set(shipEntityId, []);
  }
  const docks = shipDocks.get(shipEntityId)!;
  docks.push({
    index: docks.length,
    occupied: false,
    craftId: 0,
    state: DockState.Approach,
    alignProgress: 0,
  });
  return true;
}

export function getDockCount(shipEntityId: number): number {
  return shipDocks.get(shipEntityId)?.length ?? 0;
}

export function getDockedCraft(shipEntityId: number): number[] {
  const docks = shipDocks.get(shipEntityId);
  if (!docks) return [];
  return docks.filter(d => d.occupied).map(d => d.craftId);
}

export function createEcsDockingSystem(shipsQuery: Query, smallCraftQuery: Query) {
  return system(
    "ecs-docking-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      // Collect ship positions
      const shipList: { id: number; x: number; z: number }[] = [];
      shipsQuery.iterate(ctx.tick, (_entity, comps) => {
        const meta = comps[1] as ReturnType<typeof SimEntityMeta.create>;
        const transform = comps[0] as ReturnType<typeof SimTransform.create>;
        if (meta.type !== EntityType.Ship) return;
        const docks = shipDocks.get(meta.id);
        if (!docks || docks.length === 0) return;
        shipList.push({ id: meta.id, x: transform.x, z: transform.z, });
      });

      if (shipList.length === 0) return;

      // Iterate small craft
      smallCraftQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as ReturnType<typeof SimTransform.create>;
        const vel = comps[1] as ReturnType<typeof SimVelocity.create>;
        const meta = comps[2] as ReturnType<typeof SimEntityMeta.create>;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;

        if (meta.type !== EntityType.SmallCraft) return;

        for (const ship of shipList) {
          const docks = shipDocks.get(ship.id);
          if (!docks) continue;

          const dx = transform.x - ship.x;
          const dz = transform.z - ship.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          for (const dock of docks) {
            if (dock.occupied && dock.craftId !== meta.id) continue;

            if (dist < 15) {
              if (dock.state === DockState.Approach && !dock.occupied) {
                dock.state = DockState.Align;
                dock.alignProgress = 0;
                dock.craftId = meta.id;
              }

              if (dock.state === DockState.Align) {
                const speed = Math.sqrt(vel.vx ** 2 + vel.vz ** 2);
                if (speed < 2) {
                  dock.alignProgress += dt * 0.5;
                  if (dock.alignProgress >= 1) {
                    dock.state = DockState.Locking;
                  }
                } else {
                  dock.alignProgress = Math.max(0, dock.alignProgress - dt * 0.5);
                }
              }

              if (dock.state === DockState.Locking) {
                dock.state = DockState.Docked;
                dock.occupied = true;
                meta.flags |= EntityFlags.Docked;
                transform.x = ship.x;
                transform.z = ship.z;
                vel.vx = 0;
                vel.vz = 0;
              }
            } else if (dock.craftId === meta.id && dock.state !== DockState.Docked) {
              dock.state = DockState.Approach;
              dock.alignProgress = 0;
              dock.craftId = 0;
            }
          }
        }
      });
    },
    { queries: [shipsQuery, smallCraftQuery] },
  );
}

export { shipDocks as ecsShipDocks };
export type { DockSlot };
