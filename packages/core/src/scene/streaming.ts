import type { Entity } from "../ecs/entity.ts";
import type { World } from "../ecs/world.ts";
import type { Camera } from "./camera.ts";

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
}

export type ChunkLoader = (coord: ChunkCoord) => Promise<Entity[]>;
export type ChunkUnloader = (coord: ChunkCoord, data: ChunkData) => void;

export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x}:${coord.z}`;
}

export function worldToChunk(pos: [number, number, number], chunkSize: number): ChunkCoord {
  return {
    x: Math.floor(pos[0] / chunkSize),
    z: Math.floor(pos[2] / chunkSize),
  };
}

export class WorldStreamer {
  private config: StreamConfig;
  private chunks: Map<string, ChunkData> = new Map();
  private loadQueue: ChunkCoord[] = [];
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
        if (this.loadQueue.some((c) => c.x === coord.x && c.z === coord.z)) continue;

        const distSq = dx * dx + dz * dz;
        if (distSq > radius * radius) continue;

        this.loadQueue.push(coord);
      }
    }

    this.loadQueue.sort((a, b) => {
      const distA = (a.x - camChunk.x) ** 2 + (a.z - camChunk.z) ** 2;
      const distB = (b.x - camChunk.x) ** 2 + (b.z - camChunk.z) ** 2;
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
      const coord = this.loadQueue.shift()!;
      const key = chunkKey(coord);
      if (this.loading.has(key)) continue;
      if (this.chunks.has(key) && this.chunks.get(key)!.loaded) continue;

      this.loading.add(key);

      try {
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
        console.error(`[WorldStreamer] Failed to load chunk ${key}:`, err);
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

  isChunkLoaded(coord: ChunkCoord): boolean {
    const chunk = this.chunks.get(chunkKey(coord));
    return chunk?.loaded ?? false;
  }

  getChunk(coord: ChunkCoord): ChunkData | undefined {
    return this.chunks.get(chunkKey(coord));
  }

  forceLoad(coord: ChunkCoord): Promise<void> {
    this.loadQueue.unshift(coord);
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
