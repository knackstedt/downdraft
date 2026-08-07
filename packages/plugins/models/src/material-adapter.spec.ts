import { MaterialLibrary } from "@downdraft/core";
import { describe, expect, it } from "bun:test";
import { materialDataArrayToMaterials, materialDataToMaterial } from "./material-adapter";
import type { MaterialData } from "./types";

function makeMaterialData(overrides: Partial<MaterialData> = {}): MaterialData {
  return {
    name: "test_material",
    baseColor: [1, 0.5, 0.25, 1],
    metallic: 0.8,
    roughness: 0.3,
    ...overrides,
  };
}

describe("materialDataToMaterial", () => {
  it("should convert MaterialData to a Material", () => {
    const md = makeMaterialData();
    const mat = materialDataToMaterial(md);
    expect(mat.name).toBe("test_material");
    expect(mat.materialType).toBe("physical");
  });

  it("should map baseColor to a uniform", () => {
    const md = makeMaterialData({ baseColor: [0.2, 0.4, 0.6, 0.8] });
    const mat = materialDataToMaterial(md);
    const bc = mat.getUniform("baseColor");
    expect(bc).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it("should map metallic to a uniform", () => {
    const md = makeMaterialData({ metallic: 0.9 });
    const mat = materialDataToMaterial(md);
    expect(mat.getUniform("metallic")).toBe(0.9);
  });

  it("should map roughness to a uniform", () => {
    const md = makeMaterialData({ roughness: 0.15 });
    const mat = materialDataToMaterial(md);
    expect(mat.getUniform("roughness")).toBe(0.15);
  });

  it("should map emissiveColor when present", () => {
    const md = makeMaterialData({ emissiveColor: [0.1, 0.2, 0.3] });
    const mat = materialDataToMaterial(md);
    expect(mat.getUniform("emissive")).toEqual([0.1, 0.2, 0.3]);
  });

  it("should use Opaque blend mode for alpha=1", () => {
    const md = makeMaterialData({ baseColor: [1, 1, 1, 1] });
    const mat = materialDataToMaterial(md);
    expect(mat.blendMode).toBe("opaque");
  });

  it("should use AlphaBlend blend mode for alpha<1", () => {
    const md = makeMaterialData({ baseColor: [1, 1, 1, 0.5] });
    const mat = materialDataToMaterial(md);
    expect(mat.blendMode).toBe("alpha-blend");
  });

  it("should register into a library when provided", () => {
    const lib = new MaterialLibrary();
    const md = makeMaterialData({ name: "lib_test" });
    const mat = materialDataToMaterial(md, { library: lib });
    expect(lib.get("lib_test")).toBe(mat);
  });

  it("should use the name override", () => {
    const md = makeMaterialData();
    const mat = materialDataToMaterial(md, { name: "custom_name" });
    expect(mat.name).toBe("custom_name");
  });

  it("should set inlineShaderSource from the physical fallback", () => {
    const md = makeMaterialData();
    const mat = materialDataToMaterial(md);
    expect(mat.inlineShaderSource).toBeDefined();
    expect(mat.inlineShaderSource!.length).toBeGreaterThan(0);
    // Should contain the physical shader's entry point.
    expect(mat.inlineShaderSource).toContain("vs_main");
  });
});

describe("materialDataArrayToMaterials", () => {
  it("should batch-convert and register all materials", () => {
    const lib = new MaterialLibrary();
    const mds = [
      makeMaterialData({ name: "mat_a" }),
      makeMaterialData({ name: "mat_b" }),
      makeMaterialData({ name: "mat_c" }),
    ];
    const mats = materialDataArrayToMaterials(mds, lib);
    expect(mats.length).toBe(3);
    expect(lib.get("mat_a")).toBeDefined();
    expect(lib.get("mat_b")).toBeDefined();
    expect(lib.get("mat_c")).toBeDefined();
  });

  it("should handle empty array", () => {
    const lib = new MaterialLibrary();
    const mats = materialDataArrayToMaterials([], lib);
    expect(mats.length).toBe(0);
  });
});
