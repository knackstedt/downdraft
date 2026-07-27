// ============================================================================
// Chunk Manager — floating origin, chunked relative coordinates
// ============================================================================

import { WorldGenerator } from "../../shared/world/WorldGenerator";
import { ChunkInfo, PortDef, IslandDef, CHUNK_SIZE } from "./shared-constants";
import { CHUNKS_VISIBLE } from "../../shared/constants";

interface LoadedChunk {
  info: ChunkInfo;
  port: PortDef | null;
  island: IslandDef | null;
}

export class ChunkManager {
  private worldGen: WorldGenerator;
  private loadedChunks = new Map<string, LoadedChunk>();
  private centerX = NaN;
  private centerZ = NaN;

  constructor(worldGen: WorldGenerator) {
    this.worldGen = worldGen;
  }

  updateChunks(worldX: number, worldZ: number): void {
    const newCenterX = Math.floor(worldX / CHUNK_SIZE);
    const newCenterZ = Math.floor(worldZ / CHUNK_SIZE);

    if (newCenterX === this.centerX && newCenterZ === this.centerZ) return;

    this.centerX = newCenterX;
    this.centerZ = newCenterZ;

    // Load chunks in radius
    const radius = CHUNKS_VISIBLE;
    const needed = new Set<string>();

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = this.centerX + dx;
        const cz = this.centerZ + dz;
        const key = `${cx},${cz}`;
        needed.add(key);

        if (!this.loadedChunks.has(key)) {
          const info = this.worldGen.getChunkInfo(cx, cz);
          const chunk: LoadedChunk = {
            info,
            port: info.hasPort ? this.worldGen.generatePort(cx, cz, info.biome, info.securityLevel) : null,
            island: info.hasIsland ? this.worldGen.generateIsland(cx, cz, info.biome, info.securityLevel) : null,
          };
          this.loadedChunks.set(key, chunk);
        }
      }
    }

    // Unload chunks no longer needed
    for (const [key, _] of this.loadedChunks) {
      if (!needed.has(key)) {
        this.loadedChunks.delete(key);
      }
    }
  }

  getChunkInfo(chunkX: number, chunkZ: number): ChunkInfo | null {
    return this.loadedChunks.get(`${chunkX},${chunkZ}`)?.info ?? null;
  }

  getBiomeAt(worldX: number, worldZ: number): number {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return this.loadedChunks.get(`${cx},${cz}`)?.info.biome ?? 7; // default Ocean
  }

  getSecurityLevelAt(worldX: number, worldZ: number): number {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return this.loadedChunks.get(`${cx},${cz}`)?.info.securityLevel ?? 0;
  }

  getWaterDepthAt(worldX: number, worldZ: number): number {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return this.loadedChunks.get(`${cx},${cz}`)?.info.waterDepth ?? 50;
  }

  getNearbyPorts(worldX: number, worldZ: number, radius: number): PortDef[] {
    const ports: PortDef[] = [];
    const chunkRadius = Math.ceil(radius / CHUNK_SIZE);

    for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
      for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
        const cx = this.centerX + dx;
        const cz = this.centerZ + dz;
        const chunk = this.loadedChunks.get(`${cx},${cz}`);
        if (chunk?.port) {
          const distSq = Math.pow(chunk.port.position.x - worldX, 2) + Math.pow(chunk.port.position.z - worldZ, 2);
          if (distSq < radius * radius) {
            ports.push(chunk.port);
          }
        }
      }
    }
    return ports;
  }

  getNearbyIslands(worldX: number, worldZ: number, radius: number): IslandDef[] {
    const islands: IslandDef[] = [];
    const chunkRadius = Math.ceil(radius / CHUNK_SIZE);

    for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
      for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
        const cx = this.centerX + dx;
        const cz = this.centerZ + dz;
        const chunk = this.loadedChunks.get(`${cx},${cz}`);
        if (chunk?.island) {
          const distSq = Math.pow(chunk.island.position.x - worldX, 2) + Math.pow(chunk.island.position.z - worldZ, 2);
          if (distSq < radius * radius) {
            islands.push(chunk.island);
          }
        }
      }
    }
    return islands;
  }

  getLoadedChunkCount(): number {
    return this.loadedChunks.size;
  }

  reloadChunk(chunkX: number, chunkZ: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (!this.loadedChunks.has(key)) return;
    const info = this.worldGen.getChunkInfo(chunkX, chunkZ);
    const chunk: LoadedChunk = {
      info,
      port: info.hasPort ? this.worldGen.generatePort(chunkX, chunkZ, info.biome, info.securityLevel) : null,
      island: info.hasIsland ? this.worldGen.generateIsland(chunkX, chunkZ, info.biome, info.securityLevel) : null,
    };
    this.loadedChunks.set(key, chunk);
  }

  reloadAll(): void {
    this.loadedChunks.forEach((_, key) => {
      const parts = key.split(",");
      this.reloadChunk(parseInt(parts[0], 10), parseInt(parts[1], 10));
    });
  }
}
