import type { AssetManager, AssetPriority } from "../assets/manager.ts";
import type { Entity } from "../ecs/entity.ts";
import type { World } from "../ecs/world.ts";
import { createLogger } from "../util/logger.ts";
import type { Camera } from "./camera.ts";

const log = createLogger();

export interface ChunkCoord {
  x: number;
  z: number;
}

export interface ChunkKey {
  coord: ChunkCoord;
  key: string;
}

export interface ChunkData {
  name?: string;
  coord: ChunkCoord;
  entities: Entity[];
  loaded: boolean;
  loadTime: number;
  lastAccessed: number;
}

export interface StreamConfig {
  chunkSize: number;
  loadRadius: number;
  unloadRadius: number;
  maxConcurrentLoads: number;
  cameraPos?: () => [number, number, number];
  loader?: ChunkLoader;
  unloader?: ChunkUnloader;
  assetManager?: AssetManager;
  assetUriPrefix?: string;
}

export type ChunkLoader = (coord: ChunkCoord) => Promise<Entity[]>;
export type ChunkUnloader = (coord: ChunkCoord, data: ChunkData) => void;

function distanceToPriority(distSq: number, loadRadius: number): AssetPriority {
  const dist = Math.sqrt(distSq);
  const ratio = dist / loadRadius;
  if (ratio < 0.25) return "critical";
  if (ratio < 0.5) return "high";
  if (ratio < 0.75) return "normal";
  return "low";
}

export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x}:${coord.z}`;
}

export function worldToChunk(pos: [number, number, number], chunkSize: number): ChunkCoord {
  return {
    x: Math.floor(pos[0] / chunkSize),
    z: Math.floor(pos[2] / chunkSize),
  };
}

interface ChunkLoadEntry {
  coord: ChunkCoord;
  priority: AssetPriority;
  priorityValue: number;
}

const CHUNK_PRIORITY_VALUES: Record<AssetPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

export class WorldStreamer {
  private config: StreamConfig;
  private chunks: Map<string, ChunkData> = new Map();
  private loadQueue: ChunkLoadEntry[] = [];
  private loading: Set<string> = new Set();
  private world: World;
  private camera: Camera;

  constructor(world: World, camera: Camera, config: StreamConfig) {
    this.world = world;
    this.camera = camera;
    this.config = config;
  }

  async update(): Promise<void> {
    const camPos = this.config.cameraPos ? this.config.cameraPos() : [this.camera.position[0], this.camera.position[1], this.camera.position[2]];
    const camChunk = worldToChunk(camPos, this.config.chunkSize);

    this.checkUnload(camChunk);
    this.checkLoad(camChunk);
    await this.processLoadQueue();
  }

  private checkLoad(camChunk: ChunkCoord): void {
    const radius = this.config.loadRadius;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const coord = { x: camChunk.x + dx, z: camChunk.z + dz };
        const key = chunkKey(coord);
        const chunk = this.chunks.get(key);

        if (chunk && chunk.loaded) {
          chunk.lastAccessed = Date.now();
          continue;
        }

        if (this.loading.has(key)) continue;
        if (this.loadQueue.some((e) => e.coord.x === coord.x && e.coord.z === coord.z)) continue;

        const distSq = dx * dx + dz * dz;
        if (distSq > radius * radius) continue;

        const priority = distanceToPriority(distSq, radius);
        this.loadQueue.push({
          coord,
          priority,
          priorityValue: CHUNK_PRIORITY_VALUES[priority],
        });
      }
    }

    this.loadQueue.sort((a, b) => {
      if (a.priorityValue !== b.priorityValue) return a.priorityValue - b.priorityValue;
      const distA = (a.coord.x - camChunk.x) ** 2 + (a.coord.z - camChunk.z) ** 2;
      const distB = (b.coord.x - camChunk.x) ** 2 + (b.coord.z - camChunk.z) ** 2;
      return distA - distB;
    });
  }

  private checkUnload(camChunk: ChunkCoord): void {
    const unloadRadius = this.config.unloadRadius;
    const toUnload: string[] = [];

    for (const [key, chunk] of this.chunks) {
      if (!chunk.loaded) continue;
      const dx = chunk.coord.x - camChunk.x;
      const dz = chunk.coord.z - camChunk.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > unloadRadius * unloadRadius) {
        toUnload.push(key);
      }
    }

    for (const key of toUnload) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      if (this.config.unloader) {
        this.config.unloader(chunk.coord, chunk);
      } else {
        for (const entity of chunk.entities) {
          this.world._despawnImmediate(entity);
        }
      }
      chunk.loaded = false;
      chunk.entities = [];
      this.chunks.delete(key);
    }
  }

  private async processLoadQueue(): Promise<void> {
    const loader = this.config.loader;
    if (!loader) return;
    while (this.loadQueue.length > 0 && this.loading.size < this.config.maxConcurrentLoads) {
      const entry = this.loadQueue.shift()!;
      const coord = entry.coord;
      const key = chunkKey(coord);
      if (this.loading.has(key)) continue;
      if (this.chunks.has(key) && this.chunks.get(key)!.loaded) continue;

      this.loading.add(key);

      try {
        if (this.config.assetManager && this.config.assetUriPrefix) {
          const assetUri = `${this.config.assetUriPrefix}${key}.chunk`;
          await this.config.assetManager.load(assetUri, entry.priority);
        }

        const entities = await loader(coord);
        const chunk: ChunkData = {
          coord,
          entities,
          loaded: true,
          loadTime: Date.now(),
          lastAccessed: Date.now(),
        };
        this.chunks.set(key, chunk);
      } catch (err) {
        log.error("WorldStreamer", `Failed to load chunk ${key}: ${err}`);
      } finally {
        this.loading.delete(key);
      }
    }
  }

  getLoadedChunks(): ChunkData[] {
    return [...this.chunks.values()].filter((c) => c.loaded);
  }

  getLoadedCount(): number {
    return this.getLoadedChunkCount();
  }

  getLoadedChunkCount(): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.loaded) count++;
    }
    return count;
  }

  getPendingLoadCount(): number {
    return this.loadQueue.length + this.loading.size;
  }

  getLoadQueuePriorities(): { coord: ChunkCoord; priority: AssetPriority }[] {
    return this.loadQueue.map((e) => ({ coord: e.coord, priority: e.priority }));
  }

  isChunkLoaded(coord: ChunkCoord): boolean {
    const chunk = this.chunks.get(chunkKey(coord));
    return chunk?.loaded ?? false;
  }

  getChunk(coord: ChunkCoord): ChunkData | undefined {
    return this.chunks.get(chunkKey(coord));
  }

  forceLoad(coord: ChunkCoord): Promise<void> {
    this.loadQueue.unshift({
      coord,
      priority: "critical",
      priorityValue: 0,
    });
    return this.processLoadQueue();
  }

  forceUnload(coord: ChunkCoord): void {
    const key = chunkKey(coord);
    const chunk = this.chunks.get(key);
    if (!chunk || !chunk.loaded) return;
    if (this.config.unloader) {
      this.config.unloader(chunk.coord, chunk);
    } else {
      for (const entity of chunk.entities) {
        this.world._despawnImmediate(entity);
      }
    }
    chunk.loaded = false;
    chunk.entities = [];
    this.chunks.delete(key);
  }

  unloadAll(): void {
    for (const [key, chunk] of this.chunks) {
      if (chunk.loaded) {
        if (this.config.unloader) {
          this.config.unloader(chunk.coord, chunk);
        } else {
          for (const entity of chunk.entities) {
            this.world._despawnImmediate(entity);
          }
        }
      }
    }
    this.chunks.clear();
    this.loadQueue = [];
    this.loading.clear();
  }

  getStats(): { loaded: number; pending: number; loading: number } {
    return {
      loaded: this.getLoadedChunkCount(),
      pending: this.loadQueue.length,
      loading: this.loading.size,
    };
  }
}
