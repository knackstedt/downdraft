// ============================================================================
// ECS Docking System — migrated from array-based DockingSystem
//
// Query: ships (Transform + Velocity + EntityMeta + EntityData) for ship positions
// Query: smallCraft (Transform + Velocity + EntityMeta + EntityData) for craft
// Dock state remains in the shipDocks Map (external state, not per-entity)
//
// SoA components (SimTransform, SimVelocity, SimEntityMeta) via [row].
// AoS component (SimEntityData) as regular object.
// ============================================================================

import { hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { EntityFlags, EntityType } from "@shared/types";
import { SimEntityData, type SimEntityMetaSoA, type SimTransformSoA, type SimVelocitySoA } from "./components";

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
      shipsQuery.iterate(ctx.tick, (_entity, comps, row) => {
        const transform = comps[0] as unknown as SimTransformSoA;
        const meta = comps[2] as unknown as SimEntityMetaSoA;
        if (meta.type[row] !== EntityType.Ship) return;
        const docks = shipDocks.get(meta.id[row]!);
        if (!docks || docks.length === 0) return;
        shipList.push({ id: meta.id[row]!, x: transform.x[row]!, z: transform.z[row]!, });
      });

      if (shipList.length === 0) return;

      // Iterate small craft
      smallCraftQuery.iterate(ctx.tick, (_entity, comps, row) => {
        const transform = comps[0] as unknown as SimTransformSoA;
        const vel = comps[1] as unknown as SimVelocitySoA;
        const meta = comps[2] as unknown as SimEntityMetaSoA;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;

        if (meta.type[row] !== EntityType.SmallCraft) return;

        const craftId = meta.id[row]!;
        const craftX = transform.x[row]!;
        const craftZ = transform.z[row]!;

        for (const ship of shipList) {
          const docks = shipDocks.get(ship.id);
          if (!docks) continue;

          const dx = craftX - ship.x;
          const dz = craftZ - ship.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          for (const dock of docks) {
            if (dock.occupied && dock.craftId !== craftId) continue;

            if (dist < 15) {
              if (dock.state === DockState.Approach && !dock.occupied) {
                dock.state = DockState.Align;
                dock.alignProgress = 0;
                dock.craftId = craftId;
              }

              if (dock.state === DockState.Align) {
                const speed = Math.sqrt(vel.vx[row]! ** 2 + vel.vz[row]! ** 2);
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
                meta.flags[row] |= EntityFlags.Docked;
                transform.x[row] = ship.x;
                transform.z[row] = ship.z;
                vel.vx[row] = 0;
                vel.vz[row] = 0;
              }
            } else if (dock.craftId === craftId && dock.state !== DockState.Docked) {
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

if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    if (newMod) hmrSwap("ecs-docking-system", newMod);
  });
}
