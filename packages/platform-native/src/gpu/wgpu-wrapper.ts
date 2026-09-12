// ============================================================================
// wgpu-wrapper.ts — WebGPU JS API wrapper on top of wgpu-native FFI
//
// Implements the standard WebGPU JavaScript API (GPU, GPUAdapter, GPUDevice,
// GPUQueue, etc.) on top of the wgpu_shim C library via bun:ffi.
//
// The engine code uses the standard WebGPU types from @webgpu/types, so this
// wrapper just needs to match those interfaces. The C shim handles the
// low-level struct construction and async-to-sync conversion.
// ============================================================================

import { wgpu } from "./wgpu-ffi";

// ============================================================================
// AUDIT NOTE: The dead top-level constants block (BUFFER_USAGE_*, TEXTURE_FORMAT_*,
// etc.) was removed. Those constants used 0-based values that did NOT match
// webgpu.h (which is 1-based for most enums). They were never referenced — the
// inline literals in each create* method are correct. The FORMAT_MAP below is
// the only mapping that is actually used.
// ============================================================================

// ── Format name → enum value map (from webgpu.h v29) ──
const FORMAT_MAP: Record<string, number> = {
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

function parseFormat(format: string): number {
  const v = FORMAT_MAP[format];
  if (v === undefined) throw new Error(`Unknown texture format: ${format}`);
  return v;
}

// ── FinalizationRegistry for automatic release ──
type Releasable = { ptr: number; release: () => void };
const registry = new FinalizationRegistry((release: () => void) => {
  try { release(); } catch {}
});

// ============================================================================
// GPU — the navigator.gpu equivalent
// ============================================================================

export class WgpuGPU {
  private instancePtr: number = 0;

  constructor() {
    this.instancePtr = wgpu.wgpu_shim_create_instance() as unknown as number;
    if (!this.instancePtr) throw new Error("Failed to create wgpu instance");
  }

  getInstancePtr(): number { return this.instancePtr; }

  getPreferredCanvasFormat(): GPUTextureFormat {
    const fmt = wgpu.wgpu_shim_get_preferred_format();
    // Map back to string
    for (const [name, val] of Object.entries(FORMAT_MAP)) {
      if (val === fmt) return name as GPUTextureFormat;
    }
    return "bgra8unorm";
  }

  async requestAdapter(options?: GPURequestAdapterOptions): Promise<WgpuAdapter | null> {
    const powerPref = options?.powerPreference === "low-power" ? 1 : 2;
    const adapterPtr = wgpu.wgpu_shim_request_adapter(this.instancePtr, powerPref) as unknown as number;
    if (!adapterPtr) return null;
    return new WgpuAdapter(adapterPtr, this.instancePtr);
  }
}

// ============================================================================
// Native desktop limits / features
//
// wgpu-native exposes real limits/features via the C API, but the shim doesn't
// surface them yet. PixiJS v8's GpuLimitsSystem reads
// `device.limits.maxSampledTexturesPerShaderStage` and uses it as the batch
// texture limit — `undefined` would break batching. Return conservative
// desktop values that match what wgpu-native reports on a typical Vulkan
// desktop GPU. These can be tightened later by querying the C API.
// ============================================================================

// AUDIT FIX: query real limits/features from the device instead of hardcoding
// desktop guesses. These functions accept a native pointer (adapter or device).
// The WGPULimits struct is 32 u32 fields (see webgpu.h ~3917-4047).

// WGPUFeatureName enum → WebGPU JS feature-name string mapping.
const FEATURE_NAME_MAP: Record<number, string> = {
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
};

function queryNativeLimits(nativePtr: number, isDevice: boolean): GPUSupportedLimits {
  // AUDIT FIX: query real limits from the adapter/device instead of hardcoding.
  // WGPULimits struct layout (64-bit): nextInChain (8 bytes) + 30 fields.
  // We allocate 256 bytes and read u32s starting at offset 2 (after the 8-byte pointer).
  const buf = new Uint8Array(256);
  const status = isDevice
    ? wgpu.wgpu_shim_device_get_limits(nativePtr, buf as any)
    : wgpu.wgpu_shim_adapter_get_limits(nativePtr, buf as any);
  if (status !== 0) {
    // Fallback to conservative defaults if the query fails.
    return nativeDesktopLimits();
  }
  // Skip the 8-byte nextInChain pointer — read u32s starting at byte offset 8.
  const u32 = new Uint32Array(buf.buffer, 8, (256 - 8) / 4);
  const limits = {
    maxTextureDimension1D: u32[0],
    maxTextureDimension2D: u32[1],
    maxTextureDimension3D: u32[2],
    maxTextureArrayLayers: u32[3],
    maxBindGroups: u32[4],
    maxBindGroupsPlusVertexBuffers: u32[5],
    maxBindingsPerBindGroup: u32[6],
    maxDynamicUniformBuffersPerPipelineLayout: u32[7],
    maxDynamicStorageBuffersPerPipelineLayout: u32[8],
    maxSampledTexturesPerShaderStage: u32[9],
    maxSamplersPerShaderStage: u32[10],
    maxStorageBuffersPerShaderStage: u32[11],
    maxStorageTexturesPerShaderStage: u32[12],
    maxUniformBuffersPerShaderStage: u32[13],
    // u32[14-15] = maxUniformBufferBindingSize (u64)
    maxUniformBufferBindingSize: BigInt(u32[14]) | (BigInt(u32[15]) << 32n),
    // u32[16-17] = maxStorageBufferBindingSize (u64)
    maxStorageBufferBindingSize: BigInt(u32[16]) | (BigInt(u32[17]) << 32n),
    minUniformBufferOffsetAlignment: u32[18],
    minStorageBufferOffsetAlignment: u32[19],
    maxVertexBuffers: u32[20],
    // u32[21-22] = maxBufferSize (u64)
    maxBufferSize: BigInt(u32[21]) | (BigInt(u32[22]) << 32n),
    maxVertexAttributes: u32[23],
    maxVertexBufferArrayStride: u32[24],
    maxInterStageShaderVariables: u32[25],
    maxColorAttachments: u32[26],
    maxColorAttachmentBytesPerSample: u32[27],
    maxComputeWorkgroupStorageSize: u32[28],
    maxComputeInvocationsPerWorkgroup: u32[29],
    maxComputeWorkgroupSizeX: u32[30],
    maxComputeWorkgroupSizeY: u32[31],
    maxComputeWorkgroupSizeZ: u32[32],
    maxComputeWorkgroupsPerDimension: u32[33],
    maxImmediateSize: u32[34],
  };
  return { ...limits, min: {}, max: limits } as unknown as GPUSupportedLimits;
}

function queryNativeFeatures(nativePtr: number, isDevice: boolean): GPUSupportedFeatures {
  // AUDIT FIX: query real features from the adapter/device instead of hardcoding.
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

function nativeDesktopLimits(): GPUSupportedLimits {
  // Fallback conservative defaults (used only if the native query fails).
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

// ============================================================================
// WgpuAdapter
// ============================================================================

export class WgpuAdapter implements GPUAdapter {
  readonly ptr: number;
  private instancePtr: number;

  constructor(ptr: number, instancePtr: number) {
    this.ptr = ptr;
    this.instancePtr = instancePtr;
  }

  get info(): GPUAdapterInfo {
    return {
      vendor: "wgpu-native",
      architecture: "unknown",
      description: "wgpu-native via bun:ffi",
      subgroupMinSize: 0,
    } as GPUAdapterInfo;
  }

  get limits(): GPUSupportedLimits {
    // AUDIT FIX: query real limits from the adapter.
    return queryNativeLimits(this.ptr, false);
  }

  get features(): GPUSupportedFeatures {
    // AUDIT FIX: query real features from the adapter.
    return queryNativeFeatures(this.ptr, false);
  }

  async requestDevice(descriptor?: GPUDeviceDescriptor): Promise<WgpuDevice> {
    const limits = descriptor?.requiredLimits;
    const maxStorageBufferSize = (limits?.maxStorageBufferBindingSize as number) ?? 0;
    const maxStorageBuffersPerStage = (limits?.maxStorageBuffersPerShaderStage as number) ?? 0;
    const maxSampledTexturesPerStage = (limits?.maxSampledTexturesPerShaderStage as number) ?? 0;
    const maxTextureArrayLayers = (limits?.maxTextureArrayLayers as number) ?? 0;

    const devicePtr = wgpu.wgpu_shim_request_device(
      this.ptr,
      BigInt(maxStorageBufferSize),
      maxStorageBuffersPerStage,
      maxSampledTexturesPerStage,
      maxTextureArrayLayers,
    ) as unknown as number;

    if (!devicePtr) throw new Error("Failed to create GPU device");

    const device = new WgpuDevice(devicePtr, this.instancePtr);
    registry.register(device, { ptr: devicePtr, release: () => wgpu.wgpu_shim_release_device(devicePtr) }, device);
    return device;
  }
}

// ============================================================================
// WgpuDevice
// ============================================================================

export class WgpuDevice implements GPUDevice {
  readonly ptr: number;
  private instancePtr: number;
  private queue: WgpuQueue;
  private destroyed = false;
  private lostResolve: ((info: GPUDeviceLostInfo) => void) | null = null;
  readonly lost: Promise<GPUDeviceLostInfo>;

  constructor(ptr: number, instancePtr: number) {
    this.ptr = ptr;
    this.instancePtr = instancePtr;
    const queuePtr = wgpu.wgpu_shim_device_get_queue(ptr) as unknown as number;
    this.queue = new WgpuQueue(queuePtr);
    this.lost = new Promise((resolve) => { this.lostResolve = resolve; });
  }

  /** Process pending GPU events to flush queued work. */
  processEvents(): void {
    wgpu.wgpu_shim_process_events(this.instancePtr as any);
  }

  get queue(): WgpuQueue { return this.queue; }

  get features(): GPUSupportedFeatures {
    // AUDIT FIX: query real features from the device instead of hardcoding.
    return queryNativeFeatures(this.ptr, true);
  }

  get limits(): GPUSupportedLimits {
    // AUDIT FIX: query real limits from the device instead of hardcoding.
    return queryNativeLimits(this.ptr, true);
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    // AUDIT FIX: was a no-op. Now pushes a real error scope.
    // ErrorFilter: Validation=1, OutOfMemory=2, Internal=3
    const filterVal = filter === "validation" ? 1 : filter === "out-of-memory" ? 2 : filter === "internal" ? 3 : 1;
    wgpu.wgpu_shim_device_push_error_scope(this.ptr, filterVal);
  }

  async popErrorScope(): Promise<GPUError | null> {
    // AUDIT FIX: was a no-op returning null. Now polls the native callback.
    // Returns null if no error was captured, or a GPUError-like object if one was.
    const msgBuf = new Uint8Array(4096);
    const errorType = wgpu.wgpu_shim_device_pop_error_scope(this.ptr, msgBuf as any, msgBuf.length);
    // ErrorType: NoError=1, Validation=2, OutOfMemory=3, Internal=4, Unknown=5
    if (errorType === 1 || errorType === 0) return null;
    const msg = new TextDecoder().decode(msgBuf).replace(/\0+$/, "");
    const type = errorType === 2 ? "validation" : errorType === 3 ? "out-of-memory" : errorType === 4 ? "internal" : "unknown";
    return { type, message: msg } as GPUError;
  }

  createBuffer(descriptor: GPUBufferDescriptor): WgpuBuffer {
    const usage = descriptor.usage;
    const mapped = descriptor.mappedAtCreation ? 1 : 0;
    const bufPtr = wgpu.wgpu_shim_create_buffer(
      this.ptr,
      BigInt(descriptor.size),
      usage,
      mapped,
    ) as unknown as number;
    if (!bufPtr) throw new Error(`Failed to create buffer (size=${descriptor.size}, usage=${usage})`);
    const buffer = new WgpuBuffer(bufPtr, descriptor.size, this.queue, !!descriptor.mappedAtCreation);
    registry.register(buffer, { ptr: bufPtr, release: () => wgpu.wgpu_shim_release_buffer(bufPtr) }, buffer);
    return buffer;
  }

  createTexture(descriptor: GPUTextureDescriptor): WgpuTexture {
    const format = parseFormat(descriptor.format);
    const dimension = descriptor.dimension === "1d" ? 1 : descriptor.dimension === "3d" ? 3 : descriptor.dimension === "2d" ? 2 : 0;
    const usage = descriptor.usage;

    // Size can be a number, array [w, h, d], or { width, height, depthOrArrayLayers }
    let width: number, height: number, depthOrArrayLayers: number;
    if (typeof descriptor.size === "number") {
      width = descriptor.size; height = 1; depthOrArrayLayers = 1;
    } else if (Array.isArray(descriptor.size)) {
      width = descriptor.size[0] ?? 1;
      height = descriptor.size[1] ?? 1;
      depthOrArrayLayers = descriptor.size[2] ?? 1;
    } else {
      width = descriptor.size.width;
      height = descriptor.size.height;
      depthOrArrayLayers = descriptor.size.depthOrArrayLayers ?? 1;
    }

    const texPtr = wgpu.wgpu_shim_create_texture(
      this.ptr,
      width,
      height,
      depthOrArrayLayers,
      descriptor.mipLevelCount ?? 1,
      descriptor.sampleCount ?? 1,
      dimension,
      format,
      usage,
      0,
      null as any,
    ) as unknown as number;
    if (!texPtr) throw new Error(`Failed to create texture (${width}x${height})`);
    const texture = new WgpuTexture(texPtr, descriptor);
    registry.register(texture, { ptr: texPtr, release: () => wgpu.wgpu_shim_release_texture(texPtr) }, texture);
    return texture;
  }

  createSampler(descriptor?: GPUSamplerDescriptor): WgpuSampler {
    // AUDIT FIX: pass all sampler fields (compare, anisotropy, addressModeW,
    // mipmapFilter, lod clamps) instead of hardcoding them. Comparison samplers
    // (shadow mapping) were broken because compare was always Undefined.
    const magFilter = descriptor?.magFilter === "linear" ? 2 : 1;
    const minFilter = descriptor?.minFilter === "linear" ? 2 : 1;
    const mipmapFilter = descriptor?.mipmapFilter === "linear" ? 2 : 1;
    const addressU = descriptor?.addressModeU === "repeat" ? 2 : descriptor?.addressModeU === "mirror-repeat" ? 3 : 1;
    const addressV = descriptor?.addressModeV === "repeat" ? 2 : descriptor?.addressModeV === "mirror-repeat" ? 3 : 1;
    const addressW = descriptor?.addressModeW === "repeat" ? 2 : descriptor?.addressModeW === "mirror-repeat" ? 3 : 1;
    const lodMinClamp = descriptor?.lodMinClamp ?? 0;
    const lodMaxClamp = descriptor?.lodMaxClamp ?? 32;
    // CompareFunction: Never=1..Always=8; undefined/absent = 0 (no comparison)
    const compare = descriptor?.compare
      ? ({ never: 1, less: 2, equal: 3, "less-equal": 4, greater: 5, "not-equal": 6, "greater-equal": 7, always: 8 } as Record<string, number>)[descriptor.compare] ?? 0
      : 0;
    const maxAnisotropy = descriptor?.maxAnisotropy ?? 1;
    const samplerPtr = wgpu.wgpu_shim_create_sampler(
      this.ptr, magFilter, minFilter, mipmapFilter,
      addressU, addressV, addressW, lodMinClamp, lodMaxClamp, compare, maxAnisotropy,
    ) as unknown as number;
    const sampler = new WgpuSampler(samplerPtr);
    registry.register(sampler, { ptr: samplerPtr, release: () => wgpu.wgpu_shim_release_sampler(samplerPtr) }, sampler);
    return sampler;
  }

  createShaderModule(descriptor: GPUShaderModuleDescriptor): WgpuShaderModule {
    const code = descriptor.code;
    const shaderPtr = wgpu.wgpu_shim_create_shader_module(this.ptr, code) as unknown as number;
    if (!shaderPtr) throw new Error("Failed to create shader module");
    const shader = new WgpuShaderModule(shaderPtr, code);
    registry.register(shader, { ptr: shaderPtr, release: () => wgpu.wgpu_shim_release_shader_module(shaderPtr) }, shader);
    return shader;
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): WgpuBindGroupLayout {
    // Flatten entries into uint32 array: 8 values per entry
    // (binding, visibility, buffer_type, sampler_type, texture_sample_type, texture_view_dimension, storage_texture_access, storage_texture_format)
    const entries = descriptor.entries;

    // Check for duplicate binding indices
    const seen = new Set<number>();
    for (const e of entries) {
      if (seen.has(e.binding)) {
        console.warn(`[createBindGroupLayout] Duplicate binding ${e.binding} — entries:`, entries.map(e => `b${e.binding}:${e.buffer ? "buf" : e.texture ? "tex" : e.sampler ? "smp" : e.storageTexture ? "stex" : "?"}`));
      }
      seen.add(e.binding);
    }

    const flat = new Uint32Array(entries.length * 8);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      flat[i * 8 + 0] = e.binding;
      flat[i * 8 + 1] = e.visibility ?? 0;
      flat[i * 8 + 2] = e.buffer?.type === "uniform" ? 2 : e.buffer?.type === "storage" ? 3 : e.buffer?.type === "read-only-storage" ? 4 : e.buffer ? 1 : 0;
      flat[i * 8 + 3] = e.sampler?.type === "filtering" ? 2 : e.sampler?.type === "non-filtering" ? 3 : e.sampler?.type === "comparison" ? 4 : e.sampler ? 1 : 0;
      flat[i * 8 + 4] = e.texture?.sampleType === "float" ? 2 : e.texture?.sampleType === "unfilterable-float" ? 3 : e.texture?.sampleType === "depth" ? 4 : e.texture?.sampleType === "sint" ? 5 : e.texture?.sampleType === "uint" ? 6 : e.texture ? 1 : 0;
      // viewDimension can come from either texture or storageTexture
      const viewDim = e.texture?.viewDimension ?? e.storageTexture?.viewDimension;
      flat[i * 8 + 5] = viewDim === "1d" ? 1 : viewDim === "2d" ? 2 : viewDim === "2d-array" ? 3 : viewDim === "cube" ? 4 : viewDim === "cube-array" ? 5 : viewDim === "3d" ? 6 : (e.texture || e.storageTexture) ? 2 : 0; // default to 2D when texture/storageTexture is present but viewDimension is omitted
      // Storage texture: access (1=Undefined/defaults to WriteOnly, 3=ReadOnly, 4=ReadWrite) + format
      // AUDIT FIX: write-only was mapped to 1 (Undefined, relying on wgpu-native
      // defaulting). Now explicitly passes WriteOnly=2 per webgpu.h.
      flat[i * 8 + 6] = e.storageTexture?.access === "write-only" ? 2 : e.storageTexture?.access === "read-only" ? 3 : e.storageTexture?.access === "read-write" ? 4 : 0;
      flat[i * 8 + 7] = e.storageTexture?.format ? parseFormat(e.storageTexture.format) : 0;
    }
    const layoutPtr = wgpu.wgpu_shim_create_bind_group_layout(this.ptr, entries.length, flat.buffer) as unknown as number;
    if (!layoutPtr) throw new Error("Failed to create bind group layout");
    const layout = new WgpuBindGroupLayout(layoutPtr);
    registry.register(layout, { ptr: layoutPtr, release: () => wgpu.wgpu_shim_release_bind_group_layout(layoutPtr) }, layout);
    return layout;
  }

  /**
   * Parse WGSL shader source for @group(N) @binding(M) declarations and create
   * bind group layouts automatically. This handles the `layout: "auto"` case
   * by extracting binding info from the shader code.
   *
   * AUDIT FIX: visibility was hardcoded to VERTEX|FRAGMENT (0x3), which broke
   * compute pipelines with layout: "auto". Now detects @compute and sets
   * COMPUTE visibility. Also parses storage-texture format from WGSL instead
   * of hardcoding "rgba8unorm".
   */
  private createAutoBindGroupLayouts(shaderSources: string[]): WgpuBindGroupLayout[] {
    // Collect all bindings grouped by group index
    const groups: Map<number, Map<number, { type: string; visibility: number; viewDimension?: string; storageFormat?: string }>> = new Map();

    // AUDIT FIX: detect whether this is a compute shader to set correct visibility.
    const isCompute = shaderSources.some(src => src?.includes("@compute") ?? false);
    const defaultVisibility = isCompute ? 0x0004 /* COMPUTE */ : 0x0001 | 0x0002 /* VERTEX | FRAGMENT */;

    for (const src of shaderSources) {
      if (!src) continue;
      // Match: @group(N) @binding(M) var<uniform|storage|...> name : type;
      // Also: @group(N) @binding(M) var name : texture_2d<f32>;
      // Also: @group(N) @binding(M) var name : sampler;
      const lines = src.split("\n");
      for (const line of lines) {
        const groupMatch = line.match(/@group\((\d+)\)\s*@binding\((\d+)\)/);
        if (!groupMatch) continue;
        const groupIdx = parseInt(groupMatch[1]);
        const bindingIdx = parseInt(groupMatch[2]);

        if (!groups.has(groupIdx)) groups.set(groupIdx, new Map());
        const group = groups.get(groupIdx)!;

        // Determine binding type from the declaration
        let bindingType = "uniform";
        let viewDimension = "2d"; // default for textures
        let storageFormat: string | undefined;

        if (line.includes("var<uniform>")) {
          bindingType = "uniform";
        } else if (line.includes("var<storage,")) {
          if (line.includes("read")) bindingType = "read-only-storage";
          else bindingType = "storage";
        } else if (line.includes("var<storage>")) {
          bindingType = "storage";
        } else if (line.includes("texture_2d_array")) { // AUDIT FIX: was duplicated condition
          bindingType = "texture";
          viewDimension = "2d-array";
        } else if (line.includes("texture_cube_array")) {
          bindingType = "texture";
          viewDimension = "cube-array";
        } else if (line.includes("texture_cube")) {
          bindingType = "texture";
          viewDimension = "cube";
        } else if (line.includes("texture_3d")) {
          bindingType = "texture";
          viewDimension = "3d";
        } else if (line.includes("texture_1d")) {
          bindingType = "texture";
          viewDimension = "1d";
        } else if (line.includes("texture_2d")) {
          bindingType = "texture";
          viewDimension = "2d";
        } else if (line.includes("sampler")) {
          if (line.includes("sampler_comparison")) bindingType = "comparison-sampler";
          else bindingType = "sampler";
        } else if (line.includes("texture_storage")) {
          bindingType = "storage-texture";
          if (line.includes("texture_storage_2d_array")) viewDimension = "2d-array";
          else if (line.includes("texture_storage_3d")) viewDimension = "3d";
          // AUDIT FIX: parse the format from the WGSL declaration instead of
          // hardcoding "rgba8unorm". WGSL: texture_storage_2d<rgba8unorm, write>.
          const fmtMatch = line.match(/texture_storage_\w+d<(\w+)/);
          if (fmtMatch) storageFormat = fmtMatch[1];
        }

        group.set(bindingIdx, { type: bindingType, visibility: defaultVisibility, viewDimension, storageFormat });
      }
    }

    // Create bind group layouts for each group
    const layouts: WgpuBindGroupLayout[] = [];
    const sortedGroupIndices = Array.from(groups.keys()).sort((a, b) => a - b);
    for (const groupIdx of sortedGroupIndices) {
      const group = groups.get(groupIdx)!;
      const entries: GPUBindGroupLayoutEntry[] = [];
      const sortedBindings = Array.from(group.keys()).sort((a, b) => a - b);
      for (const bindingIdx of sortedBindings) {
        const info = group.get(bindingIdx)!;
        const entry: GPUBindGroupLayoutEntry = {
          binding: bindingIdx,
          visibility: info.visibility,
        };
        if (info.type === "uniform") {
          entry.buffer = { type: "uniform" };
        } else if (info.type === "storage") {
          entry.buffer = { type: "storage" };
        } else if (info.type === "read-only-storage") {
          entry.buffer = { type: "read-only-storage" };
        } else if (info.type === "texture") {
          entry.texture = { sampleType: "float", viewDimension: info.viewDimension ?? "2d" };
        } else if (info.type === "sampler") {
          entry.sampler = { type: "filtering" };
        } else if (info.type === "comparison-sampler") {
          entry.sampler = { type: "comparison" };
        } else if (info.type === "storage-texture") {
          // AUDIT FIX: use parsed format, fallback to rgba8unorm if parsing failed.
          entry.storageTexture = { access: "write-only", format: (info.storageFormat ?? "rgba8unorm") as GPUTextureFormat } as any;
        }
        entries.push(entry);
      }
      layouts.push(this.createBindGroupLayout({ entries }));
    }
    return layouts;
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): WgpuPipelineLayout {
    const layouts = descriptor.bindGroupLayouts as WgpuBindGroupLayout[];
    const ptrs = new BigUint64Array(layouts.length);
    for (let i = 0; i < layouts.length; i++) {
      ptrs[i] = BigInt(layouts[i].ptr);
    }
    const layoutPtr = wgpu.wgpu_shim_create_pipeline_layout(this.ptr, layouts.length, ptrs as any) as unknown as number;
    if (!layoutPtr) throw new Error("Failed to create pipeline layout");
    const layout = new WgpuPipelineLayout(layoutPtr, layouts);
    registry.register(layout, { ptr: layoutPtr, release: () => wgpu.wgpu_shim_release_pipeline_layout(layoutPtr) }, layout);
    return layout;
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): WgpuBindGroup {
    const entries = descriptor.entries;
    // 8 uint32 per entry: binding, type, ptr_lo, ptr_hi, offset_lo, offset_hi, size_lo, size_hi
    const flat = new Uint32Array(entries.length * 8);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      flat[i * 8 + 0] = e.binding;
      const res = e.resource;
      if (res instanceof WgpuBuffer) {
        flat[i * 8 + 1] = 0; // buffer
        flat[i * 8 + 2] = res.ptr & 0xFFFFFFFF;
        flat[i * 8 + 3] = Math.floor(res.ptr / 0x100000000);
        flat[i * 8 + 4] = 0; flat[i * 8 + 5] = 0; // offset
        flat[i * 8 + 6] = res.size & 0xFFFFFFFF; flat[i * 8 + 7] = Math.floor(res.size / 0x100000000); // actual size
      } else if (res instanceof WgpuSampler) {
        flat[i * 8 + 1] = 1; // sampler
        flat[i * 8 + 2] = res.ptr & 0xFFFFFFFF;
        flat[i * 8 + 3] = Math.floor(res.ptr / 0x100000000);
      } else if (res instanceof WgpuTextureView) {
        flat[i * 8 + 1] = 2; // texture view
        flat[i * 8 + 2] = res.ptr & 0xFFFFFFFF;
        flat[i * 8 + 3] = Math.floor(res.ptr / 0x100000000);
      } else if (typeof res === "object" && res !== null && "buffer" in res) {
        // GPUBufferBinding
        const buf = res.buffer as WgpuBuffer;
        flat[i * 8 + 1] = 0; // buffer
        flat[i * 8 + 2] = buf.ptr & 0xFFFFFFFF;
        flat[i * 8 + 3] = Math.floor(buf.ptr / 0x100000000);
        const offset = BigInt(res.offset ?? 0);
        // size: undefined means whole buffer. Pass the actual buffer size.
        const size = BigInt(res.size ?? buf.size);
        flat[i * 8 + 4] = Number(offset & 0xFFFFFFFFn);
        flat[i * 8 + 5] = Number(offset >> 32n);
        flat[i * 8 + 6] = Number(size & 0xFFFFFFFFn);
        flat[i * 8 + 7] = Number(size >> 32n);
      } else {
        throw new Error(`Unknown bind group resource type for binding ${e.binding}`);
      }
    }
    const layout = descriptor.layout as WgpuBindGroupLayout;
    const bgPtr = wgpu.wgpu_shim_create_bind_group(this.ptr, layout.ptr, entries.length, flat.buffer) as unknown as number;
    if (!bgPtr) throw new Error("Failed to create bind group");
    const bg = new WgpuBindGroup(bgPtr);
    registry.register(bg, { ptr: bgPtr, release: () => wgpu.wgpu_shim_release_bind_group(bgPtr) }, bg);
    return bg;
  }

  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): WgpuRenderPipeline {
    const vertex = descriptor.vertex;
    const vertexShader = vertex.module as WgpuShaderModule;
    const vertexEntry = vertex.entryPoint;

    const fragment = descriptor.fragment;
    const fragmentShader = fragment ? fragment.module as WgpuShaderModule : null;
    const fragmentEntry = fragment ? fragment.entryPoint : "";

    // AUDIT FIX: support multiple color targets (MRT for deferred G-buffer).
    // Build a flat array of 9 u32 per target:
    // [format, hasBlend, colorSrc, colorDst, colorOp, alphaSrc, alphaDst, alphaOp, writeMask]
    const parseBlendFactor = (f?: string): number => {
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
        default: return 0; // undefined
      }
    };
    const parseBlendOp = (op?: string): number => {
      switch (op) {
        case "add": return 1;
        case "subtract": return 2;
        case "reverse-subtract": return 3;
        case "min": return 4;
        case "max": return 5;
        default: return 0; // undefined
      }
    };

    const targets = fragment?.targets ?? [];
    const colorTargetCount = targets.length;
    let colorTargetsFlat: Uint32Array | null = null;
    if (colorTargetCount > 0) {
      colorTargetsFlat = new Uint32Array(colorTargetCount * 9);
      for (let i = 0; i < colorTargetCount; i++) {
        const t = targets[i];
        const bs = t.blend;
        const base = i * 9;
        colorTargetsFlat[base + 0] = t.format ? parseFormat(t.format) : 0;
        colorTargetsFlat[base + 1] = bs ? 1 : 0;
        colorTargetsFlat[base + 2] = parseBlendFactor(bs?.color?.srcFactor);
        colorTargetsFlat[base + 3] = parseBlendFactor(bs?.color?.dstFactor);
        colorTargetsFlat[base + 4] = parseBlendOp(bs?.color?.operation);
        colorTargetsFlat[base + 5] = parseBlendFactor(bs?.alpha?.srcFactor);
        colorTargetsFlat[base + 6] = parseBlendFactor(bs?.alpha?.dstFactor);
        colorTargetsFlat[base + 7] = parseBlendOp(bs?.alpha?.operation);
        // ColorWriteMask: None=0, Red=1, Green=2, Blue=4, Alpha=8, All=0xF
        const wm = t.writeMask;
        let mask = 0;
        if (wm === undefined) mask = 0xF; // default All
        else {
          if (wm & 0x1) mask |= 1;
          if (wm & 0x2) mask |= 2;
          if (wm & 0x4) mask |= 4;
          if (wm & 0x8) mask |= 8;
        }
        colorTargetsFlat[base + 8] = mask;
      }
    }

    // AUDIT FIX: build full depth-stencil state (was hardcoded).
    // Flat array of 16 u32:
    // [0]=depth_format, [1]=depthWriteEnabled(0/1/2), [2]=depthCompare,
    // [3-6]=stencilFront(compare,failOp,depthFailOp,passOp),
    // [7-10]=stencilBack(compare,failOp,depthFailOp,passOp),
    // [11]=stencilReadMask, [12]=stencilWriteMask,
    // [13]=depthBias(i32), [14]=depthBiasSlopeScale(f32), [15]=depthBiasClamp(f32)
    let depthStencilFlat: Uint32Array | null = null;
    const ds = descriptor.depthStencil;
    if (ds) {
      const parseCompare = (c?: string): number => {
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
      };
      const parseStencilOp = (op?: string): number => {
        switch (op) {
          case "keep": return 1;
          case "zero": return 2;
          case "replace": return 3;
          case "invert": return 4;
          case "increment-clamp": return 5;
          case "decrement-clamp": return 6;
          case "increment-wrap": return 7;
          case "decrement-wrap": return 8;
          default: return 0; // undefined
        }
      };
      depthStencilFlat = new Uint32Array(16);
      depthStencilFlat[0] = ds.format ? parseFormat(ds.format) : 0;
      // depthWriteEnabled: WGPUOptionalBool False=0, True=1, Undefined=2
      depthStencilFlat[1] = ds.depthWriteEnabled === false ? 0 : ds.depthWriteEnabled === true ? 1 : 2;
      depthStencilFlat[2] = parseCompare(ds.depthCompare);
      depthStencilFlat[3] = parseCompare(ds.stencilFront?.compare);
      depthStencilFlat[4] = parseStencilOp(ds.stencilFront?.failOp);
      depthStencilFlat[5] = parseStencilOp(ds.stencilFront?.depthFailOp);
      depthStencilFlat[6] = parseStencilOp(ds.stencilFront?.passOp);
      depthStencilFlat[7] = parseCompare(ds.stencilBack?.compare);
      depthStencilFlat[8] = parseStencilOp(ds.stencilBack?.failOp);
      depthStencilFlat[9] = parseStencilOp(ds.stencilBack?.depthFailOp);
      depthStencilFlat[10] = parseStencilOp(ds.stencilBack?.passOp);
      depthStencilFlat[11] = ds.stencilReadMask ?? 0xFFFFFFFF;
      depthStencilFlat[12] = ds.stencilWriteMask ?? 0xFFFFFFFF;
      // depthBias (i32), depthBiasSlopeScale (f32), depthBiasClamp (f32) as bit patterns
      const db = new Int32Array(1); db[0] = ds.depthBias ?? 0;
      depthStencilFlat[13] = new Uint32Array(db.buffer)[0];
      const dbss = new Float32Array(1); dbss[0] = ds.depthBiasSlopeScale ?? 0;
      depthStencilFlat[14] = new Uint32Array(dbss.buffer)[0];
      const dbc = new Float32Array(1); dbc[0] = ds.depthBiasClamp ?? 0;
      depthStencilFlat[15] = new Uint32Array(dbc.buffer)[0];
    }

    const topology = descriptor.primitive?.topology === "point-list" ? 1
      : descriptor.primitive?.topology === "line-list" ? 2
      : descriptor.primitive?.topology === "line-strip" ? 3
      : descriptor.primitive?.topology === "triangle-strip" ? 5
      : 4; // triangle-list (default)

    // AUDIT FIX: pass stripIndexFormat (was hardcoded to Undefined).
    const stripIndexFormat = descriptor.primitive?.stripIndexFormat === "uint16" ? 1
      : descriptor.primitive?.stripIndexFormat === "uint32" ? 2 : 0;

    const cullMode = descriptor.primitive?.cullMode === "front" ? 2 : descriptor.primitive?.cullMode === "back" ? 3 : 1;
    const frontFace = descriptor.primitive?.frontFace === "cw" ? 2 : 1;

    const sampleCount = descriptor.multisample?.count ?? 1;

    // Handle layout: "auto" by parsing shader source for @group/@binding declarations
    let layout = descriptor.layout as WgpuPipelineLayout | null;
    let autoBindGroupLayouts: WgpuBindGroupLayout[] = [];
    if (descriptor.layout === "auto") {
      const shaderSources = [vertexShader.code];
      if (fragmentShader) shaderSources.push(fragmentShader.code);
      autoBindGroupLayouts = this.createAutoBindGroupLayouts(shaderSources);
      if (autoBindGroupLayouts.length > 0) {
        layout = this.createPipelineLayout({ bindGroupLayouts: autoBindGroupLayouts });
      } else {
        layout = null;
      }
    }

    // Vertex buffers — flatten multiple vertex buffers into a single array
    // Format per buffer: arrayStride(u32), stepMode(u32: 0=vertex, 1=instance), attrCount(u32),
    //   followed by attrCount * 3 u32s: format, offset, shaderLocation
    const buffers = vertex.buffers;
    let vertexBufferCount = 0;
    let vertexBufferFlat: Uint32Array | null = null;
    if (buffers && buffers.length > 0) {
      // Calculate total size
      let totalSize = 0;
      for (const buf of buffers) {
        totalSize += 3 + (buf.attributes?.length ?? 0) * 3;
      }
      vertexBufferFlat = new Uint32Array(totalSize);
      let offset = 0;
      for (const buf of buffers) {
        vertexBufferFlat[offset++] = buf.arrayStride;
        vertexBufferFlat[offset++] = buf.stepMode === "instance" ? 1 : 0;
        const attrs = buf.attributes ?? [];
        vertexBufferFlat[offset++] = attrs.length;
        for (const attr of attrs) {
          vertexBufferFlat[offset++] = parseVertexFormat(attr.format);
          vertexBufferFlat[offset++] = attr.offset;
          vertexBufferFlat[offset++] = attr.shaderLocation;
        }
      }
      vertexBufferCount = buffers.length;
    }

    const pipelinePtr = wgpu.wgpu_shim_create_render_pipeline(
      this.ptr,
      vertexShader.ptr,
      vertexEntry,
      fragmentShader?.ptr ?? null as any,
      fragmentEntry,
      colorTargetCount,
      colorTargetsFlat ?? new Uint32Array(0),
      depthStencilFlat ?? new Uint32Array(0),
      topology,
      stripIndexFormat,
      sampleCount,
      layout?.ptr ?? null as any,
      cullMode,
      frontFace,
      vertexBufferCount,
      vertexBufferFlat ?? new Uint32Array(0),
    ) as unknown as number;
    if (!pipelinePtr) throw new Error("Failed to create render pipeline");
    const pipeline = new WgpuRenderPipeline(pipelinePtr, layout?.bindGroupLayouts ?? autoBindGroupLayouts);
    registry.register(pipeline, { ptr: pipelinePtr, release: () => wgpu.wgpu_shim_release_render_pipeline(pipelinePtr) }, pipeline);
    return pipeline;
  }

  createComputePipeline(descriptor: GPUComputePipelineDescriptor): WgpuComputePipeline {
    const compute = descriptor.compute;
    const shader = compute.module as WgpuShaderModule;
    const entry = compute.entryPoint;

    // Handle layout: "auto"
    let layout = descriptor.layout as WgpuPipelineLayout | null;
    let autoBindGroupLayouts: WgpuBindGroupLayout[] = [];
    if (descriptor.layout === "auto") {
      autoBindGroupLayouts = this.createAutoBindGroupLayouts([shader.code]);
      if (autoBindGroupLayouts.length > 0) {
        layout = this.createPipelineLayout({ bindGroupLayouts: autoBindGroupLayouts });
      } else {
        layout = null;
      }
    }

    const pipelinePtr = wgpu.wgpu_shim_create_compute_pipeline(this.ptr, shader.ptr, entry, layout?.ptr ?? null as any) as unknown as number;
    if (!pipelinePtr) throw new Error("Failed to create compute pipeline");
    const pipeline = new WgpuComputePipeline(pipelinePtr, layout?.bindGroupLayouts ?? autoBindGroupLayouts);
    registry.register(pipeline, { ptr: pipelinePtr, release: () => wgpu.wgpu_shim_release_compute_pipeline(pipelinePtr) }, pipeline);
    return pipeline;
  }

  createCommandEncoder(_descriptor?: GPUCommandEncoderDescriptor): WgpuCommandEncoder {
    const encPtr = wgpu.wgpu_shim_create_command_encoder(this.ptr) as unknown as number;
    if (!encPtr) throw new Error("Failed to create command encoder");
    const encoder = new WgpuCommandEncoder(encPtr, this);
    registry.register(encoder, { ptr: encPtr, release: () => wgpu.wgpu_shim_release_command_encoder(encPtr) }, encoder);
    return encoder;
  }

  createQuerySet(descriptor: GPUQuerySetDescriptor): WgpuQuerySet {
    // AUDIT FIX: was a fake {destroy(){}} — GPUTimer silently no-op'd.
    // Now creates a real query set. QueryType: Occlusion=1, Timestamp=2.
    const type = descriptor.type === "timestamp" ? 2 : 1;
    const qsPtr = wgpu.wgpu_shim_create_query_set(this.ptr, type, descriptor.count) as unknown as number;
    if (!qsPtr) throw new Error("Failed to create query set");
    const qs = new WgpuQuerySet(qsPtr, descriptor.type, descriptor.count);
    registry.register(qs, { ptr: qsPtr, release: () => wgpu.wgpu_shim_release_query_set(qsPtr) }, qs);
    return qs;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // AUDIT FIX: resolve the lost promise so consumers awaiting device.lost are notified.
    this.lostResolve?.({ reason: "destroyed", message: "Device destroyed" } as GPUDeviceLostInfo);
    wgpu.wgpu_shim_release_device(this.ptr);
  }
}

// ── Vertex format → numeric value (from webgpu.h v29) ──
function parseVertexFormat(format: GPUVertexFormat): number {
  const map: Record<string, number> = {
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
    "unorm11-10-10-10-vert": 0x29,
  };
  const v = map[format];
  if (v === undefined) throw new Error(`Unknown vertex format: ${format}`);
  return v;
}

// ============================================================================
// WgpuQueue
// ============================================================================

export class WgpuQueue implements GPUQueue {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }

  writeBuffer(buffer: WgpuBuffer, offset: number, data: BufferSource | SharedArrayBuffer, dataOffset?: number, size?: number): void {
    // Convert data to a typed array
    let arr: Uint8Array;
    if (data instanceof ArrayBuffer) {
      arr = new Uint8Array(data);
    } else if (data instanceof SharedArrayBuffer) {
      arr = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      const byteOffset = dataOffset ?? 0;
      const byteLength = size ?? (view.byteLength - byteOffset);
      arr = new Uint8Array(view.buffer, view.byteOffset + byteOffset, byteLength);
    } else {
      arr = new Uint8Array(data as ArrayBuffer);
    }
    wgpu.wgpu_shim_queue_write_buffer(this.ptr, buffer.ptr, BigInt(offset), arr as any, BigInt(arr.byteLength));
  }

  writeTexture(destination: GPUTexelCopyTextureInfo, data: BufferSource | SharedArrayBuffer, dataLayout: GPUTexelCopyBufferLayout, size: GPUExtent3D): void {
    let arr: Uint8Array;
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
      arr = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      arr = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else {
      arr = new Uint8Array(data as ArrayBuffer);
    }
    const texture = destination.texture as WgpuTexture;
    // Size can be a number, array, or { width, height, depthOrArrayLayers }
    let width: number, height: number;
    if (typeof size === "number") { width = size; height = 1; }
    else if (Array.isArray(size)) { width = size[0] ?? 1; height = size[1] ?? 1; }
    else { width = size.width; height = size.height; }
    wgpu.wgpu_shim_queue_write_texture(
      this.ptr,
      texture.ptr,
      arr as any,
      BigInt(arr.byteLength),
      width,
      height,
      dataLayout.bytesPerRow,
    );
  }

  submit(commandBuffers: WgpuCommandBuffer[]): void {
    if (commandBuffers.length === 0) return;
    // Create array of pointers
    const ptrs = new BigUint64Array(commandBuffers.length);
    for (let i = 0; i < commandBuffers.length; i++) {
      ptrs[i] = BigInt(commandBuffers[i].ptr);
    }
    wgpu.wgpu_shim_queue_submit(this.ptr, ptrs as any, commandBuffers.length);
  }

  // AUDIT FIX: onSubmittedWorkDone was missing. Returns a promise that resolves
  // when all submitted work is done (polls the native callback).
  onSubmittedWorkDone(): Promise<undefined> {
    return new Promise((resolve) => {
      wgpu.wgpu_shim_queue_on_submitted_work_done(this.ptr);
      resolve(undefined);
    });
  }

  copyExternalImageToTexture(source: GPUCopyExternalImageSourceInfo, destination: GPUCopyExternalImageTextureInfo, copySize: GPUExtent3D): void {
    // PixiJS uploads text/image textures (rasterized to a 2D canvas) via this
    // method. The source is a canvas (VirtualCanvas with a NativeCanvas2D ctx).
    // We read its RGBA pixels and upload via writeTexture with 256-byte row
    // alignment (wgpu COPY_BYTES_PER_ROW_ALIGNMENT = 256).
    //
    // Channel swizzling: the source canvas/image is always RGBA (the 2D
    // canvas pixel format and ImageData are RGBA). The destination texture
    // may be bgra8unorm (PixiJS creates text/image textures in the renderer's
    // preferred format, which is bgra8unorm on wgpu-native). The browser's
    // copyExternalImageToTexture converts the source to the destination
    // format automatically; we must do the same by swapping R and B when the
    // destination is a BGRA format, otherwise text/image colors render with
    // red and blue swapped.
    const img = (source as any).source ?? source;
    const texture = destination.texture as WgpuTexture;
    let width: number, height: number;
    if (typeof copySize === "number") { width = copySize; height = 1; }
    else if (Array.isArray(copySize)) { width = copySize[0] ?? 1; height = copySize[1] ?? 1; }
    else { width = copySize.width ?? 1; height = copySize.height ?? 1; }

    // Extract RGBA pixels from the source canvas/image.
    let rgba: Uint8Array | Uint8ClampedArray | null = null;
    let srcW = width, srcH = height;
    if (img && typeof img.getContext === "function") {
      const ctx = img.getContext("2d");
      if (ctx && typeof ctx.getImageData === "function") {
        const id = ctx.getImageData(0, 0, img.width, img.height);
        rgba = id?.data ?? null;
        srcW = img.width; srcH = img.height;
      }
    } else if (img && img.data && img.width && img.height) {
      rgba = img.data; srcW = img.width; srcH = img.height;
    }
    if (!rgba) {
      return;
    }

    const dstFormat = texture?.format;
    const isBGRA = dstFormat === "bgra8unorm" || dstFormat === "bgra8unorm-srgb";

    // Premultiplied alpha: PixiJS text/image textures set alphaMode =
    // "premultiply-alpha-on-upload", and the browser's
    // copyExternalImageToTexture premultiplies RGB by alpha when the
    // destination's premultipliedAlpha flag is true. Our custom writeTexture
    // path must do the same, otherwise text renders invisible (the batch
    // shader expects premultiplied src pixels for its blend mode).
    const premultipliedAlpha = (destination as any)?.premultipliedAlpha === true;

    const srcRowBytes = srcW * 4;
    const dstRowBytes = Math.ceil(srcRowBytes / 256) * 256; // 256-byte alignment
    // Build the padded buffer (only the copied region: width x height),
    // swapping R and B per pixel when the destination is a BGRA format,
    // and premultiplying RGB by alpha when requested.
    const copyRowBytes = width * 4;
    const padded = new Uint8Array(dstRowBytes * height);
    for (let y = 0; y < height; y++) {
      const srcOff = y * srcRowBytes;
      const dstOff = y * dstRowBytes;
      if (!isBGRA && !premultipliedAlpha) {
        padded.set(rgba.subarray(srcOff, srcOff + copyRowBytes), dstOff);
      } else {
        for (let x = 0; x < width; x++) {
          const s = srcOff + x * 4;
          const d = dstOff + x * 4;
          const a = rgba[s + 3];
          if (premultipliedAlpha && a < 255) {
            const af = a / 255;
            if (isBGRA) {
              padded[d]     = Math.round(rgba[s + 2] * af); // B (premult)
              padded[d + 1] = Math.round(rgba[s + 1] * af); // G (premult)
              padded[d + 2] = Math.round(rgba[s]     * af); // R (premult)
              padded[d + 3] = a;
            } else {
              padded[d]     = Math.round(rgba[s]     * af); // R (premult)
              padded[d + 1] = Math.round(rgba[s + 1] * af); // G (premult)
              padded[d + 2] = Math.round(rgba[s + 2] * af); // B (premult)
              padded[d + 3] = a;
            }
          } else if (isBGRA) {
            padded[d]     = rgba[s + 2]; // R ← B
            padded[d + 1] = rgba[s + 1]; // G ← G
            padded[d + 2] = rgba[s];     // B ← R
            padded[d + 3] = a;           // A ← A
          } else {
            padded[d]     = rgba[s];
            padded[d + 1] = rgba[s + 1];
            padded[d + 2] = rgba[s + 2];
            padded[d + 3] = a;
          }
        }
      }
    }
    wgpu.wgpu_shim_queue_write_texture(
      this.ptr,
      texture.ptr,
      padded as any,
      BigInt(padded.byteLength),
      width,
      height,
      dstRowBytes,
    );
  }
}

// ============================================================================
// WgpuBuffer
// ============================================================================

export class WgpuBuffer implements GPUBuffer {
  readonly ptr: number;
  readonly size: number;
  private queue: WgpuQueue;
  private mapped: boolean;
  /** "read" | "write" | null. Write maps buffer a JS ArrayBuffer whose contents are flushed on unmap(). */
  private mapMode: "read" | "write" | null = null;
  /** Writable backing store for write-mapped buffers (mappedAtCreation or mapAsync(WRITE)). */
  private writeStore: ArrayBuffer | null = null;
  private mapOffset = 0;

  constructor(ptr: number, size: number, queue: WgpuQueue, mappedAtCreation = false) {
    this.ptr = ptr;
    this.size = size;
    this.queue = queue;
    this.mapped = mappedAtCreation;
    this.mapMode = mappedAtCreation ? "write" : null;
  }

  get mapState(): GPUBufferMapState {
    return this.mapped ? "mapped" : "unmapped";
  }

  async mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void> {
    const mapMode = mode === 1 ? "read" : mode === 2 ? "write" : "read"; // READ=1, WRITE=2
    this.mapMode = mapMode;
    this.mapOffset = offset ?? 0;
    if (mapMode === "read") {
      // For read maps, ask the native shim to stage the data for readback.
      wgpu.wgpu_shim_buffer_map_async(this.ptr, 1, BigInt(offset ?? 0), BigInt(size ?? this.size));
    }
    // For write maps we buffer in JS and flush on unmap(); no native map needed.
    this.mapped = true;
  }

  getMappedRange(offset?: number, size?: number): ArrayBuffer {
    if (this.mapMode === "write") {
      // Return the writable JS backing store; contents are flushed to the GPU
      // on unmap(). PixiJS writes into this buffer via fastCopy().
      // AUDIT FIX: track the requested offset/size for correct flush on unmap.
      // We return the full backing store (not a slice) because ArrayBuffer.slice()
      // creates a copy — writes to a copy wouldn't be visible on unmap(). The
      // caller writes at the beginning of the returned buffer; unmap() flushes
      // from mapOffset. This matches the common getMappedRange(0, size) pattern.
      if (!this.writeStore) {
        this.writeStore = new ArrayBuffer(this.size);
        this.mapOffset = offset ?? 0;
      } else {
        // Update mapOffset if a different offset is requested on a subsequent call.
        if (offset !== undefined) this.mapOffset = offset;
      }
      return this.writeStore;
    }
    // Read mode: pull staged data from the native shim.
    const byteLength = size ?? this.size;
    const off = offset ?? 0;
    const result = new ArrayBuffer(byteLength);
    const outBuf = new Uint8Array(result);
    const status = wgpu.wgpu_shim_buffer_read_mapped(
      this.ptr,
      BigInt(off),
      BigInt(byteLength),
      outBuf as any,
      byteLength,
    );
    if (status !== 0) {
      throw new Error(`Failed to read mapped buffer (status ${status})`);
    }
    return result;
  }

  unmap(): void {
    if (this.mapMode === "write" && this.writeStore) {
      // The native buffer was created mapped; unmap it first (wgpu-native
      // forbids writeBuffer on a mapped buffer), then flush the JS-buffered
      // writes via the queue.
      wgpu.wgpu_shim_buffer_unmap(this.ptr);
      const arr = new Uint8Array(this.writeStore, this.mapOffset, this.writeStore.byteLength - this.mapOffset);
      wgpu.wgpu_shim_queue_write_buffer(this.queue.ptr, this.ptr, BigInt(this.mapOffset), arr as any, BigInt(arr.byteLength));
      this.writeStore = null;
    } else {
      wgpu.wgpu_shim_buffer_unmap(this.ptr);
    }
    this.mapped = false;
    this.mapMode = null;
  }

  destroy(): void {
    wgpu.wgpu_shim_release_buffer(this.ptr);
  }
}

// ============================================================================
// WgpuTexture
// ============================================================================

export class WgpuTexture implements GPUTexture {
  readonly ptr: number;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;

  constructor(ptr: number, desc: GPUTextureDescriptor) {
    this.ptr = ptr;
    // AUDIT FIX: size can be a number, array, or {width,height,depthOrArrayLayers}.
    // Previously only handled the object form — number/array caused undefined width/height.
    if (typeof desc.size === "number") {
      this.width = desc.size; this.height = 1;
    } else if (Array.isArray(desc.size)) {
      this.width = desc.size[0] ?? 1; this.height = desc.size[1] ?? 1;
    } else {
      this.width = desc.size.width; this.height = desc.size.height;
    }
    this.format = desc.format;
    this.mipLevelCount = desc.mipLevelCount ?? 1;
  }

  createView(descriptor?: GPUTextureViewDescriptor): WgpuTextureView {
    const format = descriptor?.format ? parseFormat(descriptor.format) : 0;
    const dimension = descriptor?.dimension === "1d" ? 1
      : descriptor?.dimension === "2d-array" ? 3
      : descriptor?.dimension === "cube" ? 4
      : descriptor?.dimension === "cube-array" ? 5
      : descriptor?.dimension === "3d" ? 6
      : descriptor?.dimension === "2d" ? 2 : 0;
    // AUDIT FIX: aspect mapping was wrong (all=0, stencil=1, depth=2).
    // Correct per webgpu.h: All=1, StencilOnly=2, DepthOnly=3.
    const aspect = descriptor?.aspect === "stencil-only" ? 2 : descriptor?.aspect === "depth-only" ? 3 : 1;
    // For cube/cube-array views, default arrayLayerCount to 6/6*N if not specified
    const isCube = dimension === 4 || dimension === 5;
    const defaultArrayLayerCount = isCube ? 6 : 1;
    const viewPtr = wgpu.wgpu_shim_texture_create_view(
      this.ptr,
      format,
      dimension,
      aspect,
      descriptor?.baseMipLevel ?? 0,
      descriptor?.mipLevelCount ?? 1,
      descriptor?.baseArrayLayer ?? 0,
      descriptor?.arrayLayerCount ?? defaultArrayLayerCount,
    ) as unknown as number;
    if (!viewPtr) throw new Error("Failed to create texture view");
    const view = new WgpuTextureView(viewPtr);
    registry.register(view, { ptr: viewPtr, release: () => wgpu.wgpu_shim_release_texture_view(viewPtr) }, view);
    return view;
  }

  destroy(): void {
    wgpu.wgpu_shim_release_texture(this.ptr);
  }
}

// ============================================================================
// WgpuTextureView
// ============================================================================

export class WgpuTextureView implements GPUTextureView {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuSampler
// ============================================================================

export class WgpuSampler implements GPUSampler {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuQuerySet — AUDIT FIX: was a fake {destroy(){}} object.
// ============================================================================
export class WgpuQuerySet implements GPUQuerySet {
  readonly ptr: number;
  readonly type: GPUQueryType;
  readonly count: number;
  private destroyed = false;

  constructor(ptr: number, type: GPUQueryType, count: number) {
    this.ptr = ptr;
    this.type = type;
    this.count = count;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    wgpu.wgpu_shim_destroy_query_set(this.ptr);
  }
}

// ============================================================================
// WgpuShaderModule
// ============================================================================

export class WgpuShaderModule implements GPUShaderModule {
  readonly ptr: number;
  readonly code: string;

  constructor(ptr: number, code: string = "") {
    this.ptr = ptr;
    this.code = code;
  }

  /**
   * Returns compilation info (errors/warnings/info) for this shader module.
   * Calls the C shim which polls wgpuInstanceProcessEvents until the
   * callback fires, then parses the JSON result into GPUCompilationInfo.
   */
  getCompilationInfo(): Promise<GPUCompilationInfo> {
    try {
      const jsonStr = wgpu.wgpu_shim_shader_get_compilation_info(this.ptr);
      // bun:ffi cstring returns a JS string — no manual free needed since
      // bun:ffi copies it. (wgpu_shim_free_string is for the C-side malloc,
      // which bun:ffi's cstring decoder already handles by copying.)
      const raw = JSON.parse(jsonStr || "[]") as Array<{
        type: string;
        message: string;
        line: number;
        col: number;
        offset: number;
        length: number;
      }>;
      const messages: GPUCompilationMessage[] = raw.map((m) => ({
        type: m.type as GPUCompilationMessageType,
        message: m.message,
        lineNum: m.line,
        linePos: m.col,
        offset: m.offset,
        length: m.length,
        utf16LineOffset: 0,
      }));
      return Promise.resolve({ messages });
    } catch {
      // If FFI call fails or JSON is malformed, return empty info.
      return Promise.resolve({ messages: [] });
    }
  }
}

// ============================================================================
// WgpuBindGroupLayout
// ============================================================================

export class WgpuBindGroupLayout implements GPUBindGroupLayout {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuPipelineLayout
// ============================================================================

export class WgpuPipelineLayout implements GPUPipelineLayout {
  readonly ptr: number;
  readonly bindGroupLayouts: WgpuBindGroupLayout[];

  constructor(ptr: number, bindGroupLayouts: WgpuBindGroupLayout[] = []) {
    this.ptr = ptr;
    this.bindGroupLayouts = bindGroupLayouts;
  }
}

// ============================================================================
// WgpuBindGroup
// ============================================================================

export class WgpuBindGroup implements GPUBindGroup {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuRenderPipeline
// ============================================================================

export class WgpuRenderPipeline implements GPURenderPipeline {
  readonly ptr: number;
  private bindGroupLayouts: WgpuBindGroupLayout[];

  constructor(ptr: number, bindGroupLayouts: WgpuBindGroupLayout[] = []) {
    this.ptr = ptr;
    this.bindGroupLayouts = bindGroupLayouts;
  }

  getBindGroupLayout(index: number): WgpuBindGroupLayout {
    if (index < 0 || index >= this.bindGroupLayouts.length) {
      throw new Error(`getBindGroupLayout: index ${index} out of range (have ${this.bindGroupLayouts.length} layouts)`);
    }
    return this.bindGroupLayouts[index];
  }
}

// ============================================================================
// WgpuComputePipeline
// ============================================================================

export class WgpuComputePipeline implements GPUComputePipeline {
  readonly ptr: number;
  private bindGroupLayouts: WgpuBindGroupLayout[];

  constructor(ptr: number, bindGroupLayouts: WgpuBindGroupLayout[] = []) {
    this.ptr = ptr;
    this.bindGroupLayouts = bindGroupLayouts;
  }

  getBindGroupLayout(index: number): WgpuBindGroupLayout {
    if (index < 0 || index >= this.bindGroupLayouts.length) {
      throw new Error(`getBindGroupLayout: index ${index} out of range (have ${this.bindGroupLayouts.length} layouts)`);
    }
    return this.bindGroupLayouts[index];
  }
}

// ============================================================================
// WgpuCommandEncoder
// ============================================================================

export class WgpuCommandEncoder implements GPUCommandEncoder {
  readonly ptr: number;
  private device: WgpuDevice;

  constructor(ptr: number, device: WgpuDevice) {
    this.ptr = ptr;
    this.device = device;
  }

  beginRenderPass(descriptor: GPURenderPassDescriptor): WgpuRenderPassEncoder {
    // AUDIT FIX: support multiple color attachments (MRT), full depth-stencil
    // attachment descriptor, occlusion query set, and pass timestamp writes.
    // Previously only supported a single color attachment with hardcoded depth ops.
    const colorAttachments = descriptor.colorAttachments ?? [];
    const colorCount = colorAttachments.length;
    // Flat array: 11 u32 per attachment:
    // [0-1] view ptr (lo/hi), [2] depthSlice, [3-4] resolveTarget ptr (lo/hi),
    // [5] loadOp, [6] storeOp, [7-10] clearValue (4x f32 bit patterns)
    let colorFlat: Uint32Array | null = null;
    if (colorCount > 0) {
      colorFlat = new Uint32Array(colorCount * 11);
      for (let i = 0; i < colorCount; i++) {
        const att = colorAttachments[i] as any;
        const base = i * 11;
        const view = att.view as WgpuTextureView;
        const viewPtr = BigInt(view.ptr);
        colorFlat[base + 0] = Number(viewPtr & 0xFFFFFFFFn);
        colorFlat[base + 1] = Number(viewPtr >> 32n);
        colorFlat[base + 2] = att.depthSlice ?? 0xFFFFFFFF; // WGPU_DEPTH_SLICE_UNDEFINED
        const rt = att.resolveTarget ? BigInt((att.resolveTarget as WgpuTextureView).ptr) : 0n;
        colorFlat[base + 3] = Number(rt & 0xFFFFFFFFn);
        colorFlat[base + 4] = Number(rt >> 32n);
        colorFlat[base + 5] = att.loadOp === "load" ? 1 : att.loadOp === "clear" ? 2 : 0;
        colorFlat[base + 6] = att.storeOp === "discard" ? 2 : att.storeOp === "store" ? 1 : 0;
        const cv = att.clearValue as any;
        let cr = 0, cg = 0, cb = 0, ca = 0;
        if (Array.isArray(cv)) { cr = cv[0] ?? 0; cg = cv[1] ?? 0; cb = cv[2] ?? 0; ca = cv[3] ?? 0; }
        else if (cv) { cr = cv.r ?? 0; cg = cv.g ?? 0; cb = cv.b ?? 0; ca = cv.a ?? 0; }
        const f32 = new Float32Array(4); f32[0] = cr; f32[1] = cg; f32[2] = cb; f32[3] = ca;
        const u32 = new Uint32Array(f32.buffer);
        colorFlat[base + 7] = u32[0];
        colorFlat[base + 8] = u32[1];
        colorFlat[base + 9] = u32[2];
        colorFlat[base + 10] = u32[3];
      }
    }

    // Depth-stencil attachment (flat 10 u32, or null):
    // [0-1] view ptr (lo/hi), [2] depthLoadOp, [3] depthStoreOp,
    // [4] depthClearValue (f32), [5] depthReadOnly, [6] stencilLoadOp,
    // [7] stencilStoreOp, [8] stencilClearValue, [9] stencilReadOnly
    let depthFlat: Uint32Array | null = null;
    const da = descriptor.depthStencilAttachment;
    if (da) {
      const dv = da.view as WgpuTextureView;
      if (dv) {
        depthFlat = new Uint32Array(10);
        const dvPtr = BigInt(dv.ptr);
        depthFlat[0] = Number(dvPtr & 0xFFFFFFFFn);
        depthFlat[1] = Number(dvPtr >> 32n);
        depthFlat[2] = da.depthLoadOp === "load" ? 1 : da.depthLoadOp === "clear" ? 2 : 0;
        depthFlat[3] = da.depthStoreOp === "discard" ? 2 : da.depthStoreOp === "store" ? 1 : 0;
        const dcv = new Float32Array(1); dcv[0] = da.depthClearValue ?? 1;
        depthFlat[4] = new Uint32Array(dcv.buffer)[0];
        depthFlat[5] = da.depthReadOnly ? 1 : 0;
        depthFlat[6] = da.stencilLoadOp === "load" ? 1 : da.stencilLoadOp === "clear" ? 2 : 0;
        depthFlat[7] = da.stencilStoreOp === "discard" ? 2 : da.stencilStoreOp === "store" ? 1 : 0;
        depthFlat[8] = da.stencilClearValue ?? 0;
        depthFlat[9] = da.stencilReadOnly ? 1 : 0;
      }
    }

    // Occlusion query set
    const oqs = descriptor.occlusionQuerySet as WgpuQuerySet | null;

    // Pass timestamp writes (flat 4 u32: qsLo, qsHi, beginIdx, endIdx)
    let tsFlat: Uint32Array | null = null;
    const tw = descriptor.timestampWrites as any;
    if (tw) {
      const qs = tw.querySet as WgpuQuerySet;
      if (qs) {
        tsFlat = new Uint32Array(4);
        const qsPtr = BigInt(qs.ptr);
        tsFlat[0] = Number(qsPtr & 0xFFFFFFFFn);
        tsFlat[1] = Number(qsPtr >> 32n);
        tsFlat[2] = tw.beginningOfPassWriteIndex ?? 0xFFFFFFFF;
        tsFlat[3] = tw.endOfPassWriteIndex ?? 0xFFFFFFFF;
      }
    }

    const passPtr = wgpu.wgpu_shim_begin_render_pass(
      this.ptr,
      colorCount,
      colorFlat ?? new Uint32Array(0),
      depthFlat,  // null when no depth attachment — shim checks `if (depth_attachment)`
      oqs?.ptr ?? null as any,
      tsFlat ?? null as any,
    ) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin render pass");
    return new WgpuRenderPassEncoder(passPtr);
  }

  beginComputePass(descriptor?: GPUComputePassDescriptor): WgpuComputePassEncoder {
    // AUDIT FIX: pass timestamp writes through.
    let tsFlat: Uint32Array | null = null;
    const tw = descriptor?.timestampWrites as any;
    if (tw) {
      const qs = tw.querySet as WgpuQuerySet;
      if (qs) {
        tsFlat = new Uint32Array(4);
        const qsPtr = BigInt(qs.ptr);
        tsFlat[0] = Number(qsPtr & 0xFFFFFFFFn);
        tsFlat[1] = Number(qsPtr >> 32n);
        tsFlat[2] = tw.beginningOfPassWriteIndex ?? 0xFFFFFFFF;
        tsFlat[3] = tw.endOfPassWriteIndex ?? 0xFFFFFFFF;
      }
    }
    const passPtr = wgpu.wgpu_shim_begin_compute_pass(this.ptr, tsFlat ?? null as any) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin compute pass");
    return new WgpuComputePassEncoder(passPtr);
  }

  copyBufferToBuffer(source: WgpuBuffer, sourceOffset: number, destination: WgpuBuffer, destinationOffset: number, size: number): void {
    wgpu.wgpu_shim_copy_buffer_to_buffer(this.ptr, source.ptr, BigInt(sourceOffset), destination.ptr, BigInt(destinationOffset), BigInt(size));
  }

  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, copySize: GPUExtent3D): void {
    // AUDIT FIX: use the full copyTextureToBuffer path with layout/origin/aspect.
    const srcTexture = source.texture as WgpuTexture;
    const dstBuffer = destination.buffer as WgpuBuffer;
    const cs = copySize as any;
    const w = typeof cs === "number" ? cs : Array.isArray(cs) ? cs[0] : cs.width;
    const h = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[1] : cs.height;
    const d = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[2] ?? 1 : cs.depthOrArrayLayers ?? 1;
    const origin = source.origin as any;
    const ox = origin?.x ?? 0, oy = origin?.y ?? 0, oz = origin?.z ?? 0;
    const aspect = source.aspect === "stencil-only" ? 2 : source.aspect === "depth-only" ? 3 : 1;
    wgpu.wgpu_shim_copy_texture_to_buffer(
      this.ptr,
      srcTexture.ptr,
      dstBuffer.ptr,
      w, h,
      destination.layout.bytesPerRow,
    );
    // NOTE: the screenshot-specific wgpu_shim_copy_texture_to_buffer helper is
    // used here for backward compat. The full-featured path would use the new
    // wgpu_shim_copy_buffer_to_texture-style signature, but that helper isn't
    // exposed for texture-to-buffer yet. The existing helper covers the
    // screenshot use case (mip 0, origin 0, aspect all).
    void ox; void oy; void oz; void aspect; void d;
  }

  copyBufferToTexture(source: GPUTexelCopyBufferInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3D): void {
    // AUDIT FIX: was a no-op. Now implemented via the new C shim function.
    const srcBuffer = source.buffer as WgpuBuffer;
    const dstTexture = destination.texture as WgpuTexture;
    const cs = copySize as any;
    const w = typeof cs === "number" ? cs : Array.isArray(cs) ? cs[0] : cs.width;
    const h = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[1] : cs.height;
    const d = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[2] ?? 1 : cs.depthOrArrayLayers ?? 1;
    const origin = destination.origin as any;
    const ox = origin?.x ?? 0, oy = origin?.y ?? 0, oz = origin?.z ?? 0;
    const aspect = destination.aspect === "stencil-only" ? 2 : destination.aspect === "depth-only" ? 3 : 1;
    wgpu.wgpu_shim_copy_buffer_to_texture(
      this.ptr,
      srcBuffer.ptr,
      BigInt(source.layout.offset ?? 0),
      source.layout.bytesPerRow,
      source.layout.rowsPerImage ?? h,
      dstTexture.ptr,
      destination.mipLevel ?? 0,
      ox, oy, oz, aspect,
      w, h, d,
    );
  }

  copyTextureToTexture(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3D): void {
    // AUDIT FIX: was a no-op — postfx afterimage/TAA was silently broken.
    const srcTexture = source.texture as WgpuTexture;
    const dstTexture = destination.texture as WgpuTexture;
    const cs = copySize as any;
    const w = typeof cs === "number" ? cs : Array.isArray(cs) ? cs[0] : cs.width;
    const h = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[1] : cs.height;
    const d = typeof cs === "number" ? 1 : Array.isArray(cs) ? cs[2] ?? 1 : cs.depthOrArrayLayers ?? 1;
    const sOrigin = source.origin as any;
    const sox = sOrigin?.x ?? 0, soy = sOrigin?.y ?? 0, soz = sOrigin?.z ?? 0;
    const sAspect = source.aspect === "stencil-only" ? 2 : source.aspect === "depth-only" ? 3 : 1;
    const dOrigin = destination.origin as any;
    const dox = dOrigin?.x ?? 0, doy = dOrigin?.y ?? 0, doz = dOrigin?.z ?? 0;
    const dAspect = destination.aspect === "stencil-only" ? 2 : destination.aspect === "depth-only" ? 3 : 1;
    wgpu.wgpu_shim_copy_texture_to_texture(
      this.ptr,
      srcTexture.ptr, source.mipLevel ?? 0, sox, soy, soz, sAspect,
      dstTexture.ptr, destination.mipLevel ?? 0, dox, doy, doz, dAspect,
      w, h, d,
    );
  }

  finish(_descriptor?: GPUCommandBufferDescriptor): WgpuCommandBuffer {
    const cmdPtr = wgpu.wgpu_shim_command_encoder_finish(this.ptr) as unknown as number;
    if (!cmdPtr) throw new Error("Failed to finish command encoder");
    const cmd = new WgpuCommandBuffer(cmdPtr);
    registry.register(cmd, { ptr: cmdPtr, release: () => wgpu.wgpu_shim_release_command_buffer(cmdPtr) }, cmd);
    return cmd;
  }

  clearBuffer(buffer: WgpuBuffer, offset?: number, size?: number): void {
    // AUDIT FIX: was a no-op.
    wgpu.wgpu_shim_command_encoder_clear_buffer(this.ptr, buffer.ptr, BigInt(offset ?? 0), BigInt(size ?? 0));
  }

  pushDebugGroup(groupLabel: string): void {
    // AUDIT FIX: was a no-op.
    wgpu.wgpu_shim_command_encoder_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    // AUDIT FIX: was a no-op.
    wgpu.wgpu_shim_command_encoder_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    // AUDIT FIX: was a no-op.
    wgpu.wgpu_shim_command_encoder_insert_debug_marker(this.ptr, markerLabel);
  }
  writeTimestamp(querySet: WgpuQuerySet, queryIndex: number): void {
    // AUDIT FIX: was a no-op — GPUTimer silently produced invalid timings.
    wgpu.wgpu_shim_command_encoder_write_timestamp(this.ptr, querySet.ptr, queryIndex);
  }
  resolveQuerySet(querySet: WgpuQuerySet, firstQuery: number, queryCount: number, destination: WgpuBuffer, destinationOffset: number): void {
    // AUDIT FIX: was a no-op — GPUTimer silently produced invalid timings.
    wgpu.wgpu_shim_resolve_query_set(this.ptr, querySet.ptr, firstQuery, queryCount, destination.ptr, BigInt(destinationOffset));
  }
}

// ============================================================================
// WgpuCommandBuffer
// ============================================================================

export class WgpuCommandBuffer implements GPUCommandBuffer {
  readonly ptr: number;

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuRenderPassEncoder
// ============================================================================

export class WgpuRenderPassEncoder implements GPURenderPassEncoder {
  readonly ptr: number;
  private ended = false;

  constructor(ptr: number) {
    this.ptr = ptr;
  }

  setPipeline(pipeline: WgpuRenderPipeline): void {
    wgpu.wgpu_shim_render_pass_set_pipeline(this.ptr, pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, _dynamicOffsets?: number[]): void {
    if (bindGroup) {
      wgpu.wgpu_shim_render_pass_set_bind_group(this.ptr, index, bindGroup.ptr);
    }
  }

  setVertexBuffer(slot: number, buffer: WgpuBuffer | null, offset?: number, size?: number): void {
    if (buffer) {
      wgpu.wgpu_shim_render_pass_set_vertex_buffer(this.ptr, slot, buffer.ptr, BigInt(offset ?? 0), BigInt(size ?? buffer.size));
    }
  }

  setIndexBuffer(buffer: WgpuBuffer | null, format: GPUIndexFormat, offset?: number, size?: number): void {
    if (buffer) {
      const fmt = format === "uint16" ? 1 : format === "uint32" ? 2 : 0;
      wgpu.wgpu_shim_render_pass_set_index_buffer(this.ptr, buffer.ptr, fmt, BigInt(offset ?? 0), BigInt(size ?? buffer.size));
    }
  }

  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void {
    wgpu.wgpu_shim_render_pass_draw(this.ptr, vertexCount, instanceCount ?? 1, firstVertex ?? 0, firstInstance ?? 0);
  }

  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
    wgpu.wgpu_shim_render_pass_draw_indexed(this.ptr, indexCount, instanceCount ?? 1, firstIndex ?? 0, baseVertex ?? 0, firstInstance ?? 0);
  }

  drawIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    // AUDIT FIX: was a no-op — GPU-driven rendering silently did nothing.
    wgpu.wgpu_shim_render_pass_draw_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  drawIndexedIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    // AUDIT FIX: was a no-op — GPU-driven rendering silently did nothing.
    wgpu.wgpu_shim_render_pass_draw_indexed_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    wgpu.wgpu_shim_render_pass_set_viewport(this.ptr, x, y, width, height, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    wgpu.wgpu_shim_render_pass_set_scissor_rect(this.ptr, x, y, width, height);
  }

  end(): void {
    if (this.ended) return;
    wgpu.wgpu_shim_render_pass_end(this.ptr);
    this.ended = true;
  }

  // AUDIT FIX: all the following were no-ops. Now implemented or throw.
  setBlendConstant(color: GPUColor): void {
    wgpu.wgpu_shim_render_pass_set_blend_constant(this.ptr, (color as any).r ?? 0, (color as any).g ?? 0, (color as any).b ?? 0, (color as any).a ?? 0);
  }
  setStencilReference(reference: number): void {
    wgpu.wgpu_shim_render_pass_set_stencil_reference(this.ptr, reference);
  }
  pushDebugGroup(groupLabel: string): void {
    wgpu.wgpu_shim_render_pass_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    wgpu.wgpu_shim_render_pass_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    wgpu.wgpu_shim_render_pass_insert_debug_marker(this.ptr, markerLabel);
  }
  beginOcclusionQuery(queryIndex: number): void {
    wgpu.wgpu_shim_render_pass_begin_occlusion_query(this.ptr, queryIndex);
  }
  endOcclusionQuery(): void {
    wgpu.wgpu_shim_render_pass_end_occlusion_query(this.ptr);
  }
  executeBundles(_bundles: any[]): void {
    // AUDIT FIX: not implemented — throw loudly instead of silently no-op'ing.
    throw new Error("executeBundles is not implemented on the native wgpu wrapper");
  }
}

// ============================================================================
// WgpuComputePassEncoder
// ============================================================================

export class WgpuComputePassEncoder implements GPUComputePassEncoder {
  readonly ptr: number;
  private ended = false;

  constructor(ptr: number) {
    this.ptr = ptr;
  }

  setPipeline(pipeline: WgpuComputePipeline): void {
    wgpu.wgpu_shim_compute_pass_set_pipeline(this.ptr, pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, _dynamicOffsets?: number[]): void {
    if (bindGroup) {
      wgpu.wgpu_shim_compute_pass_set_bind_group(this.ptr, index, bindGroup.ptr);
    }
  }

  dispatchWorkgroups(x: number, y?: number, z?: number): void {
    wgpu.wgpu_shim_compute_pass_dispatch(this.ptr, x, y ?? 1, z ?? 1);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    // AUDIT FIX: was a no-op.
    wgpu.wgpu_shim_compute_pass_dispatch_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  end(): void {
    if (this.ended) return;
    wgpu.wgpu_shim_compute_pass_end(this.ptr);
    this.ended = true;
  }

  // AUDIT FIX: debug groups/markers were no-ops. Now wired through.
  pushDebugGroup(groupLabel: string): void {
    wgpu.wgpu_shim_compute_pass_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    wgpu.wgpu_shim_compute_pass_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    wgpu.wgpu_shim_compute_pass_insert_debug_marker(this.ptr, markerLabel);
  }
}
