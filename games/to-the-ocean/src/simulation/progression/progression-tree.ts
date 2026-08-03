// ============================================================================
// Progression Tree — capability-based unlocks (not XP)
// ============================================================================

import { SimPlayer } from "../simulation";
import { HullTier, EquipmentTier } from "../../shared/types";

export class ProgressionTree {
  private hullTiers: HullTier[] = [
    {
      tier: 0,
      name: "Raft",
      maxSize: { x: 5, y: 1, z: 5 },
      maxModules: 4,
      depthRating: 0,
      cargoCapacity: 20,
      storageCapacity: 10,
      requiredMaterials: [],
    },
    {
      tier: 1,
      name: "Dinghy",
      maxSize: { x: 8, y: 2, z: 5 },
      maxModules: 8,
      depthRating: 5,
      cargoCapacity: 50,
      storageCapacity: 25,
      requiredMaterials: [{ itemId: "wood", quantity: 20 }, { itemId: "rope", quantity: 10 }],
    },
    {
      tier: 2,
      name: "Sloop",
      maxSize: { x: 12, y: 3, z: 6 },
      maxModules: 16,
      depthRating: 20,
      cargoCapacity: 100,
      storageCapacity: 50,
      requiredMaterials: [{ itemId: "wood", quantity: 50 }, { itemId: "metal_scrap", quantity: 20 }, { itemId: "cloth", quantity: 15 }],
    },
    {
      tier: 3,
      name: "Cutter",
      maxSize: { x: 16, y: 4, z: 8 },
      maxModules: 32,
      depthRating: 50,
      cargoCapacity: 200,
      storageCapacity: 100,
      requiredMaterials: [{ itemId: "wood", quantity: 100 }, { itemId: "metal_scrap", quantity: 50 }, { itemId: "engine_part", quantity: 5 }],
    },
    {
      tier: 4,
      name: "Schooner",
      maxSize: { x: 24, y: 5, z: 10 },
      maxModules: 64,
      depthRating: 100,
      cargoCapacity: 500,
      storageCapacity: 200,
      requiredMaterials: [{ itemId: "steel_plate", quantity: 100 }, { itemId: "engine_part", quantity: 20 }, { itemId: "circuit_board", quantity: 10 }],
    },
    {
      tier: 5,
      name: "Barge",
      maxSize: { x: 40, y: 6, z: 15 },
      maxModules: 128,
      depthRating: 200,
      cargoCapacity: 2000,
      storageCapacity: 500,
      requiredMaterials: [{ itemId: "steel_plate", quantity: 500 }, { itemId: "engine_part", quantity: 50 }, { itemId: "advanced_circuit", quantity: 20 }],
    },
  ];

  private equipmentTiers: EquipmentTier[] = [
    {
      tier: 0,
      name: "Basic Rod",
      catchPoolRarity: 1,
      effectiveness: 1,
      requiredMaterials: [],
    },
    {
      tier: 1,
      name: "Reinforced Rod",
      catchPoolRarity: 2,
      effectiveness: 1.5,
      requiredMaterials: [{ itemId: "wood", quantity: 5 }, { itemId: "rope", quantity: 3 }],
    },
    {
      tier: 2,
      name: "Professional Rod",
      catchPoolRarity: 3,
      effectiveness: 2,
      requiredMaterials: [{ itemId: "metal_scrap", quantity: 10 }, { itemId: "fishing_line", quantity: 5 }],
    },
    {
      tier: 3,
      name: "Master Rod",
      catchPoolRarity: 4,
      effectiveness: 3,
      requiredMaterials: [{ itemId: "steel_plate", quantity: 5 }, { itemId: "rare_reel", quantity: 1 }],
    },
    {
      tier: 4,
      name: "Legendary Rod",
      catchPoolRarity: 5,
      effectiveness: 5,
      requiredMaterials: [{ itemId: "abyssal_pearl", quantity: 1 }, { itemId: "legendary_reel", quantity: 1 }],
    },
  ];

  // Dock tiers
  private dockTiers = [
    { tier: 0, name: "No Dock", maxCraftSize: 0, requiredMaterials: [] },
    { tier: 1, name: "Small Dock", maxCraftSize: 1, requiredMaterials: [{ itemId: "wood", quantity: 10 }] },
    { tier: 2, name: "Medium Dock", maxCraftSize: 2, requiredMaterials: [{ itemId: "wood", quantity: 20 }, { itemId: "metal_scrap", quantity: 10 }] },
    { tier: 3, name: "Large Dock", maxCraftSize: 3, requiredMaterials: [{ itemId: "steel_plate", quantity: 20 }, { itemId: "engine_part", quantity: 5 }] },
  ];

  // Crafting tiers
  private craftingTiers = [
    { tier: 0, name: "Basic", recipes: ["wood_plank", "rope", "basic_rod", "raw_fish"] },
    { tier: 1, name: "Intermediate", recipes: ["storage_locker", "reinforced_rod", "cooked_fish", "bed_basic"] },
    { tier: 2, name: "Advanced", recipes: ["workbench_advanced", "professional_rod", "fridge", "rain_collector"] },
    { tier: 3, name: "Expert", recipes: ["freezer", "master_rod", "hydroponic_planter", "engine_part"] },
    { tier: 4, name: "Master", recipes: ["legendary_rod", "advanced_circuit", "steel_plate"] },
  ];

  private playerProgression = new Map<number, {
    hullTier: number;
    equipmentTier: number;
    dockTier: number;
    craftingTier: number;
    unlockedRecipes: Set<string>;
  }>();

  tick(dt: number, players: SimPlayer[], playerCount: number): void {
    // Progression is event-driven, not tick-based
    // This just ensures all active players have progression data
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (!this.playerProgression.has(p.playerId)) {
        this.playerProgression.set(p.playerId, {
          hullTier: 0,
          equipmentTier: 0,
          dockTier: 0,
          craftingTier: 0,
          unlockedRecipes: new Set(this.craftingTiers[0].recipes),
        });
      }
    }
  }

  getHullTier(tier: number): HullTier | null {
    return this.hullTiers[tier] ?? null;
  }

  getEquipmentTier(tier: number): EquipmentTier | null {
    return this.equipmentTiers[tier] ?? null;
  }

  getDockTier(tier: number): { tier: number; name: string; maxCraftSize: number } | null {
    return this.dockTiers[tier] ?? null;
  }

  getPlayerProgression(playerId: number) {
    return this.playerProgression.get(playerId) ?? null;
  }

  // Check if player can upgrade hull
  canUpgradeHull(playerId: number, materials: Map<string, number>): boolean {
    const prog = this.playerProgression.get(playerId);
    if (!prog) return false;
    const nextTier = this.hullTiers[prog.hullTier + 1];
    if (!nextTier) return false; // max tier
    // Check materials
    for (const req of nextTier.requiredMaterials) {
      if ((materials.get(req.itemId) ?? 0) < req.quantity) return false;
    }
    return true;
  }

  // Upgrade hull tier
  upgradeHull(playerId: number): boolean {
    const prog = this.playerProgression.get(playerId);
    if (!prog) return false;
    if (prog.hullTier >= this.hullTiers.length - 1) return false;
    prog.hullTier++;
    return true;
  }

  // Unlock a recipe
  unlockRecipe(playerId: number, recipe: string): boolean {
    const prog = this.playerProgression.get(playerId);
    if (!prog) return false;
    if (prog.unlockedRecipes.has(recipe)) return false;
    prog.unlockedRecipes.add(recipe);
    return true;
  }

  // Check if recipe is unlocked
  hasRecipe(playerId: number, recipe: string): boolean {
    return this.playerProgression.get(playerId)?.unlockedRecipes.has(recipe) ?? false;
  }
}
