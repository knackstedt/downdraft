import { describe, expect, it } from "bun:test";
import {
    Dome360Pass
} from "./dome-360.ts";
import {
    DEFAULT_FLUID_CONFIG
} from "./fluid-render.ts";
import {
    DEFAULT_PROCEDURAL_CONFIG,
    generateProceduralTexture,
    type ProceduralTextureType,
} from "./procedural-texture.ts";
import {
    layoutSDFText,
    parseSDFFont,
    SDF_TEXT_SHADER,
    type SDFFontData,
} from "./sdf-text.ts";

describe("fluid-render", () => {
  it("DEFAULT_FLUID_CONFIG has expected values", () => {
    expect(DEFAULT_FLUID_CONFIG.gridResolution).toBe(128);
    expect(DEFAULT_FLUID_CONFIG.viscosity).toBe(0.0001);
    expect(DEFAULT_FLUID_CONFIG.pressureIterations).toBe(20);
    expect(DEFAULT_FLUID_CONFIG.enabled).toBe(false);
  });
});

describe("dome-360", () => {
  it("creates pass with default config", () => {
    const pass = new Dome360Pass();
    expect(pass.name).toBe("dome-360");
    expect(pass.config.fov).toBeCloseTo(Math.PI / 3);
    expect(pass.config.aspect).toBeCloseTo(16 / 9);
    expect(pass.config.background).toBe(true);
  });

  it("accepts custom config", () => {
    const pass = new Dome360Pass({ fov: Math.PI / 2, aspect: 1 });
    expect(pass.config.fov).toBeCloseTo(Math.PI / 2);
    expect(pass.config.aspect).toBe(1);
  });
});

describe("sdf-text", () => {
  const mockFont: SDFFontData = {
    glyphs: new Map([
      [65, { char: "A", charCode: 65, x: 0, y: 0, width: 0.5, height: 0.6, advance: 0.7, bearingX: 0, bearingY: 0.6 }],
      [66, { char: "B", charCode: 66, x: 0.5, y: 0, width: 0.5, height: 0.6, advance: 0.65, bearingX: 0, bearingY: 0.6 }],
    ]),
    atlasWidth: 512,
    atlasHeight: 512,
    fontSize: 32,
    distanceRange: 4,
    lineHeight: 1.2,
    ascent: 0.8,
    descent: -0.2,
    name: "test-font",
  };

  it("parseSDFFont parses JSON font data", () => {
    const json = JSON.stringify({
      name: "test",
      atlas: { width: 256, height: 256, size: 24, distanceRange: 3 },
      metrics: { lineHeight: 1.0, ascender: 0.7, descender: -0.3 },
      glyphs: [
        { unicode: 65, advance: 0.5, planeBounds: { left: 0, right: 0.4, top: 0.5, bottom: 0 } },
      ],
    });
    const font = parseSDFFont(json);
    expect(font.name).toBe("test");
    expect(font.atlasWidth).toBe(256);
    expect(font.fontSize).toBe(24);
    expect(font.glyphs.size).toBe(1);
    expect(font.glyphs.get(65)?.char).toBe("A");
  });

  it("layoutSDFText produces quads", () => {
    const result = layoutSDFText("AB", mockFont, 32);
    expect(result.quads.length).toBe(2);
    expect(result.quads[0].w).toBeGreaterThan(0);
    expect(result.quads[1].x).toBeGreaterThan(result.quads[0].x);
  });

  it("layoutSDFText handles newlines", () => {
    const result = layoutSDFText("A\nB", mockFont, 32);
    expect(result.quads.length).toBe(2);
    expect(result.quads[1].y).toBeGreaterThan(result.quads[0].y);
  });

  it("layoutSDFText respects maxWidth", () => {
    const result = layoutSDFText("AB", mockFont, 32, 0.8);
    // Should wrap since AB advance (0.7+0.65=1.35) > 0.8 at scale=1
    expect(result.quads.length).toBe(2);
    expect(result.quads[1].y).toBeGreaterThan(result.quads[0].y);
  });

  it("SDF_TEXT_SHADER contains WGSL code", () => {
    expect(SDF_TEXT_SHADER).toContain("atlasTex");
    expect(SDF_TEXT_SHADER).toContain("smoothstep");
    expect(SDF_TEXT_SHADER).toContain("outlineColor");
  });
});

describe("procedural-texture", () => {
  it("DEFAULT_PROCEDURAL_CONFIG has expected values", () => {
    expect(DEFAULT_PROCEDURAL_CONFIG.type).toBe("checkerboard");
    expect(DEFAULT_PROCEDURAL_CONFIG.width).toBe(256);
    expect(DEFAULT_PROCEDURAL_CONFIG.height).toBe(256);
  });

  it("generates checkerboard texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "checkerboard",
      width: 4,
      height: 4,
      scale: 2,
    });
    expect(data.length).toBe(4 * 4 * 4);
    // First pixel should be colorA (white)
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
  });

  it("generates noise texture with varied values", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "noise",
      width: 8,
      height: 8,
      scale: 4,
    });
    expect(data.length).toBe(8 * 8 * 4);
    // Should have some variation
    const values = new Set<number>();
    for (let i = 0; i < data.length; i += 4) values.add(data[i]);
    expect(values.size).toBeGreaterThan(1);
  });

  it("generates perlin/fbm texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "perlin",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates voronoi texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "voronoi",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates brick texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "brick",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates wood texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "wood",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates marble texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "marble",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates grid texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "grid",
      width: 16,
      height: 16,
      scale: 4,
    });
    expect(data.length).toBe(16 * 16 * 4);
  });

  it("generates gradient texture", () => {
    const data = generateProceduralTexture({
      ...DEFAULT_PROCEDURAL_CONFIG,
      type: "gradient",
      width: 4,
      height: 4,
    });
    // Top should be colorA, bottom should be colorB
    expect(data[0]).toBe(255); // top-left R = colorA[0] * 255
    expect(data[(3 * 4 + 0) * 4]).toBe(64); // bottom-left: v=0.75, lerp(1,0,0.75)*255 ≈ 64
  });

  it("supports all texture types", () => {
    const types: ProceduralTextureType[] = ["checkerboard", "noise", "perlin", "voronoi", "brick", "wood", "marble", "grid", "gradient"];
    for (const type of types) {
      const data = generateProceduralTexture({ ...DEFAULT_PROCEDURAL_CONFIG, type, width: 4, height: 4 });
      expect(data.length).toBe(4 * 4 * 4);
    }
  });
});
