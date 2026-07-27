// ============================================================================
// Docking System — approach, align, lock mechanic for small craft
// ============================================================================

import { SimEntity } from "../Simulation";
import { EntityType, EntityFlags, SmallCraftType } from "../../shared/types";

enum DockState { Approach, Align, Locking, Docked, Released }

interface DockSlot {
  index: number;
  occupied: boolean;
  craftId: number;
  state: DockState;
  alignProgress: number;
}

export class DockingSystem {
  private shipDocks = new Map<number, DockSlot[]>(); // shipEntityId -> dock slots

  // Add a dock to a ship
  addDock(shipEntityId: number): boolean {
    if (!this.shipDocks.has(shipEntityId)) {
      this.shipDocks.set(shipEntityId, []);
    }
    const docks = this.shipDocks.get(shipEntityId)!;
    docks.push({
      index: docks.length,
      occupied: false,
      craftId: 0,
      state: DockState.Approach,
      alignProgress: 0,
    });
    return true;
  }

  getDockCount(shipEntityId: number): number {
    return this.shipDocks.get(shipEntityId)?.length ?? 0;
  }

  tick(dt: number, entities: SimEntity[], count: number): void {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.SmallCraft) continue;

      // Check if near a ship with docks
      for (let j = 0; j < count; j++) {
        const ship = entities[j];
        if (!ship || ship.type !== EntityType.Ship) continue;

        const docks = this.shipDocks.get(ship.id);
        if (!docks || docks.length === 0) continue;

        const dx = ent.position.x - ship.position.x;
        const dz = ent.position.z - ship.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        for (const dock of docks) {
          if (dock.occupied && dock.craftId !== ent.id) continue;

          if (dist < 15) {
            // Approach phase
            if (dock.state === DockState.Approach && !dock.occupied) {
              dock.state = DockState.Align;
              dock.alignProgress = 0;
              dock.craftId = ent.id;
            }

            // Align phase
            if (dock.state === DockState.Align) {
              // Check alignment (simplified: just requires proximity + slow speed)
              const speed = Math.sqrt(ent.velocity.x ** 2 + ent.velocity.z ** 2);
              if (speed < 2) {
                dock.alignProgress += dt * 0.5; // 2 seconds to align
                if (dock.alignProgress >= 1) {
                  dock.state = DockState.Locking;
                }
              } else {
                dock.alignProgress = Math.max(0, dock.alignProgress - dt * 0.5);
              }
            }

            // Locking phase
            if (dock.state === DockState.Locking) {
              dock.state = DockState.Docked;
              dock.occupied = true;
              ent.flags |= EntityFlags.Docked;
              // Snap craft to dock position
              ent.position.x = ship.position.x;
              ent.position.z = ship.position.z;
              ent.velocity.x = 0;
              ent.velocity.z = 0;
            }
          } else if (dock.craftId === ent.id && dock.state !== DockState.Docked) {
            // Reset if moved away
            dock.state = DockState.Approach;
            dock.alignProgress = 0;
            dock.craftId = 0;
          }
        }
      }
    }
  }

  // Release a docked craft
  release(shipEntityId: number, dockIndex: number, entities: SimEntity[], count: number): boolean {
    const docks = this.shipDocks.get(shipEntityId);
    if (!docks || dockIndex < 0 || dockIndex >= docks.length) return false;
    const dock = docks[dockIndex];
    if (!dock.occupied) return false;

    // Find craft entity and unflag
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.id !== dock.craftId) continue;
      ent.flags &= ~EntityFlags.Docked;
      break;
    }

    dock.occupied = false;
    dock.craftId = 0;
    dock.state = DockState.Approach;
    dock.alignProgress = 0;
    return true;
  }

  // Get all docked craft for a ship
  getDockedCraft(shipEntityId: number): number[] {
    const docks = this.shipDocks.get(shipEntityId);
    if (!docks) return [];
    return docks.filter(d => d.occupied).map(d => d.craftId);
  }

  // Refuel/recharge docked craft
  refuelDocked(shipEntityId: number, entities: SimEntity[], count: number, dt: number): void {
    const docks = this.shipDocks.get(shipEntityId);
    if (!docks) return;
    for (const dock of docks) {
      if (!dock.occupied) continue;
      for (let i = 0; i < count; i++) {
        const ent = entities[i];
        if (!ent || ent.id !== dock.craftId) continue;
        // Refuel: data[0] = fuel, data[1] = maxFuel
        if (ent.data[1] > 0) {
          ent.data[0] = Math.min(ent.data[1], ent.data[0] + 5 * dt);
        }
        // Repair
        ent.health = Math.min(ent.maxHealth, ent.health + 2 * dt);
        break;
      }
    }
  }

  // Store craft at a port (when mothership is docked)
  storeCraftAtPort(craftEntityId: number, portId: string): { stored: boolean; shippingCost: number } {
    // In full implementation, would remove entity and store at port
    // Shipping cost to move to another port
    const shippingCost = 50; // base cost
    return { stored: true, shippingCost };
  }
}
