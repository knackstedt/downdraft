import type { MCMesh, MCChunkConfig, DensityField } from "./generator.ts";
import { generateChunk } from "./generator.ts";

export interface LODLevel {
  chunkSize: number;
  scale: number;
  distance: number;
}

export const DEFAULT_LOD_LEVELS: LODLevel[] = [
  { chunkSize: 32, scale: 1.0, distance: 0 },
  { chunkSize: 32, scale: 2.0, distance: 64 },
  { chunkSize: 16, scale: 4.0, distance: 128 },
  { chunkSize: 16, scale: 8.0, distance: 256 },
];

export interface ChunkLODEntry {
  coord: { x: number; z: number };
  lod: number;
  mesh: MCMesh | null;
  dirty: boolean;
}

export class TerrainLODManager {
  private field: DensityField;
  private levels: LODLevel[];
  private chunks: Map<string, ChunkLODEntry> = new Map();
  private cameraPos: [number, number, number] = [0, 0, 0];
  private originY: number;

  constructor(field: DensityField, levels?: LODLevel[], originY: number = 0) {
    this.field = field;
    this.levels = levels ?? DEFAULT_LOD_LEVELS;
    this.originY = originY;
  }

  setCamera(pos: [number, number, number]): void {
    this.cameraPos = pos;
  }

  selectLOD(chunkX: number, chunkZ: number): number {
    const cx = chunkX * this.levels[0].chunkSize * this.levels[0].scale;
    const cz = chunkZ * this.levels[0].chunkSize * this.levels[0].scale;
    const dx = cx - this.cameraPos[0];
    const dz = cz - this.cameraPos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (dist >= this.levels[i].distance) return i;
    }
    return 0;
  }

  getOrCreateChunk(chunkX: number, chunkZ: number): ChunkLODEntry {
    const key = `${chunkX}:${chunkZ}`;
    let entry = this.chunks.get(key);
    if (!entry) {
      const lod = this.selectLOD(chunkX, chunkZ);
      entry = { coord: { x: chunkX, z: chunkZ }, lod, mesh: null, dirty: true };
      this.chunks.set(key, entry);
    }
    return entry;
  }

  generateChunk(chunkX: number, chunkZ: number): MCMesh {
    const entry = this.getOrCreateChunk(chunkX, chunkZ);
    const level = this.levels[entry.lod];
    const config: MCChunkConfig = {
      chunkSize: level.chunkSize,
      isoLevel: 0.5,
      scale: level.scale,
    };
    const originX = chunkX * level.chunkSize * level.scale;
    const originZ = chunkZ * level.chunkSize * level.scale;
    const mesh = generateChunk(originX, this.originY, originZ, this.field, config);
    entry.mesh = mesh;
    entry.dirty = false;
    return mesh;
  }

  updateLOD(): { toGenerate: Array<{ x: number; z: number; lod: number }>; toUnload: string[] } {
    const toGenerate: Array<{ x: number; z: number; lod: number }> = [];
    const toUnload: string[] = [];

    for (const [key, entry] of this.chunks) {
      const newLOD = this.selectLOD(entry.coord.x, entry.coord.z);
      if (newLOD !== entry.lod) {
        entry.lod = newLOD;
        entry.dirty = true;
        toGenerate.push({ x: entry.coord.x, z: entry.coord.z, lod: newLOD });
      }
    }

    return { toGenerate, toUnload };
  }

  getChunk(key: string): ChunkLODEntry | undefined {
    return this.chunks.get(key);
  }

  getAllChunks(): ChunkLODEntry[] {
    return [...this.chunks.values()];
  }

  removeChunk(chunkX: number, chunkZ: number): void {
    this.chunks.delete(`${chunkX}:${chunkZ}`);
  }

  clear(): void {
    this.chunks.clear();
  }

  getStats(): { total: number; dirty: number; generated: number } {
    let dirty = 0;
    let generated = 0;
    for (const entry of this.chunks.values()) {
      if (entry.dirty) dirty++;
      if (entry.mesh) generated++;
    }
    return { total: this.chunks.size, dirty, generated };
  }
}
