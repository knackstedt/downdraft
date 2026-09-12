// ============================================================================
// native-font.ts — FreeType-based text rasterizer for native mode
//
// Uses libfont_shim.so (FreeType) via bun:ffi to render TrueType text into
// RGBA pixel buffers. This replaces the crude 8x12 bitmap glyph atlas in
// NativeCanvas2D with proper anti-aliased font rendering.
//
// The font is loaded once from a system TTF file (DejaVu Sans by default).
// Each fillText call renders the text string to pixels via FreeType, then
// composites the white-alpha pixels into the canvas2D pixel buffer with the
// requested fill color.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, ptr, type CFunction } from "../ffi/ffi-adapter.js";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : (typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url)));

function findFontShimLibrary(): string {
  const candidates = [
    join(_dirname, "..", "..", "native", "libfont_shim.so"),
    join(process.cwd(), "packages", "platform-native", "native", "libfont_shim.so"),
    join(process.cwd(), "native", "libfont_shim.so"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const pkgRoot = join(_dirname, "..", "..");
  const rel = join(pkgRoot, "native", "libfont_shim.so");
  if (existsSync(rel)) return rel;
  throw new Error("libfont_shim.so not found. Build with: cd native && gcc -shared -fPIC -o libfont_shim.so font_shim.c $(pkg-config --cflags --libs freetype2) -lm");
}

function findSystemFont(): string {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const { execSync } = require("node:child_process");
    const result = execSync("fc-match -f %{file} sans-serif 2>/dev/null", { encoding: "utf-8" }).trim();
    if (result && existsSync(result)) return result;
  } catch {}
  throw new Error("No system TTF font found. Install fonts-dejavu or similar.");
}

let ftFace: bigint = 0n;
let ftInitialized = false;

function ensureInit(): void {
  if (ftInitialized) return;
  ftInitialized = true;
  try {
    const fontPath = findSystemFont();
    ftFace = BigInt(fontSymbols.ft_shim_init(fontPath) as unknown as number);
    if (ftFace === 0n) {
      console.warn("[native-font] FreeType init failed — falling back to bitmap font");
    }
  } catch (e) {
    console.warn(`[native-font] FreeType init error: ${e} — falling back to bitmap font`);
    ftFace = 0n;
  }
}

const { symbols: fontSymbols } = dlopen(findFontShimLibrary(), {
  ft_shim_init: { args: ["cstring"], returns: "i64" } as CFunction,
  ft_shim_render_text: { args: ["i64", "cstring", "i32", "ptr", "i32", "i32", "i32", "ptr", "ptr"], returns: "i32" } as CFunction,
  ft_shim_measure: { args: ["i64", "cstring", "i32"], returns: "i32" } as CFunction,
  ft_shim_free: { args: ["ptr"], returns: "void" } as CFunction,
  ft_shim_done: { args: ["i64"], returns: "void" } as CFunction,
});

// Pre-allocated buffer for text rendering (reused across calls)
const MAX_TEXT_WIDTH = 2048;
const MAX_TEXT_HEIGHT = 128;
const renderBuffer = new Uint8Array(MAX_TEXT_WIDTH * MAX_TEXT_HEIGHT * 4);
const widthOutBuf = new Int32Array(1);
const heightOutBuf = new Int32Array(1);

/**
 * Render text using FreeType. Returns RGBA pixel data (white text with alpha)
 * or null if FreeType is unavailable.
 */
export function renderTextFreeType(text: string, fontSize: number): { data: Uint8Array; width: number; height: number } | null {
  ensureInit();
  if (ftFace === 0n) return null;

  const widthPtr = ptr(widthOutBuf);
  const heightPtr = ptr(heightOutBuf);
  const dataPtr = ptr(renderBuffer);

  const result = fontSymbols.ft_shim_render_text(
    ftFace, text, fontSize,
    dataPtr, renderBuffer.length,
    MAX_TEXT_WIDTH, MAX_TEXT_HEIGHT,
    widthPtr, heightPtr,
  ) as unknown as number;

  if (result <= 0) return null;

  const w = widthOutBuf[0];
  const h = heightOutBuf[0];
  if (w <= 0 || h <= 0) return null;

  // Copy the used portion of the buffer
  const size = w * h * 4;
  const copy = new Uint8Array(size);
  copy.set(renderBuffer.subarray(0, size));
  return { data: copy, width: w, height: h };
}

/**
 * Measure text width using FreeType.
 * Returns the width in pixels, or -1 if FreeType is unavailable.
 */
export function measureTextFreeType(text: string, fontSize: number): number {
  ensureInit();
  if (ftFace === 0n) return -1;
  return fontSymbols.ft_shim_measure(ftFace, text, fontSize) as unknown as number;
}

/** Check if FreeType is available and initialized. */
export function isFreeTypeAvailable(): boolean {
  ensureInit();
  return ftFace !== 0n;
}
