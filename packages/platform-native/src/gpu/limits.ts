// ============================================================================
// limits.ts — WGPULimits / WGPUSupportedFeatures query + serialization
//
// queryNativeLimits reads the WGPULimits struct out of the shim by its C
// layout (nextInChain pointer then fields in declaration order). The result
// is cached by callers (adapter/device) — limits never change for the life
// of the object.
//
// serializeRequiredLimits/Features convert a GPUDeviceDescriptor into the
// flat arrays the shim's wgpu_shim_request_device expects.
// ============================================================================

import type { ptr } from "../ffi/ffi-adapter";
import { FEATURE_NAME_MAP, FEATURE_VALUE_MAP, LIMIT_FIELD_INDEX } from "./enums";
import { wgpu } from "./wgpu-ffi";

// WGPULimits field order within the struct (after the 8-byte nextInChain
// pointer). u64 fields occupy two u32 slots. u32 index → JS name.
const LIMIT_READ_ORDER: (string | null)[] = [
  "maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D",
  "maxTextureArrayLayers", "maxBindGroups", "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup", "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout", "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage", "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize", null,          // u64: u32[14-15]
  "maxStorageBufferBindingSize", null,          // u64: u32[16-17]
  "minUniformBufferOffsetAlignment", "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  null,                                          // padding before u64
  "maxBufferSize", null,                         // u64: u32[22-23]
  "maxVertexAttributes", "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables", "maxColorAttachments",
  "maxColorAttachmentBytesPerSample", "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension", "maxImmediateSize",
];

/** Query real limits from an adapter or device pointer. Cached per call site. */
export function queryNativeLimits(nativePtr: ptr, isDevice: boolean): GPUSupportedLimits {
  const buf = new Uint8Array(256);
  const status = isDevice
    ? wgpu.wgpu_shim_device_get_limits(nativePtr, buf as any)
    : wgpu.wgpu_shim_adapter_get_limits(nativePtr, buf as any);
  if (status !== 0) {
    return nativeDesktopLimits();
  }
  // Skip the 8-byte nextInChain pointer — read u32s starting at byte offset 8.
  const u32 = new Uint32Array(buf.buffer, 8, (256 - 8) / 4);
  const limits: Record<string, number | bigint> = {};
  for (let i = 0; i < LIMIT_READ_ORDER.length; i++) {
    const name = LIMIT_READ_ORDER[i];
    if (!name) continue;
    if (name === "maxUniformBufferBindingSize" || name === "maxStorageBufferBindingSize" || name === "maxBufferSize") {
      limits[name] = BigInt(u32[i]) | (BigInt(u32[i + 1]) << 32n);
    } else {
      limits[name] = u32[i];
    }
  }
  // WGPU_LIMIT_U32_UNDEFINED (0xFFFFFFFF) fields → sane defaults so engine
  // code doesn't multiply by 4 billion.
  if (limits.maxBufferSize === 0n || limits.maxBufferSize === 0xFFFFFFFFFFFFFFFFn) {
    limits.maxBufferSize = BigInt(limits.maxStorageBufferBindingSize as bigint);
  }
  return limits as unknown as GPUSupportedLimits;
}

/** Query real features from an adapter or device pointer. */
export function queryNativeFeatures(nativePtr: ptr, isDevice: boolean): GPUSupportedFeatures {
  const maxCount = 64;
  const featBuf = new Uint32Array(maxCount);
  const count = isDevice
    ? wgpu.wgpu_shim_device_get_features(nativePtr, featBuf as any, maxCount)
    : wgpu.wgpu_shim_adapter_get_features(nativePtr, featBuf as any, maxCount);
  const features = new Set<string>();
  for (let i = 0; i < count && i < maxCount; i++) {
    const name = FEATURE_NAME_MAP[featBuf[i]];
    if (name) features.add(name);
  }
  return features as unknown as GPUSupportedFeatures;
}

/**
 * Serialize descriptor.requiredLimits into the flat (index, lo32, hi32)
 * triple array the shim expects.
 */
export function serializeRequiredLimits(requiredLimits?: Record<string, number | bigint | undefined>): Uint32Array {
  if (!requiredLimits) return new Uint32Array(0);
  const entries: number[] = [];
  for (const [name, value] of Object.entries(requiredLimits)) {
    if (value === undefined) continue;
    const idx = LIMIT_FIELD_INDEX[name];
    if (idx === undefined) {
      throw new Error(`requestDevice: unknown limit "${name}"`);
    }
    const v = BigInt(value);
    entries.push(idx, Number(v & 0xFFFFFFFFn), Number((v >> 32n) & 0xFFFFFFFFn));
  }
  return new Uint32Array(entries);
}

/**
 * Serialize descriptor.requiredFeatures into a u32 array of WGPUFeatureName
 * values. Throws on a feature name this wgpu-native build can't express.
 */
export function serializeRequiredFeatures(requiredFeatures?: Iterable<string>): Uint32Array {
  if (!requiredFeatures) return new Uint32Array(0);
  const values: number[] = [];
  // oxlint-disable-next-line downdraft/no-for-of -- iterates Iterable<string>; for..of required
  for (const name of requiredFeatures) {
    const v = FEATURE_VALUE_MAP[name];
    if (v === undefined) {
      throw new Error(`requestDevice: unknown/unsupported feature "${name}"`);
    }
    values.push(v);
  }
  return new Uint32Array(values);
}

/** Conservative desktop defaults — only used when the native query fails. */
function nativeDesktopLimits(): GPUSupportedLimits {
  const limits = {
    maxTextureDimension1D: 8192,
    maxTextureDimension2D: 8192,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 256,
    maxBindGroups: 8,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageBuffersInVertexStage: 8,
    maxStorageBuffersInFragmentStage: 8,
    maxStorageTexturesPerShaderStage: 4,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 16384,
    maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 268435456,
    maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderVariables: 16,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 16384,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
  };
  return { ...limits, min: {}, max: limits } as unknown as GPUSupportedLimits;
}
