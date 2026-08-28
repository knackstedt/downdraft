// ============================================================================
// Tilesets — registry of selectable tile sets for Sandjongg.
//
// The board/match engine treats an element id as an opaque matching key: only
// the level generator (deals random ids 0..N-1), the sand spawner
// (tilesetMaterial), and the renderer (draws a glyph/image per id) care what
// the ids *mean*. This module exposes a `Tileset` registry so games can swap
// the visual + sand-material identity of the ids without touching the board,
// pathfinding, or match-engine logic.
//
// Two tilesets ship today:
//   - "elements": the original 18 procedural elemental tiles (Fire, Water,
//     Earth, ...). Rendered as a colored tile + a procedurally-drawn Canvas2D
//     glyph. Each element maps to a distinct reactive sand material so
//     crumbled tiles produce interesting reactions in the pit.
//   - "riichi": 34 real riichi-mahjong tiles (Man/Pin/Sou 1-9 + 7 honors)
//     rendered from vendored SVG assets (light + dark variants). Crumbled
//     tiles spawn a suit-based sand material (Man→Dirt, Pin→Water,
//     Sou→Plant, winds→Steam, Haku→Salt, Hatsu→Acid, Chun→Lava) so the
//     sandjongg pit still reacts, just keyed by suit instead of by tile.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { ELEMENTS, type ElementDef } from "./elements";

export type TilesetId = "elements" | "riichi";
export type TileTheme = "light" | "dark";

/** A single tile definition within a tileset. Index in `tiles` = element id. */
export interface TileDef {
  id: number;
  name: string;
  /** Sand material to spawn when crumbled. */
  sandMaterial: number;
  /** Procedural glyph id (elements tileset) OR asset key (riichi tileset,
   *  e.g. "Man1", "Ton"). The renderer branches on `assetBased`. */
  glyph: string;
  /** Display color (CSS) — used for the debug swatch + procedural tile bg. */
  color: string;
  /** Accent/glyph color (CSS) — used for the procedural glyph + debug. */
  glyphColor: string;
}

export interface Tileset {
  id: TilesetId;
  /** Display name for the UI selector. */
  label: string;
  /** Tile definitions, indexed by element id (0..tiles.length-1). */
  tiles: TileDef[];
  /** When true, the renderer blits a pre-rasterized SVG per tile instead of
   *  drawing a procedural color + glyph. */
  assetBased: boolean;
  /** Whether this tileset supports a light/dark theme toggle. Asset-based
   *  tilesets load a different SVG folder per theme; procedural tilesets
   *  ignore the theme (their colors are fixed). */
  themed: boolean;
  /** Tile cell aspect ratio (width / height). 1.0 = square. The riichi SVGs
   *  are 300×400 portrait → 0.75. The renderer uses this to compute
   *  rectangular grid cells (tileW = tileH * aspect) so tiles render at their
   *  natural proportions instead of being squashed into squares. */
  tileAspect: number;
}

// --- "elements" tileset (wraps the existing ELEMENTS array) ----------------

const ELEMENTS_TILESET: Tileset = {
  id: "elements",
  label: "Elements",
  assetBased: false,
  themed: false,
  tileAspect: 1.0,
  tiles: ELEMENTS.map((e: ElementDef): TileDef => ({
    id: e.id,
    name: e.name,
    sandMaterial: e.sandMaterial,
    glyph: e.glyph,
    color: e.color,
    glyphColor: e.glyphColor,
  })),
};

// --- "riichi" tileset (34 real mahjong tiles, SVG-rendered) ----------------
//
// Suit-based sand-material mapping (so crumbled riichi tiles still produce
// reactive sand in sandjongg mode, keyed by suit instead of by tile):
//   Man  (characters)  -> Dirt
//   Pin  (circles)     -> Water
//   Sou  (bamboo)      -> Plant
//   Winds (Ton/Nan/...) -> Steam
//   Haku (white dragon) -> Salt
//   Hatsu (green dragon) -> Acid
//   Chun (red dragon)   -> Lava

/** Asset key for each riichi tile (matches the vendored SVG filename). */
const RIICHI_NAMES: { key: string; name: string; mat: number }[] = [
  // Man (characters) 1-9  -> Dirt
  { key: "Man1",  name: "Man 1",  mat: Material.Dirt },
  { key: "Man2",  name: "Man 2",  mat: Material.Dirt },
  { key: "Man3",  name: "Man 3",  mat: Material.Dirt },
  { key: "Man4",  name: "Man 4",  mat: Material.Dirt },
  { key: "Man5",  name: "Man 5",  mat: Material.Dirt },
  { key: "Man6",  name: "Man 6",  mat: Material.Dirt },
  { key: "Man7",  name: "Man 7",  mat: Material.Dirt },
  { key: "Man8",  name: "Man 8",  mat: Material.Dirt },
  { key: "Man9",  name: "Man 9",  mat: Material.Dirt },
  // Pin (circles) 1-9 -> Water
  { key: "Pin1",  name: "Pin 1",  mat: Material.Water },
  { key: "Pin2",  name: "Pin 2",  mat: Material.Water },
  { key: "Pin3",  name: "Pin 3",  mat: Material.Water },
  { key: "Pin4",  name: "Pin 4",  mat: Material.Water },
  { key: "Pin5",  name: "Pin 5",  mat: Material.Water },
  { key: "Pin6",  name: "Pin 6",  mat: Material.Water },
  { key: "Pin7",  name: "Pin 7",  mat: Material.Water },
  { key: "Pin8",  name: "Pin 8",  mat: Material.Water },
  { key: "Pin9",  name: "Pin 9",  mat: Material.Water },
  // Sou (bamboo) 1-9 -> Plant
  { key: "Sou1",  name: "Sou 1",  mat: Material.Plant },
  { key: "Sou2",  name: "Sou 2",  mat: Material.Plant },
  { key: "Sou3",  name: "Sou 3",  mat: Material.Plant },
  { key: "Sou4",  name: "Sou 4",  mat: Material.Plant },
  { key: "Sou5",  name: "Sou 5",  mat: Material.Plant },
  { key: "Sou6",  name: "Sou 6",  mat: Material.Plant },
  { key: "Sou7",  name: "Sou 7",  mat: Material.Plant },
  { key: "Sou8",  name: "Sou 8",  mat: Material.Plant },
  { key: "Sou9",  name: "Sou 9",  mat: Material.Plant },
  // Winds -> Steam
  { key: "Ton",   name: "Ton (East)",   mat: Material.Steam },
  { key: "Nan",   name: "Nan (South)",  mat: Material.Steam },
  { key: "Shaa",  name: "Shaa (West)",  mat: Material.Steam },
  { key: "Pei",   name: "Pei (North)",  mat: Material.Steam },
  // Dragons
  { key: "Haku",  name: "Haku (White)",   mat: Material.Salt },
  { key: "Hatsu", name: "Hatsu (Green)",  mat: Material.Acid },
  { key: "Chun",  name: "Chun (Red)",     mat: Material.Lava },
];

// Neutral tile-cream / dark colors for the debug swatch. The actual tile face
// is drawn from the SVG, so these only show in the debug panel.
const RIICHI_LIGHT_BG = "#f5e9c8";
const RIICHI_LIGHT_GLYPH = "#1a1a1a";
const RIICHI_DARK_BG = "#1f1f24";
const RIICHI_DARK_GLYPH = "#e8e8e8";

const RIICHI_TILESET: Tileset = {
  id: "riichi",
  label: "Riichi",
  assetBased: true,
  themed: true,
  tileAspect: .75, // 4:3 portrait (300×400 SVG canvas); true mahjong tile proportions
  tiles: RIICHI_NAMES.map((t, i): TileDef => ({
    id: i,
    name: t.name,
    sandMaterial: t.mat,
    glyph: t.key,
    color: RIICHI_LIGHT_BG,
    glyphColor: RIICHI_LIGHT_GLYPH,
  })),
};

// --- Registry --------------------------------------------------------------

export const TILESETS: Record<TilesetId, Tileset> = {
  elements: ELEMENTS_TILESET,
  riichi: RIICHI_TILESET,
};

export const TILESET_IDS: TilesetId[] = ["elements", "riichi"];

/** Get a tileset by id. Throws if unknown (programming error). */
export function getTileset(id: TilesetId): Tileset {
  const ts = TILESETS[id];
  if (!ts) throw new Error(`Unknown tileset: ${id}`);
  return ts;
}

/** Number of tiles in a tileset (= max element id + 1). */
export function getTileCount(id: TilesetId): number {
  return getTileset(id).tiles.length;
}

/** Tile cell aspect ratio (width / height) for a tileset. 1.0 = square. */
export function getTileAspect(id: TilesetId): number {
  return getTileset(id).tileAspect;
}

/** Sand material for a (tileset, elementId) pair. Returns Empty if invalid. */
export function tilesetMaterial(id: TilesetId, elementId: number): number {
  return getTileset(id).tiles[elementId]?.sandMaterial ?? Material.Empty;
}

/** Tile definition for a (tileset, elementId) pair. Throws if invalid. */
export function getTileDef(id: TilesetId, elementId: number): TileDef {
  const def = getTileset(id).tiles[elementId];
  if (!def) throw new Error(`No tile ${elementId} in tileset ${id}`);
  return def;
}

/** Debug-swatch colors for a (tileset, elementId, theme) pair. Asset-based
 *  tilesets pick a neutral cream/dark so the debug swatch is sensible even
 *  though the real face is drawn from an SVG. */
export function tileDebugColors(id: TilesetId, elementId: number, theme: TileTheme): { color: string; glyphColor: string } {
  const ts = getTileset(id);
  if (ts.assetBased) {
    return theme === "dark"
      ? { color: RIICHI_DARK_BG, glyphColor: RIICHI_DARK_GLYPH }
      : { color: RIICHI_LIGHT_BG, glyphColor: RIICHI_LIGHT_GLYPH };
  }
  const def = ts.tiles[elementId];
  return { color: def?.color ?? "#888", glyphColor: def?.glyphColor ?? "#fff" };
}
