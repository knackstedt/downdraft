// ============================================================================
// Island Manager — spawns/despawns island entities based on chunk loading
// ============================================================================

import { ChunkManager } from "./ChunkManager";
import { EntityType, EntityFlags, EntityId } from "../../shared/types";

export class IslandManager {
  private chunkManager: ChunkManager;
  private spawnedIslands = new Map<string, EntityId>();
  private spawnRadius: number;

  constructor(chunkManager: ChunkManager, spawnRadius: number = 3000) {
    this.chunkManager = chunkManager;
    this.spawnRadius = spawnRadius;
  }

  tick(
    spawnEntity: (type: EntityType, opts: {
      position: { x: number; y: number; z: number };
      scale?: number;
      flags?: number;
      health?: number;
      maxHealth?: number;
      data?: Float32Array;
    }) => EntityId,
    removeEntity: (id: EntityId) => void,
    playerX: number,
    playerZ: number,
  ): void {
    const nearby = this.chunkManager.getNearbyIslands(playerX, playerZ, this.spawnRadius);
    const nearbyIds = new Set<string>();

    for (let i = 0; i < nearby.length; i++) {
      const island = nearby[i];
      nearbyIds.add(island.id);

      if (!this.spawnedIslands.has(island.id)) {
        const entityId = spawnEntity(EntityType.Island, {
          position: { x: island.position.x, y: 0, z: island.position.z },
          scale: island.radius,
          flags: EntityFlags.Static,
          health: 999999,
          maxHealth: 999999,
          data: new Float32Array([
            island.radius,        // ISLAND_DATA.RADIUS
            island.biome,         // ISLAND_DATA.BIOME
            island.size,          // ISLAND_DATA.SIZE
            island.hasCoves ? 1 : 0,  // ISLAND_DATA.HAS_COVES
            island.hasCaves ? 1 : 0,  // ISLAND_DATA.HAS_CAVES
            island.resourceNodes.length, // ISLAND_DATA.RESOURCE_COUNT
          ]),
        });
        this.spawnedIslands.set(island.id, entityId);
      }
    }

    // Despawn islands no longer nearby
    for (const [islandId, entityId] of this.spawnedIslands) {
      if (!nearbyIds.has(islandId)) {
        removeEntity(entityId);
        this.spawnedIslands.delete(islandId);
      }
    }
  }

  reset(): void {
    this.spawnedIslands.clear();
  }

  getSpawnedCount(): number {
    return this.spawnedIslands.size;
  }
}
