// ============================================================================
// native-canvas2d.ts — Canvas2D with text rendering for IMUI
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
  // Named colors (subset PixiJS commonly uses)
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

export class NativeCanvas2D {
  width: number;
  height: number;
  private _fillStyle: string = "#000000";
  private _strokeStyle: string = "#000000";
  private _font: string = "16px sans-serif";
  private _textAlign: string = "left";
  private _textBaseline: string = "alphabetic";
  lineWidth: number = 1;
  globalAlpha: number = 1;
  globalCompositeOperation: string = "source-over";
  private pixels: Uint8ClampedArray;
  // 2D affine transform: [a c e, b d f] == [scaleX skewX tx, skewY scaleY ty].
  // Stored as {a,b,c,d,e,f}. Identity = {1,0,0,1,0,0}.
  private a = 1; private b = 0; private c = 0; private d = 1; private e = 0; private f = 0;
  private transformStack: Array<{ a: number; b: number; c: number; d: number; e: number; f: number }> = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  get fillStyle(): string { return this._fillStyle; }
  set fillStyle(v: any) {
    // PixiJS may set fillStyle to a CanvasPattern or CanvasGradient object
    // (when the fill style's texture !== Texture.WHITE, e.g. due to a
    // PixiJS version mismatch). parseColor handles non-string values by
    // returning black, which would make text invisible on dark backgrounds.
    // Fall back to white for pattern/gradient objects so text remains visible.
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
  save(): void { this.transformStack.push({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f }); }
  restore(): void { const t = this.transformStack.pop(); if (t) { this.a = t.a; this.b = t.b; this.c = t.c; this.d = t.d; this.e = t.e; this.f = t.f; } }
  resetTransform(): void { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; }
  translate(tx: number, ty: number): void { this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; }
  scale(sx: number, sy: number): void { this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; }
  rotate(_r: number): void { /* not needed for text; no-op */ }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const na = a * this.a + c * this.b;
    const nb = b * this.a + d * this.b;
    const nc = a * this.c + c * this.d;
    const nd = b * this.c + d * this.d;
    const ne = a * this.e + c * this.f + e;
    const nf = b * this.e + d * this.f + f;
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
    // FreeType/SDL_ttf renders text taller than the nominal fontSize (it
    // includes ascenders + descenders, typically ~1.2× fontSize). Report
    // generous ascent/descent so PixiJS allocates a tall enough canvas;
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
    // Apply the current transform's scale to the font size (PixiJS text uses
    // a uniform scale of `resolution` via context.scale(res, res) so the
    // raster is resolution× crisper). Use the geometric mean of |a| and |d|.
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
    const dstStartX = Math.floor(tx);
    const dstStartY = Math.floor(ty);

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
            const idx = (dstY * this.width + dstX) * 4;
            // Non-premultiplied "over" compositing.
            // The canvas must store non-premultiplied RGBA because
            // copyExternalImageToTexture premultiplies on upload (premult=true).
            // Using premultiplied compositing here would double-premultiply,
            // making text invisible (alpha squared).
            const srcA = (alpha / 255) * (ca / 255) * this.globalAlpha;
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
          const srcA = (coverage / (ss * ss)) * (ca / 255) * this.globalAlpha;
          const dstX = Math.floor(cursorX + px);
          const dstY = Math.floor(curY + py);
          if (dstX < 0 || dstX >= this.width || dstY < 0 || dstY >= this.height) continue;
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
    const [r, g, b, a] = parseColor(this._fillStyle);
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    // Build one filled row, then stamp it — row-wise set() instead of per-pixel.
    const rowLen = (x1 - x0) * 4;
    const row = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i += 4) {
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a;
    }
    for (let py = y0; py < y1; py++) {
      this.pixels.set(row, (py * this.width + x0) * 4);
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const rowLen = (x1 - x0) * 4;
    for (let py = y0; py < y1; py++) {
      this.pixels.fill(0, (py * this.width + x0) * 4, (py * this.width + x0) * 4 + rowLen);
    }
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
    if (ImageDataCtor) return new ImageDataCtor(w, h, data);
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

  // ── Path / gradient no-ops (PixiJS text uses fillText/measureText; these
  //    are stubbed for completeness so probes/calls don't throw). ──
  beginPath(): void {}
  closePath(): void {}
  moveTo(_x: number, _y: number): void {}
  lineTo(_x: number, _y: number): void {}
  arc(_x: number, _y: number, _r: number, _start: number, _end: number): void {}
  rect(_x: number, _y: number, _w: number, _h: number): void {}
  roundRect(_x: number, _y: number, _w: number, _h: number, _r: any): void {}
  ellipse(_x: number, _y: number, _rx: number, _ry: number, _rot: number, _start: number, _end: number): void {}
  bezierCurveTo(_c1x: number, _c1y: number, _c2x: number, _c2y: number, _x: number, _y: number): void {}
  quadraticCurveTo(_c1x: number, _c1y: number, _x: number, _y: number): void {}
  fill(): void {}
  stroke(): void {}
  clip(): void {}
  setLineDash(_dash: number[]): void {}
  createLinearGradient(_x0: number, _y0: number, _x1: number, _y1: number): any { return { addColorStop: () => {} }; }
  createRadialGradient(_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, _r1: number): any { return { addColorStop: () => {} }; }
  createPattern(_image: any, _repetition: string): any {
    // PixiJS getCanvasFillStyle calls createPattern when the fill style's
    // texture is not Texture.WHITE (e.g. due to a PixiJS version mismatch
    // where Texture.WHITE from one version !== Texture.WHITE from another).
    // Return a pattern-shaped object with setTransform so the code path
    // doesn't crash. The fillStyle setter handles non-string values.
    return { setTransform: () => {} };
  }
  drawImage(image: any, dx: number, dy: number, dw?: number, dh?: number): void {
    // Blit a NativeImageBitmap (RGBA) into the pixel buffer — used by PixiJS
    // text when compositing canvas snapshots and by getPixels paths.
    // Sources: NativeImageBitmap (getPixelData), NativeImage (getBitmap),
    // canvas-like objects (getPixelData on NativeSurface/VirtualCanvas),
    // and ImageData-shaped {data, width, height}.
    const src = image?.getPixelData?.()
      ?? image?.getBitmap?.()?.getPixelData?.()
      ?? image?.data;
    if (!src) return;
    const sw = image?.width ?? dw ?? 0;
    const sh = image?.height ?? dh ?? 0;
    if (!sw || !sh) return;
    const fx = Math.floor(dx);
    const fy = Math.floor(dy);
    // Clip the blit rect to the canvas — copy contiguous row spans.
    const x0 = Math.max(0, fx);
    const y0 = Math.max(0, fy);
    const x1 = Math.min(this.width, fx + sw);
    const y1 = Math.min(this.height, fy + sh);
    if (x1 <= x0 || y1 <= y0) return;
    const rowBytes = (x1 - x0) * 4;
    for (let py = y0; py < y1; py++) {
      const sIdx = ((py - fy) * sw + (x0 - fx)) * 4;
      const dIdx = (py * this.width + x0) * 4;
      this.pixels.set(src.subarray(sIdx, sIdx + rowBytes), dIdx);
    }
  }
}
