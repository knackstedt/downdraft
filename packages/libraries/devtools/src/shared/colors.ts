// ============================================================================
// colors.ts — DevTools color palette + font helpers for the native debugger.
//
// Mirrors the ProfilerScene constants so the debugger shares a visual language
// with the in-game profiler overlay. All colors are 0xRRGGBB numbers (PixiJS).
// ============================================================================

// ── Backgrounds ──
export const BG_DARK = 0x1a1a2e;
export const BG_PANEL = 0x111122;
export const BG_CHART = 0x0a0a16;
export const BG_GRID = 0x222244;
export const BG_INPUT = 0x0d0d18;
export const BG_HOVER = 0x2a2a44;
export const BG_SELECTED = 0x3a3a5c;

// ── Accents ──
export const COLOR_GREEN = 0x00ff88;
export const COLOR_YELLOW = 0xffaa00;
export const COLOR_RED = 0xff4444;
export const COLOR_BLUE = 0x4488ff;
export const COLOR_PURPLE = 0xff00ff;
export const COLOR_CYAN = 0x00ffff;
export const COLOR_ORANGE = 0xff8800;

// ── Text ──
export const COLOR_TEXT = 0xcccccc;
export const COLOR_TEXT_DIM = 0x888888;
export const COLOR_TEXT_BRIGHT = 0xffffff;
export const COLOR_HEADER = 0x00ff88;

// ── Console severity ──
export const SEVERITY_COLORS: Record<string, number> = {
  log: COLOR_TEXT,
  info: COLOR_BLUE,
  warn: COLOR_YELLOW,
  warning: COLOR_YELLOW,
  error: COLOR_RED,
  debug: COLOR_TEXT_DIM,
  trace: COLOR_PURPLE,
};

// ── Lines / borders ──
export const COLOR_BORDER = 0x333355;
export const COLOR_AXIS = 0x444466;

// ── Per-worker / per-thread chart colors (cycled) ──
export const THREAD_COLORS = [COLOR_GREEN, COLOR_BLUE, COLOR_YELLOW, COLOR_CYAN, COLOR_PURPLE, COLOR_RED, COLOR_ORANGE];

export const FONT = "monospace";

/** Font scale multiplier (set from the debugger host at init). */
let _fontScale = 1;
export function setFontScale(scale: number): void { _fontScale = scale; }
export function getFontScale(): number { return _fontScale; }
/** Scale a base font size by the current font scale. */
export function fs(size: number): number { return Math.round(size * _fontScale); }
