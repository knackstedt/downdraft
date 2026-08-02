// ============================================================================
// Format Mapping — maps backend-agnostic TextureFormat to backend-specific
// formats and provides capability queries (filterable, renderable, etc.)
// ============================================================================

import type { TextureFormat } from "./types.ts";

export interface FormatInfo {
  /** Bytes per texel (for uncompressed formats). 0 for compressed. */
  bytesPerTexel: number;
  /** Whether this format can be used as a render attachment. */
  renderable: boolean;
  /** Whether this format can be filtered (linear sampling). */
  filterable: boolean;
  /** Whether this format is a compressed format. */
  compressed: boolean;
  /** Whether this format is a depth/stencil format. */
  depthOrStencil: boolean;
  /** Whether this format supports blending. */
  blendable: boolean;
}

const FORMAT_INFO: Record<TextureFormat, FormatInfo> = {
  "rgba8unorm": { bytesPerTexel: 4, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: true },
  "rgba8snorm": { bytesPerTexel: 4, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: false },
  "bgra8unorm": { bytesPerTexel: 4, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: true },
  "rgba16float": { bytesPerTexel: 8, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: true },
  "rg16float": { bytesPerTexel: 4, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: true },
  "r16float": { bytesPerTexel: 2, renderable: true, filterable: true, compressed: false, depthOrStencil: false, blendable: true },
  "rgba32float": { bytesPerTexel: 16, renderable: true, filterable: false, compressed: false, depthOrStencil: false, blendable: false },
  "rg32float": { bytesPerTexel: 8, renderable: true, filterable: false, compressed: false, depthOrStencil: false, blendable: false },
  "r32float": { bytesPerTexel: 4, renderable: true, filterable: false, compressed: false, depthOrStencil: false, blendable: false },
  "depth32float": { bytesPerTexel: 4, renderable: true, filterable: false, compressed: false, depthOrStencil: true, blendable: false },
  "depth16unorm": { bytesPerTexel: 2, renderable: true, filterable: true, compressed: false, depthOrStencil: true, blendable: false },
  "depth24plus": { bytesPerTexel: 4, renderable: true, filterable: false, compressed: false, depthOrStencil: true, blendable: false },
  "depth24plus-stencil8": { bytesPerTexel: 4, renderable: true, filterable: false, compressed: false, depthOrStencil: true, blendable: false },
  "bc1-rgba-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc2-rgba-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc3-rgba-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc4-r-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc5-rg-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc6h-rgb-ufloat": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
  "bc7-rgba-unorm": { bytesPerTexel: 0, renderable: false, filterable: true, compressed: true, depthOrStencil: false, blendable: false },
};

export function getFormatInfo(format: TextureFormat): FormatInfo {
  return FORMAT_INFO[format] ?? FORMAT_INFO["rgba8unorm"];
}

export function isDepthFormat(format: TextureFormat): boolean {
  return getFormatInfo(format).depthOrStencil;
}

export function isCompressedFormat(format: TextureFormat): boolean {
  return getFormatInfo(format).compressed;
}

export function isFilterableFormat(format: TextureFormat): boolean {
  return getFormatInfo(format).filterable;
}

export function isRenderableFormat(format: TextureFormat): boolean {
  return getFormatInfo(format).renderable;
}

// ─── WebGPU Format Mapping ─────────────────────────────────────────────────

export function toWebGPUFormat(format: TextureFormat): GPUTextureFormat {
  return format as GPUTextureFormat;
}

export function fromWebGPUFormat(format: GPUTextureFormat): TextureFormat {
  return format as TextureFormat;
}

// ─── WebGL2 Format Mapping ─────────────────────────────────────────────────

export interface WebGL2FormatMapping {
  internalFormat: number;
  format: number;
  type: number;
  /** For compressed formats, the block size in bytes. */
  blockSize?: number;
  /** For compressed formats, the block width in pixels. */
  blockWidth?: number;
  /** For compressed formats, the block height in pixels. */
  blockHeight?: number;
}

/**
 * Maps backend TextureFormat to WebGL2 internalFormat/format/type.
 * The actual GL constants are resolved lazily via the WebGL2 context
 * since they are numeric constants on the WebGLRenderingContext.
 */
export function getWebGL2FormatMapping(format: TextureFormat): WebGL2FormatMapping | null {
  // These mappings use string keys that will be resolved to GL constants
  // by the WebGL2 backend at runtime.
  const mappings: Record<TextureFormat, WebGL2FormatMapping> = {
    "rgba8unorm": { internalFormat: 0x8058, format: 0x1908, type: 0x1401 }, // GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE
    "rgba8snorm": { internalFormat: 0x8F97, format: 0x1908, type: 0x1400 }, // GL_RGBA8_SNORM, GL_RGBA, GL_BYTE
    "bgra8unorm": { internalFormat: 0x8051, format: 0x80E1, type: 0x1401 }, // GL_BGRA8_EXT, GL_BGRA, GL_UNSIGNED_BYTE (requires WEBGL_compressed_texture_s3tc_srgb or similar)
    "rgba16float": { internalFormat: 0x8814, format: 0x1908, type: 0x8B61 }, // GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT
    "rg16float": { internalFormat: 0x822F, format: 0x8227, type: 0x8B61 }, // GL_RG16F, GL_RG, GL_HALF_FLOAT
    "r16float": { internalFormat: 0x822D, format: 0x1903, type: 0x8B61 }, // GL_R16F, GL_RED, GL_HALF_FLOAT
    "rgba32float": { internalFormat: 0x8814, format: 0x1908, type: 0x1406 }, // Fallback: GL_RGBA16F with float, needs EXT_color_buffer_float
    "rg32float": { internalFormat: 0x8230, format: 0x8227, type: 0x1406 }, // GL_RG32F, GL_RG, GL_FLOAT
    "r32float": { internalFormat: 0x822E, format: 0x1903, type: 0x1406 }, // GL_R32F, GL_RED, GL_FLOAT
    "depth32float": { internalFormat: 0x8CAC, format: 0x1902, type: 0x1406 }, // GL_DEPTH_COMPONENT32F, GL_DEPTH_COMPONENT, GL_FLOAT
    "depth16unorm": { internalFormat: 0x81A5, format: 0x1902, type: 0x1403 }, // GL_DEPTH_COMPONENT16, GL_DEPTH_COMPONENT, GL_UNSIGNED_SHORT
    "depth24plus": { internalFormat: 0x81A6, format: 0x1902, type: 0x1405 }, // GL_DEPTH_COMPONENT24, GL_DEPTH_COMPONENT, GL_UNSIGNED_INT
    "depth24plus-stencil8": { internalFormat: 0x88F0, format: 0x84F9, type: 0x84FA }, // GL_DEPTH24_STENCIL8, GL_DEPTH_STENCIL, GL_UNSIGNED_INT_24_8
    "bc1-rgba-unorm": { internalFormat: 0x83F1, format: 0x83F1, type: 0, blockSize: 8, blockWidth: 4, blockHeight: 4 }, // GL_COMPRESSED_RGBA_S3TC_DXT1
    "bc2-rgba-unorm": { internalFormat: 0x83F2, format: 0x83F2, type: 0, blockSize: 16, blockWidth: 4, blockHeight: 4 },
    "bc3-rgba-unorm": { internalFormat: 0x83F3, format: 0x83F3, type: 0, blockSize: 16, blockWidth: 4, blockHeight: 4 },
    "bc4-r-unorm": { internalFormat: 0x8DBB, format: 0x8DBB, type: 0, blockSize: 8, blockWidth: 4, blockHeight: 4 },
    "bc5-rg-unorm": { internalFormat: 0x8DBC, format: 0x8DBC, type: 0, blockSize: 16, blockWidth: 4, blockHeight: 4 },
    "bc6h-rgb-ufloat": { internalFormat: 0x8E8F, format: 0x8E8F, type: 0, blockSize: 16, blockWidth: 4, blockHeight: 4 },
    "bc7-rgba-unorm": { internalFormat: 0x8E8C, format: 0x8E8C, type: 0, blockSize: 16, blockWidth: 4, blockHeight: 4 },
  };

  return mappings[format] ?? null;
}

/**
 * Returns a fallback format for WebGL2 when the requested format is not
 * available (e.g. no float render target support).
 */
export function getWebGL2FallbackFormat(format: TextureFormat): TextureFormat {
  switch (format) {
    case "rgba16float":
    case "rgba32float":
      return "rgba8unorm"; // Fallback to LDR
    case "rg16float":
    case "rg32float":
      return "rgba8unorm";
    case "r16float":
    case "r32float":
      return "rgba8unorm";
    case "bgra8unorm":
      return "rgba8unorm"; // WebGL2 doesn't natively support BGRA
    case "depth32float":
      return "depth24plus"; // More widely supported
    default:
      return format;
  }
}
