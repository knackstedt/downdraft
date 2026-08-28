// ============================================================================
// TileAtlas — pre-rasterizes vendored SVG tile assets into an offscreen
// canvas atlas for fast Canvas2D blitting.
//
// Asset-based tilesets (e.g. "riichi") ship SVGs in
// `../assets/tiles/riichi/{regular,black}/*.svg`. Each SVG is 300×400
// (portrait) and contains only the glyph with a transparent background — the
// tile face color is NOT in the SVG. We load each SVG into an HTMLImageElement,
// then rasterize it into a slot of a single offscreen canvas whose dimensions
// match the tileset's aspect ratio (tileAspect = width / height):
//   - slot width  = ATLAS_SLOT_W (fixed at 128)
//   - slot height = round(ATLAS_SLOT_W / tileAspect)
// For riichi (aspect 0.75): 128×170 portrait slots. For elements (aspect 1.0):
// 128×128 square slots (though elements is procedural and doesn't use the
// atlas).
//
// Each slot is filled with the tile face background color (cream for light,
// dark for dark) then the glyph is drawn with "contain" scaling (fit inside
// the inset region, preserve aspect ratio). The slot aspect matches the SVG
// canvas aspect (0.75 for riichi), so the glyph fills the slot at its natural
// proportions and the SVG's built-in horizontal padding reads as the tile-face
// margin. High-quality image smoothing is enabled so the 300×400 SVG downscales
// crisply into the 128-wide slot.
//
// The atlas is keyed by element id (index in the tileset's `tiles` array).
// `draw(ctx, elementId, x, y, w, h)` blits the pre-rasterized slot scaled to
// the on-screen tile rect — a single `drawImage` from a bitmap per tile, fast
// enough for per-frame Canvas2D rendering.
//
// One atlas is cached per (tileset, theme) pair. The renderer preloads the
// atlas for the active tileset+theme on init and reloads when either changes
// (awaiting the new atlas before swapping so there's no flash of missing
// tiles).
// ============================================================================

import { getTileset, type TileTheme, type TilesetId } from "../shared/tilesets";

/** Fixed atlas slot width. High enough that downscaling to on-screen tile
 *  sizes (≤64px) stays crisp; small enough that the atlas bitmap is cheap. */
const ATLAS_SLOT_W = 128;

// Vite glob: maps asset path → raw SVG text (eager, query: ?raw). We inline
// the SVG text at build time and convert to data URLs at runtime to avoid
// COEP/fetch issues when loading SVGs as Image elements in Electron.
const SVG_TEXTS = import.meta.glob("../assets/tiles/riichi/{regular,black}/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Folder name for each theme. */
const THEME_FOLDER: Record<TileTheme, string> = {
  light: "regular",
  dark: "black",
};

/** A loaded atlas for one (tileset, theme) pair. */
export class TileAtlas {
  /** Offscreen canvas holding all tile slots in a horizontal strip:
   *  width = tiles.length * slotW, height = slotH. */
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private tileCount: number;
  private slotW: number;
  private slotH: number;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    tileCount: number,
    slotW: number,
    slotH: number,
  ) {
    this.canvas = canvas;
    this.tileCount = tileCount;
    this.slotW = slotW;
    this.slotH = slotH;
  }

  /** Blit the tile for `elementId` into the given on-screen rect (top-left
   *  x/y + width w + height h). No-op if the element id is out of range. */
  draw(ctx: CanvasRenderingContext2D, elementId: number, x: number, y: number, w: number, h: number): void {
    if (elementId < 0 || elementId >= this.tileCount) return;
    ctx.drawImage(
      this.canvas as CanvasImageSource,
      elementId * this.slotW, 0, this.slotW, this.slotH, // source slot
      x, y, w, h,                                         // dest rect
    );
  }
}

/** Load an SVG text string into an HTMLImageElement via a data URL. The SVG
 *  text is inlined at build time via import.meta.glob(?raw), so no runtime
 *  fetch is needed — this avoids COEP/fetch issues in Electron. */
function loadImageFromText(svgText: string, label: string): Promise<HTMLImageElement> {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load SVG: ${label} — ${String(e)}`));
    img.src = dataUrl;
  });
}

/** Tile face background colors per theme. The riichi SVGs contain only the
 *  glyph (transparent background) — the tile face color must be drawn
 *  separately. These match the Front.svg fill colors from the upstream repo:
 *  #f5f0eb (cream) for light, #1e1e1e (dark) for dark. */
const TILE_BG: Record<TileTheme, string> = {
  light: "#f5f0eb",
  dark: "#1e1e1e",
};

/** Inset (px) between the tile face background and the glyph image within
 *  each atlas slot. The background fills the full slot; the glyph is drawn
 *  this many pixels inset from each edge so the background color shows as a
 *  border around the glyph. */
const GLYPH_INSET = 4;

/** Rasterize a 300×400 SVG glyph into an atlas slot of (slotW × slotH). The
 *  SVGs contain only the glyph (transparent background) with horizontal padding
 *  baked into the 300×400 canvas, so we:
 *  1. Fill the slot with the tile face background color (cream/dark).
 *  2. Draw the glyph with "contain" scaling (fit inside the inset region,
 *     preserve aspect ratio). The slot aspect matches the SVG canvas aspect
 *     (0.75 for riichi), so the glyph fills the inset region at its natural
 *     proportions and the SVG's built-in padding reads as the tile-face margin.
 *     The GLYPH_INSET leaves a border of background color around the glyph.
 *
 *  High-quality image smoothing is enabled so the 300×400 SVG downscales
 *  crisply into the 128-wide slot (avoids jagged/aliased glyph edges).
 *
 *  Drawn into the slot at (slotIndex * slotW, 0). */
function rasterizeTile(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  img: HTMLImageElement,
  slotIndex: number,
  slotW: number,
  slotH: number,
  bg: string,
): void {
  const sx = slotW * slotIndex;

  // 1. Fill the slot with the tile face background.
  ctx.fillStyle = bg;
  ctx.fillRect(sx, 0, slotW, slotH);

  // 2. Draw the glyph with "contain" scaling into the inset region (slot minus
  //    GLYPH_INSET on each side). The slot aspect matches the SVG aspect, so
  //    the glyph fills the inset region at natural proportions with the SVG's
  //    built-in padding as margin. High-quality smoothing anti-aliases the
  //    300×400 → 128-wide downscale so glyph edges stay crisp, not jagged.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const iw = img.naturalWidth || 300;
  const ih = img.naturalHeight || 400;
  const innerW = slotW - GLYPH_INSET * 2;
  const innerH = slotH - GLYPH_INSET * 2;
  const scale = Math.min(innerW / iw, innerH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = sx + GLYPH_INSET + (innerW - dw) / 2;
  const dy = GLYPH_INSET + (innerH - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** Build the atlas for a (tileset, theme) pair. Resolves once every SVG has
 *  loaded + rasterized. Throws if any SVG fails to load. */
export async function loadTileAtlas(tileset: TilesetId, theme: TileTheme): Promise<TileAtlas> {
  const ts = getTileset(tileset);
  if (!ts.assetBased) {
    throw new Error(`Tileset "${tileset}" is not asset-based; no atlas to load.`);
  }
  const folder = THEME_FOLDER[theme];
  // Build the SVG text map keyed by asset key (e.g. "Man1" → svg text). The
  // glob keys are paths like "../assets/tiles/riichi/regular/Man1.svg".
  const textByKey = new Map<string, string>();
  const prefix = `../assets/tiles/riichi/${folder}/`;
  for (const [path, text] of Object.entries(SVG_TEXTS)) {
    if (!path.startsWith(prefix)) continue;
    const file = path.slice(prefix.length);           // "Man1.svg"
    const key = file.replace(/\.svg$/i, "");           // "Man1"
    textByKey.set(key, text);
  }

  const tileCount = ts.tiles.length;
  // Atlas slot dimensions match the tileset's aspect ratio so the glyph fills
  // the slot at its natural proportions.
  const slotW = ATLAS_SLOT_W;
  const slotH = Math.round(ATLAS_SLOT_W / ts.tileAspect);
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(tileCount * slotW, slotH)
    : Object.assign(document.createElement("canvas"), { width: tileCount * slotW, height: slotH });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  // Load + rasterize each tile's SVG. Load in parallel for speed.
  const bg = TILE_BG[theme];
  await Promise.all(ts.tiles.map(async (def, i) => {
    const text = textByKey.get(def.glyph);
    if (!text) throw new Error(`No SVG asset for tile "${def.glyph}" (tileset ${tileset}, theme ${theme})`);
    const img = await loadImageFromText(text, `${def.glyph}.svg`);
    rasterizeTile(ctx, img, i, slotW, slotH, bg);
  }));

  return new TileAtlas(canvas, tileCount, slotW, slotH);
}

/** Synchronous check: is this tileset asset-based (needs an atlas)? */
export function isAssetBased(tileset: TilesetId): boolean {
  return getTileset(tileset).assetBased;
}
