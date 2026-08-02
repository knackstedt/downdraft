import { describe, it, expect } from "bun:test";
import {
  getFormatInfo,
  isDepthFormat,
  isCompressedFormat,
  isFilterableFormat,
  isRenderableFormat,
  getWebGL2FormatMapping,
  getWebGL2FallbackFormat,
} from "./format-mapping.ts";
import type { TextureFormat } from "./types.ts";

describe("format-mapping — getFormatInfo", () => {
  it("returns correct info for rgba8unorm", () => {
    const info = getFormatInfo("rgba8unorm");
    expect(info.bytesPerTexel).toBe(4);
    expect(info.renderable).toBe(true);
    expect(info.filterable).toBe(true);
    expect(info.compressed).toBe(false);
    expect(info.depthOrStencil).toBe(false);
    expect(info.blendable).toBe(true);
  });

  it("returns correct info for depth32float", () => {
    const info = getFormatInfo("depth32float");
    expect(info.bytesPerTexel).toBe(4);
    expect(info.renderable).toBe(true);
    expect(info.filterable).toBe(false);
    expect(info.depthOrStencil).toBe(true);
    expect(info.blendable).toBe(false);
  });

  it("returns correct info for bc1-rgba-unorm (compressed)", () => {
    const info = getFormatInfo("bc1-rgba-unorm");
    expect(info.bytesPerTexel).toBe(0);
    expect(info.renderable).toBe(false);
    expect(info.filterable).toBe(true);
    expect(info.compressed).toBe(true);
    expect(info.depthOrStencil).toBe(false);
  });

  it("falls back to rgba8unorm for unknown formats", () => {
    const info = getFormatInfo("unknown-format" as TextureFormat);
    expect(info.bytesPerTexel).toBe(4);
    expect(info.renderable).toBe(true);
  });
});

describe("format-mapping — predicate functions", () => {
  it("isDepthFormat", () => {
    expect(isDepthFormat("depth32float")).toBe(true);
    expect(isDepthFormat("depth16unorm")).toBe(true);
    expect(isDepthFormat("depth24plus")).toBe(true);
    expect(isDepthFormat("depth24plus-stencil8")).toBe(true);
    expect(isDepthFormat("rgba8unorm")).toBe(false);
    expect(isDepthFormat("bc1-rgba-unorm")).toBe(false);
  });

  it("isCompressedFormat", () => {
    expect(isCompressedFormat("bc1-rgba-unorm")).toBe(true);
    expect(isCompressedFormat("bc7-rgba-unorm")).toBe(true);
    expect(isCompressedFormat("bc6h-rgb-ufloat")).toBe(true);
    expect(isCompressedFormat("rgba8unorm")).toBe(false);
    expect(isCompressedFormat("depth32float")).toBe(false);
  });

  it("isFilterableFormat", () => {
    expect(isFilterableFormat("rgba8unorm")).toBe(true);
    expect(isFilterableFormat("rgba16float")).toBe(true);
    expect(isFilterableFormat("depth16unorm")).toBe(true);
    expect(isFilterableFormat("rgba32float")).toBe(false);
    expect(isFilterableFormat("depth32float")).toBe(false);
    expect(isFilterableFormat("bc1-rgba-unorm")).toBe(true);
  });

  it("isRenderableFormat", () => {
    expect(isRenderableFormat("rgba8unorm")).toBe(true);
    expect(isRenderableFormat("depth32float")).toBe(true);
    expect(isRenderableFormat("bc1-rgba-unorm")).toBe(false);
    expect(isRenderableFormat("bc7-rgba-unorm")).toBe(false);
  });
});

describe("format-mapping — WebGL2 format mapping", () => {
  it("returns mapping for rgba8unorm", () => {
    const m = getWebGL2FormatMapping("rgba8unorm");
    expect(m).not.toBeNull();
    expect(m!.internalFormat).toBe(0x8058); // GL_RGBA8
    expect(m!.format).toBe(0x1908); // GL_RGBA
    expect(m!.type).toBe(0x1401); // GL_UNSIGNED_BYTE
  });

  it("returns mapping for rgba16float", () => {
    const m = getWebGL2FormatMapping("rgba16float");
    expect(m).not.toBeNull();
    expect(m!.internalFormat).toBe(0x8814); // GL_RGBA16F
    expect(m!.type).toBe(0x8B61); // GL_HALF_FLOAT
  });

  it("returns mapping for depth24plus-stencil8", () => {
    const m = getWebGL2FormatMapping("depth24plus-stencil8");
    expect(m).not.toBeNull();
    expect(m!.internalFormat).toBe(0x88F0); // GL_DEPTH24_STENCIL8
  });

  it("includes block info for compressed formats", () => {
    const bc1 = getWebGL2FormatMapping("bc1-rgba-unorm");
    expect(bc1).not.toBeNull();
    expect(bc1!.blockSize).toBe(8);
    expect(bc1!.blockWidth).toBe(4);
    expect(bc1!.blockHeight).toBe(4);

    const bc3 = getWebGL2FormatMapping("bc3-rgba-unorm");
    expect(bc3).not.toBeNull();
    expect(bc3!.blockSize).toBe(16);
  });

  it("returns null for unknown formats", () => {
    expect(getWebGL2FormatMapping("unknown" as TextureFormat)).toBeNull();
  });
});

describe("format-mapping — WebGL2 fallback", () => {
  it("falls back float formats to rgba8unorm", () => {
    expect(getWebGL2FallbackFormat("rgba16float")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("rgba32float")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("rg16float")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("rg32float")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("r16float")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("r32float")).toBe("rgba8unorm");
  });

  it("falls back bgra8unorm to rgba8unorm", () => {
    expect(getWebGL2FallbackFormat("bgra8unorm")).toBe("rgba8unorm");
  });

  it("falls back depth32float to depth24plus", () => {
    expect(getWebGL2FallbackFormat("depth32float")).toBe("depth24plus");
  });

  it("returns same format for natively supported formats", () => {
    expect(getWebGL2FallbackFormat("rgba8unorm")).toBe("rgba8unorm");
    expect(getWebGL2FallbackFormat("depth24plus")).toBe("depth24plus");
    expect(getWebGL2FallbackFormat("depth16unorm")).toBe("depth16unorm");
    expect(getWebGL2FallbackFormat("bc1-rgba-unorm")).toBe("bc1-rgba-unorm");
  });
});
