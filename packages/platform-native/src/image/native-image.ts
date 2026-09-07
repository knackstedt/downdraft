// ============================================================================
// native-image.ts — Native image decoding replacing createImageBitmap
//
// Uses stb_image via bun:ffi to decode PNG/JPEG/BMP/TGA images.
// Implements the ImageBitmap interface that the engine's asset loaders expect.
// ============================================================================

import { dlopen, ptr, type CFunction } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

  console.log("[platform-native] Image polyfills installed (stb_image + OffscreenCanvas stub)");
}

// ── Minimal Canvas2D for text measurement ──
// The engine's text atlas uses Canvas2D to measure and render text.
// For the first screenshot without UI, we provide a minimal stub.

class NativeCanvas2D {
  private width: number;
  private height: number;
  private _fillStyle: string = "#000000";
  private _font: string = "16px sans-serif";

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get fillStyle(): string { return this._fillStyle; }
  set fillStyle(v: string) { this._fillStyle = v; }
  get font(): string { return this._font; }
  set font(v: string) { this._font = v; }

  // Text measurement — approximate based on font size
  measureText(text: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } {
    const fontSize = parseInt(this._font) || 16;
    const width = text.length * fontSize * 0.6; // approximate
    return {
      width,
      actualBoundingBoxAscent: fontSize * 0.8,
      actualBoundingBoxDescent: fontSize * 0.2,
    };
  }

  fillText(_text: string, _x: number, _y: number): void {
    // No-op — text rendering not supported in minimal mode
  }

  fillRect(_x: number, _y: number, _w: number, _h: number): void {}
  clearRect(_x: number, _y: number, _w: number, _h: number): void {}
  drawImage(_image: any, _dx: number, _dy: number): void {}
  getImageData(x: number, y: number, w: number, h: number): any {
    return new ((globalThis as any).ImageData)(w, h);
  }
  putImageData(_data: any, _x: number, _y: number): void {}
}
