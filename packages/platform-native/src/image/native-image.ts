// ============================================================================
// native-image.ts — Native image decoding replacing createImageBitmap
//
// Uses stb_image via bun:ffi to decode PNG/JPEG/BMP/TGA images.
// Implements the ImageBitmap interface that the engine's asset loaders expect.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { dlopen, ptr, type CFunction } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger();

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

function findImageShimLibrary(): string {
  const envPath = process.env.IMAGE_SHIM_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const relativePath = join(_dirname, "..", "..", "native", "libimage_shim.so");
  if (existsSync(relativePath)) return relativePath;

  throw new Error("libimage_shim.so not found. Build with: cd native && gcc -shared -fPIC -o libimage_shim.so image_shim.c -lm");
}

const { symbols } = dlopen(findImageShimLibrary(), {
  image_shim_decode: { args: ["ptr", "i32", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" } as CFunction,
  image_shim_decode_file: { args: ["cstring", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" } as CFunction,
  image_shim_info: { args: ["ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" } as CFunction,
});

const imageShim = symbols as unknown as {
  image_shim_decode: (data: ptr, size: number, outData: ptr, outSize: number, wOut: ptr, hOut: ptr, cOut: ptr) => number;
  image_shim_decode_file: (path: string, outData: ptr, outSize: number, wOut: ptr, hOut: ptr, cOut: ptr) => number;
  image_shim_info: (data: ptr, size: number, wOut: ptr, hOut: ptr, cOut: ptr) => number;
};

// ── NativeImageBitmap: implements the ImageBitmap interface ──

export class NativeImageBitmap implements ImageBitmap {
  readonly width: number;
  readonly height: number;
  private pixelData: Uint8Array;
  private closed: boolean = false;

  constructor(width: number, height: number, pixelData: Uint8Array) {
    this.width = width;
    this.height = height;
    this.pixelData = pixelData;
  }

  // Get the raw RGBA pixel data (4 bytes per pixel)
  getPixelData(): Uint8Array {
    return this.pixelData;
  }

  close(): void {
    this.closed = true;
    this.pixelData = new Uint8Array(0);
  }
}

// ── createImageBitmap polyfill ──
// The engine calls createImageBitmap(blob) to decode images.
// We support: Blob, ArrayBuffer, Uint8Array, and string (file path).

export async function createImageBitmapNative(
  source: Blob | ArrayBuffer | Uint8Array | string,
  options?: ImageBitmapOptions,
): Promise<NativeImageBitmap> {
  let data: Uint8Array;

  if (typeof source === "string") {
    // File path — first get image info, then decode
    const fileData = await Bun.file(source).arrayBuffer();
    data = new Uint8Array(fileData);
  } else if (source instanceof Blob) {
    data = new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof ArrayBuffer) {
    data = new Uint8Array(source);
  } else if (source instanceof Uint8Array) {
    data = source;
  } else if (typeof source === "object" && source !== null && "width" in source && "height" in source && "getContext" in source) {
    // Canvas-like object — get 2D context and extract image data
    const canvas = source as any;
    const ctx = canvas.getContext("2d");
    if (ctx && typeof ctx.getImageData === "function") {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Create a NativeImageBitmap directly from the pixel data
      const pixels = new Uint8Array(imgData.data.buffer || imgData.data);
      return {
        width: canvas.width,
        height: canvas.height,
        data: pixels,
        close: () => {},
      } as unknown as NativeImageBitmap;
    }
    // If no 2D context, create a 1x1 gray pixel as fallback
    const fallback = new Uint8Array([0xcc, 0xcc, 0xcc, 0xff]);
    return {
      width: 1,
      height: 1,
      data: fallback,
      close: () => {},
    } as unknown as NativeImageBitmap;
  } else {
    throw new Error(`Unsupported image source type: ${typeof source}`);
  }

  // First, get image info to know the size
  const wBuf = new Int32Array(1);
  const hBuf = new Int32Array(1);
  const cBuf = new Int32Array(1);
  const infoResult = imageShim.image_shim_info(data as any, data.byteLength, wBuf as any, hBuf as any, cBuf as any);
  if (infoResult !== 0) throw new Error("Failed to get image info");

  const width = wBuf[0];
  const height = hBuf[0];
  const pixelSize = width * height * 4;

  // Allocate output buffer and decode into it
  const pixels = new Uint8Array(pixelSize);
  const decodeResult = imageShim.image_shim_decode(
    data as any, data.byteLength,
    pixels as any, pixelSize,
    wBuf as any, hBuf as any, cBuf as any,
  );
  if (decodeResult !== 0) throw new Error(`Failed to decode image (error ${decodeResult})`);

  return new NativeImageBitmap(width, height, pixels);
}

// ── Install polyfills on globalThis ──

export function installImagePolyfills(): void {
  if (typeof (globalThis as any).createImageBitmap === "undefined") {
    (globalThis as any).createImageBitmap = createImageBitmapNative;
  }

  if (typeof (globalThis as any).ImageBitmap === "undefined") {
    (globalThis as any).ImageBitmap = NativeImageBitmap;
  }

  // OffscreenCanvas polyfill — minimal, just for text atlas measurement
  if (typeof (globalThis as any).OffscreenCanvas === "undefined") {
    (globalThis as any).OffscreenCanvas = class OffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(contextType: string): any {
        if (contextType === "2d") {
          return new NativeCanvas2D(this.width, this.height);
        }
        return null;
      }

      transferToImageBitmap(): NativeImageBitmap {
        return new NativeImageBitmap(this.width, this.height, new Uint8Array(this.width * this.height * 4));
      }
    };
  }

  // ImageData polyfill
  if (typeof (globalThis as any).ImageData === "undefined") {
    (globalThis as any).ImageData = class ImageData {
      width: number;
      height: number;
      data: Uint8ClampedArray;

      constructor(width: number, height: number, data?: Uint8ClampedArray) {
        this.width = width;
        this.height = height;
        this.data = data ?? new Uint8ClampedArray(width * height * 4);
      }
    };
  }

  // Image polyfill — PixiJS DOMAdapter.createImage() returns `new Image()`.
  // Setting `src` decodes the file via stb_image (createImageBitmapNative) and
  // fires onload/onerror. Supports file paths, data: URLs, and http(s) via
  // Bun.file/fetch.
  if (typeof (globalThis as any).Image === "undefined") {
    (globalThis as any).Image = class NativeImage {
      width: number = 0;
      height: number = 0;
      naturalWidth: number = 0;
      naturalHeight: number = 0;
      src: string = "";
      alt: string = "";
      onload: ((this: any, ev: any) => any) | null = null;
      onerror: ((this: any, ev: any) => any) | null = null;
      private _bitmap: NativeImageBitmap | null = null;
      readonly complete: boolean = false;

      get width_(): number { return this.width; }

      async _load(src: string): Promise<void> {
        try {
          let source: Blob | ArrayBuffer | Uint8Array | string;
          if (src.startsWith("data:")) {
            // data URL — decode base64 payload
            const comma = src.indexOf(",");
            const b64 = src.slice(comma + 1);
            const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
            source = bytes;
          } else if (src.startsWith("http://") || src.startsWith("https://")) {
            const resp = await fetch(src);
            source = new Uint8Array(await resp.arrayBuffer());
          } else {
            source = src; // file path
          }
          const bmp = await createImageBitmapNative(source);
          this._bitmap = bmp as unknown as NativeImageBitmap;
          this.width = bmp.width;
          this.height = bmp.height;
          this.naturalWidth = bmp.width;
          this.naturalHeight = bmp.height;
          (this as any).complete = true;
          if (this.onload) this.onload.call(this, { type: "load", target: this });
        } catch (err) {
          (this as any).complete = true;
          if (this.onerror) this.onerror.call(this, { type: "error", target: this, error: err });
        }
      }

      getBitmap(): NativeImageBitmap | null { return this._bitmap; }

      addEventListener(type: string, listener: (ev: any) => void): void {
        if (type === "load") this.onload = listener as any;
        else if (type === "error") this.onerror = listener as any;
      }
      removeEventListener(type: string, _listener: (ev: any) => void): void {
        if (type === "load") this.onload = null;
        else if (type === "error") this.onerror = null;
      }
      decode(): Promise<void> { return this._load(this.src); }
    };
    // Intercept src assignment to trigger load. Use a Proxy on the prototype
    // setter so `img.src = url` works like a browser.
    const NativeImageCtor = (globalThis as any).Image;
    const srcDesc = Object.getOwnPropertyDescriptor(NativeImageCtor.prototype, "src");
    if (!srcDesc || !srcDesc.set) {
      Object.defineProperty(NativeImageCtor.prototype, "src", {
        get: function () { return this._src ?? ""; },
        set: function (v: string) {
          this._src = v;
          if (v) this._load(v);
        },
        configurable: true,
      });
    }
  }

  log.info("platform-native", "Image polyfills installed (stb_image + OffscreenCanvas + Image)");
}

// ── FreeType-based text rasterizer ──
// Uses libfont_shim.so (FreeType) via bun:ffi to render TrueType text.
// Falls back to the 8x12 bitmap glyph atlas if FreeType is unavailable.

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
  return "";
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
    const libPath = findFontShimLibrary();
    if (!libPath) { log.warn("platform-native", "libfont_shim.so not found — using bitmap font fallback"); return; }
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

function ftIsAvailable(): boolean {
  ensureFreeTypeInit();
  return ftFace !== 0n;
}

function ftMeasureText(text: string, fontSize: number): number {
  ensureFreeTypeInit();
  if (ftFace === 0n || !ftSymbols) return -1;
  return ftSymbols.ft_shim_measure(ftFace, text, fontSize) as unknown as number;
}

function ftRenderText(text: string, fontSize: number): { data: Uint8Array; width: number; height: number } | null {
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

// ── Canvas2D with text rendering for IMUI ──
// Implements fillText using FreeType (when available) or a built-in 8x12
// bitmap glyph atlas as fallback. The TextAtlasCache uses this to rasterize
// text into GPU textures.

const GLYPH_W = 8;
const GLYPH_H = 12;
const FONT_CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

// 8x12 bitmap glyph patterns (X = on, . = off)
const GLYPH_PATTERNS: Record<string, string[]> = {
  ' ': ['........','........','........','........','........','........','........','........','........','........','........','........'],
  '!': ['...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','........','...XX...','...XX...','........','........'],
  '"': ['..XX.XX.','..XX.XX.','..XX.XX.','........','........','........','........','........','........','........','........','........'],
  '#': ['..XX.XX.','..XX.XX.','..XX.XX.','XXXXXXXX','..XX.XX.','XXXXXXXX','..XX.XX.','..XX.XX.','..XX.XX.','........','........','........'],
  '$': ['...XXX..','.XX.X.X.','.X..X...','.XX.XX..','...X.XX.','.X..X.X.','.XX.X.X.','..XXX...','........','........','........','........'],
  '%': ['XX...XX.','XX..XX..','...XX...','..XX....','..XX....','...XX...','..XX..XX','XX...XX.','........','........','........','........'],
  '&': ['..XXX...','.XX.XX..','.XX.XX..','..XX....','.XX.XXX.','XX.X.XX.','X..XX.X.','.XXX..X.','........','........','........','........'],
  '\'': ['...XX...','...XX...','...XX...','........','........','........','........','........','........','........','........','........'],
  '(': ['....XX..','...XX...','..XX....','..XX....','..XX....','..XX....','..XX....','...XX...','....XX..','........','........','........'],
  ')': ['..XX....','...XX...','....XX..','....XX..','....XX..','....XX..','....XX..','...XX...','..XX....','........','........','........'],
  '*': ['........','..X..X..','.XX.XXX.','X.XXX.X.','.XX.XXX.','..X..X..','........','........','........','........','........','........'],
  '+': ['........','........','...XX...','...XX...','...XX...','XXXXXXX.','...XX...','...XX...','...XX...','........','........','........'],
  ',': ['........','........','........','........','........','........','........','...XX...','...XX...','..XX....','........','........'],
  '-': ['........','........','........','........','XXXXXXX.','XXXXXXX.','........','........','........','........','........','........'],
  '.': ['........','........','........','........','........','........','........','...XX...','...XX...','........','........','........'],
  '/': ['......XX','.....XX.','....XX..','...XX...','..XX....','.XX.....','XX......','XX......','........','........','........','........'],
  '0': ['..XXX...','.XX.XX..','.X...X..','X..X..X.','X..X..X.','X..X..X.','.X...X..','.XX.XX..','..XXX...','........','........','........'],
  '1': ['...XX...','..XXX...','.XXXX...','...XX...','...XX...','...XX...','...XX...','...XX...','XXXXXXX.','........','........','........'],
  '2': ['..XXX...','.XX.XX..','X....X..','....XX..','..XX....','.XX.....','XX......','XXXXXXX.','XXXXXXX.','........','........','........'],
  '3': ['..XXX...','.XX.XX..','X....X..','...XX...','...XXX..','......X.','X....X..','.XX.XX..','..XXX...','........','........','........'],
  '4': ['....XX..','...XXX..','..X.XX..','.X..XX..','X...XX..','XXXXXXX.','....XX..','....XX..','....XX..','........','........','........'],
  '5': ['XXXXXXX.','XX......','XX......','XXXXX...','....XX..','......X.','X....X..','.XX.XX..','..XXX...','........','........','........'],
  '6': ['..XXX...','.XX.XX..','XX......','XXXXX...','XX.X.XX.','X....X..','.X...X..','.XX.XX..','..XXX...','........','........','........'],
  '7': ['XXXXXXX.','X....X..','....X...','...X....','..X.....','..X.....','.XX.....','.XX.....','.XX.....','........','........','........'],
  '8': ['..XXX...','.XX.XX..','.X...X..','.XX.XX..','..XXX...','.XX.XX..','.X...X..','.XX.XX..','..XXX...','........','........','........'],
  '9': ['..XXX...','.XX.XX..','.X...X..','.XX..XX.','..XX.XX.','....XX..','...XX...','..XX....','.XXX....','........','........','........'],
  ':': ['........','........','...XX...','...XX...','........','........','...XX...','...XX...','........','........','........','........'],
  ';': ['........','........','...XX...','...XX...','........','........','...XX...','...XX...','..XX....','........','........','........'],
  '<': ['........','....XX..','...XX...','..XX....','.XX.....','..XX....','...XX...','....XX..','........','........','........','........'],
  '=': ['........','........','........','XXXXXXX.','........','XXXXXXX.','........','........','........','........','........','........'],
  '>': ['........','.XX.....','..XX....','...XX...','....XX..','...XX...','..XX....','.XX.....','........','........','........','........'],
  '?': ['..XXX...','.XX.XX..','X....X..','....XX..','...XX...','........','...XX...','...XX...','........','........','........','........'],
  '@': ['..XXX...','.X...X..','X.XX.XX.','X.XXXX.X','X.XX.XX.','X.XXXX.X','X.XX.XX.','.X...X..','..XXX...','........','........','........'],
  'A': ['..XXX...','.XX.XX..','.X...X..','X.....X.','XXXXXXX.','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'B': ['XXXXXX..','X.....X.','X.....X.','XXXXXX..','X.....X.','X.....X.','X.....X.','X.....X.','XXXXXX..','........','........','........'],
  'C': ['..XXXX..','.X....X.','X.......','X.......','X.......','X.......','X.......','.X....X.','..XXXX..','........','........','........'],
  'D': ['XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','X....X..','XXXXX...','........','........','........'],
  'E': ['XXXXXXX.','X.......','X.......','XXXXXX..','X.......','X.......','X.......','X.......','XXXXXXX.','........','........','........'],
  'F': ['XXXXXXX.','X.......','X.......','XXXXXX..','X.......','X.......','X.......','X.......','X.......','........','........','........'],
  'G': ['..XXXX..','.X....X.','X.......','X.......','X...XXX.','X.....X.','X.....X.','.X...X..','..XXX.X.','........','........','........'],
  'H': ['X.....X.','X.....X.','X.....X.','XXXXXXX.','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'I': ['XXXXXXX.','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','XXXXXXX.','........','........','........'],
  'J': ['..XXXXX.','....XX..','....XX..','....XX..','....XX..','....XX..','X...XX..','X...XX..','.XXX....','........','........','........'],
  'K': ['X.....X.','X....X..','X...X...','X..X....','XXX.....','X..X....','X...X...','X....X..','X.....X.','........','........','........'],
  'L': ['X.......','X.......','X.......','X.......','X.......','X.......','X.......','X.......','XXXXXXX.','........','........','........'],
  'M': ['X.....X.','XX...XX.','X.X.X.X.','X..X..X.','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'N': ['X.....X.','XX....X.','X.X...X.','X..X..X.','X...X.X.','X....XX.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'O': ['..XXX...','.X...X..','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'P': ['XXXXXX..','X.....X.','X.....X.','X.....X.','XXXXXX..','X.......','X.......','X.......','X.......','........','........','........'],
  'Q': ['..XXX...','.X...X..','X.....X.','X.....X.','X.....X.','X...X.X.','.X...X..','..XXX...','...XX...','........','........','........'],
  'R': ['XXXXXX..','X.....X.','X.....X.','X.....X.','XXXXXX..','X..X....','X...X...','X....X..','X.....X.','........','........','........'],
  'S': ['..XXXX..','.X....X.','X.......','..XXX...','....XXX.','......X.','X.....X.','.X....X.','..XXXX..','........','........','........'],
  'T': ['XXXXXXX.','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','........','........'],
  'U': ['X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'V': ['X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','.X...X..','..X.X...','..X.X...','...X....','........','........','........'],
  'W': ['X.....X.','X.....X.','X.....X.','X.....X.','X..X..X.','X..X..X.','X.X.X.X.','.X...X..','.X...X..','........','........','........'],
  'X': ['X.....X.','X.....X.','.X...X..','..X.X...','...X....','..X.X...','.X...X..','X.....X.','X.....X.','........','........','........'],
  'Y': ['X.....X.','X.....X.','.X...X..','..X.X...','...X....','...X....','...X....','...X....','...X....','........','........','........'],
  'Z': ['XXXXXXX.','......X.','.....X..','....X...','...X....','..X.....','.X......','X.......','XXXXXXX.','........','........','........'],
  '[': ['..XXXX..','..XX....','..XX....','..XX....','..XX....','..XX....','..XX....','..XX....','..XXXX..','........','........','........'],
  '\\': ['XX......','XX......','.XX.....','..XX....','...XX...','....XX..','.....XX.','.....XX.','........','........','........','........'],
  ']': ['..XXXX..','....XX..','....XX..','....XX..','....XX..','....XX..','....XX..','....XX..','..XXXX..','........','........','........'],
  '^': ['...X....','..XXX...','.X.X.X..','X.....X.','........','........','........','........','........','........','........','........'],
  '_': ['........','........','........','........','........','........','........','........','XXXXXXXX','........','........','........'],
  '`': ['..XX....','...XX...','....XX..','........','........','........','........','........','........','........','........','........'],
  'a': ['........','........','........','..XXX...','....XX..','.X..XXX.','XX...XX.','.X..XXX.','..XXXXX.','........','........','........'],
  'b': ['X.......','X.......','X.......','XXXXX...','X....X..','X.....X.','X.....X.','X....X..','XXXXX...','........','........','........'],
  'c': ['........','........','........','..XXX...','.X...X..','X.......','X.......','.X...X..','..XXX...','........','........','........'],
  'd': ['......X.','......X.','......X.','..XXXXX.','.....X..','X.....X.','X.....X.','X....X..','..XXXXX.','........','........','........'],
  'e': ['........','........','........','..XXX...','.X...X..','XXXXXXX.','X.......','.X...X..','..XXX...','........','........','........'],
  'f': ['...XXX..','..X.....','..X.....','XXXXX...','..X.....','..X.....','..X.....','..X.....','..X.....','........','........','........'],
  'g': ['........','........','........','..XXXXX.','X....X..','X....X..','X....X..','X....X..','.XXXXX..','......X.','..XXX...','.XX....'],
  'h': ['X.......','X.......','X.......','XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'i': ['...XX...','........','........','..XXX...','...XX...','...XX...','...XX...','...XX...','..XXXXX.','........','........','........'],
  'j': ['......X.','........','........','...XXX..','......X.','......X.','......X.','......X.','X....X..','X....X..','.XXX....'],
  'k': ['X.......','X.......','X.......','X...XX..','X..X....','XXX.....','X..X....','X...X...','X....X..','........','........','........'],
  'l': ['..XXX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','..XXXXX.','........','........','........'],
  'm': ['........','........','........','XX.XX...','X.X.X.X.','X.X.X.X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'n': ['........','........','........','XXXXX...','X....X..','X.....X.','X.....X.','X.....X.','X.....X.','........','........','........'],
  'o': ['........','........','........','..XXX...','.X...X..','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'p': ['........','........','........','XXXXX...','X....X..','X.....X.','X.....X.','X....X..','XXXXX...','X.....X.','X.....X.','........'],
  'q': ['........','........','........','..XXXXX.','.....X..','X.....X.','X.....X.','X....X..','..XXXXX.','......X.','......X.','........'],
  'r': ['........','........','........','X..XXX..','X.X....','XXX.....','X.......','X.......','X.......','........','........','........'],
  's': ['........','........','........','..XXXXX.','X......','.XXXXX..','......X.','X.....X.','.XXXXX..','........','........','........'],
  't': ['..X.....','..X.....','..X.....','XXXXX...','..X.....','..X.....','..X.....','..X.....','...XX...','........','........','........'],
  'u': ['........','........','........','X.....X.','X.....X.','X.....X.','X.....X.','.X...X..','..XXX...','........','........','........'],
  'v': ['........','........','........','X.....X.','X.....X.','.X...X..','.X...X..','..X.X...','...X....','........','........','........'],
  'w': ['........','........','........','X.....X.','X.....X.','X..X..X.','X.X.X.X.','.X...X..','.X...X..','........','........','........'],
  'x': ['........','........','........','X.....X.','.X...X..','..X.X...','..X.X...','.X...X..','X.....X.','........','........','........'],
  'y': ['........','........','........','X.....X.','X.....X.','.X...X..','.X...X..','..X.X...','...X....','...X....','..X.....','.X......'],
  'z': ['........','........','........','XXXXXXX.','....XX..','..XX....','.XX.....','XX......','XXXXXXX.','........','........','........'],
  '{': ['...XXX..','..XX....','..X.....','..X.....','XXX.....','..X.....','..X.....','..XX....','...XXX..','........','........','........'],
  '|': ['...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','...XX...','........','........','........'],
  '}': ['XXX.....','..XX....','...X....','...X....','...XXX..','...X....','...X....','..XX....','XXX.....','........','........','........'],
  '~': ['........','........','..XX..X.','X.X.XX..','X......X','........','........','........','........','........','........','........'],
};

function parseColor(color: string): [number, number, number, number] {
  // Parse rgba(r,g,b,a) or #rrggbb
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbaMatch) {
    return [parseInt(rgbaMatch[1]), parseInt(rgbaMatch[2]), parseInt(rgbaMatch[3]), rgbaMatch[4] ? Math.round(parseFloat(rgbaMatch[4]) * 255) : 255];
  }
  const hexMatch = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hexMatch) {
    return [parseInt(hexMatch[1], 16), parseInt(hexMatch[2], 16), parseInt(hexMatch[3], 16), 255];
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
  set fillStyle(v: string) { this._fillStyle = v; }
  get strokeStyle(): string { return this._strokeStyle; }
  set strokeStyle(v: string) { this._strokeStyle = v; }
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
    return {
      width,
      actualBoundingBoxAscent: fontSize * 0.8,
      actualBoundingBoxDescent: fontSize * 0.2,
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
    else if (this._textBaseline === "alphabetic") logicalY = y - baseFontSize * 0.8;

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
            const a = (alpha / 255) * (ca / 255) * this.globalAlpha;
            const invAlpha = 1 - a;
            this.pixels[idx]     = Math.min(255, this.pixels[idx]     * invAlpha + cr * a);
            this.pixels[idx + 1] = Math.min(255, this.pixels[idx + 1] * invAlpha + cg * a);
            this.pixels[idx + 2] = Math.min(255, this.pixels[idx + 2] * invAlpha + cb * a);
            this.pixels[idx + 3] = Math.min(255, this.pixels[idx + 3] + ca * a);
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
          const alpha = (coverage / (ss * ss)) * (ca / 255) * this.globalAlpha;
          const dstX = Math.floor(cursorX + px);
          const dstY = Math.floor(curY + py);
          if (dstX < 0 || dstX >= this.width || dstY < 0 || dstY >= this.height) continue;
          const idx = (dstY * this.width + dstX) * 4;
          const invAlpha = 1 - alpha;
          this.pixels[idx]     = Math.min(255, this.pixels[idx]     * invAlpha + cr * alpha);
          this.pixels[idx + 1] = Math.min(255, this.pixels[idx + 1] * invAlpha + cg * alpha);
          this.pixels[idx + 2] = Math.min(255, this.pixels[idx + 2] * invAlpha + cb * alpha);
          this.pixels[idx + 3] = Math.min(255, this.pixels[idx + 3] + ca * alpha);
        }
      }
      cursorX += fontSize * 0.6;
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = parseColor(this._fillStyle);
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, Math.ceil(y + h)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.width, Math.ceil(x + w)); px++) {
        const idx = (py * this.width + px) * 4;
        this.pixels[idx] = r;
        this.pixels[idx + 1] = g;
        this.pixels[idx + 2] = b;
        this.pixels[idx + 3] = a;
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, Math.ceil(y + h)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.width, Math.ceil(x + w)); px++) {
        const idx = (py * this.width + px) * 4;
        this.pixels[idx] = 0;
        this.pixels[idx + 1] = 0;
        this.pixels[idx + 2] = 0;
        this.pixels[idx + 3] = 0;
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): any {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const srcX = Math.floor(x) + px;
        const srcY = Math.floor(y) + py;
        if (srcX >= 0 && srcX < this.width && srcY >= 0 && srcY < this.height) {
          const srcIdx = (srcY * this.width + srcX) * 4;
          const dstIdx = (py * w + px) * 4;
          data[dstIdx] = this.pixels[srcIdx];
          data[dstIdx + 1] = this.pixels[srcIdx + 1];
          data[dstIdx + 2] = this.pixels[srcIdx + 2];
          data[dstIdx + 3] = this.pixels[srcIdx + 3];
        }
      }
    }
    const ImageDataCtor = (globalThis as any).ImageData;
    return new ImageDataCtor(w, h, data);
  }

  putImageData(data: any, x: number, y: number): void {
    if (!data?.data) return;
    const srcData = data.data as Uint8ClampedArray;
    const w = data.width;
    const h = data.height;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dstX = Math.floor(x) + px;
        const dstY = Math.floor(y) + py;
        if (dstX >= 0 && dstX < this.width && dstY >= 0 && dstY < this.height) {
          const srcIdx = (py * w + px) * 4;
          const dstIdx = (dstY * this.width + dstX) * 4;
          this.pixels[dstIdx] = srcData[srcIdx];
          this.pixels[dstIdx + 1] = srcData[srcIdx + 1];
          this.pixels[dstIdx + 2] = srcData[srcIdx + 2];
          this.pixels[dstIdx + 3] = srcData[srcIdx + 3];
        }
      }
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
  drawImage(image: any, dx: number, dy: number, dw?: number, dh?: number): void {
    // Blit a NativeImageBitmap (RGBA) into the pixel buffer — used by PixiJS
    // text when compositing canvas snapshots and by getPixels paths.
    const src = image?.getPixelData?.() ?? image?.data;
    if (!src) return;
    const sw = image?.width ?? dw ?? 0;
    const sh = image?.height ?? dh ?? 0;
    if (!sw || !sh) return;
    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        const dstX = Math.floor(dx) + px;
        const dstY = Math.floor(dy) + py;
        if (dstX < 0 || dstX >= this.width || dstY < 0 || dstY >= this.height) continue;
        const sIdx = (py * sw + px) * 4;
        const dIdx = (dstY * this.width + dstX) * 4;
        this.pixels[dIdx] = src[sIdx];
        this.pixels[dIdx + 1] = src[sIdx + 1];
        this.pixels[dIdx + 2] = src[sIdx + 2];
        this.pixels[dIdx + 3] = src[sIdx + 3];
      }
    }
  }
}
