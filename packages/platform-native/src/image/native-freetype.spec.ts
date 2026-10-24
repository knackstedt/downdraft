// native-freetype.spec.ts — rendered-run contract for the ft_shim canvas path.
//
// fillText rasterizes " text " (one space of margin each side) so glyph
// overhang outside [0, advance) survives; padX restores the pen origin.
// These pin the margin + cache behavior. Early-returns when the platform
// library / a system font isn't available (CI without native artifacts).

import { describe, expect, test } from "bun:test";
import { ftBaseline, ftIsAvailable, ftMeasureText, ftRenderText } from "./native-freetype";

describe("ftRenderText", () => {
  test("returns a padded bitmap with padX = the space advance", () => {
    if (!ftIsAvailable()) return;
    const bmp = ftRenderText("Hello", 24)!;
    expect(bmp).not.toBeNull();
    const space = ftMeasureText(" ", 24);
    expect(space).toBeGreaterThan(0);
    expect(bmp.padX).toBe(space);
    // Padded raster: " Hello " — width covers the text advance + margins.
    const textAdv = ftMeasureText("Hello", 24);
    expect(bmp.width).toBeGreaterThanOrEqual(textAdv);
    expect(bmp.data.length).toBe(bmp.width * bmp.height * 4);
  });

  test("repeated calls hit the bitmap cache", () => {
    if (!ftIsAvailable()) return;
    const a = ftRenderText("cache-hit-key", 18)!;
    const b = ftRenderText("cache-hit-key", 18)!;
    expect(b).toBe(a);
  });

  test("measure agrees across sizes", () => {
    if (!ftIsAvailable()) return;
    expect(ftMeasureText("iiii", 16)).toBeLessThan(ftMeasureText("WWWW", 16));
  });

  test("ftBaseline calibrates inside the bitmap (not size*1.0)", () => {
    if (!ftIsAvailable()) return;
    const bl = ftBaseline(16);
    const bmp = ftRenderText("H", 16)!;
    // Baseline row is inside the bitmap and clearly below size*1.0 —
    // pinning the probe so a metric swap doesn't silently regress text
    // placement (text floats ~12% high when baseline = fontSize).
    expect(bl).toBeGreaterThan(0);
    expect(bl).toBeLessThan(bmp.height);
    expect(bl).toBeLessThan(16);
    expect(ftBaseline(16)).toBe(bl); // cached
  });
});
