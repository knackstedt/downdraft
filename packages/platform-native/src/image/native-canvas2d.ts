// ============================================================================
// native-canvas2d.ts — software CanvasRenderingContext2D (text + shapes)
//
// Implements fillText using FreeType (when available) or a built-in 8x12
// bitmap glyph atlas as fallback. The TextAtlasCache uses this to rasterize
// text into GPU textures.
// ============================================================================

import { ftIsAvailable, ftMeasureText, ftRenderText } from "./native-freetype";

const GLYPH_W = 8;
const GLYPH_H = 12;

// 8x12 bitmap glyph patterns (X = on, . = off)
const GLYPH_PATTERNS: Record<string, string[]> = {
  ' ': ['........','........','........','........','........','........','........','........','........','........','........','........'],
  '!': ['...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','...XX...','...XX...','........','........','........'],
  '"': ['..XX.XX.','..XX.XX.','..XX.XX.','........','........','........','........','........','........','........','........','........'],
  '#': ['..XX.XX.','..XX.XX.','..XX.XX.','XXXXXXXX','..XX.XX.','XXXXXXXX','..XX.XX.','..XX.XX.','..XX.XX.','........','........','........'],
  '$': ['...XXX..','.XX.X.X.','.X..X...','.XX.XX..','...X.XX.','.X..X.X.','.X..X.X.','..XXX...','........','........','........','........'],
  '%': ['XX...XX.','XX..XX..','...XX...','..XX....','..XX....','...XX...','..XX..XX','XX...XX.','........','........','........','........'],
  '&': ['..XXX...','.XX.XX..','.XX.XX..','..XX....','.XX.XXX.','XX.X.XX.','X..XX.X.','.XXX..X.','........','........','........','........'],
  '\'': ['...XX...','...XX...','...XX...','........','........','........','........','........','........','........','........','........'],
  '(': ['....XX..','...XX...','..XX....','..XX....','..XX....','..XX....','...XX...','....XX..','........','........','........','........'],
  ')': ['..XX....','...XX...','....XX..','....XX..','....XX..','....XX..','...XX...','..XX....','........','........','........','........'],
  '*': ['........','........','..X..X..','.XX.XXX.','X.XXX.X.','.XX.XXX.','..X..X..','........','........','........','........','........'],
  '+': ['........','........','...XX...','...XX...','...XX...','XXXXXXX.','...XX...','...XX...','...XX...','........','........','........'],
  ',': ['........','........','........','........','........','........','........','...XX...','...XX...','..XX....','........','........'],
  '-': ['........','........','........','........','XXXXXXX.','XXXXXXX.','........','........','........','........','........','........'],
  '.': ['........','........','........','........','........','........','........','...XX...','...XX...','........','........','........'],
  '/': ['......XX','.....XX.','....XX..','...XX...','..XX....','.XX.....','XX......','XX......','........','........','........','........'],
  '0': ['..XXX...','.XX.XX..','.X...X..','X..X..X.','X..X..X.','X..X..X.','.X...X..','.XX.XX..','..XXX...','........','........','........'],
  '1': ['...XX...','..XXX...','.XXXX...','...XX...','...XX...','...XX...','...XX...','XXXXXXX.','........','........','........','........'],
  '2': ['..XXX...','.XX.XX..','X....X..','....XX..','..XX....','.XX.....','XX......','XXXXXXX.','........','........','........','........'],
  '3': ['..XXX...','.XX.XX..','X....X..','...XX...','...XXX..','......X.','X....X..','.XX.XX..','..XXX...','........','........','........'],
  '4': ['....XX..','...XXX..','..X.XX..','.X..XX..','X...XX..','XXXXXXX.','....XX..','....XX..','....XX..','........','........','........'],
  '5': ['XXXXXXX.','XX......','XX......','XXXXX...','....XX..','......X.','X....X..','.XX.XX..','..XXX...','........','........','........'],
  '6': ['..XXX...','.XX.XX..','XX......','XXXXX...','XX.X.XX.','X....X..','.XX.XX..','..XXX...','........','........','........','........'],
  '7': ['XXXXXXX.','X....X..','....X...','...X....','..X.....','.XX.....','.XX.....','.XX.....','........','........','........','........'],
  '8': ['..XXX...','.XX.XX..','X..X..X.','.XX.XX..','..XXX...','.XX.XX..','X..X..X.','.XX.XX..','..XXX...','........','........','........'],
  '9': ['..XXX...','.XX.XX..','X..X..XX','..XX.XX.','....XX..','...XX....','..XX....','.XXX....','........','........','........','........'],
  ':': ['........','........','...XX...','...XX...','........','........','........','...XX...','...XX...','........','........','........'],
  ';': ['........','........','...XX...','...XX...','........','........','........','...XX...','...XX...','..XX....','........','........'],
  '<': ['........','....XX..','...XX...','..XX....','.XX.....','..XX....','...XX...','....XX..','........','........','........','........'],
  '=': ['........','........','........','XXXXXXX.','........','XXXXXXX.','........','........','........','........','........','........'],
  '>': ['........','.XX.....','..XX....','...XX...','....XX..','...XX...','..XX....','.XX.....','........','........','........','........'],
  '?': ['..XXX...','.XX.XX..','X....X..','....XX..','...XX...','........','...XX...','...XX...','........','........','........','........'],
  '@': ['..XXX...','.X...X..','X.XX.XX.','X.XXXX.X','X.XX.XX.','X.XX.XX.','.X...X..','..XXX...','........','........','........','........'],
  'A': ['..XXX...','.XX.XX..','X.....X.','X.....X.','XXXXXXX.','X.....X.','X.....X.','X.....X.','........','........','........','........'],
  'B': ['XXXXXX..','X.....X.','X.....X.','XXXXXX..','X.....X.','X.....X.','X.....X.','XXXXXX..','........','........','........','........'],
  'C': ['..XXX...','.X...X..','X.......','X.......','X.......','X.......','.X...X..','..XXX...','........','........','........','........'],
  'D': ['XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','X....X..','XXXXX...','........','........','........','........'],
  'E': ['XXXXXXX.','X.......','X.......','XXXXXX..','X.......','X.......','X.......','XXXXXXX.','........','........','........','........'],
  'F': ['XXXXXXX.','X.......','X.......','XXXXXX..','X.......','X.......','X.......','X.......','........','........','........','........'],
  'G': ['..XXX...','.X...X..','X.......','X.......','X...XXX.','X.....X.','.X...X..','..XXXXX.','........','........','........','........'],
  'H': ['X.....X.','X.....X.','X.....X.','XXXXXXX.','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........','........'],
  'I': ['.XXXXX..','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','.XXXXX..','........','........','........','........'],
  'J': ['..XXXXX.','....XX..','....XX..','....XX..','....XX..','X...XX..','X...XX..','.XXX....','........','........','........','........'],
  'K': ['X.....X.','X....X..','X...X...','X..X....','XXX.....','X..X....','X...X...','X....X..','X.....X.','........','........','........'],
  'L': ['X.......','X.......','X.......','X.......','X.......','X.......','X.......','XXXXXXX.','........','........','........','........'],
  'M': ['X.....X.','XX...XX.','X.X.X.X.','X..X..X.','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........','........'],
  'N': ['X.....X.','XX....X.','X.X...X.','X..X..X.','X...X.X.','X....XX.','X.....X.','X.....X.','........','........','........','........'],
  'O': ['..XXX...','.X...X..','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........','........'],
  'P': ['XXXXXX..','X.....X.','X.....X.','XXXXXX..','X.......','X.......','X.......','X.......','........','........','........','........'],
  'Q': ['..XXX...','.X...X..','X.....X.','X.....X.','X...X.X.','.X...X..','..XXX...','...XX...','........','........','........','........'],
  'R': ['XXXXXX..','X.....X.','X.....X.','XXXXXX..','X..X....','X...X...','X....X..','X.....X.','........','........','........','........'],
  'S': ['..XXXX..','.X....X.','X.......','..XXX...','....XXX.','......X.','X.....X.','.X....X.','..XXXX..','........','........','........'],
  'T': ['XXXXXXX.','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','........','........','........'],
  'U': ['X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........','........'],
  'V': ['X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','.X...X..','..X.X...','..X.X...','...X....','........','........','........'],
  'W': ['X.....X.','X.....X.','X.....X.','X.....X.','X..X..X.','X.X.X.X.','.X...X..','.X...X..','........','........','........','........'],
  'X': ['X.....X.','X.....X.','.X...X..','..X.X...','...X....','..X.X...','.X...X..','X.....X.','X.....X.','........','........','........'],
  'Y': ['X.....X.','X.....X.','.X...X..','..X.X...','...X....','...X....','...X....','...X....','........','........','........','........'],
  'Z': ['XXXXXXX.','......X.','.....X..','....X...','...X....','..X.....','.X......','X.......','XXXXXXX.','........','........','........'],
  '[': ['..XXXX..','..XX....','..XX....','..XX....','..XX....','..XX....','..XX....','..XXXX..','........','........','........','........'],
  '\\': ['XX......','XX......','.XX.....','..XX....','...XX...','....XX..','.....XX.','.....XX.','........','........','........','........'],
  ']': ['..XXXX..','....XX..','....XX..','....XX..','....XX..','....XX..','....XX..','..XXXX..','........','........','........','........'],
  '^': ['...X....','..XXX...','.X.X.X..','X.....X.','........','........','........','........','........','........','........','........'],
  '_': ['........','........','........','........','........','........','........','........','XXXXXXXX','........','........','........'],
  '`': ['..XX....','...XX...','....XX..','........','........','........','........','........','........','........','........','........'],
  'a': ['........','........','........','..XXX...','....XX..','.X..XXX.','XX...XX.','.X..XXX.','..XXXXX.','........','........','........'],
  'b': ['X.......','X.......','X.......','XXXXX...','X....X..','X.....X.','X.....X.','X....X..','XXXXX...','........','........','........'],
  'c': ['........','........','........','..XXX...','.X...X..','X.......','X.......','.X...X..','..XXX...','........','........','........'],
  'd': ['......X.','......X.','......X.','..XXXXX.','.....X..','X.....X.','X.....X.','X....X..','..XXXXX.','........','........','........'],
  'e': ['........','........','........','..XXX...','.X...X..','XXXXXXX.','X.......','.X...X..','..XXX...','........','........','........'],
  'f': ['...XXX..','..X.....','..X.....','XXXXX...','..X.....','..X.....','..X.....','..X.....','...XX...','........','........','........'],
  'g': ['........','........','........','..XXXXX.','X....X..','X....X..','X....X..','.XXXXX..','......X.','..XXX...','.XX....','........'],
  'h': ['X.......','X.......','X.......','XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'i': ['...XX...','........','........','..XXX...','...XX...','...XX...','...XX...','...XX...','..XXXXX.','........','........','........'],
  'j': ['......X.','........','........','...XXX..','......X.','......X.','......X.','X....X..','X....X..','.XXX....','........','........'],
  'k': ['X.......','X.......','X.......','X...XX..','X..X....','XXX.....','X..X....','X...X...','X....X..','........','........','........'],
  'l': ['..XXX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','..XXXXX.','........','........','........','........'],
  'm': ['........','........','........','XX.XX...','X.X.X.X.','X.X.X.X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'n': ['........','........','........','XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'o': ['........','........','........','..XXX...','.X...X..','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'p': ['........','........','........','XXXXX...','X....X..','X.....X.','X....X..','XXXXX...','X.....X.','X.....X.','........','........'],
  'q': ['........','........','........','..XXXXX.','.....X..','X.....X.','X....X..','..XXXXX.','......X.','......X.','........','........'],
  'r': ['........','........','........','X..XXX..','X.X....','XXX.....','X.......','X.......','X.......','........','........','........'],
  's': ['........','........','........','..XXXXX.','X......','.XXXXX..','......X.','X.....X.','.XXXXX..','........','........','........'],
  't': ['..X.....','..X.....','..X.....','XXXXX...','..X.....','..X.....','..X.....','..X.....','...XX...','........','........','........'],
  'u': ['........','........','........','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'v': ['........','........','........','X.....X.','X.....X.','X.....X.','.X...X..','..X.X...','...X....','........','........','........'],
  'w': ['........','........','........','X.....X.','X.....X.','X..X..X.','X.X.X.X.','.X...X..','.X...X..','........','........','........'],
  'x': ['........','........','........','X.....X.','X.....X.','.X...X..','..X.X...','.X...X..','X.....X.','........','........','........'],
  'y': ['........','........','........','X.....X.','X.....X.','.X...X..','..X.X...','...X....','...X....','..X.....','.X......','........'],
  'z': ['........','........','........','XXXXXXX.','....XX..','..XX....','.XX.....','XX......','XXXXXXX.','........','........','........'],
  '{': ['...XXX..','..XX....','..XX....','..X.....','XXX.....','..X.....','..XX....','..XX....','...XXX..','........','........','........'],
  '|': ['...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','........','........'],
  '}': ['XXX.....','..XX....','...XX....','...X....','...XXX..','...X....','...XX....','..XX....','XXX.....','........','........','........'],
  '~': ['........','........','..XX..X.','X.X.XX..','X......X','........','........','........','........','........','........','........'],
};

function parseColor(color: string): [number, number, number, number] {
  if (typeof color !== "string") return [0, 0, 0, 255];
  const c = color.trim().toLowerCase();
  // Named colors (common subset)
  const NAMED: Record<string, [number, number, number]> = {
    white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0],
    green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
    cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128],
    grey: [128, 128, 128], silver: [192, 192, 192], lime: [0, 255, 0],
    aqua: [0, 255, 255], teal: [0, 128, 128], navy: [0, 0, 128],
    fuchsia: [255, 0, 255], purple: [128, 0, 128], olive: [128, 128, 0],
    maroon: [128, 0, 0], orange: [255, 165, 0], transparent: [0, 0, 0],
  };
  if (NAMED[c]) return [NAMED[c][0], NAMED[c][1], NAMED[c][2], c === "transparent" ? 0 : 255];
  // rgba(r,g,b,a) or rgb(r,g,b)
  const rgbaMatch = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbaMatch) {
    return [parseInt(rgbaMatch[1]), parseInt(rgbaMatch[2]), parseInt(rgbaMatch[3]), rgbaMatch[4] ? Math.round(parseFloat(rgbaMatch[4]) * 255) : 255];
  }
  // 8-digit hex #rrggbbaa
  const hex8 = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex8) {
    return [parseInt(hex8[1], 16), parseInt(hex8[2], 16), parseInt(hex8[3], 16), parseInt(hex8[4], 16)];
  }
  // 6-digit hex #rrggbb
  const hex6 = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) {
    return [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16), 255];
  }
  // 3-digit hex #rgb
  const hex3 = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    return [parseInt(hex3[1] + hex3[1], 16), parseInt(hex3[2] + hex3[2], 16), parseInt(hex3[3] + hex3[3], 16), 255];
  }
  return [0, 0, 0, 255];
}

// ── Gradients ──
// Libraries render gradient fills through createLinearGradient/
// createRadialGradient + fillRect on a small texture-generation canvas —
// implement real gradients so those fills don't collapse to solid white.

interface GradientStop { offset: number; color: [number, number, number, number]; }

class NativeCanvasGradient {
  __ddGradient = true;
  constructor(
    public kind: "linear" | "radial",
    public x0: number, public y0: number,
    public x1: number, public y1: number,
    public r0 = 0, public r1 = 0,
  ) {}
  stops: GradientStop[] = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color: parseColor(color) });
    this.stops.sort((a, b) => a.offset - b.offset);
  }
  /** Interpolated RGBA at t in [0,1] (clamped — Canvas "pad" spread). */
  colorAt(t: number): [number, number, number, number] {
    const s = this.stops;
    if (s.length === 0) return [0, 0, 0, 255];
    if (t <= s[0]!.offset) return s[0]!.color;
    if (t >= s[s.length - 1]!.offset) return s[s.length - 1]!.color;
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i]!.offset) {
        const a = s[i - 1]!;
        const b = s[i]!;
        const f = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 0;
        return [
          a.color[0] + (b.color[0] - a.color[0]) * f,
          a.color[1] + (b.color[1] - a.color[1]) * f,
          a.color[2] + (b.color[2] - a.color[2]) * f,
          a.color[3] + (b.color[3] - a.color[3]) * f,
        ];
      }
    }
    return s[s.length - 1]!.color;
  }
  /** Gradient parameter at canvas point (x,y). */
  tAt(x: number, y: number): number {
    if (this.kind === "linear") {
      const dx = this.x1 - this.x0;
      const dy = this.y1 - this.y0;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) return 1;
      return Math.max(0, Math.min(1, ((x - this.x0) * dx + (y - this.y0) * dy) / len2));
    }
    // Radial: interpolate along the focal→outer axis using the inner radius.
    const d = Math.hypot(x - this.x0, y - this.y0);
    const span = this.r1 - this.r0;
    if (span <= 0) return 1;
    return Math.max(0, Math.min(1, (d - this.r0) / span));
  }
}

// ── Path rasterization helpers ──

/** A flattened subpath: device-space points [x0,y0,x1,y1,...] + closed flag.
 *  `sx/sy` are the user-space start point (pen target after closePath);
 *  generated stroke geometry leaves them unset. */
interface Subpath { pts: number[]; closed: boolean; sx?: number; sy?: number; }

/** Full canvas-2d drawing state — what save()/restore() snapshots. */
interface DrawState {
  a: number; b: number; c: number; d: number; e: number; f: number;
  fillStyle: string;
  fillGradient: NativeCanvasGradient | null;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  composite: string;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  /** Coverage mask (0-255 per pixel). Masks are immutable once installed —
   *  clip() allocates a new one, so sharing the ref across saves is safe. */
  clip: Uint8ClampedArray | null;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
}

export class NativeCanvas2D {
  width: number;
  height: number;
  private _fillStyle: string = "#000000";
  private _fillGradient: NativeCanvasGradient | null = null;
  private _strokeStyle: string = "#000000";
  private _font: string = "16px sans-serif";
  private _textAlign: string = "left";
  private _textBaseline: string = "alphabetic";
  lineWidth: number = 1;
  lineCap: string = "butt";
  lineJoin: string = "miter";
  miterLimit: number = 10;
  lineDashOffset: number = 0;
  globalAlpha: number = 1;
  globalCompositeOperation: string = "source-over";
  shadowColor: string = "rgba(0,0,0,0)";
  shadowBlur: number = 0;
  shadowOffsetX: number = 0;
  shadowOffsetY: number = 0;
  imageSmoothingEnabled: boolean = true;
  imageSmoothingQuality: string = "low";
  private pixels: Uint8ClampedArray;
  // 2D affine transform: [a c e, b d f] == [scaleX skewX tx, skewY scaleY ty].
  // Stored as {a,b,c,d,e,f}. Identity = {1,0,0,1,0,0}.
  private a = 1; private b = 0; private c = 0; private d = 1; private e = 0; private f = 0;
  private stateStack: DrawState[] = [];
  // ── Current path (device-space, flattened at record time) ──
  private path: Subpath[] = [];
  private curSub: Subpath | null = null;
  private curX = 0; private curY = 0;          // current point, user coords
  private dash: number[] = [];
  private clipMask: Uint8ClampedArray | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  /** Resize the bitmap + reset all drawing state (spec behavior when the
   *  owning canvas's width/height is assigned — the context object itself is
   *  preserved). Used by the canvas polyfills so previously-handed-out
   *  contexts stay valid. */
  reset(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.pixels = new Uint8ClampedArray(Math.max(0, w * h * 4));
    this.resetState();
  }

  private resetState(): void {
    this._fillStyle = "#000000";
    this._fillGradient = null;
    this._strokeStyle = "#000000";
    this._font = "16px sans-serif";
    this._textAlign = "left";
    this._textBaseline = "alphabetic";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this.lineDashOffset = 0;
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.shadowColor = "rgba(0,0,0,0)";
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "low";
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    this.stateStack.length = 0;
    this.path = [];
    this.curSub = null;
    this.dash = [];
    this.clipMask = null;
  }

  get fillStyle(): any { return this._fillGradient ?? this._fillStyle; }
  set fillStyle(v: any) {
    // Callers may set fillStyle to a CanvasPattern or CanvasGradient object
    // rather than a color string. parseColor handles non-string values by
    // returning black, which would make text invisible on dark backgrounds.
    // Fall back to white for pattern/gradient objects so text remains visible.
    if (v instanceof NativeCanvasGradient) {
      this._fillGradient = v;
      return;
    }
    this._fillGradient = null;
    if (typeof v === "string") this._fillStyle = v;
    else this._fillStyle = "#ffffff";
  }
  get strokeStyle(): string { return this._strokeStyle; }
  set strokeStyle(v: any) {
    if (typeof v === "string") this._strokeStyle = v;
    else this._strokeStyle = "#ffffff";
  }
  get font(): string { return this._font; }
  set font(v: string) { this._font = v; }
  get textAlign(): string { return this._textAlign; }
  set textAlign(v: string) { this._textAlign = v; }
  get textBaseline(): string { return this._textBaseline; }
  set textBaseline(v: string) { this._textBaseline = v; }

  // ── Transforms ──
  save(): void {
    this.stateStack.push({
      a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f,
      fillStyle: this._fillStyle, fillGradient: this._fillGradient,
      strokeStyle: this._strokeStyle, lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha, composite: this.globalCompositeOperation,
      lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit,
      dash: [...this.dash], dashOffset: this.lineDashOffset,
      clip: this.clipMask,
      shadowColor: this.shadowColor, shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX, shadowOffsetY: this.shadowOffsetY,
      font: this._font, textAlign: this._textAlign, textBaseline: this._textBaseline,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality,
    });
  }
  restore(): void {
    const s = this.stateStack.pop();
    if (!s) return;
    this.a = s.a; this.b = s.b; this.c = s.c; this.d = s.d; this.e = s.e; this.f = s.f;
    this._fillStyle = s.fillStyle; this._fillGradient = s.fillGradient;
    this._strokeStyle = s.strokeStyle; this.lineWidth = s.lineWidth;
    this.globalAlpha = s.globalAlpha; this.globalCompositeOperation = s.composite;
    this.lineCap = s.lineCap; this.lineJoin = s.lineJoin; this.miterLimit = s.miterLimit;
    this.dash = s.dash; this.lineDashOffset = s.dashOffset;
    this.clipMask = s.clip;
    this.shadowColor = s.shadowColor; this.shadowBlur = s.shadowBlur;
    this.shadowOffsetX = s.shadowOffsetX; this.shadowOffsetY = s.shadowOffsetY;
    this._font = s.font; this._textAlign = s.textAlign; this._textBaseline = s.textBaseline;
    this.imageSmoothingEnabled = s.imageSmoothingEnabled;
    this.imageSmoothingQuality = s.imageSmoothingQuality;
  }
  resetTransform(): void { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; }
  translate(tx: number, ty: number): void { this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; }
  scale(sx: number, sy: number): void { this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; }
  rotate(r: number): void {
    const cos = Math.cos(r), sin = Math.sin(r);
    this.transform(cos, sin, -sin, cos, 0, 0);
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // Post-multiply: CTM' = CTM × M (the argument applies in user space).
    const na = this.a * a + this.c * b;
    const nb = this.b * a + this.d * b;
    const nc = this.a * c + this.c * d;
    const nd = this.b * c + this.d * d;
    const ne = this.a * e + this.c * f + this.e;
    const nf = this.b * e + this.d * f + this.f;
    this.a = na; this.b = nb; this.c = nc; this.d = nd; this.e = ne; this.f = nf;
  }
  private transformPoint(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  private getFontSize(): number {
    const m = this._font.match(/(\d+)px/);
    return m ? parseInt(m[1]) : 16;
  }

  measureText(text: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } {
    const fontSize = this.getFontSize();
    // Use FreeType for accurate measurement when available
    const ftWidth = ftMeasureText(text, fontSize);
    const width = ftWidth >= 0 ? ftWidth : text.length * fontSize * 0.6;
    // cosmic-text renders text taller than the nominal fontSize (it
    // includes ascenders + descenders, typically ~1.2× fontSize). Report
    // generous ascent/descent so callers allocate a tall enough canvas;
    // otherwise the bottom of glyphs (descenders like 'g', 'p', 'y') gets
    // clipped.
    return {
      width,
      actualBoundingBoxAscent: fontSize * 1.25,
      actualBoundingBoxDescent: fontSize * 0.25,
    };
  }

  fillText(text: string, x: number, y: number): void {
    this._renderText(text, x, y, this._fillStyle, false);
  }

  strokeText(text: string, x: number, y: number): void {
    this._renderText(text, x, y, this._strokeStyle, true);
  }

  private _renderText(text: string, x: number, y: number, styleColor: string, isStroke: boolean): void {
    const baseFontSize = this.getFontSize();
    // Apply the current transform's scale to the font size (canvas text
    // libraries scale the context — e.g. context.scale(res, res) for a
    // `resolution` factor — so the raster renders crisper). Use the
    // geometric mean of |a| and |d|.
    const scaleFactor = Math.sqrt(Math.abs(this.a * this.d)) || 1;
    const fontSize = Math.max(1, Math.round(baseFontSize * scaleFactor));
    const [cr, cg, cb, ca] = parseColor(styleColor);

    // Adjust y based on textBaseline (in pre-transform units)
    let logicalY = y;
    if (this._textBaseline === "top") logicalY = y;
    else if (this._textBaseline === "middle") logicalY = y - baseFontSize * 0.5;
    else if (this._textBaseline === "alphabetic") logicalY = y - baseFontSize * 1.0;

    // Transform the start point through the current affine.
    const [tx, ty] = this.transformPoint(x, logicalY);
    let dstStartX = Math.floor(tx);
    const dstStartY = Math.floor(ty);

    // textAlign: measure in device px (fontSize already includes the
    // transform scale) and shift the pen left for center/right.
    if (this._textAlign === "center" || this._textAlign === "right" || this._textAlign === "end") {
      const w = ftIsAvailable() ? ftMeasureText(text, fontSize) : -1;
      const tw = w >= 0 ? w : text.length * fontSize * 0.6;
      dstStartX -= Math.floor(this._textAlign === "center" ? tw / 2 : tw);
    }

    // Try FreeType first for proper anti-aliased TrueType rendering
    if (ftIsAvailable()) {
      const result = ftRenderText(text, fontSize);
      if (result) {
        const { data, width: tw, height: th } = result;
        for (let py = 0; py < th; py++) {
          for (let px = 0; px < tw; px++) {
            const srcIdx = (py * tw + px) * 4;
            const alpha = data[srcIdx + 3];
            if (alpha === 0) continue;
            const dstX = dstStartX + px;
            const dstY = dstStartY + py;
            if (dstX < 0 || dstX >= this.width || dstY < 0 || dstY >= this.height) continue;
            let srcA = (alpha / 255) * (ca / 255) * this.globalAlpha;
            if (this.clipMask) srcA *= this.clipMask[dstY * this.width + dstX]! / 255;
            if (srcA <= 0) continue;
            const idx = (dstY * this.width + dstX) * 4;
            // Non-premultiplied "over" compositing.
            // The canvas must store non-premultiplied RGBA because
            // copyExternalImageToTexture premultiplies on upload (premult=true).
            // Using premultiplied compositing here would double-premultiply,
            // making text invisible (alpha squared).
            const dstA = this.pixels[idx + 3] / 255;
            const outA = srcA + dstA * (1 - srcA);
            if (outA > 0) {
              this.pixels[idx]     = Math.min(255, (cr * srcA + this.pixels[idx]     * dstA * (1 - srcA)) / outA);
              this.pixels[idx + 1] = Math.min(255, (cg * srcA + this.pixels[idx + 1] * dstA * (1 - srcA)) / outA);
              this.pixels[idx + 2] = Math.min(255, (cb * srcA + this.pixels[idx + 2] * dstA * (1 - srcA)) / outA);
            }
            this.pixels[idx + 3] = Math.min(255, outA * 255);
          }
        }
        return;
      }
    }

    // Fallback: original 8x12 bitmap glyph atlas
    const scaleX = fontSize / GLYPH_W;
    const scaleY = fontSize / GLYPH_H;
    const ss = 2;

    let cursorX = dstStartX;
    let curY = dstStartY;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') { cursorX = dstStartX; curY += fontSize * 1.2; continue; }
      const pattern = GLYPH_PATTERNS[ch];
      if (!pattern || pattern.length < GLYPH_H) { cursorX += fontSize * 0.6; continue; }

      const glyphW = Math.ceil(GLYPH_W * scaleX);
      const glyphH = Math.ceil(GLYPH_H * scaleY);

      for (let py = 0; py < glyphH; py++) {
        for (let px = 0; px < glyphW; px++) {
          let coverage = 0;
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) {
              const srcX = Math.floor((px * ss + sx) / (scaleX * ss));
              const srcY = Math.floor((py * ss + sy) / (scaleY * ss));
              if (srcX >= 0 && srcX < GLYPH_W && srcY >= 0 && srcY < GLYPH_H && pattern[srcY] && srcX < pattern[srcY].length) {
                if (pattern[srcY][srcX] === 'X') coverage++;
              }
            }
          }
          if (coverage === 0) continue;
          let srcA = (coverage / (ss * ss)) * (ca / 255) * this.globalAlpha;
          const dstX = Math.floor(cursorX + px);
          const dstY = Math.floor(curY + py);
          if (dstX < 0 || dstX >= this.width || dstY < 0 || dstY >= this.height) continue;
          if (this.clipMask) srcA *= this.clipMask[dstY * this.width + dstX]! / 255;
          if (srcA <= 0) continue;
          const idx = (dstY * this.width + dstX) * 4;
          // Non-premultiplied "over" compositing (see FreeType path above).
          const dstA = this.pixels[idx + 3] / 255;
          const outA = srcA + dstA * (1 - srcA);
          if (outA > 0) {
            this.pixels[idx]     = Math.min(255, (cr * srcA + this.pixels[idx]     * dstA * (1 - srcA)) / outA);
            this.pixels[idx + 1] = Math.min(255, (cg * srcA + this.pixels[idx + 1] * dstA * (1 - srcA)) / outA);
            this.pixels[idx + 2] = Math.min(255, (cb * srcA + this.pixels[idx + 2] * dstA * (1 - srcA)) / outA);
          }
          this.pixels[idx + 3] = Math.min(255, outA * 255);
        }
      }
      cursorX += fontSize * 0.6;
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    // Fast path: identity transform, no clip, opaque source-over solid fill —
    // stamp whole rows with set(). Slow path routes through the path
    // rasterizer so transforms/clip/alpha/composite/gradient all apply.
    const isIdentity = this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1;
    if (isIdentity && !this.clipMask && !this._fillGradient &&
        this.globalAlpha >= 1 && this.globalCompositeOperation === "source-over") {
      const [r, g, b, a] = parseColor(this._fillStyle);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(this.width, Math.ceil(x + w));
      const y1 = Math.min(this.height, Math.ceil(y + h));
      if (x1 <= x0 || y1 <= y0) return;
      const rowLen = (x1 - x0) * 4;
      const row = new Uint8Array(rowLen);
      for (let i = 0; i < rowLen; i += 4) {
        row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a;
      }
      for (let py = y0; py < y1; py++) {
        this.pixels.set(row, (py * this.width + x0) * 4);
      }
      return;
    }
    const savedPath = this.path, savedSub = this.curSub;
    this.path = []; this.curSub = null;
    this.rect(x, y, w, h);
    this.drawShadow();
    this.compositeSubs(this.path, false, this._fillGradient ? "#ffffff" : this._fillStyle, this._fillGradient);
    this.path = savedPath; this.curSub = savedSub;
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const isIdentity = this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1;
    if (isIdentity && !this.clipMask) {
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(this.width, Math.ceil(x + w));
      const y1 = Math.min(this.height, Math.ceil(y + h));
      if (x1 <= x0 || y1 <= y0) return;
      const rowLen = (x1 - x0) * 4;
      for (let py = y0; py < y1; py++) {
        this.pixels.fill(0, (py * this.width + x0) * 4, (py * this.width + x0) * 4 + rowLen);
      }
      return;
    }
    // Transformed/clipped clear: rasterize the rect, erase covered pixels.
    const savedPath = this.path, savedSub = this.curSub;
    this.path = []; this.curSub = null;
    this.rect(x, y, w, h);
    const subs = this.path;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let si = 0; si < subs.length; si++) {
      const pts = subs[si]!.pts;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i]! < minX) minX = pts[i]!;
        if (pts[i]! > maxX) maxX = pts[i]!;
        if (pts[i + 1]! < minY) minY = pts[i + 1]!;
        if (pts[i + 1]! > maxY) maxY = pts[i + 1]!;
      }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.width, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height, Math.ceil(maxY));
    const rw = x1 - x0;
    if (rw > 0 && y1 > y0) {
      const cov = new Float32Array(rw);
      const clip = this.clipMask;
      const W = this.width;
      for (let py = y0; py < y1; py++) {
        this.rasterizeRowOffset(subs, py, false, cov, x0);
        for (let i = 0; i < rw; i++) {
          let c = cov[i]!;
          if (c <= 0) continue;
          const px = x0 + i;
          if (clip) c *= clip[py * W + px]! / 255;
          if (c <= 0) continue;
          const idx = (py * W + px) * 4;
          // Erase proportionally to coverage.
          this.pixels[idx] *= 1 - c;
          this.pixels[idx + 1] *= 1 - c;
          this.pixels[idx + 2] *= 1 - c;
          this.pixels[idx + 3] *= 1 - c;
        }
      }
    }
    this.path = savedPath; this.curSub = savedSub;
  }

  createImageData(w: number, h: number): any {
    const data = new Uint8ClampedArray(w * h * 4);
    const ImageDataCtor = (globalThis as any).ImageData;
    if (ImageDataCtor) return new ImageDataCtor(data, w, h);
    return { data, width: w, height: h, colorSpace: "srgb" };
  }

  getImageData(x: number, y: number, w: number, h: number): any {
    const data = new Uint8ClampedArray(w * h * 4);
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    // Clip to the canvas bounds — copy contiguous row spans with set().
    const x0 = Math.max(0, fx);
    const y0 = Math.max(0, fy);
    const x1 = Math.min(this.width, fx + w);
    const y1 = Math.min(this.height, fy + h);
    if (x1 > x0 && y1 > y0) {
      const rowBytes = (x1 - x0) * 4;
      for (let py = y0; py < y1; py++) {
        const srcIdx = (py * this.width + x0) * 4;
        const dstIdx = ((py - fy) * w + (x0 - fx)) * 4;
        data.set(this.pixels.subarray(srcIdx, srcIdx + rowBytes), dstIdx);
      }
    }
    const ImageDataCtor = (globalThis as any).ImageData;
    if (ImageDataCtor) return new ImageDataCtor(data, w, h);
    // Fallback: return a plain object shaped like ImageData (for Bun native mode
    // where the ImageData constructor is not available).
    return { data, width: w, height: h, colorSpace: "srgb" };
  }

  putImageData(data: any, x: number, y: number): void {
    if (!data?.data) return;
    const srcData = data.data as Uint8ClampedArray;
    const w = data.width;
    const h = data.height;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const x0 = Math.max(0, fx);
    const y0 = Math.max(0, fy);
    const x1 = Math.min(this.width, fx + w);
    const y1 = Math.min(this.height, fy + h);
    if (x1 <= x0 || y1 <= y0) return;
    const rowBytes = (x1 - x0) * 4;
    for (let py = y0; py < y1; py++) {
      const srcIdx = ((py - fy) * w + (x0 - fx)) * 4;
      const dstIdx = (py * this.width + x0) * 4;
      this.pixels.set(srcData.subarray(srcIdx, srcIdx + rowBytes), dstIdx);
    }
  }

  // ── Path construction (recorded in user space, flattened to device-space
  //    polylines immediately so fill/stroke/clip work purely in pixels) ──
  beginPath(): void { this.path = []; this.curSub = null; }

  private devPt(x: number, y: number): [number, number] { return this.transformPoint(x, y); }

  private startSub(x: number, y: number): void {
    const [dx, dy] = this.devPt(x, y);
    this.curSub = { pts: [dx, dy], closed: false, sx: x, sy: y };
    this.path.push(this.curSub);
    this.curX = x; this.curY = y;
  }

  private lineToDev(x: number, y: number): void {
    if (!this.curSub) { this.startSub(x, y); return; }
    const [dx, dy] = this.devPt(x, y);
    this.curSub.pts.push(dx, dy);
    this.curX = x; this.curY = y;
  }

  moveTo(x: number, y: number): void { this.startSub(x, y); }
  lineTo(x: number, y: number): void { this.lineToDev(x, y); }

  closePath(): void {
    if (!this.curSub) return;
    this.curSub.closed = true;
    // Pen returns to the subpath's start point (per spec); subsequent lineTo
    // calls continue the same subpath from there.
    this.curX = this.curSub.sx ?? this.curX; this.curY = this.curSub.sy ?? this.curY;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.startSub(x, y);
    this.lineToDev(x + w, y);
    this.lineToDev(x + w, y + h);
    this.lineToDev(x, y + h);
    if (this.curSub) this.curSub.closed = true;
    this.curSub = null;
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void {
    const rr = Array.isArray(radii) ? radii : [radii ?? 0];
    // Canvas allows [tl,tr,br,bl] shorthand — normalize to 4 corners.
    const [tl, tr, br, bl] = [rr[0] ?? 0, rr[1] ?? rr[0] ?? 0, rr[2] ?? rr[0] ?? 0, rr[3] ?? rr[1] ?? rr[0] ?? 0]
      .map((v) => Math.max(0, Math.min(v, Math.min(w, h) / 2)));
    // Roughly-constant angle step sized for small device-space radii.
    const scale = this.approxScale();
    const seg = (r: number) => Math.max(2, Math.min(12, Math.ceil((r * scale) / 2)));
    const cornerArc = (cx: number, cy: number, r: number, a0: number, a1: number, moveFirst: boolean) => {
      const n = seg(r);
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0 && moveFirst) this.startSub(px, py);
        else this.lineToDev(px, py);
      }
    };
    const PI2 = Math.PI / 2;
    // Top-left corner → clockwise.
    cornerArc(x + tl, y + tl, tl, -Math.PI, -Math.PI + PI2, true);
    cornerArc(x + w - tr, y + tr, tr, -PI2, 0, false);
    cornerArc(x + w - br, y + h - br, br, 0, PI2, false);
    cornerArc(x + bl, y + h - bl, bl, PI2, Math.PI, false);
    if (this.curSub) this.curSub.closed = true;
    this.curSub = null;
  }

  /** Mean absolute scale of the transform (for tessellation tolerance). */
  private approxScale(): number {
    const sx = Math.hypot(this.a, this.b);
    const sy = Math.hypot(this.c, this.d);
    return (sx + sy) / 2 || 1;
  }

  /** Flatten a circular arc into line segments. */
  private arcPts(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean): void {
    // Normalize sweep to [0, 2π] honoring the counterclockwise flag
    // (counterclockwise = decreasing angle).
    let sweep = ccw ? a0 - a1 : a1 - a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    const n = this.arcSegs(Math.max(rx, ry), sweep);
    for (let i = 0; i <= n; i++) {
      const a = ccw ? a0 - (sweep * i) / n : a0 + (sweep * i) / n;
      const ux = Math.cos(a) * rx, uy = Math.sin(a) * ry;
      const px = cx + ux * Math.cos(rot) - uy * Math.sin(rot);
      const py = cy + ux * Math.sin(rot) + uy * Math.cos(rot);
      this.lineToDev(px, py);
    }
  }

  private arcSegs(r: number, sweep: number): number {
    // Chord-error driven: step <= sqrt(8*tol/r_dev) with tol ≈ 0.4px.
    const rDev = Math.max(1, r * this.approxScale());
    const step = Math.min(0.5, Math.sqrt(3.2 / rDev));
    return Math.max(3, Math.min(160, Math.ceil(sweep / step)));
  }

  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void {
    if (r <= 0) { this.lineToDev(x, y); return; }
    this.arcPts(x, y, r, r, 0, start, end, ccw === true);
  }

  ellipse(x: number, y: number, rx: number, ry: number, rot: number, start: number, end: number, ccw?: boolean): void {
    if (rx <= 0 || ry <= 0) { this.lineToDev(x, y); return; }
    this.arcPts(x, y, rx, ry, rot, start, end, ccw === true);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (!this.curSub || r <= 0) { this.lineToDev(x1, y1); return; }
    const [x0, y0] = [this.curX, this.curY];
    // Tangent-circle construction (standard canvas arcTo).
    let dx = x0 - x1, dy = y0 - y1;
    const d0 = Math.hypot(dx, dy);
    if (d0 === 0) { this.lineToDev(x1, y1); return; }
    dx /= d0; dy /= d0;
    let ex = x2 - x1, ey = y2 - y1;
    const d1 = Math.hypot(ex, ey);
    if (d1 === 0) { this.lineToDev(x1, y1); return; }
    ex /= d1; ey /= d1;
    const cosA = -(dx * ex + dy * ey);
    if (cosA >= 0.9999) { this.lineToDev(x1, y1); return; } // collinear
    const tan = Math.sqrt((1 - cosA) / (1 + cosA));
    const dist = r / tan;
    const bx = x1 + dx * dist, by = y1 + dy * dist;
    const cx2 = x1 + ex * dist, cy2 = y1 + ey * dist;
    // Circle center lies along the angle bisector at distance r/sin(half).
    const mx = (dx + ex) / 2, my = (dy + ey) / 2;
    const mLen = Math.hypot(mx, my) || 1;
    const sinH = Math.sqrt((1 - cosA) / 2);
    const ccx = x1 + (mx / mLen) * (r / sinH);
    const ccy = y1 + (my / mLen) * (r / sinH);
    const a0 = Math.atan2(by - ccy, bx - ccx);
    const a1 = Math.atan2(cy2 - ccy, cx2 - ccx);
    // Sweep direction: pick the shorter arc consistent with travel direction.
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const cross = dx * ey - dy * ex;
    if ((sweep > 0) !== (cross < 0)) sweep += sweep > 0 ? -Math.PI * 2 : Math.PI * 2;
    this.lineToDev(bx, by);
    const n = this.arcSegs(r, Math.abs(sweep));
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      this.lineToDev(ccx + Math.cos(a) * r, ccy + Math.sin(a) * r);
    }
  }

  quadraticCurveTo(c1x: number, c1y: number, x: number, y: number): void {
    const [x0, y0] = this.curSub ? [this.curX, this.curY] : [x, y];
    const scale = this.approxScale();
    const len = (Math.hypot(c1x - x0, c1y - y0) + Math.hypot(x - c1x, y - c1y)) * scale;
    const n = Math.max(4, Math.min(64, Math.ceil(len / 4)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      this.lineToDev(
        mt * mt * x0 + 2 * mt * t * c1x + t * t * x,
        mt * mt * y0 + 2 * mt * t * c1y + t * t * y,
      );
    }
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const [x0, y0] = this.curSub ? [this.curX, this.curY] : [x, y];
    const scale = this.approxScale();
    const len = (Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y)) * scale;
    const n = Math.max(4, Math.min(96, Math.ceil(len / 4)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      this.lineToDev(
        mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x,
        mt * mt * mt * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * y,
      );
    }
  }

  // ── Rasterization: scanline coverage + blending ──

  /** Inverse affine (user-space sampling for gradients). */
  private invTransform(): [number, number, number, number, number, number] {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return [1, 0, 0, 1, 0, 0];
    const ia = this.d / det, ib = -this.b / det, ic = -this.c / det, id = this.a / det;
    return [ia, ib, ic, id, -(this.e * ia + this.f * ic), -(this.e * ib + this.f * id)];
  }

  fill(rule?: string): void {
    if (this.path.length === 0) return;
    const evenOdd = rule === "evenodd";
    this.drawShadow();
    this.compositeSubs(this.path, evenOdd, this._fillStyle, this._fillGradient);
  }

  private compositeSubs(subs: Subpath[], evenOdd: boolean, style: string, grad: NativeCanvasGradient | null): void {
    const [cr, cg, cb, ca0] = parseColor(style);
    const baseA = (ca0 / 255) * this.globalAlpha;
    if (baseA <= 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let si = 0; si < subs.length; si++) {
      const pts = subs[si]!.pts;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i]! < minX) minX = pts[i]!;
        if (pts[i]! > maxX) maxX = pts[i]!;
        if (pts[i + 1]! < minY) minY = pts[i + 1]!;
        if (pts[i + 1]! > maxY) maxY = pts[i + 1]!;
      }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.width, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return;

    const w = x1 - x0;
    const cov = new Float32Array(w);
    const inv = grad ? this.invTransform() : null;
    const clip = this.clipMask;
    const px = this.pixels;
    const op = this.globalCompositeOperation;
    const W = this.width;

    for (let y = y0; y < y1; y++) {
      // Accumulate coverage for this scanline across all subpaths.
      cov.fill(0);
      this.rasterizeRowOffset(subs, y, evenOdd, cov, x0);
      for (let i = 0; i < w; i++) {
        let c = cov[i]!;
        if (c <= 0) continue;
        if (c > 1) c = 1;
        const x = x0 + i;
        if (clip) {
          const cm = clip[y * W + x]! / 255;
          c *= cm;
          if (c <= 0) continue;
        }
        let sr = cr, sg = cg, sb = cb, sa = baseA;
        if (grad && inv) {
          const ux = inv[0] * x + inv[2] * y + inv[4];
          const uy = inv[1] * x + inv[3] * y + inv[5];
          const col = grad.colorAt(grad.tAt(ux, uy));
          sr = col[0]; sg = col[1]; sb = col[2];
          sa *= col[3] / 255;
        }
        const idx = (y * W + x) * 4;
        this.blend(idx, sr, sg, sb, sa * c, op);
      }
    }
  }

  /** Blend one pixel at byte offset idx with source color sr,sg,sb and
   *  effective alpha sa∈[0,1]. Pixels are stored non-premultiplied. */
  private blend(idx: number, sr: number, sg: number, sb: number, sa: number, op: string): void {
    const px = this.pixels;
    const dr = px[idx]!, dg = px[idx + 1]!, db = px[idx + 2]!;
    const da = px[idx + 3]! / 255;
    let or: number, og: number, ob: number, oa: number;
    switch (op) {
      case "destination-out":
        or = dr; og = dg; ob = db; oa = da * (1 - sa);
        break;
      case "destination-over": {
        oa = da + sa * (1 - da);
        if (oa <= 0) { or = og = ob = 0; break; }
        or = (dr * da + sr * sa * (1 - da)) / oa;
        og = (dg * da + sg * sa * (1 - da)) / oa;
        ob = (db * da + sb * sa * (1 - da)) / oa;
        break;
      }
      case "source-atop":
        // Source over destination, result confined to dst alpha.
        oa = da;
        or = sr * sa + dr * (1 - sa);
        og = sg * sa + dg * (1 - sa);
        ob = sb * sa + db * (1 - sa);
        break;
      case "source-in":
        oa = sa * da;
        or = sr; og = sg; ob = sb;
        break;
      case "destination-in":
        oa = da * sa;
        or = dr; og = dg; ob = db;
        break;
      case "copy":
        or = sr; og = sg; ob = sb; oa = sa;
        break;
      case "lighter": {
        oa = Math.min(1, sa + da);
        or = Math.min(255, sr * sa + dr * da);
        og = Math.min(255, sg * sa + dg * da);
        ob = Math.min(255, sb * sa + db * da);
        break;
      }
      case "xor": {
        oa = sa + da - 2 * sa * da;
        if (oa <= 0) { or = og = ob = 0; break; }
        or = (sr * sa * (1 - da) + dr * da * (1 - sa)) / oa;
        og = (sg * sa * (1 - da) + dg * da * (1 - sa)) / oa;
        ob = (sb * sa * (1 - da) + db * da * (1 - sa)) / oa;
        break;
      }
      default: { // source-over
        oa = sa + da * (1 - sa);
        if (oa <= 0) { or = og = ob = 0; break; }
        or = (sr * sa + dr * da * (1 - sa)) / oa;
        og = (sg * sa + dg * da * (1 - sa)) / oa;
        ob = (sb * sa + db * da * (1 - sa)) / oa;
        break;
      }
    }
    px[idx] = Math.min(255, Math.max(0, or));
    px[idx + 1] = Math.min(255, Math.max(0, og));
    px[idx + 2] = Math.min(255, Math.max(0, ob));
    px[idx + 3] = Math.min(255, Math.max(0, oa * 255));
  }

  /** Coverage into `cov` (w entries) for scanline y, offset by x0. 4 subrow
   *  samples with subpixel x-area accumulation. */
  private rasterizeRowOffset(subs: Subpath[], y: number, evenOdd: boolean, cov: Float32Array, x0: number): void {
    const w = cov.length;
    const xs: number[] = [];
    const ds: number[] = [];
    for (let s = 0; s < 4; s++) {
      const sy = y + 0.125 + s * 0.25;
      xs.length = 0; ds.length = 0;
      for (let si = 0; si < subs.length; si++) {
        const sub = subs[si]!;
        const pts = sub.pts;
        const n = pts.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (!sub.closed && j === 0) break;
          const x1 = pts[i * 2]!, y1 = pts[i * 2 + 1]!;
          const x2 = pts[j * 2]!, y2 = pts[j * 2 + 1]!;
          if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) {
            const t = (sy - y1) / (y2 - y1);
            xs.push(x1 + t * (x2 - x1));
            ds.push(y2 > y1 ? 1 : -1);
          }
        }
      }
      if (xs.length < 2) continue;
      for (let i = 1; i < xs.length; i++) {
        const xv = xs[i]!, dv = ds[i]!;
        let k = i - 1;
        while (k >= 0 && xs[k]! > xv) { xs[k + 1] = xs[k]!; ds[k + 1] = ds[k]!; k--; }
        xs[k + 1] = xv; ds[k + 1] = dv;
      }
      let wind = 0;
      let inside = false;
      let spanStart = 0;
      for (let i = 0; i < xs.length; i++) {
        wind += ds[i]!;
        const nowInside = evenOdd ? (wind & 1) === 1 : wind !== 0;
        if (nowInside && !inside) spanStart = xs[i]!;
        else if (!nowInside && inside) {
          const xa = Math.max(x0, spanStart) - x0;
          const xb = Math.min(x0 + w, xs[i]!) - x0;
          if (xb > xa) {
            const p0 = Math.floor(xa), p1 = Math.min(w - 1, Math.floor(xb));
            for (let p = p0; p <= p1; p++) {
              const l = Math.max(xa, p), r = Math.min(xb, p + 1);
              cov[p] += Math.max(0, r - l) * 0.25;
            }
          }
        }
        inside = nowInside;
      }
    }
  }

  /** Expand the current path into stroke polygons (quads per segment plus
   *  join/cap discs) honoring lineWidth, dashes, joins, and caps. */
  private strokeGeometry(): Subpath[] {
    // Path points are already device-space, so the stroke width must be
    // scaled by the current transform (SVG strokes rely on this).
    const half = (this.lineWidth / 2) * this.approxScale();
    if (half <= 0) return [];
    const out: Subpath[] = [];
    const dash = this.dash;
    const dashOn = dash.length >= 2;

    const segQuad = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      const nx = (-dy / len) * half, ny = (dx / len) * half;
      out.push({ pts: [x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny], closed: true });
    };
    const disc = (cx: number, cy: number) => {
      const n = Math.max(6, Math.min(24, Math.ceil(half * 1.5)));
      const pts: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(cx + Math.cos(a) * half, cy + Math.sin(a) * half);
      }
      out.push({ pts, closed: true });
    };
    const joinPt = (x: number, y: number) => {
      if (this.lineJoin === "round") disc(x, y);
      // "miter"/"bevel": quads already bevel the corner — nothing extra.
    };
    const capEnd = (x: number, y: number, alongX: number, alongY: number) => {
      if (this.lineCap === "round") disc(x, y);
      else if (this.lineCap === "square") {
        const len = Math.hypot(alongX, alongY) || 1;
        const ex = (alongX / len) * half, ey = (alongY / len) * half;
        const nx = (-alongY / len) * half, ny = (alongX / len) * half;
        out.push({ pts: [x + nx, y + ny, x + nx + ex, y + ny + ey, x - nx + ex, y - ny + ey, x - nx, y - ny], closed: true });
      }
    };

    for (let si = 0; si < this.path.length; si++) {
      const sub = this.path[si]!;
      const pts = sub.pts;
      const n = pts.length / 2;
      if (n < 2) continue;
      const segCount = sub.closed ? n : n - 1;

      if (dashOn) {
        // Walk the subpath emitting dash-on segments as quads.
        const total: { x1: number; y1: number; x2: number; y2: number }[] = [];
        for (let i = 0; i < segCount; i++) {
          const j = (i + 1) % n;
          total.push({ x1: pts[i * 2]!, y1: pts[i * 2 + 1]!, x2: pts[j * 2]!, y2: pts[j * 2 + 1]! });
        }
        let dashIdx = 0;
        let remain = dash[0]!;
        let on = true;
        let pos = -this.lineDashOffset;
        // Normalize pos into the dash pattern.
        const period = dash.reduce((s, v) => s + v, 0) || 1;
        pos = ((pos % period) + period) % period;
        while (pos > remain) { pos -= remain; dashIdx = (dashIdx + 1) % dash.length; remain = dash[dashIdx]!; on = !on; }
        remain -= pos;
        for (let ti = 0; ti < total.length; ti++) {
          const seg = total[ti]!;
          let sx = seg.x1, sy = seg.y1;
          const sdx = seg.x2 - seg.x1, sdy = seg.y2 - seg.y1;
          const sLen = Math.hypot(sdx, sdy);
          if (sLen < 1e-6) continue;
          let walked = 0;
          while (walked < sLen) {
            const step = Math.min(remain, sLen - walked);
            if (on) {
              const t0 = walked / sLen, t1 = (walked + step) / sLen;
              segQuad(sx + sdx * t0, sy + sdy * t0, sx + sdx * t1, sy + sdy * t1);
            }
            walked += step;
            if (walked >= sLen) { remain -= step; }
            if (remain <= 1e-9) {
              dashIdx = (dashIdx + 1) % dash.length;
              remain = dash[dashIdx]!;
              on = !on;
            }
          }
        }
        continue;
      }

      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % n;
        const x1 = pts[i * 2]!, y1 = pts[i * 2 + 1]!;
        const x2 = pts[j * 2]!, y2 = pts[j * 2 + 1]!;
        segQuad(x1, y1, x2, y2);
      }
      if (this.lineJoin === "round") {
        const first = sub.closed ? 0 : 1;
        const last = sub.closed ? n - 1 : n - 2;
        for (let i = first; i <= last; i++) joinPt(pts[i * 2]!, pts[i * 2 + 1]!);
      }
      if (!sub.closed && this.lineCap !== "butt") {
        capEnd(pts[0]!, pts[1]!, pts[0]! - pts[2]!, pts[1]! - pts[3]!);
        capEnd(pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, pts[(n - 1) * 2]! - pts[(n - 2) * 2]!, pts[(n - 1) * 2 + 1]! - pts[(n - 2) * 2 + 1]!);
      }
    }
    return out;
  }

  stroke(): void {
    if (this.path.length === 0) return;
    const geo = this.strokeGeometry();
    if (geo.length === 0) return;
    this.drawShadow();
    // Fill the stroke geometry as one path — overlapping quads union via the
    // winding rule, so joins don't double-darken.
    this.compositeSubs(geo, false, this._strokeStyle, null);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    const saved = this.path;
    this.path = []; this.curSub = null;
    this.rect(x, y, w, h);
    this.stroke();
    this.path = saved; this.curSub = null;
  }

  clip(rule?: string): void {
    if (this.path.length === 0) return;
    const evenOdd = rule === "evenodd";
    // Rasterize the path coverage into a full-canvas mask.
    const mask = new Uint8ClampedArray(this.width * this.height);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let si = 0; si < this.path.length; si++) {
      const pts = this.path[si]!.pts;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i]! < minX) minX = pts[i]!;
        if (pts[i]! > maxX) maxX = pts[i]!;
        if (pts[i + 1]! < minY) minY = pts[i + 1]!;
        if (pts[i + 1]! > maxY) maxY = pts[i + 1]!;
      }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.width, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height, Math.ceil(maxY));
    const w = x1 - x0;
    const cov = new Float32Array(Math.max(0, w));
    for (let y = y0; y < y1; y++) {
      this.rasterizeRowOffset(this.path, y, evenOdd, cov, x0);
      for (let i = 0; i < w; i++) {
        const c = cov[i]!;
        if (c > 0) mask[y * this.width + x0 + i] = Math.min(255, Math.round(c * 255));
      }
    }
    if (this.clipMask) {
      const prev = this.clipMask;
      for (let i = 0; i < mask.length; i++) mask[i] = (mask[i]! * prev[i]!) / 255;
    }
    this.clipMask = mask;
  }

  /** Drop shadows: rasterize the current path coverage into a bbox mask, box-
   *  blur it (3 passes ≈ gaussian), and stamp shadowColor underneath. */
  private drawShadow(): void {
    const [sr, sg, sb, sa0] = parseColor(this.shadowColor);
    const shadowA = (sa0 / 255) * this.globalAlpha;
    if (shadowA <= 0) return;
    if (this.shadowBlur <= 0 && this.shadowOffsetX === 0 && this.shadowOffsetY === 0) return;

    // Shape bbox.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let si = 0; si < this.path.length; si++) {
      const pts = this.path[si]!.pts;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i]! < minX) minX = pts[i]!;
        if (pts[i]! > maxX) maxX = pts[i]!;
        if (pts[i + 1]! < minY) minY = pts[i + 1]!;
        if (pts[i + 1]! > maxY) maxY = pts[i + 1]!;
      }
    }
    const pad = Math.ceil(this.shadowBlur) + 2;
    const bx0 = Math.max(0, Math.floor(minX) - pad);
    const bx1 = Math.min(this.width, Math.ceil(maxX) + pad);
    const by0 = Math.max(0, Math.floor(minY) - pad);
    const by1 = Math.min(this.height, Math.ceil(maxY) + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw <= 0 || bh <= 0) return;

    const mask = new Float32Array(bw * bh);
    const cov = new Float32Array(bw);
    for (let y = by0; y < by1; y++) {
      this.rasterizeRowOffset(this.path, y, false, cov, bx0);
      for (let i = 0; i < bw; i++) mask[(y - by0) * bw + i] = Math.min(1, cov[i]!);
    }

    // Box blur (3 horizontal+vertical passes) approximating gaussian.
    const r = Math.max(1, Math.round(this.shadowBlur / 3));
    const tmp = new Float32Array(bw * bh);
    for (let pass = 0; pass < 3; pass++) {
      // Horizontal.
      for (let y = 0; y < bh; y++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += mask[y * bw + Math.min(bw - 1, Math.max(0, x))]!;
        for (let x = 0; x < bw; x++) {
          tmp[y * bw + x] = acc / (2 * r + 1);
          const add = mask[y * bw + Math.min(bw - 1, x + r + 1)]!;
          const sub = mask[y * bw + Math.max(0, x - r)]!;
          acc += add - sub;
        }
      }
      // Vertical.
      for (let x = 0; x < bw; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[Math.min(bh - 1, Math.max(0, y)) * bw + x]!;
        for (let y = 0; y < bh; y++) {
          mask[y * bw + x] = acc / (2 * r + 1);
          const add = tmp[Math.min(bh - 1, y + r + 1) * bw + x]!;
          const sub = tmp[Math.max(0, y - r) * bw + x]!;
          acc += add - sub;
        }
      }
    }

    // Stamp the shadow color through the blurred mask at the offset.
    const ox = Math.round(this.shadowOffsetX), oy = Math.round(this.shadowOffsetY);
    const W = this.width;
    const clip = this.clipMask;
    for (let y = 0; y < bh; y++) {
      const dy = by0 + y + oy;
      if (dy < 0 || dy >= this.height) continue;
      for (let x = 0; x < bw; x++) {
        const c = mask[y * bw + x]!;
        if (c <= 0) continue;
        const dx = bx0 + x + ox;
        if (dx < 0 || dx >= W) continue;
        let cc = c;
        if (clip) {
          cc *= clip[dy * W + dx]! / 255;
          if (cc <= 0) continue;
        }
        this.blend((dy * W + dx) * 4, sr, sg, sb, shadowA * cc, "source-over");
      }
    }
  }

  setLineDash(segments: number[]): void { this.dash = segments.slice(); }
  getLineDash(): number[] { return [...this.dash]; }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): NativeCanvasGradient {
    return new NativeCanvasGradient("linear", x0, y0, x1, y1);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): NativeCanvasGradient {
    return new NativeCanvasGradient("radial", x0, y0, x1, y1, r0, r1);
  }
  createPattern(_image: any, _repetition: string): any {
    // Some libraries call createPattern for texture-backed fill styles.
    // Return a pattern-shaped object with setTransform so the code path
    // doesn't crash. The fillStyle setter handles non-string values.
    return { setTransform: () => {} };
  }
  drawImage(image: any, ...args: number[]): void {
    // Supports all three DOM signatures:
    //   drawImage(img, dx, dy)
    //   drawImage(img, dx, dy, dw, dh)
    //   drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    // Sources: NativeImageBitmap (getPixelData), NativeImage (getBitmap),
    // canvas-like objects (getPixelData on OffscreenCanvas/VirtualCanvas),
    // and ImageData-shaped {data, width, height}.
    const src = image?.getPixelData?.()
      ?? image?.getBitmap?.()?.getPixelData?.()
      ?? image?.data;
    if (!src) return;
    const imgW = image?.width ?? image?.naturalWidth ?? 0;
    const imgH = image?.height ?? image?.naturalHeight ?? 0;
    if (!imgW || !imgH) return;

    let sx = 0, sy = 0, sw = imgW, sh = imgH;
    let dx: number, dy: number, dw: number, dh: number;
    // args counts: 2 = drawImage(img, dx, dy), 4 = +dw,dh, 8 = +sx,sy,sw,sh
    // (the DOM "9-arg" form counts the image argument itself).
    if (args.length >= 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number, number];
    } else if (args.length >= 4) {
      [dx, dy, dw, dh] = args as [number, number, number, number];
    } else {
      [dx, dy] = args as [number, number];
      dw = sw; dh = sh;
    }
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;

    const W = this.width, H = this.height;
    const clip = this.clipMask;
    const gAlpha = this.globalAlpha;
    const op = this.globalCompositeOperation;
    const fast = gAlpha >= 1 && op === "source-over" && !clip;

    // Fast path: axis-aligned (unrotated) transform — dest stays a rect.
    const axisAligned = Math.abs(this.b) < 1e-9 && Math.abs(this.c) < 1e-9;
    if (axisAligned) {
      // Device-space dest rect.
      const dx0 = this.a * dx + this.e;
      const dy0 = this.d * dy + this.f;
      const dwDev = this.a * dw;
      const dhDev = this.d * dh;
      const rx = Math.min(dx0, dx0 + dwDev);
      const ry = Math.min(dy0, dy0 + dhDev);
      const rw = Math.abs(dwDev), rh = Math.abs(dhDev);
      const flipX = dwDev < 0, flipY = dhDev < 0;
      const x0 = Math.max(0, Math.floor(rx));
      const y0 = Math.max(0, Math.floor(ry));
      const x1 = Math.min(W, Math.ceil(rx + rw));
      const y1 = Math.min(H, Math.ceil(ry + rh));
      if (x1 <= x0 || y1 <= y0) return;

      const smooth = this.imageSmoothingEnabled && (rw !== sw || rh !== sh);
      if (!smooth && !flipX && !flipY) {
        // Nearest / 1:1 row-copy path.
        for (let py = y0; py < y1; py++) {
          const fy = sy + ((py - ry) / rh) * sh;
          const syy = Math.min(imgH - 1, Math.max(0, Math.floor(fy)));
          const sRow = syy * imgW * 4;
          const dRow = py * W;
          for (let pxx = x0; pxx < x1; pxx++) {
            const fxx = sx + ((pxx - rx) / rw) * sw;
            const sxx = Math.min(imgW - 1, Math.max(0, Math.floor(fxx)));
            const sIdx = sRow + sxx * 4;
            const dIdx = (dRow + pxx) * 4;
            const sa = (src[sIdx + 3]! / 255) * gAlpha;
            if (sa <= 0) continue;
            if (clip) {
              const cm = clip[dRow + pxx]! / 255;
              if (cm <= 0) continue;
              this.blend(dIdx, src[sIdx]!, src[sIdx + 1]!, src[sIdx + 2]!, sa * cm, op);
            } else if (fast) {
              this.pixels[dIdx] = src[sIdx]!;
              this.pixels[dIdx + 1] = src[sIdx + 1]!;
              this.pixels[dIdx + 2] = src[sIdx + 2]!;
              this.pixels[dIdx + 3] = src[sIdx + 3]!;
            } else {
              this.blend(dIdx, src[sIdx]!, src[sIdx + 1]!, src[sIdx + 2]!, sa, op);
            }
          }
        }
        return;
      }
      // Bilinear resample (optionally flipped).
      for (let py = y0; py < y1; py++) {
        let fy = ((py - ry) / rh);
        if (flipY) fy = 1 - fy;
        const gy = sy + fy * sh - 0.5;
        const dRow = py * W;
        for (let pxx = x0; pxx < x1; pxx++) {
          let fx = ((pxx - rx) / rw);
          if (flipX) fx = 1 - fx;
          const gx = sx + fx * sw - 0.5;
          // Bilinear taps, clamped to the source rect edges.
          const cx0 = Math.max(sx, Math.floor(gx));
          const cy0 = Math.max(sy, Math.floor(gy));
          const cx1 = Math.min(sx + sw - 1, cx0 + 1);
          const cy1 = Math.min(sy + sh - 1, cy0 + 1);
          const fxr = Math.min(1, Math.max(0, gx - Math.floor(gx)));
          const fyr = Math.min(1, Math.max(0, gy - Math.floor(gy)));
          const i00 = (Math.floor(cy0) * imgW + Math.floor(cx0)) * 4;
          const i10 = (Math.floor(cy0) * imgW + Math.floor(cx1)) * 4;
          const i01 = (Math.floor(cy1) * imgW + Math.floor(cx0)) * 4;
          const i11 = (Math.floor(cy1) * imgW + Math.floor(cx1)) * 4;
          const w00 = (1 - fxr) * (1 - fyr), w10 = fxr * (1 - fyr), w01 = (1 - fxr) * fyr, w11 = fxr * fyr;
          const sr = src[i00]! * w00 + src[i10]! * w10 + src[i01]! * w01 + src[i11]! * w11;
          const sg = src[i00 + 1]! * w00 + src[i10 + 1]! * w10 + src[i01 + 1]! * w01 + src[i11 + 1]! * w11;
          const sb = src[i00 + 2]! * w00 + src[i10 + 2]! * w10 + src[i01 + 2]! * w01 + src[i11 + 2]! * w11;
          const sa = (src[i00 + 3]! * w00 + src[i10 + 3]! * w10 + src[i01 + 3]! * w01 + src[i11 + 3]! * w11) / 255 * gAlpha;
          if (sa <= 0) continue;
          let cc = 1;
          if (clip) {
            cc = clip[dRow + pxx]! / 255;
            if (cc <= 0) continue;
          }
          this.blend((dRow + pxx) * 4, sr, sg, sb, sa * cc, op);
        }
      }
      return;
    }

    // General path: full affine. Inverse-map each dest pixel into the source
    // rect; out-of-rect samples are transparent.
    const [ia, ib, ic, id, ie, if2] = this.invTransform();
    // Dest quad corners → bbox.
    const corners = [
      this.devPt(dx, dy), this.devPt(dx + dw, dy),
      this.devPt(dx + dw, dy + dh), this.devPt(dx, dy + dh),
    ];
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const px = corners[i]![0]!, py = corners[i]![1]!;
      if (px < mnx) mnx = px; if (px > mxx) mxx = px;
      if (py < mny) mny = py; if (py > mxy) mxy = py;
    }
    const x0 = Math.max(0, Math.floor(mnx));
    const y0 = Math.max(0, Math.floor(mny));
    const x1 = Math.min(W, Math.ceil(mxx));
    const y1 = Math.min(H, Math.ceil(mxy));
    if (x1 <= x0 || y1 <= y0) return;
    for (let py = y0; py < y1; py++) {
      const dRow = py * W;
      for (let pxx = x0; pxx < x1; pxx++) {
        // Map device px → user space → normalized dest-rect coords.
        const ux = ia * pxx + ic * py + ie;
        const uy = ib * pxx + id * py + if2;
        const fx = (ux - dx) / dw, fy = (uy - dy) / dh;
        if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) continue;
        const gx = sx + fx * sw - 0.5;
        const gy = sy + fy * sh - 0.5;
        const cx0 = Math.max(sx, Math.floor(gx));
        const cy0 = Math.max(sy, Math.floor(gy));
        const cx1 = Math.min(sx + sw - 1, cx0 + 1);
        const cy1 = Math.min(sy + sh - 1, cy0 + 1);
        const fxr = Math.min(1, Math.max(0, gx - Math.floor(gx)));
        const fyr = Math.min(1, Math.max(0, gy - Math.floor(gy)));
        const i00 = (Math.floor(cy0) * imgW + Math.floor(cx0)) * 4;
        const i10 = (Math.floor(cy0) * imgW + Math.floor(cx1)) * 4;
        const i01 = (Math.floor(cy1) * imgW + Math.floor(cx0)) * 4;
        const i11 = (Math.floor(cy1) * imgW + Math.floor(cx1)) * 4;
        const w00 = (1 - fxr) * (1 - fyr), w10 = fxr * (1 - fyr), w01 = (1 - fxr) * fyr, w11 = fxr * fyr;
        const sr = src[i00]! * w00 + src[i10]! * w10 + src[i01]! * w01 + src[i11]! * w11;
        const sg = src[i00 + 1]! * w00 + src[i10 + 1]! * w10 + src[i01 + 1]! * w01 + src[i11 + 1]! * w11;
        const sb = src[i00 + 2]! * w00 + src[i10 + 2]! * w10 + src[i01 + 2]! * w01 + src[i11 + 2]! * w11;
        const sa = (src[i00 + 3]! * w00 + src[i10 + 3]! * w10 + src[i01 + 3]! * w01 + src[i11 + 3]! * w11) / 255 * gAlpha;
        if (sa <= 0) continue;
        let cc = 1;
        if (clip) {
          cc = clip[dRow + pxx]! / 255;
          if (cc <= 0) continue;
        }
        this.blend((dRow + pxx) * 4, sr, sg, sb, sa * cc, op);
      }
    }
  }
}
