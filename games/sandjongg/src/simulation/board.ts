// ============================================================================
// TileBoard — pure puzzle board state with multi-layer support.
// ============================================================================
//
// Tiles are stored in a 3D structure: tiles[(col + row*cols) * MAX_LAYERS + layer].
//
// Selectability uses a per-layer top-down lock: a tile is selectable only if it
// sits on the highest occupied layer (maxOccupiedLayer). Lower layers stay
// locked until every layer above them is fully cleared — you clear the board
// top-down, one layer at a time.
//
// Pathfinding (Shisen-Sho connect) operates within a single layer: the path
// can only traverse cells that are empty on that specific layer.
//

import { MAX_LAYERS } from "../shared/constants";
import type { SerializedBoard, Tile } from "../shared/types";

export class TileBoard {
  readonly cols: number;
  readonly rows: number;
  readonly maxLayers: number;
  /** tiles[(col + row*cols) * MAX_LAYERS + layer] or null. */
  readonly tiles: (Tile | null)[];
  private nextId: number;

  constructor(cols: number, rows: number, maxLayers: number = 1) {
    this.cols = cols;
    this.rows = rows;
    this.maxLayers = Math.max(1, Math.min(MAX_LAYERS, maxLayers));
    this.tiles = new Array(cols * rows * MAX_LAYERS).fill(null);
    this.nextId = 0;
  }

  /** Get the tile at (col, row, layer), or null if empty/out-of-bounds. */
  at(col: number, row: number, layer: number = 0): Tile | null {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
    if (layer < 0 || layer >= this.maxLayers) return null;
    return this.tiles[(col + row * this.cols) * MAX_LAYERS + layer];
  }

  /** Get the topmost tile at (col, row) — the one on the highest occupied layer. */
  topTile(col: number, row: number): Tile | null {
    for (let layer = this.maxLayers - 1; layer >= 0; layer--) {
      const t = this.at(col, row, layer);
      if (t !== null) return t;
    }
    return null;
  }

  /** Highest layer index that contains any tile, or -1 if the board is empty. */
  maxOccupiedLayer(): number {
    for (let layer = this.maxLayers - 1; layer >= 0; layer--) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (this.tiles[(c + r * this.cols) * MAX_LAYERS + layer] !== null) return layer;
        }
      }
    }
    return -1;
  }

  /** Is the tile at (col, row, layer) selectable? Per-layer top-down lock: only
   *  tiles on the highest occupied layer are selectable — a layer stays locked
   *  until the layer above is fully cleared. */
  isSelectable(col: number, row: number, layer: number): boolean {
    if (this.at(col, row, layer) === null) return false;
    return layer === this.maxOccupiedLayer();
  }

  /** Place a tile at (col, row, layer). Returns the placed tile. */
  place(col: number, row: number, element: number, layer: number = 0): Tile {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      throw new Error(`place out of bounds: (${col},${row})`);
    }
    if (layer < 0 || layer >= this.maxLayers) {
      throw new Error(`place layer out of bounds: ${layer}`);
    }
    const tile: Tile = { id: this.nextId++, element, col, row, layer };
    this.tiles[(col + row * this.cols) * MAX_LAYERS + layer] = tile;
    return tile;
  }

  /** Remove the tile at (col, row, layer). Returns the removed tile or null. */
  remove(col: number, row: number, layer: number = 0): Tile | null {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
    if (layer < 0 || layer >= this.maxLayers) return null;
    const idx = (col + row * this.cols) * MAX_LAYERS + layer;
    const tile = this.tiles[idx];
    this.tiles[idx] = null;
    return tile;
  }

  /** Is the cell at (col, row, layer) empty? Out-of-bounds returns false. */
  isEmpty(col: number, row: number, layer: number = 0): boolean {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
    if (layer < 0 || layer >= this.maxLayers) return false;
    return this.tiles[(col + row * this.cols) * MAX_LAYERS + layer] === null;
  }

  /** Total number of tiles remaining across all layers. */
  remainingCount(): number {
    let count = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] !== null) count++;
    }
    return count;
  }

  /** Number of distinct element types still on the board. */
  elementsLeft(): number {
    const seen = new Set<number>();
    for (const t of this.tiles) {
      if (t !== null) seen.add(t.element);
    }
    return seen.size;
  }

  /** Get all remaining tiles. */
  allTiles(): Tile[] {
    const out: Tile[] = [];
    for (const t of this.tiles) {
      if (t !== null) out.push(t);
    }
    return out;
  }

  /** Get all selectable tiles — all tiles on the highest occupied layer
   *  (the only layer that is unlocked under the per-layer top-down rule). */
  selectableTiles(): Tile[] {
    const top = this.maxOccupiedLayer();
    if (top < 0) return [];
    const out: Tile[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const t = this.at(c, r, top);
        if (t !== null) out.push(t);
      }
    }
    return out;
  }

  /** Is the board fully cleared? */
  isCleared(): boolean {
    return this.remainingCount() === 0;
  }

  /** Serialize for saves. */
  serialize(): SerializedBoard {
    const tiles = new Array(this.cols * this.rows * this.maxLayers);
    for (let l = 0; l < this.maxLayers; l++) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const t = this.at(c, r, l);
          tiles[(c + r * this.cols) * this.maxLayers + l] = t !== null ? t.element : -1;
        }
      }
    }
    return { cols: this.cols, rows: this.rows, maxLayers: this.maxLayers, tiles, nextId: this.nextId };
  }

  /** Deserialize from saves. */
  static deserialize(data: SerializedBoard): TileBoard {
    const maxLayers = data.maxLayers ?? 1;
    const board = new TileBoard(data.cols, data.rows, maxLayers);
    board.nextId = data.nextId;
    for (let l = 0; l < maxLayers; l++) {
      for (let r = 0; r < data.rows; r++) {
        for (let c = 0; c < data.cols; c++) {
          const el = data.tiles[(c + r * data.cols) * maxLayers + l];
          if (el >= 0) {
            board.tiles[(c + r * data.cols) * MAX_LAYERS + l] = { id: board.nextId++, element: el, col: c, row: r, layer: l };
          }
        }
      }
    }
    return board;
  }
}
