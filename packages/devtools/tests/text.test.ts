// text.test.ts — raster-pipeline regression coverage.
//
// The ft_shim bitmap contract spans [0, ceil(advance)] of the rasterized
// string. These specs pin the compensations that keep text crisp and
// complete: atlas gutters vs linear-sample bleed, padX tracking on padded
// rasters, and style-aware weight resolution.

import { describe, expect, test } from "bun:test";

// WebGPU flag globals exist in the app runtime, not under bun test.
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 8 };

import { TextAtlas } from "../src/text/atlas";
import { faceKey, loadFaces, resolveWeight } from "../src/text/fonts";
import { RunCache } from "../src/text/run-cache";

// Minimal GPUDevice stub — atlas alloc/upload logic is pure CPU; the
// writeTexture calls are captured to inspect padded slot contents.
function stubDevice() {
  const writes: { origin: { x: number; y: number }; data: Uint8Array; bpr: number; w: number; h: number }[] = [];
  const device = {
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {},
    }),
    queue: {
      writeTexture(dst: { origin: { x: number; y: number } }, data: Uint8Array, layout: { bytesPerRow: number }, size: { width: number; height: number }) {
        writes.push({ origin: dst.origin, data: new Uint8Array(data), bpr: layout.bytesPerRow, w: size.width, h: size.height });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
}

describe("resolveWeight", () => {
  test("picks the nearest available weight", () => {
    expect(resolveWeight("inter", 400)).toBe(400);
    expect(resolveWeight("inter", 450)).toBe(400);
    expect(resolveWeight("inter", 650)).toBe(600); // tie — nearest keeps the first found
    expect(resolveWeight("inter", 900)).toBe(700);
    expect(resolveWeight("jetbrains", 600)).toBe(500);
  });

  test("constrains to weights offering the requested style", () => {
    // Only jetbrains:400 ships an italic face — a 700 italic request must
    // resolve to 400 rather than produce an unregistered key.
    expect(resolveWeight("jetbrains", 700, "italic")).toBe(400);
    expect(faceKey("jetbrains", resolveWeight("jetbrains", 700, "italic"), "italic")).toBe("jetbrains:400:italic");
    // Families with no italic at all fall back to the normal pool.
    expect(resolveWeight("inter", 700, "italic")).toBe(700);
  });
});

describe("TextAtlas", () => {
  test("regions are offset by a transparent gutter and never overlap", () => {
    const { device } = stubDevice();
    const atlas = new TextAtlas(device, 64);
    const a = atlas.alloc(10, 8)!;
    const b = atlas.alloc(10, 8)!;
    expect(a).toMatchObject({ u: 1, v: 1, w: 10, h: 8 });
    // Second region starts after a's slot + gutter: u = 1 + 10 + 2*PAD.
    expect(b.u).toBe(13);
    expect(b.v).toBe(1);
    atlas.destroy();
  });

  test("upload writes a zeroed gutter around the bitmap", () => {
    const { device, writes } = stubDevice();
    const atlas = new TextAtlas(device, 64);
    const region = atlas.alloc(4, 2)!;
    // Solid bitmap — every texel nonzero.
    const bmp = new Uint8Array(4 * 2 * 4).fill(200);
    atlas.upload(region, bmp);
    const w = writes.at(-1)!;
    // Slot covers the padded rect anchored one texel up-left of the region.
    expect(w.origin).toEqual({ x: 0, y: 0 });
    expect(w.w).toBe(6);
    expect(w.h).toBe(4);
    // Gutter rows + columns are transparent.
    const px = (x: number, y: number) => w.data[(y * w.bpr + x * 4) + 3]!;
    expect(px(0, 0)).toBe(0);
    expect(px(5, 0)).toBe(0);
    expect(px(0, 3)).toBe(0);
    expect(px(5, 3)).toBe(0);
    expect(px(0, 1)).toBe(0);
    expect(px(5, 1)).toBe(0);
    // Interior carries the bitmap.
    expect(px(1, 1)).toBe(200);
    expect(px(4, 2)).toBe(200);
    atlas.destroy();
  });

  test("reset invalidates regions via generation bump", () => {
    const { device } = stubDevice();
    const atlas = new TextAtlas(device, 64);
    const a = atlas.alloc(10, 8)!;
    atlas.reset();
    const b = atlas.alloc(10, 8)!;
    expect(b.generation).toBe(a.generation + 1);
    atlas.destroy();
  });
});

describe("RunCache raster contract", () => {
  async function makeCache() {
    const { device } = stubDevice();
    const cache = new RunCache(new TextAtlas(device, 512));
    await cache.init();
    return cache;
  }

  test("chunks rasterize with a space margin and report padX + run-space inkX", async () => {
    const cache = await makeCache();
    const faces = await loadFaces();
    faces.forEach((f) => cache.registerFace(f));
    if (!cache.ready) return; // platform lib unavailable — nothing to assert

    const face = "jetbrains:400:italic";
    const run = cache.getRun(face, 16, "jgy")!;
    const chunk = cache.getChunk(face, 16, "jgy")!;
    expect(run).not.toBeNull();
    expect(chunk.region).not.toBeNull();
    expect(chunk.padX).toBeGreaterThan(0);
    // Padded bitmap is wider than the run's advance — the margin is where
    // italic overhang lands instead of clipping at the advance edge.
    expect(chunk.w).toBeGreaterThan(run.advance);
    // inkX is reported in run pen space (pad subtracted) — jetbrains
    // italic glyphs start near/at the pen origin.
    expect(chunk.inkX).toBeLessThan(chunk.padX);
    cache.dispose();
  });

  test("repeated chunks hit the cache", async () => {
    const cache = await makeCache();
    const faces = await loadFaces();
    faces.forEach((f) => cache.registerFace(f));
    if (!cache.ready) return;
    const a = cache.getChunk("inter:400:normal", 14, "cache me")!;
    const b = cache.getChunk("inter:400:normal", 14, "cache me")!;
    expect(a.region).toBe(b.region);
    cache.dispose();
  });

  test("unregistered faces return null without poisoning the cache", async () => {
    const cache = await makeCache();
    expect(cache.getChunk("bogus:400:normal", 14, "nope")).toBeNull();
    expect(cache.getRun("bogus:400:normal", 14, "nope")).toBeNull();
    cache.dispose();
  });
});
