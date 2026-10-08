// ============================================================================
// native-image.ts — Native image decoding replacing createImageBitmap
//
// Uses the Rust `image` crate (in libdowndraft_platform) via FFI to decode
// PNG/JPEG/BMP/TGA images.
// Implements the ImageBitmap interface that the engine's asset loaders expect.
//
// Text rasterization lives in native-canvas2d.ts (Canvas2D + glyph atlas)
// and native-freetype.ts (FreeType bindings); both are re-exported here for
// backwards-compatible imports.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { resolveBlobUrl } from "../dom/blob-urls";
import { dlopen, type CFunction } from "../ffi/ffi-adapter";
import { resolvePlatformLibrary, resolveShimLibrary } from "../ffi/lib-paths";
import { encodePNG } from "../screenshot/screenshot";
import { NativeCanvas2D } from "./native-canvas2d";

export { NativeCanvas2D } from "./native-canvas2d";
export { getFreeTypeTextRenderer } from "./native-freetype";

const log = createLogger();

// Lazy dlopen — importing this module (e.g. for NativeCanvas2D's bitmap-font
// fallback) must not fail when libimage_shim is absent.
const IMAGE_SHIM_SPEC: Record<string, CFunction> = {
  image_shim_decode: { args: ["ptr", "i32", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
  image_shim_decode_file: { args: ["cstring", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
  image_shim_info: { args: ["ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
};

interface ImageShimSymbols {
  image_shim_decode: (data: number, size: number, outData: number, outSize: number, wOut: number, hOut: number, cOut: number) => number;
  image_shim_decode_file: (path: string, outData: number, outSize: number, wOut: number, hOut: number, cOut: number) => number;
  image_shim_info: (data: number, size: number, wOut: number, hOut: number, cOut: number) => number;
}

let _imageShim: ImageShimSymbols | null = null;
function imageShim(): ImageShimSymbols {
  if (!_imageShim) {
    // Resolution order: explicit IMAGE_SHIM_PATH override → unified Rust
    // platform lib (downdraft_platform).
    const libPath = process.env.IMAGE_SHIM_PATH
      ? resolveShimLibrary("image_shim", "IMAGE_SHIM_PATH")
      : resolvePlatformLibrary();
    _imageShim = dlopen(libPath, IMAGE_SHIM_SPEC).symbols as unknown as ImageShimSymbols;
  }
  return _imageShim;
}

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
    const { readFile } = await import("node:fs/promises");
    const fileData = await readFile(source);
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
      // Copy the pixel data — getImageData's buffer may be a shared canvas
      // backing store that later draws would mutate.
      const pixels = new Uint8Array(imgData.data.length);
      pixels.set(imgData.data);
      return new NativeImageBitmap(canvas.width, canvas.height, pixels);
    }
    // If no 2D context, create a 1x1 gray pixel as fallback
    return new NativeImageBitmap(1, 1, new Uint8Array([0xcc, 0xcc, 0xcc, 0xff]));
  } else {
    throw new Error(`Unsupported image source type: ${typeof source}`);
  }

  // First, get image info to know the size
  const wBuf = new Int32Array(1);
  const hBuf = new Int32Array(1);
  const cBuf = new Int32Array(1);
  const infoResult = imageShim().image_shim_info(data as any, data.byteLength, wBuf as any, hBuf as any, cBuf as any);
  if (infoResult !== 0) throw new Error("Failed to get image info");

  const width = wBuf[0];
  const height = hBuf[0];
  const pixelSize = width * height * 4;

  // Allocate output buffer and decode into it
  const pixels = new Uint8Array(pixelSize);
  const decodeResult = imageShim().image_shim_decode(
    data as any, data.byteLength,
    pixels as any, pixelSize,
    wBuf as any, hBuf as any, cBuf as any,
  );
  if (decodeResult !== 0) throw new Error(`Failed to decode image (error ${decodeResult})`);

  return new NativeImageBitmap(width, height, pixels);
}

// ── Install polyfills on globalThis ──

export function installImagePolyfills(): void {
  // Always override — Deno ships native createImageBitmap/ImageBitmap/
  // OffscreenCanvas that reject the engine's polyfilled canvas objects and
  // produce bitmaps the wgpu texture upload path can't consume.
  (globalThis as any).createImageBitmap = createImageBitmapNative;
  (globalThis as any).ImageBitmap = NativeImageBitmap;

  // OffscreenCanvas polyfill — used by libraries for offscreen text/shape
  // rasterization.
  // getContext("2d") returns a FreeType-backed NativeCanvas2D; transferToImageBitmap
  // copies the 2D context's pixel data (not empty) so text textures upload correctly.
  {
    (globalThis as any).OffscreenCanvas = class OffscreenCanvas {
      private _width: number;
      private _height: number;
      private ctx2d: NativeCanvas2D | null = null;

      constructor(width: number, height: number) {
        this._width = width;
        this._height = height;
      }

      get width(): number { return this._width; }
      get height(): number { return this._height; }

      // DOM semantics: assigning width/height (even the same value) clears the
      // bitmap AND resets the drawing state (transform, globalAlpha, styles).
      // Canvas pools that reuse scratch canvases rely on this — without it,
      // stale globalAlpha / scale transforms leak between renders (ghosting).
      set width(w: number) { this._width = w; this.resetCtx(); }
      set height(h: number) { this._height = h; this.resetCtx(); }

      private resetCtx(): void {
        if (this.ctx2d) this.ctx2d = new NativeCanvas2D(this._width, this._height);
      }

      getContext(contextType: string): any {
        if (contextType === "2d") {
          if (!this.ctx2d || this.ctx2d.width !== this._width || this.ctx2d.height !== this._height) {
            this.ctx2d = new NativeCanvas2D(this._width, this._height);
          }
          return this.ctx2d;
        }
        return null;
      }

      /** Pixels of the 2D backing store (drawImage source compatibility). */
      getPixelData(): Uint8Array | null {
        if (!this.ctx2d) return null;
        return new Uint8Array(this.ctx2d["pixels"].buffer.slice(0));
      }

      toBlob(callback: (blob: Blob | null) => void, _type?: string): void {
        const pixels = this.getPixelData();
        if (!pixels) { callback(null); return; }
        callback(new Blob([new Uint8Array(encodePNG(this.width, this.height, pixels))], { type: "image/png" }));
      }

      toDataURL(_type?: string): string {
        const pixels = this.getPixelData();
        if (!pixels) return "data:,";
        const png = encodePNG(this.width, this.height, pixels);
        return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
      }

      transferToImageBitmap(): NativeImageBitmap {
        // Copy the 2D context's pixel data so text textures are not empty.
        if (this.ctx2d) {
          const pixels = new Uint8Array(this.ctx2d["pixels"].length);
          pixels.set(this.ctx2d["pixels"]);
          return new NativeImageBitmap(this.width, this.height, pixels);
        }
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

  // Image polyfill — image-loading libraries construct `new Image()`.
  // Setting `src` decodes the file via the image crate (createImageBitmapNative) and
  // fires onload/onerror. Supports file paths, data: URLs, and http(s) via fetch.
  if (typeof (globalThis as any).Image === "undefined") {
    (globalThis as any).Image = class NativeImage {
      width: number = 0;
      height: number = 0;
      naturalWidth: number = 0;
      naturalHeight: number = 0;
      alt: string = "";
      onload: ((this: any, ev: any) => any) | null = null;
      onerror: ((this: any, ev: any) => any) | null = null;
      private _bitmap: NativeImageBitmap | null = null;
      private _src = "";
      private _complete = false;

      // src must be an accessor — assigning img.src triggers the decode.
      // (The previous implementation declared `src` as a class field, which
      // shadowed the prototype setter so img.src = url never loaded.)
      get src(): string { return this._src; }
      set src(v: string) {
        this._src = v;
        if (v) void this._load(v);
      }
      get complete(): boolean { return this._complete; }

      async _load(src: string): Promise<void> {
        try {
          let source: Blob | ArrayBuffer | Uint8Array | string;
          if (src.startsWith("data:")) {
            // data URL — decode base64 payload. Use atob when Node's Buffer
            // global is unavailable (Deno).
            const comma = src.indexOf(",");
            const b64 = src.slice(comma + 1);
            const bin = typeof Buffer !== "undefined"
              ? Buffer.from(b64, "base64")
              : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            source = bin instanceof Uint8Array ? bin : Uint8Array.from(bin);
          } else if (src.startsWith("blob:")) {
            const blob = resolveBlobUrl(src);
            if (!blob) throw new Error(`Unknown blob URL: ${src}`);
            source = blob;
          } else if (src.startsWith("http://") || src.startsWith("https://")) {
            const resp = await fetch(src);
            source = new Uint8Array(await resp.arrayBuffer());
          } else {
            source = src; // file path
          }
          const bmp = await createImageBitmapNative(source);
          this._bitmap = bmp;
          this.width = bmp.width;
          this.height = bmp.height;
          this.naturalWidth = bmp.width;
          this.naturalHeight = bmp.height;
          this._complete = true;
          if (this.onload) this.onload.call(this, { type: "load", target: this });
        } catch (err) {
          this._complete = true;
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
      decode(): Promise<void> { return this._load(this._src); }
    };
  }

  log.info("platform-native", "Image polyfills installed (image crate + OffscreenCanvas + Image)");
}
