import { describe, it, expect, vi } from "bun:test";
import { createWebGL2Capabilities } from "./capabilities.ts";
import type { TextureFormat } from "./types.ts";

function createMockGL2(extensions: Record<string, unknown> = {}) {
  const params: Record<number, number> = {
    0x0D33: 4096, // MAX_TEXTURE_SIZE
    0x913A: 64,   // MAX_ARRAY_TEXTURE_LAYERS (GL_TEXTURE_2D_ARRAY)
    0x8A2F: 84,   // MAX_UNIFORM_BLOCK_SIZE
    0x8A2E: 36,   // MAX_UNIFORM_BUFFER_BINDINGS
    0x8DFB: 8,    // MAX_COLOR_ATTACHMENTS
    0x8869: 16,   // MAX_VERTEX_ATTRIBS
    0x8B4D: 16,   // MAX_TEXTURE_IMAGE_UNITS
    0x8B4C: 32,   // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  };

  return {
    getExtension: vi.fn((name: string) => extensions[name] ?? null),
    getParameter: vi.fn((pname: number) => params[pname] ?? 0),
    MAX_TEXTURE_SIZE: 0x0D33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x913A,
    MAX_UNIFORM_BLOCK_SIZE: 0x8A2F,
    MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2E,
    MAX_COLOR_ATTACHMENTS: 0x8DFB,
    MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_TEXTURE_IMAGE_UNITS: 0x8B4D,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4C,
  } as unknown as WebGL2RenderingContext;
}

describe("capabilities — createWebGL2Capabilities (no extensions)", () => {
  const gl = createMockGL2({});
  const caps = createWebGL2Capabilities(gl);

  it("reports backend as webgl2", () => {
    expect(caps.backend).toBe("webgl2");
  });

  it("reports no compute shaders", () => {
    expect(caps.computeShaders).toBe(false);
  });

  it("reports no timestamp queries", () => {
    expect(caps.timestampQueries).toBe(false);
  });

  it("reports no float render targets without extension", () => {
    expect(caps.floatRenderTargets).toBe(false);
  });

  it("reports no BC compression without extension", () => {
    expect(caps.bcCompression).toBe(false);
  });

  it("reports no anisotropic filtering without extension", () => {
    expect(caps.anisotropicFiltering).toBe(false);
  });

  it("reports core WebGL2 features as available", () => {
    expect(caps.multipleRenderTargets).toBe(true);
    expect(caps.instancing).toBe(true);
    expect(caps.uniformBuffers).toBe(true);
    expect(caps.transformFeedback).toBe(true);
    expect(caps.comparisonSamplers).toBe(true);
  });

  it("reads limits from GL context", () => {
    expect(caps.maxTextureSize).toBe(4096);
    expect(caps.maxColorAttachments).toBe(8);
    expect(caps.maxVertexAttributes).toBe(16);
  });

  it("reports reduced engine limits for WebGL2", () => {
    expect(caps.maxPointLights).toBe(8);
    expect(caps.maxSpotLights).toBe(4);
    expect(caps.maxParticles).toBe(1000);
    expect(caps.maxShadowMapSize).toBe(1024);
  });

  it("isFormatSupported returns false for bgra8unorm", () => {
    expect(caps.isFormatSupported("bgra8unorm")).toBe(false);
  });

  it("isFormatSupported returns false for float formats without extension", () => {
    expect(caps.isFormatSupported("rgba16float")).toBe(false);
    expect(caps.isFormatSupported("rgba32float")).toBe(false);
  });

  it("isFormatSupported returns false for compressed formats without extension", () => {
    expect(caps.isFormatSupported("bc1-rgba-unorm")).toBe(false);
    expect(caps.isFormatSupported("bc7-rgba-unorm")).toBe(false);
  });

  it("isFormatSupported returns true for basic formats", () => {
    expect(caps.isFormatSupported("rgba8unorm")).toBe(true);
    expect(caps.isFormatSupported("depth24plus")).toBe(true);
  });

  it("isFormatRenderable returns false for compressed formats", () => {
    expect(caps.isFormatRenderable("bc1-rgba-unorm")).toBe(false);
  });

  it("isFormatRenderable returns false for bgra8unorm", () => {
    expect(caps.isFormatRenderable("bgra8unorm")).toBe(false);
  });

  it("isFormatFilterable returns false for float32 without linear extension", () => {
    expect(caps.isFormatFilterable("rgba32float")).toBe(false);
  });

  it("isFormatFilterable returns true for basic filterable formats", () => {
    expect(caps.isFormatFilterable("rgba8unorm")).toBe(true);
  });
});

describe("capabilities — createWebGL2Capabilities (with extensions)", () => {
  const gl = createMockGL2({
    "EXT_color_buffer_float": {},
    "EXT_texture_filter_anisotropic": {},
    "WEBGL_compressed_texture_s3tc": {},
    "OES_texture_float_linear": {},
  });
  const caps = createWebGL2Capabilities(gl);

  it("reports float render targets with extension", () => {
    expect(caps.floatRenderTargets).toBe(true);
  });

  it("reports half-float render targets with float extension", () => {
    expect(caps.halfFloatRenderTargets).toBe(true);
  });

  it("reports BC compression with extension", () => {
    expect(caps.bcCompression).toBe(true);
  });

  it("reports anisotropic filtering with extension", () => {
    expect(caps.anisotropicFiltering).toBe(true);
  });

  it("isFormatSupported returns true for float formats with extension", () => {
    expect(caps.isFormatSupported("rgba16float")).toBe(true);
    expect(caps.isFormatSupported("rgba32float")).toBe(true);
  });

  it("isFormatSupported returns true for compressed formats with extension", () => {
    expect(caps.isFormatSupported("bc1-rgba-unorm")).toBe(true);
    expect(caps.isFormatSupported("bc7-rgba-unorm")).toBe(true);
  });

  it("isFormatRenderable returns true for float formats with extension", () => {
    expect(caps.isFormatRenderable("rgba16float")).toBe(true);
    expect(caps.isFormatRenderable("rgba32float")).toBe(true);
  });

  it("isFormatFilterable returns true for float32 with linear extension", () => {
    expect(caps.isFormatFilterable("rgba32float")).toBe(true);
  });
});
