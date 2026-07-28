// ============================================================================
// Boat Cell System — grid-based boat building with auto-connecting tiles
// ============================================================================

import { BoatBufferWriter, MAX_BOATS, MAX_CELLS_PER_BOAT } from "../../shared/boat-buffer";
import { BOAT_CELL_WORLD_SIZE, BOAT_GRID_MAX, BOAT_GRID_MAX_HEIGHT, BOAT_LAYER_HEIGHT, CellTemplateEntry, SHIP_MASS_PER_CELL, getCellCollisionBottomY, getCellCollisionTopY, getCellSize, getWallCollisionBoxes, hasSolidCollision, isWalkableSurface, isWallType } from "../../shared/constants";
import { BOAT_PRESETS, BoatPresetName } from "./BoatPresets";

export interface BoatCell {
  type: number;
  rotation: number; // 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X)
  gridX: number;
  gridY: number;
  gridZ: number;
  sizeX: number; // grid units spanned in X (1 = single cell)
  sizeY: number; // grid units spanned in Y (layers)
  sizeZ: number; // grid units spanned in Z
}

export interface BoatMassProperties {
  mass: number;          // total mass (kg)
  invMass: number;       // 1/mass (0 if immovable)
  centerX: number;       // center of mass X (local space)
  centerY: number;       // center of mass Y (local space)
  centerZ: number;       // center of mass Z (local space)
  Iyy: number;          // yaw moment of inertia (about Y axis)
  invIyy: number;       // inverse yaw inertia
  Ixx: number;          // pitch moment of inertia (about X axis)
  invIxx: number;       // inverse pitch inertia
  Izz: number;          // roll moment of inertia (about Z axis)
  invIzz: number;       // inverse roll inertia
  radius: number;       // broad-phase collision radius
  halfLength: number;   // half extent along local Z (bow-stern)
  halfWidth: number;    // half extent along local X (port-starboard)
  bboxCenterX: number;  // geometric center of bounding box X (local space)
  bboxCenterZ: number;  // geometric center of bounding box Z (local space)
}

interface BoatGrid {
  entityId: number;
  cells: Map<string, BoatCell>; // key = "x,y,z"
  bufferSlot: number;
  massCache: BoatMassProperties | null;
  cellsCache: BoatCell[] | null;       // cached unique origin cells
  xzIndex: Map<string, boolean> | null; // cached "x,z" → true for fast isOverShipCells
  spatialGrid: Map<string, BoatCell[]> | null; // cached "gridX,gridZ" → cells overlapping bucket
  maxCellSpan: number;                  // max sizeX/sizeZ across all cells (for spatial query margin)
}

export interface RaycastResult {
  gridX: number;
  gridY: number;
  gridZ: number;
  face: number; // 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X), 4=top(+Y), 5=bottom(-Y)
}

export class BoatCellSystem {
  private boats = new Map<number, BoatGrid>(); // entityId → grid
  private nextBufferSlot = 0;
  private bufferWriter: BoatBufferWriter | null = null;
  private onCellsChangedCb: ((entityId: number) => void) | null = null;
  private bufferDirty = false;

  setBufferWriter(writer: BoatBufferWriter): void {
    this.bufferWriter = writer;
  }

  markBufferDirty(): void {
    this.bufferDirty = true;
  }

  setOnCellsChanged(cb: (entityId: number) => void): void {
    this.onCellsChangedCb = (entityId: number) => {
      this.bufferDirty = true;
      cb(entityId);
    };
  }

  // Register a ship entity with the cell system and load a preset layout
  createBoat(entityId: number, preset: BoatPresetName = "monohull"): void {
    if (this.boats.has(entityId)) return;
    if (this.nextBufferSlot >= MAX_BOATS) return;

    const grid: BoatGrid = {
      entityId,
      cells: new Map(),
      bufferSlot: this.nextBufferSlot++,
      massCache: null,
      cellsCache: null,
      xzIndex: null,
      spatialGrid: null,
      maxCellSpan: 1,
    };

    const presetData = BOAT_PRESETS[preset];
    if (presetData) {
      for (let i = 0; i < presetData.cells.length; i++) {
        const cell = presetData.cells[i];
        this.addCellInternal(grid, cell.type, cell.rotation, cell.gridX, cell.gridY, cell.gridZ);
      }
    }

    this.boats.set(entityId, grid);
  }

  // Load a preset into an existing boat (replaces all cells)
  loadPreset(entityId: number, preset: BoatPresetName): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const presetData = BOAT_PRESETS[preset];
    if (!presetData) return false;

    grid.cells.clear();
    for (let i = 0; i < presetData.cells.length; i++) {
      const cell = presetData.cells[i];
      this.addCellInternal(grid, cell.type, cell.rotation, cell.gridX, cell.gridY, cell.gridZ);
    }
    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  // Place a multi-cell template at the given grid position
  addTemplate(entityId: number, template: CellTemplateEntry[], gridX: number, gridY: number, gridZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;

    // First pass: validate all positions (bounds check only, allow overwrite)
    for (let ti = 0; ti < template.length; ti++) {
      const entry = template[ti];
      const x = gridX + entry.dx;
      const y = gridY + entry.dy;
      const z = gridZ + entry.dz;
      if (Math.abs(x) > BOAT_GRID_MAX || Math.abs(z) > BOAT_GRID_MAX) return false;
      if (y < 0 || y > BOAT_GRID_MAX_HEIGHT) return false;
      if (grid.cells.size >= MAX_CELLS_PER_BOAT) return false;
    }

    // Check that at least one template cell is near an existing cell (within 2 grid cells)
    if (grid.cells.size > 0) {
      let hasNearby = false;
      const cellKeys = Array.from(grid.cells.keys());
      for (let ti = 0; ti < template.length; ti++) {
        const entry = template[ti];
        const x = gridX + entry.dx;
        const y = gridY + entry.dy;
        const z = gridZ + entry.dz;
        // Check direct adjacency first
        if (this.hasAdjacent(grid, x, y, z)) {
          hasNearby = true;
          break;
        }
        // Check if any existing cell is within 2 cells horizontally
        for (let ci = 0; ci < cellKeys.length; ci++) {
          const parts = cellKeys[ci].split(",");
          const ex = +parts[0];
          const ez = +parts[2];
          if (Math.abs(ex - x) <= 2 && Math.abs(ez - z) <= 2) {
            hasNearby = true;
            break;
          }
        }
        if (hasNearby) break;
      }
      if (!hasNearby) return false;
    }

    // Second pass: remove any existing cells that would be overwritten, then place new cells.
    // For each position, if an existing multi-cell origin occupies it, remove ALL of that
    // origin's positions first to prevent orphaned references in the Map.
    const removedOrigins = new Set<string>();
    for (let ti = 0; ti < template.length; ti++) {
      const entry = template[ti];
      const x = gridX + entry.dx;
      const y = gridY + entry.dy;
      const z = gridZ + entry.dz;
      const existing = grid.cells.get(`${x},${y},${z}`);
      if (existing) {
        const originKey = `${existing.gridX},${existing.gridY},${existing.gridZ}`;
        if (!removedOrigins.has(originKey)) {
          removedOrigins.add(originKey);
          this.removeCellPositions(grid, existing);
        }
      }
    }

    // Third pass: place all new cells
    for (let ti = 0; ti < template.length; ti++) {
      const entry = template[ti];
      this.addCellInternal(grid, entry.type, entry.rotation, gridX + entry.dx, gridY + entry.dy, gridZ + entry.dz);
    }
    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  // Invalidate caches — called whenever cells change
  private invalidateMassCache(entityId: number): void {
    const grid = this.boats.get(entityId);
    if (grid) {
      grid.massCache = null;
      grid.cellsCache = null;
      grid.xzIndex = null;
      grid.spatialGrid = null;
    }
  }

  removeBoat(entityId: number): void {
    const grid = this.boats.get(entityId);
    if (!grid) return;
    if (this.bufferWriter) {
      this.bufferWriter.clearBoat(grid.bufferSlot);
    }
    this.boats.delete(entityId);
  }

  // --- Cell operations ---

  addCell(entityId: number, type: number, rotation: number, gridX: number, gridY: number, gridZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    if (grid.cells.size >= MAX_CELLS_PER_BOAT) return false;

    const size = getCellSize(type, rotation);

    // Validate all occupied positions for multi-cell types
    for (let sx = 0; sx < size.sizeX; sx++) {
      for (let sy = 0; sy < size.sizeY; sy++) {
        for (let sz = 0; sz < size.sizeZ; sz++) {
          const x = gridX + sx;
          const y = gridY + sy;
          const z = gridZ + sz;
          if (Math.abs(x) > BOAT_GRID_MAX || Math.abs(z) > BOAT_GRID_MAX) return false;
          if (y < 0 || y > BOAT_GRID_MAX_HEIGHT) return false;
          if (grid.cells.has(`${x},${y},${z}`)) return false;
        }
      }
    }

    // Check adjacency: new cell must be adjacent to an existing cell
    if (grid.cells.size > 0 && !this.hasAdjacentMulti(grid, gridX, gridY, gridZ, size)) return false;

    this.addCellInternal(grid, type, rotation, gridX, gridY, gridZ);
    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  removeCell(entityId: number, gridX: number, gridY: number, gridZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const key = `${gridX},${gridY},${gridZ}`;
    const cell = grid.cells.get(key);
    if (!cell) return false;

    // Don't remove if it would split the boat into disconnected pieces
    if (!this.canRemoveWithoutDisconnect(grid, cell.gridX, cell.gridY, cell.gridZ)) return false;

    // Remove all occupied positions for multi-cell types
    for (let sx = 0; sx < cell.sizeX; sx++) {
      for (let sy = 0; sy < cell.sizeY; sy++) {
        for (let sz = 0; sz < cell.sizeZ; sz++) {
          grid.cells.delete(`${cell.gridX + sx},${cell.gridY + sy},${cell.gridZ + sz}`);
        }
      }
    }
    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  rotateCell(entityId: number, gridX: number, gridY: number, gridZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const key = `${gridX},${gridY},${gridZ}`;
    const cell = grid.cells.get(key);
    if (!cell) return false;

    // Remove old positions from the map
    this.removeCellPositions(grid, cell);

    // Apply new rotation
    cell.rotation = (cell.rotation + 1) % 4;

    // Recalculate size and re-register positions
    const size = getCellSize(cell.type, cell.rotation);
    cell.sizeX = size.sizeX;
    cell.sizeY = size.sizeY;
    cell.sizeZ = size.sizeZ;
    this.addCellPositions(grid, cell);

    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  replaceCell(entityId: number, type: number, gridX: number, gridY: number, gridZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const key = `${gridX},${gridY},${gridZ}`;
    const cell = grid.cells.get(key);
    if (!cell) return false;

    // Remove old positions from the map
    this.removeCellPositions(grid, cell);

    // Update type and reset rotation
    cell.type = type;
    cell.rotation = 0;

    // Recalculate size and re-register positions
    const size = getCellSize(type, 0);
    cell.sizeX = size.sizeX;
    cell.sizeY = size.sizeY;
    cell.sizeZ = size.sizeZ;
    this.addCellPositions(grid, cell);

    this.invalidateMassCache(entityId);
    this.onCellsChangedCb?.(entityId);
    return true;
  }

  canPlaceCell(entityId: number, action: string, gridX: number, gridY: number, gridZ: number, template?: CellTemplateEntry[], cellType?: number, rotation: number = 0): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;

    switch (action) {
      case "build": {
        if (template) {
          // Track template positions to detect internal overlaps
          const templatePositions = new Set<string>();
          for (let ti = 0; ti < template.length; ti++) {
            const entry = template[ti];
            const x = gridX + entry.dx;
            const y = gridY + entry.dy;
            const z = gridZ + entry.dz;
            if (Math.abs(x) > BOAT_GRID_MAX || Math.abs(z) > BOAT_GRID_MAX) return false;
            if (y < 0 || y > BOAT_GRID_MAX_HEIGHT) return false;
            if (grid.cells.size >= MAX_CELLS_PER_BOAT) return false;
            // Check overlap with existing cells
            const posKey = `${x},${y},${z}`;
            if (grid.cells.has(posKey)) return false;
            templatePositions.add(posKey);
          }
          if (grid.cells.size > 0) {
            let hasNearby = false;
            const cellKeys = Array.from(grid.cells.keys());
            for (let ti = 0; ti < template.length; ti++) {
              const entry = template[ti];
              const x = gridX + entry.dx;
              const y = gridY + entry.dy;
              const z = gridZ + entry.dz;
              if (this.hasAdjacent(grid, x, y, z)) { hasNearby = true; break; }
              for (let ci = 0; ci < cellKeys.length; ci++) {
                const parts = cellKeys[ci].split(",");
                const ex = +parts[0];
                const ez = +parts[2];
                if (Math.abs(ex - x) <= 2 && Math.abs(ez - z) <= 2) { hasNearby = true; break; }
              }
              if (hasNearby) break;
            }
            if (!hasNearby) return false;
          }
          return true;
        } else {
          const size = getCellSize(cellType ?? 0, rotation);
          // Validate all occupied positions for multi-cell types
          for (let sx = 0; sx < size.sizeX; sx++) {
            for (let sy = 0; sy < size.sizeY; sy++) {
              for (let sz = 0; sz < size.sizeZ; sz++) {
                const x = gridX + sx;
                const y = gridY + sy;
                const z = gridZ + sz;
                if (Math.abs(x) > BOAT_GRID_MAX || Math.abs(z) > BOAT_GRID_MAX) return false;
                if (y < 0 || y > BOAT_GRID_MAX_HEIGHT) return false;
                if (grid.cells.has(`${x},${y},${z}`)) return false;
              }
            }
          }
          if (grid.cells.size >= MAX_CELLS_PER_BOAT) return false;
          if (grid.cells.size > 0 && !this.hasAdjacentMulti(grid, gridX, gridY, gridZ, size)) return false;
          return true;
        }
      }
      case "delete": {
        const cell = grid.cells.get(`${gridX},${gridY},${gridZ}`);
        if (!cell) return false;
        if (!this.canRemoveWithoutDisconnect(grid, cell.gridX, cell.gridY, cell.gridZ)) return false;
        return true;
      }
      case "rotate": {
        return grid.cells.has(`${gridX},${gridY},${gridZ}`);
      }
      case "replace": {
        return grid.cells.has(`${gridX},${gridY},${gridZ}`);
      }
      default:
        return false;
    }
  }

  getCellAt(entityId: number, gridX: number, gridY: number, gridZ: number): BoatCell | null {
    const grid = this.boats.get(entityId);
    if (!grid) return null;
    return grid.cells.get(`${gridX},${gridY},${gridZ}`) ?? null;
  }

  getCells(entityId: number): BoatCell[] {
    const grid = this.boats.get(entityId);
    if (!grid) return [];
    // Return cached unique origin cells if available
    if (grid.cellsCache) return grid.cellsCache;
    // Build cache: unique origin cells only (multi-cell fills multiple positions with same reference)
    const seen = new Set<string>();
    const result: BoatCell[] = [];
    const cellValues = Array.from(grid.cells.values());
    let maxSpan = 1;
    for (let ci = 0; ci < cellValues.length; ci++) {
      const cell = cellValues[ci];
      const originKey = `${cell.gridX},${cell.gridY},${cell.gridZ}`;
      if (seen.has(originKey)) continue;
      seen.add(originKey);
      result.push(cell);
      if (cell.sizeX > maxSpan) maxSpan = cell.sizeX;
      if (cell.sizeZ > maxSpan) maxSpan = cell.sizeZ;
    }
    grid.cellsCache = result;
    grid.maxCellSpan = maxSpan;
    return result;
  }

  // Build (or return cached) spatial grid: maps "gridX,gridZ" bucket → cells overlapping that bucket.
  // Each cell is inserted into all buckets it spans (gridX..gridX+sizeX-1, gridZ..gridZ+sizeZ-1).
  private getSpatialGrid(entityId: number): Map<string, BoatCell[]> | null {
    const grid = this.boats.get(entityId);
    if (!grid) return null;
    if (grid.spatialGrid) return grid.spatialGrid;
    const cells = this.getCells(entityId);
    if (cells.length === 0) return null;
    const sg = new Map<string, BoatCell[]>();
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      for (let sx = 0; sx < cell.sizeX; sx++) {
        for (let sz = 0; sz < cell.sizeZ; sz++) {
          const key = `${cell.gridX + sx},${cell.gridZ + sz}`;
          const bucket = sg.get(key);
          if (bucket) {
            bucket.push(cell);
          } else {
            sg.set(key, [cell]);
          }
        }
      }
    }
    grid.spatialGrid = sg;
    return sg;
  }

  // Query spatial grid for cells near a local-space position.
  // Returns a deduplicated array of cells whose grid buckets overlap the query range.
  private querySpatialGrid(
    grid: BoatGrid,
    localX: number, localZ: number,
    margin: number,
  ): BoatCell[] {
    const sg = grid.spatialGrid;
    if (!sg) return grid.cellsCache ?? [];
    const minGx = Math.floor((localX - margin) / BOAT_CELL_WORLD_SIZE);
    const maxGx = Math.floor((localX + margin) / BOAT_CELL_WORLD_SIZE);
    const minGz = Math.floor((localZ - margin) / BOAT_CELL_WORLD_SIZE);
    const maxGz = Math.floor((localZ + margin) / BOAT_CELL_WORLD_SIZE);
    const seen = new Set<BoatCell>();
    const result: BoatCell[] = [];
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gz = minGz; gz <= maxGz; gz++) {
        const bucket = sg.get(`${gx},${gz}`);
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const cell = bucket[bi];
          if (seen.has(cell)) continue;
          seen.add(cell);
          result.push(cell);
        }
      }
    }
    return result;
  }

  // Compute and cache mass properties for a boat (total mass, center of mass, moments of inertia)
  getMassProperties(entityId: number): BoatMassProperties {
    const grid = this.boats.get(entityId);
    if (!grid) return DEFAULT_MASS_PROPERTIES;
    if (grid.massCache) return grid.massCache;

    const cells = this.getCells(entityId);
    if (cells.length === 0) return DEFAULT_MASS_PROPERTIES;

    let totalMass = 0;
    let sumMx = 0, sumMy = 0, sumMz = 0;
    let minLocalX = Infinity, maxLocalX = -Infinity;
    let minLocalZ = Infinity, maxLocalZ = -Infinity;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cellVolume = cell.sizeX * cell.sizeY * cell.sizeZ;
      const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const ly = cell.gridY * BOAT_LAYER_HEIGHT + cell.sizeY * BOAT_LAYER_HEIGHT / 2;
      const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const m = SHIP_MASS_PER_CELL * cellVolume;
      totalMass += m;
      sumMx += lx * m;
      sumMy += ly * m;
      sumMz += lz * m;
      const minX = cell.gridX * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const maxX = (cell.gridX + cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE + BOAT_CELL_WORLD_SIZE / 2;
      const minZ = cell.gridZ * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const maxZ = (cell.gridZ + cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE + BOAT_CELL_WORLD_SIZE / 2;
      if (minX < minLocalX) minLocalX = minX;
      if (maxX > maxLocalX) maxLocalX = maxX;
      if (minZ < minLocalZ) minLocalZ = minZ;
      if (maxZ > maxLocalZ) maxLocalZ = maxZ;
    }

    const cx = sumMx / totalMass;
    const cy = sumMy / totalMass;
    const cz = sumMz / totalMass;

    // Moments of inertia about principal axes through center of mass
    // For a collection of point masses: I = sum(m * r²)
    let Ixx = 0, Iyy = 0, Izz = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cellVolume = cell.sizeX * cell.sizeY * cell.sizeZ;
      const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2 - cx;
      const ly = cell.gridY * BOAT_LAYER_HEIGHT + cell.sizeY * BOAT_LAYER_HEIGHT / 2 - cy;
      const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2 - cz;
      const m = SHIP_MASS_PER_CELL * cellVolume;
      Ixx += m * (lz * lz + ly * ly);
      Iyy += m * (lx * lx + lz * lz);
      Izz += m * (lx * lx + ly * ly);
    }

    // Broad-phase radius
    let maxR = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const r = Math.sqrt(lx * lx + lz * lz) + BOAT_CELL_WORLD_SIZE * 0.5 * Math.max(cell.sizeX, cell.sizeZ);
      if (r > maxR) maxR = r;
    }

    const halfLength = (maxLocalZ - minLocalZ) / 2 + BOAT_CELL_WORLD_SIZE / 2;
    const halfWidth = (maxLocalX - minLocalX) / 2 + BOAT_CELL_WORLD_SIZE / 2;
    const bboxCenterX = (maxLocalX + minLocalX) / 2;
    const bboxCenterZ = (maxLocalZ + minLocalZ) / 2;

    const props: BoatMassProperties = {
      mass: totalMass,
      invMass: totalMass > 0 ? 1 / totalMass : 0,
      centerX: cx,
      centerY: cy,
      centerZ: cz,
      Iyy,
      invIyy: Iyy > 0 ? 1 / Iyy : 0,
      Ixx,
      invIxx: Ixx > 0 ? 1 / Ixx : 0,
      Izz,
      invIzz: Izz > 0 ? 1 / Izz : 0,
      radius: maxR || 4,
      halfLength,
      halfWidth,
      bboxCenterX,
      bboxCenterZ,
    };

    grid.massCache = props;
    return props;
  }

  // Approximate collision radius (max distance from center to any cell edge)
  getShipCollisionRadius(entityId: number): number {
    const grid = this.boats.get(entityId);
    if (!grid) return 4;
    const cells = this.getCells(entityId);
    let maxR = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const r = Math.sqrt(lx * lx + lz * lz) + BOAT_CELL_WORLD_SIZE * 0.5 * Math.max(cell.sizeX, cell.sizeZ);
      if (r > maxR) maxR = r;
    }
    return maxR || 4;
  }

  // Convert world position to grid coordinates relative to ship
  worldToGrid(
    worldX: number, worldZ: number,
    shipX: number, shipZ: number,
    shipHeading: number,
    cellWorldSize: number,
  ): { gridX: number; gridZ: number } {
    // Transform world position into ship-local space
    const dx = worldX - shipX;
    const dz = worldZ - shipZ;
    // Rotate by -heading to get ship-local coordinates
    // heading 0 = forward -Z, sin(heading) = x component, cos(heading) = z component
    const cos = Math.cos(-shipHeading);
    const sin = Math.sin(-shipHeading);
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    // Convert to grid coordinates
    const gridX = Math.round(localX / cellWorldSize);
    const gridZ = Math.round(localZ / cellWorldSize);
    return { gridX, gridZ };
  }

  // --- Auto-connecting tile helpers ---

  hasNeighbor(entityId: number, gridX: number, gridY: number, gridZ: number, dir: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const [dx, dy, dz] = DIR_OFFSETS[dir];
    return grid.cells.has(`${gridX + dx},${gridY + dy},${gridZ + dz}`);
  }

  // Check if a ship-local XZ position is over any cell (any vertical layer)
  isOverShipCells(entityId: number, localX: number, localZ: number): boolean {
    const grid = this.boats.get(entityId);
    if (!grid) return false;
    const gridX = Math.round(localX / BOAT_CELL_WORLD_SIZE);
    const gridZ = Math.round(localZ / BOAT_CELL_WORLD_SIZE);
    // Build XZ index on demand if not cached
    if (!grid.xzIndex) {
      const index = new Map<string, boolean>();
      const cellValues = Array.from(grid.cells.values());
      for (let ci = 0; ci < cellValues.length; ci++) {
        const cell = cellValues[ci];
        for (let sx = 0; sx < cell.sizeX; sx++) {
          for (let sz = 0; sz < cell.sizeZ; sz++) {
            index.set(`${cell.gridX + sx},${cell.gridZ + sz}`, true);
          }
        }
      }
      grid.xzIndex = index;
    }
    return grid.xzIndex.has(`${gridX},${gridZ}`) ?? false;
  }

  // Compute the AABB of all cells in ship-local space.
  // Used by RapierPhysicsSystem for the simplified ship collider — a single
  // cuboid encompassing the full ship footprint. The detailed per-cell collision
  // is handled by resolveCellCollision when the player is onboard.
  getShipBounds(entityId: number): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
    const cells = this.getCells(entityId);
    if (cells.length === 0) return null;

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      const size = getCellSize(cell.type, cell.rotation);
      const cellMinX = cell.gridX * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const cellMaxX = cellMinX + size.sizeX * BOAT_CELL_WORLD_SIZE;
      const cellMinZ = cell.gridZ * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const cellMaxZ = cellMinZ + size.sizeZ * BOAT_CELL_WORLD_SIZE;

      const walkable = isWalkableSurface(cell.type);
      const cellBottomY = walkable
        ? cell.gridY * BOAT_LAYER_HEIGHT
        : getCellCollisionBottomY(cell.type, cell.gridY);
      const cellTopY = getCellCollisionTopY(cell.type, cell.gridY) +
        (size.sizeY > 1 ? (size.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);

      if (cellMinX < minX) minX = cellMinX;
      if (cellMaxX > maxX) maxX = cellMaxX;
      if (cellMinZ < minZ) minZ = cellMinZ;
      if (cellMaxZ > maxZ) maxZ = cellMaxZ;
      if (cellBottomY < minY) minY = cellBottomY;
      if (cellTopY > maxY) maxY = cellTopY;
    }

    if (minX === Infinity) return null;
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  // Find the nearest climbable cell edge for a player in ship-local space.
  // A cell is climbable if:
  //   - Its top is above the player but within climbThreshold
  //   - No solid cell directly above (pre-check for collisions)
  //   - The face toward the player is an outer edge (no neighbor on that side)
  // Returns edge position (where hands grab), target position (on top of cell), and grid coords.
  findClimbableEdge(
    entityId: number,
    localX: number, localY: number, localZ: number,
    climbThreshold: number,
    playerHeight: number,
    maxHorizontalDist: number,
  ): {
    gridX: number; gridY: number; gridZ: number;
    edgeLocalX: number; edgeLocalZ: number; topLocalY: number;
    targetLocalX: number; targetLocalZ: number;
  } | null {
    const grid = this.boats.get(entityId);
    if (!grid) return null;

    let bestDist = Infinity;
    let bestResult: {
      gridX: number; gridY: number; gridZ: number;
      edgeLocalX: number; edgeLocalZ: number; topLocalY: number;
      targetLocalX: number; targetLocalZ: number;
    } | null = null;

    const halfCell = BOAT_CELL_WORLD_SIZE / 2;

    this.getSpatialGrid(entityId);
    const climbMargin = maxHorizontalDist + grid.maxCellSpan * BOAT_CELL_WORLD_SIZE;
    const cells = this.querySpatialGrid(grid, localX, localZ, climbMargin);
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      const size = getCellSize(cell.type, cell.rotation);
      const cellCenterX = cell.gridX * BOAT_CELL_WORLD_SIZE + (size.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const cellCenterZ = cell.gridZ * BOAT_CELL_WORLD_SIZE + (size.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
      const cellMaxY = getCellCollisionTopY(cell.type, cell.gridY) +
        (size.sizeY > 1 ? (size.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);

      // Cell top must be above player feet but within climb threshold
      if (cellMaxY <= localY + 0.1) continue;
      if (cellMaxY - localY > climbThreshold) continue;

      // Pre-check: no solid cell directly above the landing position
      const aboveKey = `${cell.gridX},${cell.gridY + 1},${cell.gridZ}`;
      const aboveCell = grid.cells.get(aboveKey);
      if (aboveCell && hasSolidCollision(aboveCell.type)) continue;

      // Also check two layers above if player height would reach it
      const headYAtTop = cellMaxY + playerHeight;
      const above2MinY = (cell.gridY + 2) * BOAT_LAYER_HEIGHT;
      if (headYAtTop > above2MinY) {
        const above2Key = `${cell.gridX},${cell.gridY + 2},${cell.gridZ}`;
        const above2Cell = grid.cells.get(above2Key);
        if (above2Cell && hasSolidCollision(above2Cell.type)) continue;
      }

      // Direction from cell center to player (horizontal)
      const dirX = localX - cellCenterX;
      const dirZ = localZ - cellCenterZ;
      const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (dirLen < 0.001) continue;

      const ndx = dirX / dirLen;
      const ndz = dirZ / dirLen;

      // Determine which face of the cell faces the player and compute edge point
      // Iterate over collision boxes to find the closest edge
      const climbBoxes = getWallCollisionBoxes(cell.type, cell.rotation);
      let bestEdgeX = 0, bestEdgeZ = 0, bestEdgeDistSq = Infinity, bestNeighborDir = -1;

      for (let bi = 0; bi < climbBoxes.length; bi++) {
        const cb = climbBoxes[bi];
        const boxCx = cellCenterX + cb.offsetX;
        const boxCz = cellCenterZ + cb.offsetZ;
        let edgeX: number, edgeZ: number;
        let neighborDir: number;

        if (Math.abs(ndx) >= Math.abs(ndz)) {
          edgeX = boxCx + Math.sign(ndx) * cb.halfX;
          const zRatio = Math.abs(ndx) > 0.001 ? (ndz / Math.abs(ndx)) : 0;
          edgeZ = boxCz + Math.max(-1, Math.min(1, zRatio)) * cb.halfZ;
          neighborDir = ndx > 0 ? 1 : 3;
        } else {
          edgeZ = boxCz + Math.sign(ndz) * cb.halfZ;
          const xRatio = Math.abs(ndz) > 0.001 ? (ndx / Math.abs(ndz)) : 0;
          edgeX = boxCx + Math.max(-1, Math.min(1, xRatio)) * cb.halfX;
          neighborDir = ndz > 0 ? 2 : 0;
        }

        const hDistSq = (edgeX - localX) * (edgeX - localX) + (edgeZ - localZ) * (edgeZ - localZ);
        if (hDistSq < bestEdgeDistSq) {
          bestEdgeDistSq = hDistSq;
          bestEdgeX = edgeX;
          bestEdgeZ = edgeZ;
          bestNeighborDir = neighborDir;
        }
      }

      // Must be an outer edge — no neighbor on this side at the same layer
      const [ddx, , ddz] = DIR_OFFSETS[bestNeighborDir];
      if (grid.cells.has(`${cell.gridX + ddx},${cell.gridY},${cell.gridZ + ddz}`)) continue;

      // Check horizontal distance from player to edge
      if (bestEdgeDistSq > maxHorizontalDist * maxHorizontalDist) continue;

      if (bestEdgeDistSq < bestDist) {
        bestDist = bestEdgeDistSq;
        bestResult = {
          gridX: cell.gridX,
          gridY: cell.gridY,
          gridZ: cell.gridZ,
          edgeLocalX: bestEdgeX,
          edgeLocalZ: bestEdgeZ,
          topLocalY: cellMaxY,
          targetLocalX: cellCenterX,
          targetLocalZ: cellCenterZ,
        };
      }
    }

    return bestResult;
  }

  // Resolve collision against boat cells on ALL layers.
  // Returns wall-collision-adjusted XZ and the floor height (highest cell top at/below feet).
  // Walkable surfaces (BRIDGE, DECK) provide floor detection but no wall collision.
  // If no floor is found below the player, snaps up to the lowest solid/walkable cell top above.
  resolveCellCollision(
    entityId: number,
    localX: number, localY: number, localZ: number,
    playerRadius: number, playerHeight: number,
  ): { x: number; z: number; floorY: number } {
    const grid = this.boats.get(entityId);
    if (!grid) return { x: localX, z: localZ, floorY: -Infinity };

    let x = localX;
    let z = localZ;
    let floorY = -Infinity;
    let lowestFloorAbove = Infinity; // lowest solid/walkable cell top above player's feet

    const feetY = localY;
    const headY = localY + playerHeight;

    // Build spatial grid for O(1) bucket lookup — avoids iterating all cells on big ships.
    this.getSpatialGrid(entityId);
    // Query margin: player radius + max cell span (so multi-cell cells are caught from any edge)
    const queryMargin = playerRadius + grid.maxCellSpan * BOAT_CELL_WORLD_SIZE;
    // Multi-pass collision resolution: pushing out of one cell can push the
    // player into an adjacent cell. When the ship is rolling, local-space
    // movement is larger and multi-cell overlaps are common. We iterate
    // multiple times so pushes converge, with early-out when stable.
    //
    // We query nearby cells via spatial grid each pass. The player can be pushed
    // far enough in one pass to overlap cells that were previously out of range,
    // so we re-query each pass with the updated position.
    const MAX_PASSES = 4;
    const stepUpThreshold = playerHeight * 0.3;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let pushed = false;
      const cells = this.querySpatialGrid(grid, x, z, queryMargin);
      for (let ci = 0; ci < cells.length; ci++) {
        const cell = cells[ci];
        const size = getCellSize(cell.type, cell.rotation);

        const walkable = isWalkableSurface(cell.type);
        // Walkable surfaces (DECK, BRIDGE) sit at the layer base — their y0 is just
        // visual overhang. Solid cells use getCellCollisionBottomY for true bottom.
        const cellMinY = walkable
          ? cell.gridY * BOAT_LAYER_HEIGHT
          : getCellCollisionBottomY(cell.type, cell.gridY);
        const cellMaxY = getCellCollisionTopY(cell.type, cell.gridY) +
          (size.sizeY > 1 ? (size.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);

        // Compute XZ overlap for ALL cells — no cell type can skip this.
        // getWallCollisionBoxes returns a full-cell box for non-wall types,
        // so this works for walkable surfaces (DECK, BRIDGE) too.
        // For multi-cell types, scale the collision box to span the full size.
        const cellCx = cell.gridX * BOAT_CELL_WORLD_SIZE + (size.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
        const cellCz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (size.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
        const boxes = getWallCollisionBoxes(cell.type, cell.rotation);
        // For non-wall multi-cell types, override box half-extents to span full size
        let effectiveBoxes = boxes;
        if (!isWallType(cell.type) && (size.sizeX > 1 || size.sizeZ > 1)) {
          const halfX = (size.sizeX * BOAT_CELL_WORLD_SIZE) / 2;
          const halfZ = (size.sizeZ * BOAT_CELL_WORLD_SIZE) / 2;
          effectiveBoxes = [{ offsetX: 0, offsetZ: 0, halfX, halfZ }];
        }

        let xzOverlaps = false;
        for (let bi = 0; bi < effectiveBoxes.length; bi++) {
          const b = effectiveBoxes[bi];
          const bMinX = cellCx + b.offsetX - b.halfX;
          const bMaxX = cellCx + b.offsetX + b.halfX;
          const bMinZ = cellCz + b.offsetZ - b.halfZ;
          const bMaxZ = cellCz + b.offsetZ + b.halfZ;
          if (x >= bMinX - playerRadius && x <= bMaxX + playerRadius &&
              z >= bMinZ - playerRadius && z <= bMaxZ + playerRadius) {
            xzOverlaps = true;
            break;
          }
        }
        if (!xzOverlaps) continue;

        // Walkable surfaces (BRIDGE, DECK) are thin deck plates at the BOTTOM
        // of their cell (cellMinY), not solid blocks. The player stands on the
        // deck plate at cellMinY. The space above (up to cellMaxY) is where the
        // player's body occupies — it is NOT solid.
        if (walkable) {
          // Floor detection: deck plate at cellMinY is at or below player's feet
          if (cellMinY <= feetY + 0.15) {
            if (cellMinY > floorY) floorY = cellMinY;
          }
          // Track for snap-up when player is below the deck
          if (cellMinY > feetY + 0.15) {
            if (cellMinY < lowestFloorAbove) lowestFloorAbove = cellMinY;
          }
          // No wall collision for walkable surfaces
          continue;
        }

        // Floor detection: solid cell top is at or below player's feet (with small tolerance).
        if (cellMaxY <= feetY + 0.15) {
          if (cellMaxY > floorY) floorY = cellMaxY;
        }

        // Track lowest solid floor above the player (for snap-up when no floor below)
        if (hasSolidCollision(cell.type) && cellMaxY > feetY + 0.15) {
          if (cellMaxY < lowestFloorAbove) lowestFloorAbove = cellMaxY;
        }

        // Wall collision: solid cell whose vertical span overlaps the player's body
        // BUT: if cell top is within 30% of player height above feet, treat as step-up (floor)
        if (hasSolidCollision(cell.type) &&
            cellMaxY > feetY + 0.15 && cellMinY < headY - 0.1) {

          // Step-up: cell top is low enough to step on — treat as floor, skip wall push
          if (cellMaxY - feetY <= stepUpThreshold) {
            if (cellMaxY > floorY) floorY = cellMaxY;
            continue;
          }
          // Push player out of each collision box
          for (let bi = 0; bi < effectiveBoxes.length; bi++) {
            const b = effectiveBoxes[bi];
            const bMinX = cellCx + b.offsetX - b.halfX;
            const bMaxX = cellCx + b.offsetX + b.halfX;
            const bMinZ = cellCz + b.offsetZ - b.halfZ;
            const bMaxZ = cellCz + b.offsetZ + b.halfZ;
            const closestX = Math.max(bMinX, Math.min(x, bMaxX));
            const closestZ = Math.max(bMinZ, Math.min(z, bMaxZ));

            const dx = x - closestX;
            const dz = z - closestZ;
            const distSq = dx * dx + dz * dz;

            if (distSq < playerRadius * playerRadius) {
              if (distSq < 1e-8) {
                const penX = Math.min(x - bMinX, bMaxX - x);
                const penZ = Math.min(z - bMinZ, bMaxZ - z);
                if (penX < penZ) {
                  x += (x < (bMinX + bMaxX) / 2 ? -(penX + playerRadius) : (penX + playerRadius));
                } else {
                  z += (z < (bMinZ + bMaxZ) / 2 ? -(penZ + playerRadius) : (penZ + playerRadius));
                }
              } else {
                const dist = Math.sqrt(distSq);
                const push = (playerRadius - dist) / dist;
                x += dx * push;
                z += dz * push;
              }
              pushed = true;
            }
          }
        }
      }
      // Early-out: if no pushes occurred this pass, collision is resolved
      if (!pushed) break;
    }

    // Snap-up: if no floor was found below the player, use the lowest floor above
    if (!Number.isFinite(floorY) && lowestFloorAbove < Infinity) {
      floorY = lowestFloorAbove;
    }

    // Containment safety net: after all passes, verify the player isn't still
    // inside any solid cell. If they are, push them to the nearest free edge.
    // This catches cases where pushes conflicted or the player was pushed deep
    // into a cell by ship rotation. Iterate multiple passes because pushing
    // out of one wall can push the player into an adjacent wall.
    const SAFETY_PASSES = 3;
    for (let sp = 0; sp < SAFETY_PASSES; sp++) {
      let safetyPushed = false;
      const safetyCells = this.querySpatialGrid(grid, x, z, queryMargin);
      for (let ci = 0; ci < safetyCells.length; ci++) {
        const cell = safetyCells[ci];
        if (!hasSolidCollision(cell.type)) continue;
        if (isWalkableSurface(cell.type)) continue;
        const size = getCellSize(cell.type, cell.rotation);
        const cellMinY = getCellCollisionBottomY(cell.type, cell.gridY);
        const cellMaxY = getCellCollisionTopY(cell.type, cell.gridY) +
          (size.sizeY > 1 ? (size.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
        // Only check Y overlap with player body
        if (cellMaxY <= feetY + 0.15 || cellMinY >= headY - 0.1) continue;
        // Step-up cells are floors, not walls
        if (cellMaxY - feetY <= stepUpThreshold) continue;

        const cellCx = cell.gridX * BOAT_CELL_WORLD_SIZE + (size.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
        const cellCz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (size.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
        let effectiveBoxes = getWallCollisionBoxes(cell.type, cell.rotation);
        if (!isWallType(cell.type) && (size.sizeX > 1 || size.sizeZ > 1)) {
          const halfX = (size.sizeX * BOAT_CELL_WORLD_SIZE) / 2;
          const halfZ = (size.sizeZ * BOAT_CELL_WORLD_SIZE) / 2;
          effectiveBoxes = [{ offsetX: 0, offsetZ: 0, halfX, halfZ }];
        }
        for (let bi = 0; bi < effectiveBoxes.length; bi++) {
          const b = effectiveBoxes[bi];
          const bMinX = cellCx + b.offsetX - b.halfX;
          const bMaxX = cellCx + b.offsetX + b.halfX;
          const bMinZ = cellCz + b.offsetZ - b.halfZ;
          const bMaxZ = cellCz + b.offsetZ + b.halfZ;
          // Check if player is inside this box (not just within radius)
          if (x > bMinX - playerRadius && x < bMaxX + playerRadius &&
              z > bMinZ - playerRadius && z < bMaxZ + playerRadius) {
            const closestX = Math.max(bMinX, Math.min(x, bMaxX));
            const closestZ = Math.max(bMinZ, Math.min(z, bMaxZ));
            const dx = x - closestX;
            const dz = z - closestZ;
            const distSq = dx * dx + dz * dz;
            if (distSq < playerRadius * playerRadius) {
              if (distSq < 1e-8) {
                const penX = Math.min(x - bMinX, bMaxX - x);
                const penZ = Math.min(z - bMinZ, bMaxZ - z);
                if (penX < penZ) {
                  x += (x < (bMinX + bMaxX) / 2 ? -(penX + playerRadius) : (penX + playerRadius));
                } else {
                  z += (z < (bMinZ + bMaxZ) / 2 ? -(penZ + playerRadius) : (penZ + playerRadius));
                }
              } else {
                const dist = Math.sqrt(distSq);
                const push = (playerRadius - dist) / dist;
                x += dx * push;
                z += dz * push;
              }
              safetyPushed = true;
            }
          }
        }
      }
      if (!safetyPushed) break;
    }

    return { x, z, floorY };
  }

  // --- 3D Raycast against existing cells (ship-local space) ---

  raycastCells(
    entityId: number,
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDist: number,
  ): RaycastResult | null {
    const grid = this.boats.get(entityId);
    if (!grid) return null;

    let bestT = Infinity;
    let bestFace = -1;
    let bestCell: BoatCell | null = null;

    const cells = this.getCells(entityId);
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      // Skip non-solid, non-walkable cells (RAIL, LANTERN, SAIL) — they shouldn't
      // intercept the build ray. Only solid cells and walkable surfaces (DECK, BRIDGE)
      // are valid raycast targets for placement.
      if (!hasSolidCollision(cell.type) && !isWalkableSurface(cell.type)) continue;
      const size = getCellSize(cell.type, cell.rotation);
      const minX = cell.gridX * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const maxX = (cell.gridX + size.sizeX - 1) * BOAT_CELL_WORLD_SIZE + BOAT_CELL_WORLD_SIZE / 2;
      // Walkable surfaces (DECK, BRIDGE) have a very thin collision slab (0.1 units)
      // which is nearly impossible to hit with a ray. Use a thicker slab for raycasting
      // while keeping the top surface at the layer base for correct placement.
      const walkable = isWalkableSurface(cell.type);
      const minY = walkable
        ? cell.gridY * BOAT_LAYER_HEIGHT - 0.3
        : getCellCollisionBottomY(cell.type, cell.gridY);
      const maxY = walkable
        ? cell.gridY * BOAT_LAYER_HEIGHT
        : getCellCollisionTopY(cell.type, cell.gridY) +
          (size.sizeY > 1 ? (size.sizeY - 1) * BOAT_LAYER_HEIGHT : 0);
      const minZ = cell.gridZ * BOAT_CELL_WORLD_SIZE - BOAT_CELL_WORLD_SIZE / 2;
      const maxZ = (cell.gridZ + size.sizeZ - 1) * BOAT_CELL_WORLD_SIZE + BOAT_CELL_WORLD_SIZE / 2;

      // Slab method ray-AABB intersection
      let tmin = -Infinity;
      let tmax = Infinity;
      let hitFace = -1;

      // X axis
      if (Math.abs(dirX) < 1e-8) {
        if (originX < minX || originX > maxX) continue;
      } else {
        const t1 = (minX - originX) / dirX;
        const t2 = (maxX - originX) / dirX;
        const tn = Math.min(t1, t2);
        const tf = Math.max(t1, t2);
        if (tn > tmin) {
          tmin = tn;
          hitFace = dirX > 0 ? 3 : 1; // hitting min-X=left(3) or max-X=right(1)
        }
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }

      // Y axis
      if (Math.abs(dirY) < 1e-8) {
        if (originY < minY || originY > maxY) continue;
      } else {
        const t1 = (minY - originY) / dirY;
        const t2 = (maxY - originY) / dirY;
        const tn = Math.min(t1, t2);
        const tf = Math.max(t1, t2);
        if (tn > tmin) {
          tmin = tn;
          hitFace = dirY > 0 ? 5 : 4; // hitting min-Y=bottom(5) or max-Y=top(4)
        }
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }

      // Z axis
      if (Math.abs(dirZ) < 1e-8) {
        if (originZ < minZ || originZ > maxZ) continue;
      } else {
        const t1 = (minZ - originZ) / dirZ;
        const t2 = (maxZ - originZ) / dirZ;
        const tn = Math.min(t1, t2);
        const tf = Math.max(t1, t2);
        if (tn > tmin) {
          tmin = tn;
          hitFace = dirZ > 0 ? 0 : 2; // hitting min-Z=front(0) or max-Z=back(2)
        }
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }

      if (tmin < 0 || tmin > maxDist) continue;
      if (tmin < bestT) {
        bestT = tmin;
        bestFace = hitFace;
        bestCell = cell;
      }
    }

    if (!bestCell || bestFace < 0) return null;

    // Compute placement position based on hit face
    const [fdx, fdy, fdz] = DIR_OFFSETS[bestFace];
    return {
      gridX: bestCell.gridX + fdx,
      gridY: bestCell.gridY + fdy,
      gridZ: bestCell.gridZ + fdz,
      face: bestFace,
    };
  }

  // --- Buffer sync ---

  writeToBuffer(): void {
    if (!this.bufferWriter) return;
    if (!this.bufferDirty) return;
    this.bufferDirty = false;
    let count = 0;
    const grids = Array.from(this.boats.values());
    for (let gi = 0; gi < grids.length; gi++) {
      const grid = grids[gi];
      // Write unique origin cells only (multi-cell fills positions with same reference)
      const seen = new Set<string>();
      const cells: BoatCell[] = [];
      const cellValues = Array.from(grid.cells.values());
      for (let ci = 0; ci < cellValues.length; ci++) {
        const cell = cellValues[ci];
        const originKey = `${cell.gridX},${cell.gridY},${cell.gridZ}`;
        if (seen.has(originKey)) continue;
        seen.add(originKey);
        cells.push(cell);
      }
      this.bufferWriter.writeBoat(grid.bufferSlot, grid.entityId, cells);
      count++;
    }
    this.bufferWriter.setBoatCount(count);
    this.bufferWriter.incrementSequence();
  }

  setPreview(boatSlot: number, gridX: number, gridY: number, gridZ: number, cellType: number, visible: boolean, rotation: number = 0): void {
    this.bufferWriter?.setPreview(boatSlot, gridX, gridZ, gridY, cellType, visible, rotation);
  }

  clearPreview(): void {
    this.bufferWriter?.clearPreview();
  }

  getBufferSlot(entityId: number): number {
    const grid = this.boats.get(entityId);
    return grid ? grid.bufferSlot : -1;
  }

  // --- Internal helpers ---

  private addCellInternal(grid: BoatGrid, type: number, rotation: number, gridX: number, gridY: number, gridZ: number): void {
    const size = getCellSize(type, rotation);
    const cell: BoatCell = { type, rotation, gridX, gridY, gridZ, sizeX: size.sizeX, sizeY: size.sizeY, sizeZ: size.sizeZ };
    this.addCellPositions(grid, cell);
  }

  // Register all occupied positions for a cell in the grid map
  private addCellPositions(grid: BoatGrid, cell: BoatCell): void {
    for (let sx = 0; sx < cell.sizeX; sx++) {
      for (let sy = 0; sy < cell.sizeY; sy++) {
        for (let sz = 0; sz < cell.sizeZ; sz++) {
          grid.cells.set(`${cell.gridX + sx},${cell.gridY + sy},${cell.gridZ + sz}`, cell);
        }
      }
    }
  }

  // Remove all occupied positions for a cell from the grid map
  private removeCellPositions(grid: BoatGrid, cell: BoatCell): void {
    for (let sx = 0; sx < cell.sizeX; sx++) {
      for (let sy = 0; sy < cell.sizeY; sy++) {
        for (let sz = 0; sz < cell.sizeZ; sz++) {
          grid.cells.delete(`${cell.gridX + sx},${cell.gridY + sy},${cell.gridZ + sz}`);
        }
      }
    }
  }

  private hasAdjacent(grid: BoatGrid, gridX: number, gridY: number, gridZ: number): boolean {
    for (let di = 0; di < DIR_OFFSETS.length; di++) {
      const [dx, dy, dz] = DIR_OFFSETS[di];
      if (grid.cells.has(`${gridX + dx},${gridY + dy},${gridZ + dz}`)) return true;
    }
    return false;
  }

  // Check adjacency for multi-cell placement: any edge of the multi-cell footprint
  // must be adjacent to an existing cell
  private hasAdjacentMulti(grid: BoatGrid, gridX: number, gridY: number, gridZ: number, size: { sizeX: number; sizeY: number; sizeZ: number }): boolean {
    for (let sx = 0; sx < size.sizeX; sx++) {
      for (let sy = 0; sy < size.sizeY; sy++) {
        for (let sz = 0; sz < size.sizeZ; sz++) {
          if (this.hasAdjacent(grid, gridX + sx, gridY + sy, gridZ + sz)) return true;
        }
      }
    }
    return false;
  }

  private canRemoveWithoutDisconnect(grid: BoatGrid, gridX: number, gridY: number, gridZ: number): boolean {
    // Find the origin cell at this position
    const cell = grid.cells.get(`${gridX},${gridY},${gridZ}`);
    if (!cell) return true;

    // Collect all positions occupied by this cell (for multi-cell types)
    const occupiedKeys = new Set<string>();
    for (let sx = 0; sx < cell.sizeX; sx++) {
      for (let sy = 0; sy < cell.sizeY; sy++) {
        for (let sz = 0; sz < cell.sizeZ; sz++) {
          occupiedKeys.add(`${cell.gridX + sx},${cell.gridY + sy},${cell.gridZ + sz}`);
        }
      }
    }

    // Simple check: if only 1 cell left after removal, it's fine
    if (grid.cells.size <= occupiedKeys.size) return true;

    // BFS from any remaining cell (not the one being removed) to see if all others are reachable
    // Use unique origin cells only (multi-cell fills multiple positions with same reference)
    const remainingOrigins = new Map<string, BoatCell>();
    const cellEntries = Array.from(grid.cells.entries());
    for (let ci = 0; ci < cellEntries.length; ci++) {
      const [key, c] = cellEntries[ci];
      if (occupiedKeys.has(key)) continue;
      const originKey = `${c.gridX},${c.gridY},${c.gridZ}`;
      if (!remainingOrigins.has(originKey)) remainingOrigins.set(originKey, c);
    }
    const remainingKeys = new Set(remainingOrigins.keys());
    if (remainingKeys.size <= 1) return true;

    const visited = new Set<string>();
    const firstOrigin = remainingOrigins.values().next().value!;
    const queue: BoatCell[] = [firstOrigin];
    visited.add(`${firstOrigin.gridX},${firstOrigin.gridY},${firstOrigin.gridZ}`);

    while (queue.length > 0) {
      const c = queue.shift()!;
      for (let di = 0; di < DIR_OFFSETS.length; di++) {
        const [dx, dy, dz] = DIR_OFFSETS[di];
        const key = `${c.gridX + dx},${c.gridY + dy},${c.gridZ + dz}`;
        if (visited.has(key)) continue;
        const neighbor = grid.cells.get(key);
        if (!neighbor) continue;
        if (occupiedKeys.has(key)) continue;
        const originKey = `${neighbor.gridX},${neighbor.gridY},${neighbor.gridZ}`;
        if (visited.has(originKey)) continue;
        visited.add(originKey);
        queue.push(neighbor);
      }
    }

    return visited.size === remainingKeys.size;
  }
}

const DEFAULT_MASS_PROPERTIES: BoatMassProperties = {
  mass: 4000,
  invMass: 1 / 4000,
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  Iyy: 40000,
  invIyy: 1 / 40000,
  Ixx: 20000,
  invIxx: 1 / 20000,
  Izz: 20000,
  invIzz: 1 / 20000,
  radius: 4,
  halfLength: 4,
  halfWidth: 2,
  bboxCenterX: 0,
  bboxCenterZ: 0,
};

// Direction offsets: 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X), 4=up(+Y), 5=down(-Y)
const DIR_OFFSETS: [number, number, number][] = [
  [0, 0, -1], // 0: front (-Z)
  [1, 0, 0],  // 1: right (+X)
  [0, 0, 1],  // 2: back (+Z)
  [-1, 0, 0], // 3: left (-X)
  [0, 1, 0],  // 4: up (+Y)
  [0, -1, 0], // 5: down (-Y)
];
