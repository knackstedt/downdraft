// ============================================================================
// Island Manager — spawns/despawns island entities based on chunk loading
// ============================================================================
// In addition to island entities, this manager spawns wild forageable plants
// (berry bushes and mushrooms) on newly discovered islands, chosen from the
// crops whose preferredBiomes include the island's biome. Wild plants are
// marked isWild so they regrow/respawn and are not player-owned.

import { getCropsByBiome, type CropId } from "../../shared/data/crops";
import { BiomeType, EntityFlags, EntityId, EntityType } from "../../shared/types";
import { PLANT_DATA_SLOTS } from "../farming/plant-system";
import { ChunkManager } from "./chunk-manager";

/** Minimal interface the island manager needs to register a wild plant. */
export interface WildPlantSpawner {
  spawnEntity: (type: EntityType, opts: {
    position: { x: number; y: number; z: number };
    scale?: number;
    flags?: number;
    health?: number;
    maxHealth?: number;
    data?: Float32Array;
  }) => EntityId;
  /** Register a spawned plant entity with the PlantSystem. */
  registerPlant: (entityId: number, cropId: CropId, biome: BiomeType, isWild: boolean, initialStage?: number) => void;
}

export class IslandManager {
  private chunkManager: ChunkManager;
  private spawnedIslands = new Map<string, EntityId>();
  /** Tracks wild plant entity ids per island id for cleanup. */
  private wildPlants = new Map<string, EntityId[]>();
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
    wildSpawner?: WildPlantSpawner,
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
            island.hasCaves ? 1 : 0,  // ISLAND_DATA.HAS_COVES
            island.resourceNodes.length, // ISLAND_DATA.RESOURCE_COUNT
          ]),
        });
        this.spawnedIslands.set(island.id, entityId);

        // Spawn wild forageable plants (bushes + mushrooms) for this biome.
        if (wildSpawner) {
          this.spawnWildPlants(island, wildSpawner);
        }
      }
    }

    // Despawn islands no longer nearby
    for (const [islandId, entityId] of this.spawnedIslands) {
      if (!nearbyIds.has(islandId)) {
        removeEntity(entityId);
        this.spawnedIslands.delete(islandId);
        // Also remove wild plants that belonged to this island.
        const plants = this.wildPlants.get(islandId);
        if (plants) {
          for (const pid of plants) removeEntity(pid);
          this.wildPlants.delete(islandId);
        }
      }
    }
  }

  /** Spawn a small number of wild bushes/mushrooms around an island. */
  private spawnWildPlants(island: { id: string; position: { x: number; z: number }; radius: number; biome: BiomeType }, spawner: WildPlantSpawner): void {
    const candidates = getCropsByBiome(island.biome).filter((c) => c.isBush || c.isMushroom);
    if (candidates.length === 0) return;
    // Deterministic-ish count based on island radius; cap to keep entity budget sane.
    const count = Math.min(8, Math.max(2, Math.floor(island.radius / 40)));
    const spawned: EntityId[] = [];
    for (let i = 0; i < count; i++) {
      const crop = candidates[Math.floor(Math.random() * candidates.length)];
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * island.radius * 0.8;
      const wx = island.position.x + Math.cos(angle) * dist;
      const wz = island.position.z + Math.sin(angle) * dist;
      const wy = 0; // plants sit on the ground/island surface
      const pid = spawner.spawnEntity(EntityType.Plant, {
        position: { x: wx, y: wy, z: wz },
        flags: EntityFlags.Static,
        data: new Float32Array(PLANT_DATA_SLOTS),
      });
      if (pid) {
        // Wild plants start mature so they're immediately forageable.
        spawner.registerPlant(pid, crop.id, island.biome, true, 3);
        spawned.push(pid);
      }
    }
    if (spawned.length) this.wildPlants.set(island.id, spawned);
  }

  reset(): void {
    this.spawnedIslands.clear();
    this.wildPlants.clear();
  }

  getSpawnedCount(): number {
    return this.spawnedIslands.size;
  }
}
