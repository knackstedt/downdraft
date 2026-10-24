// ============================================================================
// native-freetype.ts — FreeType-based text rasterizer
//
// Uses libfont_shim.so (FreeType) via FFI to render TrueType text.
// Falls back gracefully when the shim or a system font is unavailable —
// NativeCanvas2D uses the 8x12 bitmap glyph atlas in that case.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync } from "node:fs";
import { assertPlatformAbi } from "../ffi/abi";
import { dlopen, ptr, type CFunction } from "../ffi/ffi-adapter";
import { findShimLibrary, resolvePlatformLibrary } from "../ffi/lib-paths";

const log = createLogger();

function findSystemFont(): string {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    // macOS / Windows fallbacks
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
    // Android
    "/system/fonts/Roboto-Regular.ttf",
    "/system/fonts/NotoSans-Regular.ttf",
    "/product/fonts/Roboto-Regular.ttf",
  ];
  for (let _i = 0, _it = candidates, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (existsSync(p)) return p;
  }
  return "";
}

let ftFace = 0n;
let ftInitialized = false;
let ftSymbols: any = null;

const FT_RENDER_BUF = new Uint8Array(2048 * 128 * 4);
const FT_WIDTH_OUT = new Int32Array(1);
const FT_HEIGHT_OUT = new Int32Array(1);

function ensureFreeTypeInit(): void {
  if (ftInitialized) return;
  ftInitialized = true;
  try {
    // Explicit FONT_SHIM_PATH override → unified Rust platform lib.
    const libPath = process.env.FONT_SHIM_PATH
      ? findShimLibrary("font_shim", "FONT_SHIM_PATH")
      : (() => { const p = resolvePlatformLibrary(true); if (p) assertPlatformAbi(p); return p; })();
    if (!libPath) { log.warn("platform-native", "platform library not found — using bitmap font fallback"); return; }
    ftSymbols = dlopen(libPath, {
      ft_shim_init: { args: ["cstring"], returns: "i64" } as CFunction,
      ft_shim_render_text: { args: ["i64", "cstring", "i32", "ptr", "i32", "i32", "i32", "ptr", "ptr"], returns: "i32" } as CFunction,
      ft_shim_measure: { args: ["i64", "cstring", "i32"], returns: "i32" } as CFunction,
      ft_shim_done: { args: ["i64"], returns: "void" } as CFunction,
    }).symbols;
    const fontPath = findSystemFont();
    if (!fontPath) { log.warn("platform-native", "No system TTF font found — using bitmap font fallback"); return; }
    ftFace = BigInt(ftSymbols.ft_shim_init(fontPath) as unknown as number);
    if (ftFace === 0n) {
      log.warn("platform-native", "FreeType init failed — using bitmap font fallback");
    } else {
      log.info("platform-native", "FreeType text rendering initialized");
    }
  } catch (e: any) {
    log.warn("platform-native", `FreeType init error: ${e?.message ?? e} — using bitmap font fallback`);
    ftFace = 0n;
  }
}

export function ftIsAvailable(): boolean {
  ensureFreeTypeInit();
  return ftFace !== 0n;
}

export function ftMeasureText(text: string, fontSize: number): number {
  ensureFreeTypeInit();
  if (ftFace === 0n || !ftSymbols) return -1;
  return ftSymbols.ft_shim_measure(ftFace, text, fontSize) as unknown as number;
}

// Small LRU for rendered bitmaps — text drawn every frame (HUDs, debug
// overlays) would otherwise re-shape + re-rasterize the same strings each
// call. Rustybuzz shaping is the expensive part; the bitmap is immutable.
const RENDER_CACHE_LIMIT = 128;
interface RenderedRun { data: Uint8Array; width: number; height: number; padX: number }
const renderCache = new Map<string, RenderedRun>();
const spaceAdvanceBySize = new Map<number, number>();

function spaceAdvance(fontSize: number): number {
  const hit = spaceAdvanceBySize.get(fontSize);
  if (hit !== undefined) return hit;
  const adv = Math.max(0, ftMeasureText(" ", fontSize));
  spaceAdvanceBySize.set(fontSize, adv);
  return adv;
}

export function ftRenderText(text: string, fontSize: number): RenderedRun | null {
  ensureFreeTypeInit();
  if (ftFace === 0n || !ftSymbols) return null;
  const key = `${fontSize}\x00${text}`;
  const hit = renderCache.get(key);
  if (hit) {
    renderCache.delete(key);
    renderCache.set(key, hit);
    return hit;
  }
  // Pad with a space each side — the shim's bitmap spans [0, ceil(advance)],
  // so ink overhanging the advance (italic f, quotes) is clipped. The margin
  // gives overhang somewhere to land; callers subtract padX to restore the
  // pen origin.
  const raster = ` ${text} `;
  const dataPtr = ptr(FT_RENDER_BUF);
  const widthPtr = ptr(FT_WIDTH_OUT);
  const heightPtr = ptr(FT_HEIGHT_OUT);
  const result = ftSymbols.ft_shim_render_text(
    ftFace, raster, fontSize,
    dataPtr, FT_RENDER_BUF.length,
    2048, 128,
    widthPtr, heightPtr,
  ) as unknown as number;
  if (result <= 0) return null;
  const w = FT_WIDTH_OUT[0];
  const h = FT_HEIGHT_OUT[0];
  if (w <= 0 || h <= 0) return null;
  const size = w * h * 4;
  const copy = new Uint8Array(size);
  copy.set(FT_RENDER_BUF.subarray(0, size));
  const out: RenderedRun = { data: copy, width: w, height: h, padX: spaceAdvance(fontSize) };
  renderCache.set(key, out);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return out;
}

/**
 * Get the FreeType text renderer function, or null if FreeType is unavailable.
 * This can be plugged into TextAtlasCache.setDirectRenderer() to bypass
 * Canvas2D and render text directly via FreeType.
 */
export function getFreeTypeTextRenderer(): ((text: string, fontSize: number) => RenderedRun | null) | null {
  ensureFreeTypeInit();
  if (ftFace === 0n) return null;
  return ftRenderText;
}
