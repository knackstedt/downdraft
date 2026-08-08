import type { Entity } from "../ecs/entity";

export interface SpatialEntry {
  entity: Entity;
  position: [number, number, number];
  radius: number;
  layer: number;
}

export interface GridCell {
  x: number;
  z: number;
  entries: SpatialEntry[];
}

export interface SpatialQueryResult {
  entries: SpatialEntry[];
  cellX: number;
  cellZ: number;
}

export class SpatialGrid {
  private cellSize: number;
  private cells: Map<string, GridCell> = new Map();
  private entryCount = 0;

  constructor(cellSize: number = 16) {
    this.cellSize = cellSize;
  }

  get cellSizeValue(): number {
    return this.cellSize;
  }

  private cellKey(x: number, z: number): string {
    return `${x}:${z}`;
  }

  private worldToCell(pos: [number, number, number]): [number, number] {
    return [
      Math.floor(pos[0] / this.cellSize),
      Math.floor(pos[2] / this.cellSize),
    ];
  }

  insert(entry: SpatialEntry): void {
    const [cx, cz] = this.worldToCell(entry.position);
    const key = this.cellKey(cx, cz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { x: cx, z: cz, entries: [] };
      this.cells.set(key, cell);
    }
    cell.entries.push(entry);
    this.entryCount++;
  }

  remove(entity: Entity, oldPos: [number, number, number]): void {
    const [cx, cz] = this.worldToCell(oldPos);
    const key = this.cellKey(cx, cz);
    const cell = this.cells.get(key);
    if (!cell) return;
    const idx = cell.entries.findIndex(
      (e) => e.entity.index === entity.index && e.entity.generation === entity.generation,
    );
    if (idx >= 0) {
      const last = cell.entries.length - 1;
      cell.entries[idx] = cell.entries[last];
      cell.entries.pop();
      this.entryCount--;
      if (cell.entries.length === 0) {
        this.cells.delete(key);
      }
    }
  }

  update(entity: Entity, oldPos: [number, number, number], newPos: [number, number, number], radius: number, layer: number): void {
    const [oldCx, oldCz] = this.worldToCell(oldPos);
    const [newCx, newCz] = this.worldToCell(newPos);
    if (oldCx === newCx && oldCz === newCz) {
      const key = this.cellKey(oldCx, oldCz);
      const cell = this.cells.get(key);
      if (cell) {
        const entry = cell.entries.find(
          (e) => e.entity.index === entity.index && e.entity.generation === entity.generation,
        );
        if (entry) {
          entry.position = newPos;
        }
      }
      return;
    }
    this.remove(entity, oldPos);
    this.insert({ entity, position: newPos, radius, layer });
  }

  queryRange(min: [number, number, number], max: [number, number, number], layer?: number): SpatialEntry[] {
    const [minCx, minCz] = this.worldToCell(min);
    const [maxCx, maxCz] = this.worldToCell(max);
    const results: SpatialEntry[] = [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const cell = this.cells.get(this.cellKey(cx, cz));
        if (!cell) continue;
        for (const entry of cell.entries) {
          if (layer !== undefined && entry.layer !== layer) continue;
          if (
            entry.position[0] >= min[0] && entry.position[0] <= max[0] &&
            entry.position[2] >= min[2] && entry.position[2] <= max[2]
          ) {
            results.push(entry);
          }
        }
      }
    }
    return results;
  }

  queryRadius(center: [number, number, number], radius: number, layer?: number): SpatialEntry[] {
    const min: [number, number, number] = [
      center[0] - radius,
      center[1] - 1e9,
      center[2] - radius,
    ];
    const max: [number, number, number] = [
      center[0] + radius,
      center[1] + 1e9,
      center[2] + radius,
    ];
    const candidates = this.queryRange(min, max, layer);
    const radiusSq = radius * radius;
    return candidates.filter((entry) => {
      const dx = entry.position[0] - center[0];
      const dz = entry.position[2] - center[2];
      return dx * dx + dz * dz <= radiusSq;
    });
  }

  queryCell(cellX: number, cellZ: number, layer?: number): SpatialEntry[] {
    const cell = this.cells.get(this.cellKey(cellX, cellZ));
    if (!cell) return [];
    if (layer === undefined) return [...cell.entries];
    return cell.entries.filter((e) => e.layer === layer);
  }

  getActiveCellCount(): number {
    return this.cells.size;
  }

  getEntryCount(): number {
    return this.entryCount;
  }

  clear(): void {
    this.cells.clear();
    this.entryCount = 0;
  }

  getCellCoords(pos: [number, number, number]): [number, number] {
    return this.worldToCell(pos);
  }

  getCellsInRadius(center: [number, number, number], radius: number): GridCell[] {
    const [cx, cz] = this.worldToCell(center);
    const cellRadius = Math.ceil(radius / this.cellSize);
    const result: GridCell[] = [];
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const cell = this.cells.get(this.cellKey(cx + dx, cz + dz));
        if (cell) result.push(cell);
      }
    }
    return result;
  }
}
