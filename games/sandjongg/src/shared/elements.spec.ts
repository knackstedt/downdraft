import { Material } from "@downdraft/library-sand";
import { describe, expect, it } from "bun:test";
import { ELEMENTS, elementToMaterial, getElement, NUM_ELEMENTS } from "./elements";

describe("elements", () => {
  it("has exactly 12 elements", () => {
    expect(NUM_ELEMENTS).toBe(12);
    expect(ELEMENTS.length).toBe(12);
  });

  it("each element has a unique id 0..11", () => {
    const ids = ELEMENTS.map((e) => e.id);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("each element maps to a valid, distinct sand Material", () => {
    const materials = new Set<number>();
    for (const el of ELEMENTS) {
      const mat = elementToMaterial(el.id);
      expect(mat).toBeGreaterThan(0); // not Empty
      expect(mat).toBeLessThan(256);
      materials.add(mat);
    }
    // At least 10 of 12 should be distinct (some elements may share a material family)
    expect(materials.size).toBeGreaterThanOrEqual(10);
  });

  it("elementToMaterial returns Empty for invalid ids", () => {
    expect(elementToMaterial(-1)).toBe(Material.Empty);
    expect(elementToMaterial(99)).toBe(Material.Empty);
  });

  it("each element has a non-empty color and glyph", () => {
    for (const el of ELEMENTS) {
      expect(el.color.length).toBeGreaterThan(0);
      expect(el.glyph.length).toBeGreaterThan(0);
      expect(el.name.length).toBeGreaterThan(0);
    }
  });

  it("getElement returns the correct definition", () => {
    for (const el of ELEMENTS) {
      expect(getElement(el.id)).toBe(el);
    }
  });
});
