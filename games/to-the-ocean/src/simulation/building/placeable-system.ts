// ============================================================================
// Placeable System — beds, storage, workbenches, rain collectors, etc.
// ============================================================================

import { SimEntity } from "../simulation";
import { EntityType, EntityFlags, StorageType } from "../../shared/types";

export interface PlaceableDef {
  id: string;
  name: string;
  category: "bed" | "storage" | "workbench" | "decor" | "utility" | "rain_collector" | "pet_bed" | "planter";
  width: number;
  height: number;
  depth: number;
  storageType?: StorageType;
  storageCapacity?: number;
  preservationRate?: number; // for food storage (1 = normal, 0.5 = fridge, 0.1 = freezer)
  isBed?: boolean;
  isRainCollector?: boolean;
  isPlanter?: boolean;
  isHydroponic?: boolean;
}

export class PlaceableSystem {
  private placeables = new Map<string, PlaceableDef>();
  private instances = new Map<number, { defId: string; parentId: number; inventory: any[] }>();

  constructor() {
    this.registerDefaultPlaceables();
  }

  private registerDefaultPlaceables(): void {
    this.register({
      id: "bed_basic",
      name: "Basic Bed",
      category: "bed",
      width: 1, height: 1, depth: 2,
      isBed: true,
    });
    this.register({
      id: "bed_bunk",
      name: "Bunk Bed",
      category: "bed",
      width: 1, height: 2, depth: 2,
      isBed: true,
    });
    this.register({
      id: "storage_locker",
      name: "Storage Locker",
      category: "storage",
      width: 1, height: 2, depth: 1,
      storageType: StorageType.Generic,
      storageCapacity: 30,
      preservationRate: 1,
    });
    this.register({
      id: "storage_fridge",
      name: "Refrigerator",
      category: "storage",
      width: 1, height: 2, depth: 1,
      storageType: StorageType.Generic,
      storageCapacity: 20,
      preservationRate: 0.5,
    });
    this.register({
      id: "storage_freezer",
      name: "Freezer",
      category: "storage",
      width: 1, height: 2, depth: 1,
      storageType: StorageType.Generic,
      storageCapacity: 15,
      preservationRate: 0.1,
    });
    this.register({
      id: "fish_tank",
      name: "Fish Tank",
      category: "storage",
      width: 2, height: 2, depth: 1,
      storageType: StorageType.FishTank,
      storageCapacity: 20,
      preservationRate: 0.3,
    });
    this.register({
      id: "weapon_locker",
      name: "Weapon Locker",
      category: "storage",
      width: 1, height: 2, depth: 1,
      storageType: StorageType.WeaponLocker,
      storageCapacity: 10,
      preservationRate: 1,
    });
    this.register({
      id: "cargo_hold",
      name: "Cargo Hold",
      category: "storage",
      width: 2, height: 2, depth: 2,
      storageType: StorageType.CargoHold,
      storageCapacity: 50,
      preservationRate: 1,
    });
    this.register({
      id: "workbench_basic",
      name: "Basic Workbench",
      category: "workbench",
      width: 2, height: 1, depth: 1,
    });
    this.register({
      id: "workbench_advanced",
      name: "Advanced Workbench",
      category: "workbench",
      width: 2, height: 1, depth: 1,
    });
    this.register({
      id: "rain_collector",
      name: "Rain Collector",
      category: "rain_collector",
      width: 1, height: 1, depth: 1,
      isRainCollector: true,
    });
    this.register({
      id: "planter_soil",
      name: "Soil Planter",
      category: "planter",
      width: 1, height: 1, depth: 1,
      isPlanter: true,
      isHydroponic: false,
    });
    this.register({
      id: "planter_hydroponic",
      name: "Hydroponic Planter",
      category: "planter",
      width: 1, height: 1, depth: 1,
      isPlanter: true,
      isHydroponic: true,
    });
    this.register({
      id: "pet_bed",
      name: "Pet Bed",
      category: "pet_bed",
      width: 1, height: 1, depth: 1,
    });
  }

  register(def: PlaceableDef): void {
    this.placeables.set(def.id, def);
  }

  getDef(id: string): PlaceableDef | null {
    return this.placeables.get(id) ?? null;
  }

  // Place a placeable on a ship or island
  place(defId: string, parentId: number): number {
    const def = this.placeables.get(defId);
    if (!def) return 0;
    // In full implementation, would create entity and register
    const instanceId = Math.floor(Math.random() * 1000000);
    this.instances.set(instanceId, {
      defId,
      parentId,
      inventory: [],
    });
    return instanceId;
  }

  remove(instanceId: number): boolean {
    return this.instances.delete(instanceId);
  }

  getInventory(instanceId: number): any[] {
    return this.instances.get(instanceId)?.inventory ?? [];
  }

  addToInventory(instanceId: number, item: any): boolean {
    const inst = this.instances.get(instanceId);
    if (!inst) return false;
    const def = this.placeables.get(inst.defId);
    if (!def || !def.storageCapacity) return false;
    if (inst.inventory.length >= def.storageCapacity) return false;
    inst.inventory.push(item);
    return true;
  }

  // Process spoilage for storage containers
  tickSpoilage(dt: number): void {
    for (const [id, inst] of this.instances) {
      const def = this.placeables.get(inst.defId);
      if (!def?.preservationRate) continue;
      for (const item of inst.inventory) {
        if (item.spoilProgress !== undefined) {
          item.spoilProgress += dt * 0.001 * def.preservationRate;
          if (item.spoilProgress >= 1) {
            // Item is spoiled
            item.spoiled = true;
          }
        }
      }
    }
  }
}
