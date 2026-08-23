// ============================================================================
// Overburden — drop item registry
//
// Maps item IDs (strings) to small integer codes for storage in the SAB's
// drop region. The renderer uses the code to look up a display color.
//
// Only items that can appear as world drops need to be registered here.
// ============================================================================

import { getItemDef } from "./items";

// --- Drop item codes (stored as float in SAB, so keep small) ---
export const DROP_NONE = 0;
export const DROP_WOOD = 1;
export const DROP_STICK = 2;
export const DROP_DIRT = 3;
export const DROP_STONE = 4;
export const DROP_SAND = 5;
export const DROP_CLAY = 6;
export const DROP_GRAVEL = 7;
export const DROP_COAL = 8;
export const DROP_COPPER_ORE = 9;
export const DROP_TIN_ORE = 10;
export const DROP_IRON_ORE = 11;
export const DROP_GOLD_ORE = 12;
export const DROP_CRYSTAL = 13;
export const DROP_FLINT = 14;
export const DROP_TORCH = 15;
export const DROP_LADDER = 16;
export const DROP_ROPE = 17;
export const DROP_SCAFFOLDING = 18;
export const DROP_GRASS = 19;
// Fruits
export const DROP_COCONUT = 20;
export const DROP_ORANGE = 21;
export const DROP_APPLE = 22;
export const DROP_LEMON = 23;
export const DROP_LIME = 24;
export const DROP_BANANA = 25;
export const DROP_PEAR = 26;
export const DROP_CHERRY = 27;
export const DROP_POMEGRANATE = 28;
export const DROP_WALNUT = 29;
export const DROP_HAZELNUT = 30;
export const DROP_KIWI = 31;
export const DROP_GRAPE = 32;
export const DROP_SEED = 33; // tree seed (spinning 2D drop on tree leaves)

const ITEM_TO_CODE = new Map<string, number>([
  ["wood", DROP_WOOD],
  ["stick", DROP_STICK],
  ["dirt", DROP_DIRT],
  ["stone", DROP_STONE],
  ["sand", DROP_SAND],
  ["clay", DROP_CLAY],
  ["gravel", DROP_GRAVEL],
  ["coal", DROP_COAL],
  ["copper_ore", DROP_COPPER_ORE],
  ["tin_ore", DROP_TIN_ORE],
  ["iron_ore", DROP_IRON_ORE],
  ["gold_ore", DROP_GOLD_ORE],
  ["crystal", DROP_CRYSTAL],
  ["flint", DROP_FLINT],
  ["torch", DROP_TORCH],
  ["ladder", DROP_LADDER],
  ["rope", DROP_ROPE],
  ["scaffolding", DROP_SCAFFOLDING],
  ["grass", DROP_GRASS],
  ["coconut", DROP_COCONUT],
  ["orange", DROP_ORANGE],
  ["apple", DROP_APPLE],
  ["lemon", DROP_LEMON],
  ["lime", DROP_LIME],
  ["banana", DROP_BANANA],
  ["pear", DROP_PEAR],
  ["cherry", DROP_CHERRY],
  ["pomegranate", DROP_POMEGRANATE],
  ["walnut", DROP_WALNUT],
  ["hazelnut", DROP_HAZELNUT],
  ["kiwi", DROP_KIWI],
  ["grape", DROP_GRAPE],
]);

const CODE_TO_ITEM = new Map<number, string>();
for (const [item, code] of ITEM_TO_CODE) {
  CODE_TO_ITEM.set(code, item);
}

/** Encode an item ID string into a small int for SAB storage. Returns 0 if unknown. */
export function encodeDropItem(itemId: string): number {
  return ITEM_TO_CODE.get(itemId) ?? DROP_NONE;
}

/** Decode a drop item code back into the item ID string. Returns null if unknown. */
export function decodeDropItem(code: number): string | null {
  return CODE_TO_ITEM.get(code | 0) ?? null;
}

// --- Display colors (RGB 0-255) ---
// For block items, use the block's palette color. For materials, use a distinct color.
const MATERIAL_COLORS: Record<number, [number, number, number]> = {
  [DROP_STICK]: [180, 140, 80],
  [DROP_COAL]: [50, 50, 50],
  [DROP_FLINT]: [80, 70, 60],
  [DROP_CRYSTAL]: [180, 220, 255],
  [DROP_COCONUT]: [120, 90, 50],
  [DROP_ORANGE]: [240, 150, 40],
  [DROP_APPLE]: [200, 60, 50],
  [DROP_LEMON]: [240, 220, 60],
  [DROP_LIME]: [160, 220, 60],
  [DROP_BANANA]: [240, 220, 80],
  [DROP_PEAR]: [180, 200, 60],
  [DROP_CHERRY]: [220, 50, 60],
  [DROP_POMEGRANATE]: [180, 40, 50],
  [DROP_WALNUT]: [120, 80, 50],
  [DROP_HAZELNUT]: [160, 120, 70],
  [DROP_KIWI]: [100, 140, 50],
  [DROP_GRAPE]: [130, 80, 160],
  [DROP_SEED]: [120, 90, 50], // brown
};

/** Get the display color (RGB 0-255) for a drop item code. */
export function getDropColor(code: number): [number, number, number] {
  const c = code | 0;
  // Check material colors first
  const mc = MATERIAL_COLORS[c];
  if (mc) return mc;
  // For block items, look up the block color via the item's placeBlock
  const itemId = CODE_TO_ITEM.get(c);
  if (itemId) {
    const def = getItemDef(itemId);
    if (def && def.placeBlock > 0) {
      // Import block-registry lazily to avoid circular imports
      // The color is looked up at render time, not import time
      return getBlockColorForItem(def.placeBlock);
    }
  }
  return [128, 128, 128]; // fallback gray
}

// Lazy import to avoid circular dependency (block-registry imports items)
import { getBlockDef } from "./block-registry";
function getBlockColorForItem(blockId: number): [number, number, number] {
  const def = getBlockDef(blockId);
  return def ? def.color : [128, 128, 128];
}
