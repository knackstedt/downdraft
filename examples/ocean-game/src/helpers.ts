// ─── Helper Functions ──────────────────────────────────────

import type { World } from "@downdraft/core";
import {
    addItem,
    countItem,
    removeItemById,
    type InventoryGrid
} from "../plugins/inventory-plugin.ts";
import { Island, addXP, islandQuery } from "./components.ts";
import { BiomeType } from "./constants.ts";
import { gameState } from "./state.ts";
import { voxelFieldHeightAt, type VoxelField } from "./terrain.ts";

// ─── Inventory helpers (delegate to grid-based InventoryPlugin) ──

export function invAdd(grid: InventoryGrid, item: string, count: number): boolean {
  const remaining = addItem(grid, item, count);
  return remaining === 0;
}

export function invRemove(grid: InventoryGrid, item: string, count: number): boolean {
  return removeItemById(grid, item, count);
}

export function invCount(grid: InventoryGrid, item: string): number {
  return countItem(grid, item);
}

// ─── Island helpers ───────────────────────────────────────

export function islandHeightAt(
  island: { x: number; z: number; radius: number; height: number; voxelField?: VoxelField | null },
  px: number, pz: number,
): number {
  if (island.voxelField) {
    const localX = px - island.x;
    const localZ = pz - island.z;
    const h = voxelFieldHeightAt(island.voxelField, localX, localZ);
    if (h >= 0) return h;
    return -1;
  }
  const dx = px - island.x;
  const dz = pz - island.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > island.radius) return -1;
  const t = dist / island.radius;
  const h = island.height * Math.max(0, 1 - t * t);
  return Math.max(0, h);
}

export function isOnIsland(px: number, pz: number): { onLand: boolean; groundY: number; islandBiome: number } {
  let bestY = -1;
  let bestBiome = BiomeType.Tropical;
  islandQuery.iterate(gameState.frameCount, (_e, [island]) => {
    const isl = island as typeof Island.defaults;
    const h = islandHeightAt(isl, px, pz);
    if (h > bestY) {
      bestY = h;
      bestBiome = isl.biome;
    }
  });
  if (bestY < 0) return { onLand: false, groundY: -1, islandBiome: BiomeType.Tropical };
  return { onLand: true, groundY: bestY, islandBiome: bestBiome };
}

// ─── Spawn helper ─────────────────────────────────────────

export function spawnEntity(world: World, components: Map<number, unknown>) {
  return world.spawn(components);
}

// Re-export addXP for convenience
export { addXP };
