// ============================================================================
// Broadphase — Spatial hash grid for AABB pair generation
//
// Inserts body AABBs into a uniform grid, then queries neighboring cells for
// potential collision pairs. O(n) insert + O(n * k) pair gen where k is the
// average number of bodies per cell.
// ============================================================================

export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

interface GridEntry {
  bodyId: number;
  aabb: AABB;
}

export class Broadphase {
  private cellSize: number;
  private cells: Map<string, GridEntry[]> = new Map();

  constructor(cellSize: number = 8) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number, cz: number): string {
    return `${cx}:${cy}:${cz}`;
  }

  private worldToCell(pos: number): number {
    return Math.floor(pos / this.cellSize);
  }

  insert(bodyId: number, aabb: AABB): void {
    const minCx = this.worldToCell(aabb.minX);
    const maxCx = this.worldToCell(aabb.maxX);
    const minCy = this.worldToCell(aabb.minY);
    const maxCy = this.worldToCell(aabb.maxY);
    const minCz = this.worldToCell(aabb.minZ);
    const maxCz = this.worldToCell(aabb.maxZ);

    const entry: GridEntry = { bodyId, aabb };
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const k = this.key(cx, cy, cz);
          let cell = this.cells.get(k);
          if (!cell) {
            cell = [];
            this.cells.set(k, cell);
          }
          cell.push(entry);
        }
      }
    }
  }

  /**
   * Generate unique candidate collision pairs by checking overlapping AABBs
   * in the same grid cells. Returns pairs as [bodyA, bodyB] with bodyA < bodyB.
   */
  generatePairs(): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    const seen = new Set<string>();

    for (const cell of this.cells.values()) {
      for (let i = 0; i < cell.length; i++) {
        for (let j = i + 1; j < cell.length; j++) {
          const a = cell[i];
          const b = cell[j];
          const aId = Math.min(a.bodyId, b.bodyId);
          const bId = Math.max(a.bodyId, b.bodyId);
          const pairKey = `${aId}:${bId}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          if (this.aabbOverlap(a.aabb, b.aabb)) {
            pairs.push([aId, bId]);
          }
        }
      }
    }

    return pairs;
  }

  clear(): void {
    this.cells.clear();
  }

  setCellSize(size: number): void {
    this.cellSize = size;
  }

  private aabbOverlap(a: AABB, b: AABB): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
           a.minY <= b.maxY && a.maxY >= b.minY &&
           a.minZ <= b.maxZ && a.maxZ >= b.minZ;
  }
}
