// ============================================================================
// Overburden — tree species + vine species
//
// Defines the 13 tree species (coconut, maple, orange, apple, lemon, lime,
// banana, spruce, pear, cherry, pomegranate, walnut, hazelnut) and the 2 vine
// species (kiwi, grape). Each tree species has:
//   - its own wood + leaf block IDs (so it renders with a distinct palette color)
//   - a distinct canopy/trunk shape generator
//   - a fruit item dropped by its leaves
//
// Vines are not trees: they climb on trees (background plane, layer 3), walls
// (foreground plane, layer 2), or trellis (foreground plane, layer 1). They
// grow during terrain generation (climbing existing trees) and continue to
// grow during the sim tick (climbing player-placed walls/trellis).
//
// Helper predicates (isWoodBlock, isLeafBlock, isTreeBlock, isVineBlock) are
// used by the renderer + worker so they don't hardcode BLOCK_WOOD/BLOCK_LEAVES
// checks that would miss the per-species blocks.
// ============================================================================

import {
    BLOCK_LEAF_APPLE, BLOCK_LEAF_BANANA, BLOCK_LEAF_CHERRY, BLOCK_LEAF_COCONUT,
    BLOCK_LEAF_HAZELNUT, BLOCK_LEAF_LEMON, BLOCK_LEAF_LIME, BLOCK_LEAF_MAPLE,
    BLOCK_LEAF_ORANGE, BLOCK_LEAF_PEAR, BLOCK_LEAF_POMEGRANATE, BLOCK_LEAF_SPRUCE,
    BLOCK_LEAF_WALNUT, BLOCK_LEAVES,
    BLOCK_VINE_GRAPE, BLOCK_VINE_KIWI,
    BLOCK_WOOD, BLOCK_WOOD_APPLE, BLOCK_WOOD_BANANA, BLOCK_WOOD_CHERRY,
    BLOCK_WOOD_COCONUT, BLOCK_WOOD_HAZELNUT, BLOCK_WOOD_LEMON, BLOCK_WOOD_LIME,
    BLOCK_WOOD_MAPLE, BLOCK_WOOD_ORANGE, BLOCK_WOOD_PEAR, BLOCK_WOOD_POMEGRANATE,
    BLOCK_WOOD_SPRUCE, BLOCK_WOOD_WALNUT,
    CHUNK_H, CHUNK_W,
} from "./constants";
import type { Chunk } from "./types";

// Inline cell index (row-major: y * CHUNK_W + x) to avoid a shared→simulation
// cross-layer import. Matches cellIndex() in simulation/chunk.ts.
function cellIdx(lx: number, ly: number): number {
  return ly * CHUNK_W + lx;
}

// --- Block ID sets (for fast predicate checks) ---
export const WOOD_BLOCK_IDS: ReadonlySet<number> = new Set([
  BLOCK_WOOD,
  BLOCK_WOOD_COCONUT, BLOCK_WOOD_MAPLE, BLOCK_WOOD_ORANGE, BLOCK_WOOD_APPLE,
  BLOCK_WOOD_LEMON, BLOCK_WOOD_LIME, BLOCK_WOOD_BANANA, BLOCK_WOOD_SPRUCE,
  BLOCK_WOOD_PEAR, BLOCK_WOOD_CHERRY, BLOCK_WOOD_POMEGRANATE, BLOCK_WOOD_WALNUT,
  BLOCK_WOOD_HAZELNUT,
]);

export const LEAF_BLOCK_IDS: ReadonlySet<number> = new Set([
  BLOCK_LEAVES,
  BLOCK_LEAF_COCONUT, BLOCK_LEAF_MAPLE, BLOCK_LEAF_ORANGE, BLOCK_LEAF_APPLE,
  BLOCK_LEAF_LEMON, BLOCK_LEAF_LIME, BLOCK_LEAF_BANANA, BLOCK_LEAF_SPRUCE,
  BLOCK_LEAF_PEAR, BLOCK_LEAF_CHERRY, BLOCK_LEAF_POMEGRANATE, BLOCK_LEAF_WALNUT,
  BLOCK_LEAF_HAZELNUT,
]);

export const VINE_BLOCK_IDS: ReadonlySet<number> = new Set([
  BLOCK_VINE_KIWI, BLOCK_VINE_GRAPE,
]);

export function isWoodBlock(id: number): boolean {
  return WOOD_BLOCK_IDS.has(id & 0xFF);
}

export function isLeafBlock(id: number): boolean {
  return LEAF_BLOCK_IDS.has(id & 0xFF);
}

/** A "tree block" is any wood or leaf block (any species). */
export function isTreeBlock(id: number): boolean {
  const b = id & 0xFF;
  return WOOD_BLOCK_IDS.has(b) || LEAF_BLOCK_IDS.has(b);
}

export function isVineBlock(id: number): boolean {
  return VINE_BLOCK_IDS.has(id & 0xFF);
}

// --- Species IDs ---
// Stable enum for species selection. Order matches the user's list.
export type TreeSpeciesId =
  | "coconut" | "maple" | "orange" | "apple" | "lemon" | "lime"
  | "banana" | "spruce" | "pear" | "cherry" | "pomegranate"
  | "walnut" | "hazelnut";

export type VineSpeciesId = "kiwi" | "grape";

export interface TreeSpecies {
  id: TreeSpeciesId;
  name: string;
  woodBlock: number;
  leafBlock: number;
  /** Fruit item dropped by leaves (undefined = no fruit, just sticks). */
  fruitItem?: string;
  /** Fruit drop chance per leaf block mined (0-1). */
  fruitChance: number;
  /** Min/max trunk height (blocks). */
  trunkMin: number;
  trunkMax: number;
  /** Relative spawn weight (higher = more common). */
  weight: number;
  /**
   * Place the canopy (leaves) into the background plane.
   * `lx, ly` = the ground cell (where the trunk base sits).
   * `trunkTopLy` = the local Y of the top trunk block (trunk grows upward,
   *   so trunkTopLy < ly). The canopy is placed above + around the trunk top.
   * `trunkHeight` = the trunk height that was generated.
   * `treeTag` = per-tree group ID stored in the upper 8 bits of the background
   *   Uint16 so felling flood-fill stays within one tree.
   */
  placeCanopy(
    chunk: Chunk,
    lx: number,
    ly: number,
    trunkTopLy: number,
    trunkHeight: number,
    leafBlock: number,
    treeTag: number,
  ): void;
}

// --- Tree tag helpers ---
// The tree tag is stored in the upper 8 bits of the background Uint16Array
// value (bits 8-15). The lower 8 bits hold the block ID. The renderer and
// sim already mask with & 0xFF, so the tag is invisible to them. The tag
// lets fellTree flood-fill only within a single tree, preventing connected
// canopies from felling neighboring trees.
export function makeTaggedBlock(blockId: number, treeTag: number): number {
  return (blockId & 0xFF) | ((treeTag & 0xFF) << 8);
}

export function getTreeTag(packedBg: number): number {
  return (packedBg >> 8) & 0xFF;
}

// --- Shape helpers ---
// All shapes place leaves into the BACKGROUND plane, only into cells that are
// currently BLOCK_AIR (so they don't overwrite trunk wood or terrain).
// Leaves are tagged with the tree's group ID so felling stays within one tree.

function tryPlaceLeaf(chunk: Chunk, lx: number, ly: number, leafBlock: number, treeTag: number): void {
  if (lx < 0 || lx >= CHUNK_W || ly < 0 || ly >= CHUNK_H) return;
  const idx = cellIdx(lx, ly);
  if (chunk.background[idx] === 0 /* BLOCK_AIR */) {
    chunk.background[idx] = makeTaggedBlock(leafBlock, treeTag);
  }
}

// Round dome: filled ellipse centered above the trunk top.
function placeDome(
  chunk: Chunk, lx: number, ly: number, trunkTopLy: number,
  _trunkHeight: number, leafBlock: number, treeTag: number,
  radiusX: number, radiusY: number,
): void {
  const cx = lx;
  const cy = trunkTopLy - Math.floor(radiusY * 0.5) - 1;
  for (let dy = -radiusY; dy <= radiusY; dy++) {
    for (let dx = -radiusX; dx <= radiusX; dx++) {
      // Ellipse fill test (slightly relaxed so the canopy is bushy)
      const ex = dx / (radiusX + 0.5);
      const ey = dy / (radiusY + 0.5);
      if (ex * ex + ey * ey <= 1.0) {
        tryPlaceLeaf(chunk, cx + dx, cy + dy, leafBlock, treeTag);
      }
    }
  }
}

// Conical (spruce): triangle widening downward from the top.
function placeCone(
  chunk: Chunk, lx: number, ly: number, trunkTopLy: number,
  trunkHeight: number, leafBlock: number, treeTag: number,
): void {
  const top = trunkTopLy - 1;
  const layers = Math.max(3, Math.floor(trunkHeight * 0.7));
  for (let i = 0; i < layers; i++) {
    const y = top - i;
    const halfW = Math.floor((i + 1) * 0.6); // widens going down
    for (let dx = -halfW; dx <= halfW; dx++) {
      // Skip the very corners for a softer triangle
      if (Math.abs(dx) === halfW && i > 0 && (i % 2 === 0)) continue;
      tryPlaceLeaf(chunk, lx + dx, y, leafBlock, treeTag);
    }
  }
}

// Palm (coconut): small frond cross at the top, 2 blocks tall.
function placePalmFronds(
  chunk: Chunk, lx: number, ly: number, trunkTopLy: number,
  _trunkHeight: number, leafBlock: number, treeTag: number,
): void {
  const y = trunkTopLy - 1;
  // Horizontal fronds
  for (let dx = -2; dx <= 2; dx++) {
    tryPlaceLeaf(chunk, lx + dx, y, leafBlock, treeTag);
    tryPlaceLeaf(chunk, lx + dx, y - 1, leafBlock, treeTag);
  }
  // A couple of top caps
  tryPlaceLeaf(chunk, lx, y - 2, leafBlock, treeTag);
  tryPlaceLeaf(chunk, lx - 1, y - 2, leafBlock, treeTag);
  tryPlaceLeaf(chunk, lx + 1, y - 2, leafBlock, treeTag);
}

// Banana: drooping leaves — wide at top, hanging down on the sides.
function placeBananaCanopy(
  chunk: Chunk, lx: number, ly: number, trunkTopLy: number,
  _trunkHeight: number, leafBlock: number, treeTag: number,
): void {
  const y = trunkTopLy - 1;
  // Wide top
  for (let dx = -2; dx <= 2; dx++) {
    tryPlaceLeaf(chunk, lx + dx, y, leafBlock, treeTag);
  }
  // Drooping sides (hang down 2-3 blocks)
  for (let dy = 1; dy <= 3; dy++) {
    tryPlaceLeaf(chunk, lx - 2, y + dy, leafBlock, treeTag);
    tryPlaceLeaf(chunk, lx + 2, y + dy, leafBlock, treeTag);
  }
  // Top cap
  tryPlaceLeaf(chunk, lx, y - 1, leafBlock, treeTag);
  tryPlaceLeaf(chunk, lx - 1, y - 1, leafBlock, treeTag);
  tryPlaceLeaf(chunk, lx + 1, y - 1, leafBlock, treeTag);
}

// Bushy small (hazelnut, lime): compact 3x3-ish blob.
function placeBush(
  chunk: Chunk, lx: number, ly: number, trunkTopLy: number,
  _trunkHeight: number, leafBlock: number, treeTag: number,
  radius: number,
): void {
  const cy = trunkTopLy - radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ex = dx / (radius + 0.3);
      const ey = dy / (radius + 0.3);
      if (ex * ex + ey * ey <= 1.0) {
        tryPlaceLeaf(chunk, lx + dx, cy + dy, leafBlock, treeTag);
      }
    }
  }
}

// --- Species table ---
export const TREE_SPECIES: TreeSpecies[] = [
  {
    id: "coconut", name: "Coconut",
    woodBlock: BLOCK_WOOD_COCONUT, leafBlock: BLOCK_LEAF_COCONUT,
    fruitItem: "coconut", fruitChance: 0.08,
    trunkMin: 6, trunkMax: 10, weight: 1.0,
    placeCanopy: placePalmFronds,
  },
  {
    id: "maple", name: "Maple",
    woodBlock: BLOCK_WOOD_MAPLE, leafBlock: BLOCK_LEAF_MAPLE,
    fruitItem: undefined, fruitChance: 0,
    trunkMin: 4, trunkMax: 6, weight: 1.4,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 3, 2),
  },
  {
    id: "orange", name: "Orange",
    woodBlock: BLOCK_WOOD_ORANGE, leafBlock: BLOCK_LEAF_ORANGE,
    fruitItem: "orange", fruitChance: 0.10,
    trunkMin: 4, trunkMax: 5, weight: 1.0,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 2, 2),
  },
  {
    id: "apple", name: "Apple",
    woodBlock: BLOCK_WOOD_APPLE, leafBlock: BLOCK_LEAF_APPLE,
    fruitItem: "apple", fruitChance: 0.10,
    trunkMin: 4, trunkMax: 5, weight: 1.2,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 2, 2),
  },
  {
    id: "lemon", name: "Lemon",
    woodBlock: BLOCK_WOOD_LEMON, leafBlock: BLOCK_LEAF_LEMON,
    fruitItem: "lemon", fruitChance: 0.10,
    trunkMin: 3, trunkMax: 4, weight: 0.9,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 2, 2),
  },
  {
    id: "lime", name: "Lime",
    woodBlock: BLOCK_WOOD_LIME, leafBlock: BLOCK_LEAF_LIME,
    fruitItem: "lime", fruitChance: 0.10,
    trunkMin: 3, trunkMax: 4, weight: 0.9,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeBush(c, lx, ly, top, h, lb, tag, 2),
  },
  {
    id: "banana", name: "Banana",
    woodBlock: BLOCK_WOOD_BANANA, leafBlock: BLOCK_LEAF_BANANA,
    fruitItem: "banana", fruitChance: 0.12,
    trunkMin: 5, trunkMax: 7, weight: 0.8,
    placeCanopy: placeBananaCanopy,
  },
  {
    id: "spruce", name: "Spruce",
    woodBlock: BLOCK_WOOD_SPRUCE, leafBlock: BLOCK_LEAF_SPRUCE,
    fruitItem: undefined, fruitChance: 0,
    trunkMin: 6, trunkMax: 9, weight: 1.1,
    placeCanopy: placeCone,
  },
  {
    id: "pear", name: "Pear",
    woodBlock: BLOCK_WOOD_PEAR, leafBlock: BLOCK_LEAF_PEAR,
    fruitItem: "pear", fruitChance: 0.10,
    trunkMin: 4, trunkMax: 5, weight: 0.9,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 2, 2),
  },
  {
    id: "cherry", name: "Cherry",
    woodBlock: BLOCK_WOOD_CHERRY, leafBlock: BLOCK_LEAF_CHERRY,
    fruitItem: "cherry", fruitChance: 0.12,
    trunkMin: 4, trunkMax: 5, weight: 1.0,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 3, 2),
  },
  {
    id: "pomegranate", name: "Pomegranate",
    woodBlock: BLOCK_WOOD_POMEGRANATE, leafBlock: BLOCK_LEAF_POMEGRANATE,
    fruitItem: "pomegranate", fruitChance: 0.10,
    trunkMin: 3, trunkMax: 4, weight: 0.8,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeBush(c, lx, ly, top, h, lb, tag, 2),
  },
  {
    id: "walnut", name: "Walnut",
    woodBlock: BLOCK_WOOD_WALNUT, leafBlock: BLOCK_LEAF_WALNUT,
    fruitItem: "walnut", fruitChance: 0.08,
    trunkMin: 5, trunkMax: 7, weight: 0.9,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeDome(c, lx, ly, top, h, lb, tag, 3, 2),
  },
  {
    id: "hazelnut", name: "Hazelnut",
    woodBlock: BLOCK_WOOD_HAZELNUT, leafBlock: BLOCK_LEAF_HAZELNUT,
    fruitItem: "hazelnut", fruitChance: 0.10,
    trunkMin: 3, trunkMax: 4, weight: 0.8,
    placeCanopy: (c, lx, ly, top, h, lb, tag) => placeBush(c, lx, ly, top, h, lb, tag, 1),
  },
];

export const TREE_SPECIES_BY_ID = new Map<string, TreeSpecies>(
  TREE_SPECIES.map((s) => [s.id, s]),
);

// Total weight for species selection.
const TOTAL_WEIGHT = TREE_SPECIES.reduce((sum, s) => sum + s.weight, 0);

/**
 * Deterministically pick a tree species for a given world cell.
 * `r` is a pre-rolled random value in [0, 1) (from hash2).
 */
export function pickTreeSpecies(r: number): TreeSpecies {
  let acc = r * TOTAL_WEIGHT;
  for (const s of TREE_SPECIES) {
    acc -= s.weight;
    if (acc <= 0) return s;
  }
  return TREE_SPECIES[TREE_SPECIES.length - 1];
}

// --- Vine species ---
export interface VineSpecies {
  id: VineSpeciesId;
  name: string;
  block: number;
  fruitItem: string;
  fruitChance: number;
  /** Relative spawn weight when a vine is planted at a tree base. */
  weight: number;
  /** Max climb height (blocks) above the planting point. */
  maxHeight: number;
}

export const VINE_SPECIES: VineSpecies[] = [
  {
    id: "kiwi", name: "Kiwi",
    block: BLOCK_VINE_KIWI,
    fruitItem: "kiwi", fruitChance: 0.06,
    weight: 1.0, maxHeight: 9,
  },
  {
    id: "grape", name: "Grape",
    block: BLOCK_VINE_GRAPE,
    fruitItem: "grape", fruitChance: 0.08,
    weight: 1.0, maxHeight: 8,
  },
];

const TOTAL_VINE_WEIGHT = VINE_SPECIES.reduce((sum, v) => sum + v.weight, 0);

export function pickVineSpecies(r: number): VineSpecies {
  let acc = r * TOTAL_VINE_WEIGHT;
  for (const v of VINE_SPECIES) {
    acc -= v.weight;
    if (acc <= 0) return v;
  }
  return VINE_SPECIES[VINE_SPECIES.length - 1];
}

export function getVineSpeciesForBlock(blockId: number): VineSpecies | undefined {
  const b = blockId & 0xFF;
  return VINE_SPECIES.find((v) => v.block === b);
}
