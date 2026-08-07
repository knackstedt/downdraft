import { describe, expect, it } from "bun:test";
import { GLTFCodecRegistry, getDefaultCodecRegistry, registerDefaultCodecs } from "./registry";

describe("GLTFCodecRegistry", () => {
  it("registers and retrieves mesh codecs by URI", () => {
    const registry = new GLTFCodecRegistry();
    const codec = {
      uri: "TEST_MESH_CODEC",
      async decode() {
        return { attributes: new Map(), vertexCount: 0, indexCount: 0 };
      },
    };
    registry.registerMeshCodec(codec);
    expect(registry.getMeshCodec("TEST_MESH_CODEC")).toBe(codec);
    expect(registry.hasMeshCodec("TEST_MESH_CODEC")).toBe(true);
    expect(registry.hasMeshCodec("NONEXISTENT")).toBe(false);
  });

  it("registers and retrieves bufferView codecs by URI", () => {
    const registry = new GLTFCodecRegistry();
    const codec = {
      uri: "TEST_BV_CODEC",
      async decode() {
        return new Uint8Array(0);
      },
    };
    registry.registerBufferViewCodec(codec);
    expect(registry.getBufferViewCodec("TEST_BV_CODEC")).toBe(codec);
    expect(registry.hasBufferViewCodec("TEST_BV_CODEC")).toBe(true);
  });

  it("registers and retrieves texture codecs by URI", () => {
    const registry = new GLTFCodecRegistry();
    const codec = {
      uri: "TEST_TEX_CODEC",
      async decode() {
        return { data: new Uint8Array(0), width: 0, height: 0, format: "rgba8unorm", mipLevels: 1, isHDR: false };
      },
    };
    registry.registerTextureCodec(codec);
    expect(registry.getTextureCodec("TEST_TEX_CODEC")).toBe(codec);
    expect(registry.hasTextureCodec("TEST_TEX_CODEC")).toBe(true);
  });

  it("declareSupported adds to supported list without registering a codec", () => {
    const registry = new GLTFCodecRegistry();
    registry.declareSupported("KHR_texture_transform");
    expect(registry.listSupported()).toContain("KHR_texture_transform");
    expect(registry.getMeshCodec("KHR_texture_transform")).toBeUndefined();
  });

  it("listSupported returns sorted unique extensions", () => {
    const registry = new GLTFCodecRegistry();
    registry.declareSupported("B");
    registry.declareSupported("A");
    registry.declareSupported("B"); // duplicate
    const list = registry.listSupported();
    expect(list).toEqual(["A", "B"]);
  });
});

describe("getDefaultCodecRegistry", () => {
  it("returns a registry with default codecs registered", () => {
    const registry = getDefaultCodecRegistry();
    const supported = registry.listSupported();
    // Codec-backed extensions
    expect(supported).toContain("KHR_draco_mesh_compression");
    expect(supported).toContain("EXT_meshopt_compression");
    expect(supported).toContain("KHR_texture_basisu");
    // Non-codec extensions
    expect(supported).toContain("KHR_texture_transform");
    expect(supported).toContain("KHR_mesh_quantization");
    expect(supported).toContain("KHR_materials_variants");
    expect(supported).toContain("KHR_lights_punctual");
  });

  it("returns the same instance on repeated calls", () => {
    const a = getDefaultCodecRegistry();
    const b = getDefaultCodecRegistry();
    expect(a).toBe(b);
  });

  it("registerDefaultCodecs populates a fresh registry", () => {
    const registry = new GLTFCodecRegistry();
    expect(registry.listSupported()).toHaveLength(0);
    registerDefaultCodecs(registry);
    expect(registry.listSupported().length).toBeGreaterThan(0);
    expect(registry.hasMeshCodec("KHR_draco_mesh_compression")).toBe(true);
    expect(registry.hasBufferViewCodec("EXT_meshopt_compression")).toBe(true);
    expect(registry.hasTextureCodec("KHR_texture_basisu")).toBe(true);
  });
});
