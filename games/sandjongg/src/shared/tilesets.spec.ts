import { Material } from "@downdraft/library-sand";
import { describe, expect, it } from "bun:test";
import {
    TILESETS,
    TILESET_IDS,
    getTileCount,
    getTileDef,
    getTileset,
    tileDebugColors,
    tilesetMaterial,
} from "./tilesets";

describe("tilesets", () => {
  it("registry has exactly the elements + riichi tilesets", () => {
    expect(TILESET_IDS).toEqual(["elements", "riichi"]);
    expect(Object.keys(TILESETS).sort()).toEqual(["elements", "riichi"]);
  });

  it("elements tileset has 18 tiles (matches ELEMENTS)", () => {
    expect(getTileCount("elements")).toBe(18);
    const ts = getTileset("elements");
    expect(ts.assetBased).toBe(false);
    expect(ts.themed).toBe(false);
    expect(ts.tileAspect).toBe(1.0); // square
    expect(ts.tiles.length).toBe(18);
    expect(ts.tiles[0].name).toBe("Fire");
    expect(ts.tiles[17].name).toBe("Liquid Nitrogen");
  });

  it("riichi tileset has 34 tiles (3 suits × 9 + 4 winds + 3 dragons)", () => {
    expect(getTileCount("riichi")).toBe(34);
    const ts = getTileset("riichi");
    expect(ts.assetBased).toBe(true);
    expect(ts.themed).toBe(true);
    expect(ts.tileAspect).toBeCloseTo(519 / 692, 5); // 4:3 portrait, matches 300×400 SVG canvas
    expect(ts.tiles.length).toBe(34);
    // Unique ids 0..33
    const ids = ts.tiles.map((t) => t.id);
    expect(ids).toEqual(Array.from({ length: 34 }, (_, i) => i));
  });

  it("riichi tiles have unique asset keys (glyphs)", () => {
    const ts = getTileset("riichi");
    const keys = new Set(ts.tiles.map((t) => t.glyph));
    expect(keys.size).toBe(34);
    // Spot-check a few keys match the vendored SVG filenames.
    expect(ts.tiles[0].glyph).toBe("Man1");
    expect(ts.tiles[9].glyph).toBe("Pin1");
    expect(ts.tiles[18].glyph).toBe("Sou1");
    expect(ts.tiles[27].glyph).toBe("Ton");
    expect(ts.tiles[31].glyph).toBe("Haku");
    expect(ts.tiles[33].glyph).toBe("Chun");
  });

  it("riichi suit-based sand-material mapping is correct", () => {
    // Man 1-9 -> Dirt
    for (let i = 0; i < 9; i++) {
      expect(tilesetMaterial("riichi", i)).toBe(Material.Dirt);
    }
    // Pin 1-9 -> Water
    for (let i = 9; i < 18; i++) {
      expect(tilesetMaterial("riichi", i)).toBe(Material.Water);
    }
    // Sou 1-9 -> Plant
    for (let i = 18; i < 27; i++) {
      expect(tilesetMaterial("riichi", i)).toBe(Material.Plant);
    }
    // Winds (Ton/Nan/Shaa/Pei) -> Steam
    for (let i = 27; i < 31; i++) {
      expect(tilesetMaterial("riichi", i)).toBe(Material.Steam);
    }
    // Dragons: Haku -> Salt, Hatsu -> Acid, Chun -> Lava
    expect(tilesetMaterial("riichi", 31)).toBe(Material.Salt);
    expect(tilesetMaterial("riichi", 32)).toBe(Material.Acid);
    expect(tilesetMaterial("riichi", 33)).toBe(Material.Lava);
  });

  it("riichi materials are all valid (non-Empty, < 256)", () => {
    const ts = getTileset("riichi");
    for (const def of ts.tiles) {
      expect(def.sandMaterial).toBeGreaterThan(0);
      expect(def.sandMaterial).toBeLessThan(256);
    }
  });

  it("elements tileset material mapping matches ELEMENTS", () => {
    // Cross-check: tilesetMaterial("elements", id) should equal the elements
    // tileset's def.sandMaterial (which mirrors ELEMENTS[id].sandMaterial).
    for (let i = 0; i < 18; i++) {
      expect(tilesetMaterial("elements", i)).toBe(getTileDef("elements", i).sandMaterial);
    }
  });

  it("tilesetMaterial returns Empty for invalid ids", () => {
    expect(tilesetMaterial("elements", -1)).toBe(Material.Empty);
    expect(tilesetMaterial("elements", 99)).toBe(Material.Empty);
    expect(tilesetMaterial("riichi", -1)).toBe(Material.Empty);
    expect(tilesetMaterial("riichi", 99)).toBe(Material.Empty);
  });

  it("getTileDef throws for invalid ids", () => {
    expect(() => getTileDef("elements", 99)).toThrow();
    expect(() => getTileDef("riichi", 99)).toThrow();
  });

  it("getTileset throws for unknown tileset id", () => {
    expect(() => getTileset("unknown" as never)).toThrow();
  });

  it("tileDebugColors returns neutral cream/dark for riichi, element colors for elements", () => {
    // Elements: returns the element's own color.
    const elColors = tileDebugColors("elements", 0, "light");
    expect(elColors.color).toBe(getTileDef("elements", 0).color);
    // Riichi light: neutral cream.
    const riichiLight = tileDebugColors("riichi", 0, "light");
    expect(riichiLight.color).toBe("#f5e9c8");
    // Riichi dark: neutral dark.
    const riichiDark = tileDebugColors("riichi", 0, "dark");
    expect(riichiDark.color).toBe("#1f1f24");
    // Riichi debug colors are the same for every tile id (suit-agnostic).
    expect(tileDebugColors("riichi", 5, "light").color).toBe(riichiLight.color);
    expect(tileDebugColors("riichi", 33, "dark").color).toBe(riichiDark.color);
  });

  it("each riichi tile has a non-empty name + asset key", () => {
    const ts = getTileset("riichi");
    for (const def of ts.tiles) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.glyph.length).toBeGreaterThan(0);
    }
  });
});
