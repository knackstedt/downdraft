import { describe, expect, it } from "bun:test";
import {
  extractTextureTransform,
  getSupportedExtensions,
  isExtensionSupported,
  processMaterialExtensions,
  processMeshPrimitiveExtensions,
} from "./gltf-extensions";
import type { MaterialData } from "./types";

describe("extractTextureTransform", () => {
  it("returns undefined when no extensions", () => {
    expect(extractTextureTransform(undefined)).toBeUndefined();
  });

  it("returns undefined when KHR_texture_transform not present", () => {
    expect(extractTextureTransform({ OTHER_EXT: {} })).toBeUndefined();
  });

  it("extracts full transform", () => {
    const result = extractTextureTransform({
      KHR_texture_transform: {
        offset: [0.5, 0.25],
        rotation: 1.5708,
        scale: [2, 0.5],
        texCoord: 1,
      },
    });
    expect(result).toEqual({
      offset: [0.5, 0.25],
      rotation: 1.5708,
      scale: [2, 0.5],
      texCoord: 1,
    });
  });

  it("uses defaults for missing fields", () => {
    const result = extractTextureTransform({
      KHR_texture_transform: {},
    });
    expect(result).toEqual({
      offset: [0, 0],
      rotation: 0,
      scale: [1, 1],
      texCoord: undefined,
    });
  });
});

describe("processMaterialExtensions", () => {
  const baseMaterial: MaterialData = {
    name: "test",
    baseColor: [1, 1, 1, 1],
    metallic: 0.5,
    roughness: 0.8,
  };

  it("returns material unchanged when no extensions", () => {
    const result = processMaterialExtensions(baseMaterial, undefined);
    expect(result).toEqual(baseMaterial);
  });

  it("applies KHR_materials_unlit", () => {
    const result = processMaterialExtensions(baseMaterial, {
      KHR_materials_unlit: {},
    });
    expect(result.metallic).toBe(0);
    expect(result.roughness).toBe(1);
  });

  it("applies KHR_materials_emissive_strength", () => {
    const mat: MaterialData = {
      ...baseMaterial,
      emissiveColor: [0.1, 0.2, 0.3],
    };
    const result = processMaterialExtensions(mat, {
      KHR_materials_emissive_strength: { emissiveStrength: 2.0 },
    });
    expect(result.emissiveColor).toEqual([0.2, 0.4, 0.6]);
  });

  it("applies KHR_texture_transform", () => {
    const result = processMaterialExtensions(baseMaterial, {
      KHR_texture_transform: {
        offset: [0.1, 0.2],
        scale: [3, 4],
      },
    });
    expect(result.textureTransform).toBeDefined();
    expect(result.textureTransform!.offset).toEqual([0.1, 0.2]);
    expect(result.textureTransform!.scale).toEqual([3, 4]);
  });

  it("converts KHR_materials_pbrSpecularGlossiness to metallic-roughness", () => {
    const result = processMaterialExtensions(baseMaterial, {
      KHR_materials_pbrSpecularGlossiness: {
        diffuseFactor: [0.8, 0.6, 0.4, 1.0],
        specularFactor: [0.9, 0.9, 0.9],
        glossinessFactor: 0.7,
      },
    });
    expect(result.baseColor).toEqual([0.8, 0.6, 0.4, 1.0]);
    expect(result.metallic).toBe(1); // maxSpec > 0.5
    expect(result.roughness).toBeCloseTo(Math.max(0.05, 1 - 0.7));
  });
});

describe("processMeshPrimitiveExtensions", () => {
  it("returns all false when no extensions", () => {
    const result = processMeshPrimitiveExtensions(undefined);
    expect(result).toEqual({ dracoCompressed: false, quantized: false, meshoptCompressed: false });
  });

  it("detects KHR_draco_mesh_compression", () => {
    const result = processMeshPrimitiveExtensions({
      KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } },
    });
    expect(result.dracoCompressed).toBe(true);
  });

  it("detects KHR_mesh_quantization", () => {
    const result = processMeshPrimitiveExtensions({
      KHR_mesh_quantization: {},
    });
    expect(result.quantized).toBe(true);
  });

  it("detects EXT_meshopt_compression", () => {
    const result = processMeshPrimitiveExtensions({
      EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 10, byteStride: 4, count: 2, mode: "ATTRIBUTES", filter: "NONE" },
    });
    expect(result.meshoptCompressed).toBe(true);
  });
});

describe("getSupportedExtensions", () => {
  it("includes the full extension matrix", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain("KHR_draco_mesh_compression");
    expect(exts).toContain("EXT_meshopt_compression");
    expect(exts).toContain("KHR_texture_transform");
    expect(exts).toContain("KHR_mesh_quantization");
    expect(exts).toContain("KHR_texture_basisu");
    expect(exts).toContain("KHR_materials_variants");
    expect(exts).toContain("KHR_lights_punctual");
    expect(exts).toContain("KHR_materials_pbrSpecularGlossiness");
    expect(exts).toContain("KHR_materials_unlit");
    expect(exts).toContain("KHR_materials_emissive_strength");
  });

  it("isExtensionSupported returns true for supported, false for unsupported", () => {
    expect(isExtensionSupported("KHR_draco_mesh_compression")).toBe(true);
    expect(isExtensionSupported("KHR_texture_transform")).toBe(true);
    expect(isExtensionSupported("NONEXISTENT_EXTENSION")).toBe(false);
  });
});
