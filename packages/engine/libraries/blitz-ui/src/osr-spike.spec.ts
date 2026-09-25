// ============================================================================
// osr-spike.spec.ts — Phase 0 Blitz capability spike (Track D groundwork)
//
// Proves the native-OSR pipeline end to end without wasm, Dioxus, or winit:
//   blitz_html::HtmlDocument + vello_cpu in a plain cdylib → dlopen'd from
//   Bun → rasterizes HTML/CSS → RGBA8 → hit-testable.
//
// The .so is produced by packages/engine/libraries/blitz-ui/native-osr
// (cargo build --release). If it is missing the spec skips rather than
// failing — native artifacts are not built in CI.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LIB = resolve(
  import.meta.dir,
  "../native-osr/target/release/libdowndraft_blitz_osr.so",
);

const haveLib = existsSync(LIB);

describe.skipIf(!haveLib)("blitz-osr spike (HtmlDocument over dlopen)", () => {
  const W = 400;
  const H = 200;

  const HTML = `<html><body style="margin:0; background:#123456;">
    <div data-ui style="position:absolute; left:10px; top:10px; width:100px; height:50px; background:#ff8800; color:white;">Hello OSR</div>
  </body></html>`;

  function open(html = HTML) {
    const { dlopen, ptr, toArrayBuffer } = require("bun:ffi");
    const lib = dlopen(LIB, {
      dd_osr_init: { args: ["f64", "f64", "f64", "ptr", "usize"], returns: "ptr" },
      dd_osr_set_html: { args: ["ptr", "ptr", "usize"], returns: "i32" },
      dd_osr_frame: { args: ["ptr"], returns: "ptr" },
      dd_osr_pixels_len: { args: ["ptr"], returns: "usize" },
      dd_osr_hit_test: { args: ["ptr", "f64", "f64"], returns: "i32" },
      dd_osr_resize: { args: ["ptr", "f64", "f64", "f64"], returns: "i32" },
      dd_osr_pointer: { args: ["ptr", "i32", "f64", "f64", "i32", "u32"], returns: "i32" },
      dd_osr_wheel: { args: ["ptr", "f64", "f64", "f64", "f64", "u32"], returns: "i32" },
      dd_osr_key: { args: ["ptr", "i32", "ptr", "usize", "ptr", "usize", "ptr", "usize", "u32"], returns: "i32" },
      dd_osr_destroy: { args: ["ptr"], returns: "i32" },
    });
    const bytes = new TextEncoder().encode(html);
    const doc = lib.symbols.dd_osr_init(W, H, 1, ptr(bytes), bytes.length);
    return { lib, doc, read: (p: number, n: number) => new Uint8Array(toArrayBuffer(p, 0, n)) };
  }

  it("rasterizes HTML/CSS to a non-empty RGBA8 buffer", () => {
    const { lib, doc, read } = open();
    expect(doc).not.toBe(0);

    const framePtr = lib.symbols.dd_osr_frame(doc);
    expect(framePtr).not.toBe(0);

    const px = read(framePtr, W * H * 4);
    expect(px.length).toBe(W * H * 4);

    // Background fill #123456 should cover the canvas — sample a corner.
    expect(px[0]).toBe(0x12);
    expect(px[1]).toBe(0x34);
    expect(px[2]).toBe(0x56);
    expect(px[3]).toBe(0xff);

    // The orange div spans (10,10)-(110,60) — sample its bottom-right corner,
    // away from the "Hello OSR" glyphs.
    const i = (55 * W + 105) * 4;
    expect(px[i]).toBeGreaterThan(0xc0);
    expect(px[i + 1]).toBeGreaterThan(0x60);
    expect(px[i + 1]).toBeLessThan(0xb0);
    expect(px[i + 2]).toBeLessThan(0x40);

    lib.symbols.dd_osr_destroy(doc);
  });

  it("hit-tests data-ui elements and ignores background", () => {
    const { lib, doc } = open();
    expect(doc).not.toBe(0);
    lib.symbols.dd_osr_frame(doc); // force layout resolve

    expect(lib.symbols.dd_osr_hit_test(doc, 20, 20)).toBe(1); // inside div
    expect(lib.symbols.dd_osr_hit_test(doc, 350, 150)).toBe(0); // background

    lib.symbols.dd_osr_destroy(doc);
  });

  it("reports not-dirty after a clean frame and re-dirties on resize", () => {
    const { lib, doc } = open();
    expect(lib.symbols.dd_osr_frame(doc)).not.toBe(0);
    // Static document — second frame should be a no-op (NULL pointer).
    expect(lib.symbols.dd_osr_frame(doc)).toBeNull();
    lib.symbols.dd_osr_resize(doc, 200, 100, 1);
    expect(lib.symbols.dd_osr_frame(doc)).not.toBe(0);
    lib.symbols.dd_osr_destroy(doc);
  });

  it("dd_osr_set_html replaces the document and re-dirties", () => {
    const { lib, doc, read } = open();
    lib.symbols.dd_osr_frame(doc); // clean
    const html2 = `<html><body style="margin:0;background:#00ff00;"></body></html>`;
    const b = new TextEncoder().encode(html2);
    const { ptr } = require("bun:ffi");
    expect(lib.symbols.dd_osr_set_html(doc, ptr(b), b.length)).toBe(0);
    const framePtr = lib.symbols.dd_osr_frame(doc);
    expect(framePtr).not.toBe(0);
    const px = read(framePtr, W * H * 4);
    // New background is green.
    expect(px[0]).toBe(0);
    expect(px[1]).toBe(0xff);
    expect(px[2]).toBe(0);
    lib.symbols.dd_osr_destroy(doc);
  });

  it("pointer + wheel + key events dispatch without crashing and mark dirty", () => {
    const { lib, doc } = open();
    lib.symbols.dd_osr_frame(doc); // clean
    const { ptr } = require("bun:ffi");
    const enc = new TextEncoder();
    const s = (v: string) => enc.encode(v);

    expect(lib.symbols.dd_osr_pointer(doc, 0, 20, 20, 0, 0)).toBe(0);   // move
    expect(lib.symbols.dd_osr_frame(doc)).not.toBe(0);                  // dirty from :hover
    expect(lib.symbols.dd_osr_pointer(doc, 1, 20, 20, 0, 0)).toBe(0);   // down (left)
    expect(lib.symbols.dd_osr_pointer(doc, 2, 20, 20, 0, 0)).toBe(0);   // up
    expect(lib.symbols.dd_osr_wheel(doc, 20, 20, 0, 120, 0)).toBe(0);   // wheel
    const k = s("a"), c = s("KeyA"), t = s("a");
    expect(lib.symbols.dd_osr_key(doc, 0, ptr(k), k.length, ptr(c), c.length, ptr(t), t.length, 0)).toBe(0);
    expect(lib.symbols.dd_osr_key(doc, 1, ptr(k), k.length, ptr(c), c.length, ptr(t), t.length, 0)).toBe(0);
    // Named keys via FromStr. Empty text → non-null scratch ptr + len 0
    // (ptr() can't convert a zero-length buffer).
    const ek = s("Enter"), ec = s("Enter"), et = s("x");
    expect(lib.symbols.dd_osr_key(doc, 0, ptr(ek), ek.length, ptr(ec), ec.length, ptr(et), 0, 0)).toBe(0);
    lib.symbols.dd_osr_destroy(doc);
  });
});
