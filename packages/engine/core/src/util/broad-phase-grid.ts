// ============================================================================
// SpatialGrid — uniform-grid spatial hash for broad-phase collision/AI queries.
//
// Inserts 2D points (x, z) into cells of configurable size. queryNeighbors
// returns all slots in the 3x3 neighborhood around a query point. The grid
// uses a numeric hash key (no string allocation) and a caller-owned output
// array to avoid per-query GC pressure.
//
// Usage:
//   const grid = new SpatialGrid(10); // cellSize = 10 units
//   grid.clear();
//   grid.insert(slotIndex, x, z);
//   const neighbors = grid.queryNeighbors(x, z, reusableOutArray);
//   for (let i = 0; i < neighbors.length; i++) { ... } // neighbors[i] is a slot index
//
// The grid is NOT thread-safe. Reuse one instance per system; clear() each tick.
// ============================================================================

export class BroadPhaseGrid {
  readonly cellSize: number;
  private readonly invCellSize: number;
  private cells: Map<number, number[]>;

  constructor(cellSize: number) {
    if (cellSize <= 0) throw new Error(`BroadPhaseGrid: cellSize must be > 0, got ${cellSize}`);
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.cells = new Map();
  }

  clear(): void {
    this.cells.clear();
  }

  insert(slot: number, x: number, z: number): void {
    const key = this.cellKey(x, z);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(slot);
  }

  // Fills `out` with slot indices in the 3x3 neighborhood around (x, z).
  // Returns `out` (caller-owned, reused across calls to avoid allocation).
  // The caller must clear `out` before calling if it's a persistent array —
  // this method appends to whatever is already in `out`.
  queryNeighbors(x: number, z: number, out: number[]): number[] {
    const cx = Math.floor(x * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const cells = this.cells;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = this.hashKey(cx + dx, cz + dz);
        const bucket = cells.get(key);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          out.push(bucket[i]);
        }
      }
    }
    return out;
  }

  // Returns the count of entries currently in the grid (for debugging/profiling).
  size(): number {
    let count = 0;
    for (const bucket of this.cells.values()) count += bucket.length;
    return count;
  }

  private cellKey(x: number, z: number): number {
    return this.hashKey(Math.floor(x * this.invCellSize), Math.floor(z * this.invCellSize));
  }

  // Numeric hash: avoids string allocation from template literals like `${cx},${cz}`.
  // The constants are large primes that mix the bits well for typical world coords.
  private hashKey(cx: number, cz: number): number {
    return ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
  }
}
