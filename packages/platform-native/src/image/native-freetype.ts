// ============================================================================
// native-freetype.ts — FreeType-based text rasterizer
//
// Uses libfont_shim.so (FreeType) via FFI to render TrueType text.
// Falls back gracefully when the shim or a system font is unavailable —
// NativeCanvas2D uses the 8x12 bitmap glyph atlas in that case.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { existsSync } from "node:fs";
import { dlopen, ptr, type CFunction } from "../ffi/ffi-adapter";
import { findShimLibrary } from "../ffi/lib-paths";

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
  ];
  for (const p of candidates) {
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
    const libPath = findShimLibrary("font_shim", "FONT_SHIM_PATH");
    if (!libPath) { log.warn("platform-native", "libfont_shim not found — using bitmap font fallback"); return; }
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

export function ftRenderText(text: string, fontSize: number): { data: Uint8Array; width: number; height: number } | null {
  ensureFreeTypeInit();
  if (ftFace === 0n || !ftSymbols) return null;
  const dataPtr = ptr(FT_RENDER_BUF);
  const widthPtr = ptr(FT_WIDTH_OUT);
  const heightPtr = ptr(FT_HEIGHT_OUT);
  const result = ftSymbols.ft_shim_render_text(
    ftFace, text, fontSize,
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
  return { data: copy, width: w, height: h };
}

/**
 * Get the FreeType text renderer function, or null if FreeType is unavailable.
 * This can be plugged into TextAtlasCache.setDirectRenderer() to bypass
 * Canvas2D and render text directly via FreeType.
 */
export function getFreeTypeTextRenderer(): ((text: string, fontSize: number) => { data: Uint8Array; width: number; height: number } | null) | null {
  ensureFreeTypeInit();
  if (ftFace === 0n) return null;
  return ftRenderText;
}
