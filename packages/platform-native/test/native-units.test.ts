// ============================================================================
// native-units.test.ts — pure-logic unit tests for @downdraft/platform-native
//
// These tests exercise the refactored package's non-native surface: enum
// mappings, event targets, screenshot readback conversion, PNG encoding, and
// library-path resolution. They require no GPU, no SDL, and no .so files.
//
// Run: bun test
// ============================================================================

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { MiniEventTarget } from "../src/dom/mini-event-target";
import { resolveShimLibrary } from "../src/ffi/lib-paths";
import {
  formatName,
  isBGRAFormat,
  parseCompare,
  parseExtent3D,
  parseFormat,
  parseOrigin3D,
  parseStencilOp,
  parseVertexFormat,
} from "../src/gpu/enums";
import { NativeImageBitmap } from "../src/image/native-image";
import { encodePNG, paddedReadbackToRGBA } from "../src/screenshot/screenshot";

// ── MiniEventTarget ──

describe("MiniEventTarget", () => {
  test("dispatches events to listeners by type", () => {
    const t = new MiniEventTarget();
    const seen: string[] = [];
    t.addEventListener("a", (e) => seen.push(`a:${e.v}`));
    t.addEventListener("b", (e) => seen.push(`b:${e.v}`));
    t.dispatchEvent({ type: "a", v: 1 });
    t.dispatchEvent({ type: "b", v: 2 });
    expect(seen).toEqual(["a:1", "b:2"]);
  });

  test("removeEventListener stops dispatch", () => {
    const t = new MiniEventTarget();
    let count = 0;
    const fn = () => count++;
    t.addEventListener("x", fn);
    t.dispatchEvent({ type: "x" });
    t.removeEventListener("x", fn);
    t.dispatchEvent({ type: "x" });
    expect(count).toBe(1);
  });

  test("accepts the DOM capture/options third arg (ignored)", () => {
    const t = new MiniEventTarget();
    let hit = 0;
    t.addEventListener("x", () => hit++, true);
    t.addEventListener("x", () => hit++, { capture: true });
    t.dispatchEvent({ type: "x" });
    expect(hit).toBe(2);
    t.removeEventListener("x", () => {}, false); // arity check
  });

  test("a throwing listener does not break other listeners", () => {
    const t = new MiniEventTarget();
    let ok = false;
    t.addEventListener("x", () => { throw new Error("boom"); });
    t.addEventListener("x", () => { ok = true; });
    t.dispatchEvent({ type: "x" });
    expect(ok).toBe(true);
  });

  test("clearListeners removes everything", () => {
    const t = new MiniEventTarget();
    let count = 0;
    t.addEventListener("a", () => count++);
    t.addEventListener("b", () => count++);
    t.clearListeners();
    t.dispatchEvent({ type: "a" });
    t.dispatchEvent({ type: "b" });
    expect(count).toBe(0);
  });
});

// ── GPU enums ──

describe("gpu/enums", () => {
  test("parseFormat maps known formats and throws on unknown", () => {
    expect(parseFormat("rgba8unorm")).toBe(0x16);
    expect(parseFormat("bgra8unorm")).toBe(0x1B);
    expect(parseFormat("bgra8unorm-srgb")).toBe(0x1C);
    expect(parseFormat("depth32float")).toBe(0x30);
    expect(() => parseFormat("not-a-format")).toThrow(/Unknown texture format/);
  });

  test("formatName round-trips parseFormat", () => {
    expect(formatName(parseFormat("bgra8unorm"))).toBe("bgra8unorm");
    expect(formatName(parseFormat("rgba8unorm-srgb"))).toBe("rgba8unorm-srgb");
  });

  test("isBGRAFormat identifies BGRA surface formats", () => {
    expect(isBGRAFormat("bgra8unorm")).toBe(true);
    expect(isBGRAFormat("bgra8unorm-srgb")).toBe(true);
    expect(isBGRAFormat("rgba8unorm")).toBe(false);
    expect(isBGRAFormat(undefined)).toBe(false);
  });

  test("parseVertexFormat maps packed formats", () => {
    expect(parseVertexFormat("float32x3")).toBe(0x1E);
    expect(parseVertexFormat("uint8x4")).toBe(0x03);
    expect(() => parseVertexFormat("bogus")).toThrow();
  });

  test("parseCompare/parseStencilOp match webgpu.h values", () => {
    expect(parseCompare("less")).toBe(2);
    expect(parseCompare("always")).toBe(8);
    expect(parseCompare(undefined)).toBe(0);
    expect(parseStencilOp("keep")).toBe(1);
    expect(parseStencilOp("increment-wrap")).toBe(7);
  });

  test("parseExtent3D normalizes number/array/dict", () => {
    expect(parseExtent3D(64)).toEqual({ width: 64, height: 1, depthOrArrayLayers: 1 });
    expect(parseExtent3D([4, 5, 6])).toEqual({ width: 4, height: 5, depthOrArrayLayers: 6 });
    expect(parseExtent3D({ width: 7, height: 8 } as any)).toEqual({ width: 7, height: 8, depthOrArrayLayers: 1 });
  });

  test("parseOrigin3D normalizes undefined/number/array/dict", () => {
    expect(parseOrigin3D(undefined)).toEqual({ x: 0, y: 0, z: 0 });
    expect(parseOrigin3D(3)).toEqual({ x: 3, y: 0, z: 0 });
    expect(parseOrigin3D([1, 2, 3])).toEqual({ x: 1, y: 2, z: 3 });
    expect(parseOrigin3D({ x: 9 } as any)).toEqual({ x: 9, y: 0, z: 0 });
  });
});

// ── Screenshot readback conversion ──

describe("paddedReadbackToRGBA", () => {
  // 2x2 image, bytesPerRow padded to 256
  function makePadded(swapRB: boolean): { padded: Uint8Array; expected: Uint8Array } {
    const bpr = 256;
    const pixels = [
      [10, 20, 30, 255],
      [40, 50, 60, 255],
      [70, 80, 90, 255],
      [100, 110, 120, 255],
    ];
    const padded = new Uint8Array(bpr * 2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const [r, g, b, a] = pixels[y * 2 + x];
        const o = y * bpr + x * 4;
        if (swapRB) {
          padded[o] = b; padded[o + 1] = g; padded[o + 2] = r; padded[o + 3] = a;
        } else {
          padded[o] = r; padded[o + 1] = g; padded[o + 2] = b; padded[o + 3] = a;
        }
      }
    }
    const expected = new Uint8Array(2 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const [r, g, b, a] = pixels[y * 2 + x];
        const o = (y * 2 + x) * 4;
        expected[o] = r; expected[o + 1] = g; expected[o + 2] = b; expected[o + 3] = a;
      }
    }
    return { padded, expected };
  }

  test("strips row padding for RGBA input", () => {
    const { padded, expected } = makePadded(false);
    expect(paddedReadbackToRGBA(padded, 2, 2, 256, "rgba8unorm")).toEqual(expected);
  });

  test("swaps B/R for BGRA input", () => {
    const { padded, expected } = makePadded(true);
    expect(paddedReadbackToRGBA(padded, 2, 2, 256, "bgra8unorm")).toEqual(expected);
    expect(paddedReadbackToRGBA(padded, 2, 2, 256, "bgra8unorm-srgb")).toEqual(expected);
  });

  test("treats missing format as RGBA (no swap)", () => {
    const { padded, expected } = makePadded(false);
    expect(paddedReadbackToRGBA(padded, 2, 2, 256)).toEqual(expected);
  });
});

// ── PNG encoder ──

describe("encodePNG", () => {
  test("produces a valid PNG with correct IHDR and decompressable IDAT", () => {
    const w = 3, h = 2;
    const rgba = new Uint8Array(w * h * 4).fill(0xAB);
    const png = encodePNG(w, h, rgba);

    // Signature
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR: first chunk after 8-byte signature — len(4) type(4) data(13) crc(4)
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(w);
    expect(png.readUInt32BE(20)).toBe(h);
    expect(png[24]).toBe(8);  // bit depth
    expect(png[25]).toBe(6);  // RGBA

    // IDAT is the second chunk
    const idatLen = png.readUInt32BE(8 + 25);
    expect(png.toString("ascii", 8 + 29, 8 + 33)).toBe("IDAT");
    const idat = png.subarray(8 + 33, 8 + 33 + idatLen);
    const raw = inflateSync(idat);
    // Each scanline: 1 filter byte + w*4 RGBA bytes
    expect(raw.length).toBe(h * (1 + w * 4));
    for (let y = 0; y < h; y++) {
      expect(raw[y * (1 + w * 4)]).toBe(0);
      for (let i = 0; i < w * 4; i++) {
        expect(raw[y * (1 + w * 4) + 1 + i]).toBe(0xAB);
      }
    }
  });
});

// ── NativeImageBitmap ──

describe("NativeImageBitmap", () => {
  test("exposes width/height and pixel data", () => {
    const px = new Uint8Array([1, 2, 3, 4]);
    const bmp = new NativeImageBitmap(1, 1, px);
    expect(bmp.width).toBe(1);
    expect(bmp.height).toBe(1);
    expect([...bmp.getPixelData()]).toEqual([1, 2, 3, 4]);
  });

  test("close() clears pixel data", () => {
    const bmp = new NativeImageBitmap(2, 2, new Uint8Array(16).fill(7));
    bmp.close();
    expect(bmp.getPixelData().length).toBe(0);
  });
});

// ── lib-paths ──

describe("resolveShimLibrary", () => {
  test("honors the env override when the file exists", () => {
    process.env.TEST_SHIM_XYZ_PATH = import.meta.filename;
    try {
      expect(resolveShimLibrary("test_shim_xyz", "TEST_SHIM_XYZ_PATH")).toBe(import.meta.filename);
    } finally {
      delete process.env.TEST_SHIM_XYZ_PATH;
    }
  });

  test("throws a clear error when the env override points at nothing", () => {
    process.env.TEST_SHIM_XYZ_PATH = "/nonexistent/libtest_shim_xyz.so";
    try {
      expect(() => resolveShimLibrary("test_shim_xyz", "TEST_SHIM_XYZ_PATH"))
        .toThrow(/does not exist/);
    } finally {
      delete process.env.TEST_SHIM_XYZ_PATH;
    }
  });

  test("throws with the searched candidate list when nothing is found", () => {
    expect(() => resolveShimLibrary("nonexistent_shim_zzz", "NONEXISTENT_ZZZ_PATH"))
      .toThrow(/libnonexistent_shim_zzz\.(so|dll|dylib) not found/);
  });
});
