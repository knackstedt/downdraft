// ============================================================================
// enums.ts — WebGPU enum/string mappings and descriptor normalization
//
// All numeric values match the WebGPU C ABI (webgpu.h v29) that
// libdowndraft_platform implements — see native-rs/src/gpu/enums.rs for the
// same table on the Rust side. These are the single source of truth — do
// NOT duplicate them in native-surface.ts or elsewhere.
// ============================================================================

// ── Format name → WGPUTextureFormat (webgpu.h v29) ──
export const FORMAT_MAP: Record<string, number> = {
  "r8unorm": 0x01, "r8snorm": 0x02, "r8uint": 0x03, "r8sint": 0x04,
  "r16unorm": 0x05, "r16snorm": 0x06, "r16uint": 0x07, "r16sint": 0x08, "r16float": 0x09,
  "rg8unorm": 0x0A, "rg8snorm": 0x0B, "rg8uint": 0x0C, "rg8sint": 0x0D,
  "r32float": 0x0E, "r32uint": 0x0F, "r32sint": 0x10,
  "rg16unorm": 0x11, "rg16snorm": 0x12, "rg16uint": 0x13, "rg16sint": 0x14, "rg16float": 0x15,
  "rgba8unorm": 0x16, "rgba8unorm-srgb": 0x17, "rgba8snorm": 0x18, "rgba8uint": 0x19, "rgba8sint": 0x1A,
  "bgra8unorm": 0x1B, "bgra8unorm-srgb": 0x1C,
  "rgb10a2uint": 0x1D, "rgb10a2unorm": 0x1E, "rg11b10ufloat": 0x1F, "rgb9e5ufloat": 0x20,
  "rg32float": 0x21, "rg32uint": 0x22, "rg32sint": 0x23,
  "rgba16unorm": 0x24, "rgba16snorm": 0x25, "rgba16uint": 0x26, "rgba16sint": 0x27, "rgba16float": 0x28,
  "rgba32float": 0x29, "rgba32uint": 0x2A, "rgba32sint": 0x2B,
  "stencil8": 0x2C,
  "depth16unorm": 0x2D, "depth24plus": 0x2E, "depth24plus-stencil8": 0x2F,
  "depth32float": 0x30, "depth32float-stencil8": 0x31,
};

export function parseFormat(format: string): number {
  const v = FORMAT_MAP[format];
  if (v === undefined) throw new Error(`Unknown texture format: ${format}`);
  return v;
}

/** Reverse lookup: WGPUTextureFormat value → JS name. */
export function formatName(value: number): GPUTextureFormat {
  for (const [name, val] of Object.entries(FORMAT_MAP)) {
    if (val === value) return name as GPUTextureFormat;
  }
  return "bgra8unorm";
}

/** True for BGRA surface formats (byte order B,G,R,A in memory). */
export function isBGRAFormat(format: string | undefined | null): boolean {
  return format === "bgra8unorm" || format === "bgra8unorm-srgb";
}

// ── Vertex format → WGPUVertexFormat (webgpu.h v29) ──
const VERTEX_FORMAT_MAP: Record<string, number> = {
  "uint8": 0x01, "uint8x2": 0x02, "uint8x4": 0x03,
  "sint8": 0x04, "sint8x2": 0x05, "sint8x4": 0x06,
  "unorm8": 0x07, "unorm8x2": 0x08, "unorm8x4": 0x09,
  "snorm8": 0x0A, "snorm8x2": 0x0B, "snorm8x4": 0x0C,
  "uint16": 0x0D, "uint16x2": 0x0E, "uint16x4": 0x0F,
  "sint16": 0x10, "sint16x2": 0x11, "sint16x4": 0x12,
  "unorm16": 0x13, "unorm16x2": 0x14, "unorm16x4": 0x15,
  "snorm16": 0x16, "snorm16x2": 0x17, "snorm16x4": 0x18,
  "float16": 0x19, "float16x2": 0x1A, "float16x4": 0x1B,
  "float32": 0x1C, "float32x2": 0x1D, "float32x3": 0x1E, "float32x4": 0x1F,
  "uint32": 0x20, "uint32x2": 0x21, "uint32x3": 0x22, "uint32x4": 0x23,
  "sint32": 0x24, "sint32x2": 0x25, "sint32x3": 0x26, "sint32x4": 0x27,
  "unorm10-10-10-2": 0x28,
  "unorm8x4-bgra": 0x29,
};

export function parseVertexFormat(format: string): number {
  const v = VERTEX_FORMAT_MAP[format];
  if (v === undefined) throw new Error(`Unknown vertex format: ${format}`);
  return v;
}

// ── WGPUFeatureName ↔ JS feature-name strings ──
export const FEATURE_NAME_MAP: Record<number, string> = {
  0x00000001: "core-features-and-limits",
  0x00000002: "depth-clip-control",
  0x00000003: "depth32float-stencil8",
  0x00000004: "texture-compression-bc",
  0x00000005: "texture-compression-bc-sliced-3d",
  0x00000006: "texture-compression-etc2",
  0x00000007: "texture-compression-astc",
  0x00000008: "texture-compression-astc-sliced-3d",
  0x00000009: "timestamp-query",
  0x0000000A: "indirect-first-instance",
  0x0000000B: "shader-f16",
  0x0000000C: "rg11b10ufloat-renderable",
  0x0000000D: "bgra8unorm-storage",
  0x0000000E: "float32-filterable",
  0x0000000F: "float32-blendable",
  0x00000010: "clip-distances",
  0x00000011: "dual-source-blending",
  0x00000012: "subgroups",
  0x00000013: "texture-formats-tier1",
  0x00000014: "texture-formats-tier2",
  0x00000015: "primitive-index",
  0x00000016: "texture-component-swizzle",
  // wgpu-extension features (FeaturesWGPU bits) — high wire ids that can't
  // collide with future WGPUFeatureName values.
  0x80000001: "timestamp-query-inside-encoders",
  0x80000002: "timestamp-query-inside-passes",
};

export const FEATURE_VALUE_MAP: Record<string, number> = Object.fromEntries(
  Object.entries(FEATURE_NAME_MAP).map(([v, name]) => [name, Number(v)]),
);

// ── Compare / stencil / blend enum parsers ──
export function parseCompare(c?: string): number {
  switch (c) {
    case "never": return 1;
    case "less": return 2;
    case "equal": return 3;
    case "less-equal": return 4;
    case "greater": return 5;
    case "not-equal": return 6;
    case "greater-equal": return 7;
    case "always": return 8;
    default: return 0; // undefined
  }
}

export function parseStencilOp(op?: string): number {
  switch (op) {
    case "keep": return 1;
    case "zero": return 2;
    case "replace": return 3;
    case "invert": return 4;
    case "increment-clamp": return 5;
    case "decrement-clamp": return 6;
    case "increment-wrap": return 7;
    case "decrement-wrap": return 8;
    default: return 0;
  }
}

export function parseBlendFactor(f?: string): number {
  switch (f) {
    case "zero": return 1;
    case "one": return 2;
    case "src": return 3;
    case "one-minus-src": return 4;
    case "src-alpha": return 5;
    case "one-minus-src-alpha": return 6;
    case "dst": return 7;
    case "one-minus-dst": return 8;
    case "dst-alpha": return 9;
    case "one-minus-dst-alpha": return 10;
    case "src-alpha-saturated": return 11;
    case "constant": return 12;
    case "one-minus-constant": return 13;
    case "src1": return 14;
    case "one-minus-src1": return 15;
    case "src1-alpha": return 16;
    case "one-minus-src1-alpha": return 17;
    default: return 0;
  }
}

export function parseBlendOp(op?: string): number {
  switch (op) {
    case "add": return 1;
    case "subtract": return 2;
    case "reverse-subtract": return 3;
    case "min": return 4;
    case "max": return 5;
    default: return 0;
  }
}

// ── Texture aspect / view dimension / texture dimension ──
// WGPUTextureAspect: All=1, StencilOnly=2, DepthOnly=3
export function parseAspect(aspect?: string): number {
  return aspect === "stencil-only" ? 2 : aspect === "depth-only" ? 3 : 1;
}

// WGPUTextureViewDimension: 1D=1, 2D=2, 2DArray=3, Cube=4, CubeArray=5, 3D=6
export function parseViewDimension(dim?: string): number {
  switch (dim) {
    case "1d": return 1;
    case "2d": return 2;
    case "2d-array": return 3;
    case "cube": return 4;
    case "cube-array": return 5;
    case "3d": return 6;
    default: return 0; // undefined → auto
  }
}

// WGPUTextureDimension: 1D=1, 2D=2, 3D=3 (0=Undefined → defaults to 2D)
export function parseTextureDimension(dim?: string): number {
  return dim === "1d" ? 1 : dim === "3d" ? 3 : dim === "2d" ? 2 : 0;
}

// ── GPUExtent3D / GPUOrigin3D normalization ──
// These unions accept a number, [x,y,z] array, or a dict. Normalize to a dict.

export interface Extent3D { width: number; height: number; depthOrArrayLayers: number; }
export interface Origin3D { x: number; y: number; z: number; }

export function parseExtent3D(size: GPUExtent3D | number): Extent3D {
  if (typeof size === "number") return { width: size, height: 1, depthOrArrayLayers: 1 };
  if (Array.isArray(size)) {
    return { width: size[0] ?? 1, height: size[1] ?? 1, depthOrArrayLayers: size[2] ?? 1 };
  }
  const d = size as { width: number; height?: number; depthOrArrayLayers?: number };
  return { width: d.width, height: d.height ?? 1, depthOrArrayLayers: d.depthOrArrayLayers ?? 1 };
}

export function parseOrigin3D(origin?: GPUOrigin3D | number): Origin3D {
  if (origin === undefined) return { x: 0, y: 0, z: 0 };
  if (typeof origin === "number") return { x: origin, y: 0, z: 0 };
  if (Array.isArray(origin)) return { x: origin[0] ?? 0, y: origin[1] ?? 0, z: origin[2] ?? 0 };
  const d = origin as { x?: number; y?: number; z?: number };
  return { x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 };
}

// ── WGPULimits field order ──
// Must stay in sync with the limit read/write logic in native-rs/src/gpu/.
export const LIMIT_FIELD_INDEX: Record<string, number> = {
  maxTextureDimension1D: 0,
  maxTextureDimension2D: 1,
  maxTextureDimension3D: 2,
  maxTextureArrayLayers: 3,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 5,
  maxBindingsPerBindGroup: 6,
  maxDynamicUniformBuffersPerPipelineLayout: 7,
  maxDynamicStorageBuffersPerPipelineLayout: 8,
  maxSampledTexturesPerShaderStage: 9,
  maxSamplersPerShaderStage: 10,
  maxStorageBuffersPerShaderStage: 11,
  maxStorageTexturesPerShaderStage: 12,
  maxUniformBuffersPerShaderStage: 13,
  maxUniformBufferBindingSize: 14,       // u64
  maxStorageBufferBindingSize: 15,       // u64
  minUniformBufferOffsetAlignment: 16,
  minStorageBufferOffsetAlignment: 17,
  maxVertexBuffers: 18,
  maxBufferSize: 19,                      // u64
  maxVertexAttributes: 20,
  maxVertexBufferArrayStride: 21,
  maxInterStageShaderVariables: 22,
  maxColorAttachments: 23,
  maxColorAttachmentBytesPerSample: 24,
  maxComputeWorkgroupStorageSize: 25,
  maxComputeInvocationsPerWorkgroup: 26,
  maxComputeWorkgroupSizeX: 27,
  maxComputeWorkgroupSizeY: 28,
  maxComputeWorkgroupSizeZ: 29,
  maxComputeWorkgroupsPerDimension: 30,
  maxImmediateSize: 31,
};
