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

// ── WebGPU constants (from webgpu.h, matching @webgpu/types) ──

// BufferUsage
const BUFFER_USAGE_NONE = 0x0000;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_MAP_WRITE = 0x0002;
const BUFFER_USAGE_COPY_SRC = 0x0004;
const BUFFER_USAGE_COPY_DST = 0x0008;
const BUFFER_USAGE_INDEX = 0x0010;
const BUFFER_USAGE_VERTEX = 0x0020;
const BUFFER_USAGE_UNIFORM = 0x0040;
const BUFFER_USAGE_STORAGE = 0x0080;
const BUFFER_USAGE_INDIRECT = 0x0100;
const BUFFER_USAGE_QUERY_RESOLVE = 0x0200;

// TextureUsage
const TEXTURE_USAGE_NONE = 0x0000;
const TEXTURE_USAGE_COPY_SRC = 0x0001;
const TEXTURE_USAGE_COPY_DST = 0x0002;
const TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;
const TEXTURE_USAGE_STORAGE_BINDING = 0x0008;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;

// TextureFormat (subset — full list is long)
const TEXTURE_FORMAT_UNDEFINED = 0;
const TEXTURE_FORMAT_R8UNORM = 1;
const TEXTURE_FORMAT_R8SNORM = 2;
const TEXTURE_FORMAT_R8UINT = 3;
const TEXTURE_FORMAT_R8SINT = 4;
const TEXTURE_FORMAT_R16UINT = 5;
const TEXTURE_FORMAT_R16SINT = 6;
const TEXTURE_FORMAT_R16FLOAT = 7;
const TEXTURE_FORMAT_RG8UNORM = 8;
const TEXTURE_FORMAT_RG8SNORM = 9;
const TEXTURE_FORMAT_RG8UINT = 10;
const TEXTURE_FORMAT_RG8SINT = 11;
const TEXTURE_FORMAT_R32UINT = 12;
const TEXTURE_FORMAT_R32SINT = 13;
const TEXTURE_FORMAT_R32FLOAT = 14;
const TEXTURE_FORMAT_RG16UINT = 15;
const TEXTURE_FORMAT_RG16SINT = 16;
const TEXTURE_FORMAT_RG16FLOAT = 17;
const TEXTURE_FORMAT_RGBA8UNORM = 18;
const TEXTURE_FORMAT_RGBA8UNORM_SRGB = 19;
const TEXTURE_FORMAT_RGBA8SNORM = 20;
const TEXTURE_FORMAT_RGBA8UINT = 21;
const TEXTURE_FORMAT_RGBA8SINT = 22;
const TEXTURE_FORMAT_BGRA8UNORM = 23;
const TEXTURE_FORMAT_BGRA8UNORM_SRGB = 24;
const TEXTURE_FORMAT_RGB10A2UINT = 25;
const TEXTURE_FORMAT_RGB10A2UNORM = 26;
const TEXTURE_FORMAT_RG11B10UFLOAT = 27;
const TEXTURE_FORMAT_RGB9E5UFLOAT = 28;
const TEXTURE_FORMAT_RG32UINT = 29;
const TEXTURE_FORMAT_RG32SINT = 30;
const TEXTURE_FORMAT_RG32FLOAT = 31;
const TEXTURE_FORMAT_RGBA16UINT = 32;
const TEXTURE_FORMAT_RGBA16SINT = 33;
const TEXTURE_FORMAT_RGBA16FLOAT = 34;
const TEXTURE_FORMAT_RGBA32UINT = 35;
const TEXTURE_FORMAT_RGBA32SINT = 36;
const TEXTURE_FORMAT_RGBA32FLOAT = 37;
const TEXTURE_FORMAT_DEPTH16UNORM = 38;
const TEXTURE_FORMAT_DEPTH24PLUS = 39;
const TEXTURE_FORMAT_DEPTH24PLUS_STENCIL8 = 40;
const TEXTURE_FORMAT_DEPTH32FLOAT = 41;
const TEXTURE_FORMAT_DEPTH32FLOAT_STENCIL8 = 42;

// TextureDimension
const TEXTURE_DIMENSION_1D = 0;
const TEXTURE_DIMENSION_2D = 1;
const TEXTURE_DIMENSION_3D = 2;

// TextureViewDimension
const TEXTURE_VIEW_DIMENSION_UNDEFINED = 0;
const TEXTURE_VIEW_DIMENSION_1D = 1;
const TEXTURE_VIEW_DIMENSION_2D = 2;
const TEXTURE_VIEW_DIMENSION_2D_ARRAY = 3;
const TEXTURE_VIEW_DIMENSION_CUBE = 4;
const TEXTURE_VIEW_DIMENSION_CUBE_ARRAY = 5;
const TEXTURE_VIEW_DIMENSION_3D = 6;

// TextureAspect
const TEXTURE_ASPECT_ALL = 0;
const TEXTURE_ASPECT_STENCIL_ONLY = 1;
const TEXTURE_ASPECT_DEPTH_ONLY = 2;

// PresentMode
const PRESENT_MODE_FIFO = 0;
const PRESENT_MODE_IMMEDIATE = 1;
const PRESENT_MODE_MAILBOX = 2;

// LoadOp / StoreOp
const LOAD_OP_CLEAR = 0;
const LOAD_OP_LOAD = 1;
const STORE_OP_STORE = 0;
const STORE_OP_DISCARD = 1;

// PrimitiveTopology
const PRIMITIVE_TOPOLOGY_POINT_LIST = 0;
const PRIMITIVE_TOPOLOGY_LINE_LIST = 1;
const PRIMITIVE_TOPOPE_LINE_STRIP = 2;
const PRIMITIVE_TOPOLOGY_TRIANGLE_LIST = 3;
const PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP = 4;

// CullMode
const CULL_MODE_NONE = 0;
const CULL_MODE_FRONT = 1;
const CULL_MODE_BACK = 2;

// FrontFace
const FRONT_FACE_CCW = 0;
const FRONT_FACE_CW = 1;

// FilterMode
const FILTER_MODE_NEAREST = 0;
const FILTER_MODE_LINEAR = 1;

// AddressMode
const ADDRESS_MODE_REPEAT = 0;
const ADDRESS_MODE_MIRROR_REPEAT = 1;
const ADDRESS_MODE_CLAMP_TO_EDGE = 2;

// BufferBindingType
const BUFFER_BINDING_TYPE_UNDEFINED = 0;
const BUFFER_BINDING_TYPE_UNIFORM = 1;
const BUFFER_BINDING_TYPE_STORAGE = 2;
const BUFFER_BINDING_TYPE_READ_ONLY_STORAGE = 3;

// SamplerBindingType
const SAMPLER_BINDING_TYPE_UNDEFINED = 0;
const SAMPLER_BINDING_TYPE_FILTERING = 1;
const SAMPLER_BINDING_TYPE_NON_FILTERING = 2;
const SAMPLER_BINDING_TYPE_COMPARISON = 3;

// TextureSampleType
const TEXTURE_SAMPLE_TYPE_UNDEFINED = 0;
const TEXTURE_SAMPLE_TYPE_FLOAT = 1;
const TEXTURE_SAMPLE_TYPE_UNFILTERABLE_FLOAT = 2;
const TEXTURE_SAMPLE_TYPE_DEPTH = 3;
const TEXTURE_SAMPLE_TYPE_SINT = 4;
const TEXTURE_SAMPLE_TYPE_UINT = 5;

// MapMode
const MAP_MODE_READ = 0x0001;
const MAP_MODE_WRITE = 0x0002;

// IndexFormat
const INDEX_FORMAT_UNDEFINED = 0;
const INDEX_FORMAT_UINT16 = 1;
const INDEX_FORMAT_UINT32 = 2;

// CompareFunction
const COMPARE_FUNCTION_UNDEFINED = 0;
const COMPARE_FUNCTION_NEVER = 1;
const COMPARE_FUNCTION_LESS = 2;
const COMPARE_FUNCTION_EQUAL = 3;
const COMPARE_FUNCTION_LESS_EQUAL = 4;
const COMPARE_FUNCTION_GREATER = 5;
const COMPARE_FUNCTION_NOT_EQUAL = 6;
const COMPARE_FUNCTION_GREATER_EQUAL = 7;
const COMPARE_FUNCTION_ALWAYS = 8;

// ShaderStage
const SHADER_STAGE_NONE = 0x0000;
const SHADER_STAGE_VERTEX = 0x0001;
const SHADER_STAGE_FRAGMENT = 0x0002;
const SHADER_STAGE_COMPUTE = 0x0004;

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
    return { min: {}, max: {} } as unknown as GPUSupportedLimits;
  }

  get features(): GPUSupportedFeatures {
    return new Set() as unknown as GPUSupportedFeatures;
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
    return new Set() as unknown as GPUSupportedFeatures;
  }

  get limits(): GPUSupportedLimits {
    return { min: {}, max: {} } as unknown as GPUSupportedLimits;
  }

  pushErrorScope(_filter: GPUErrorFilter): void {
    // TODO: implement error scopes via wgpuDevicePushErrorScope
  }

  async popErrorScope(): Promise<GPUError | null> {
    return null;
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
    const buffer = new WgpuBuffer(bufPtr, descriptor.size, this.queue);
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
    const magFilter = descriptor?.magFilter === "linear" ? 2 : 1;
    const minFilter = descriptor?.minFilter === "linear" ? 2 : 1;
    const addressU = descriptor?.addressModeU === "repeat" ? 2 : descriptor?.addressModeU === "mirror-repeat" ? 3 : 1;
    const addressV = descriptor?.addressModeV === "repeat" ? 2 : descriptor?.addressModeV === "mirror-repeat" ? 3 : 1;
    const samplerPtr = wgpu.wgpu_shim_create_sampler(this.ptr, magFilter, minFilter, addressU, addressV) as unknown as number;
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
      // Note: wgpu-native expects Undefined(1) for write-only (it defaults), not WriteOnly(2)
      flat[i * 8 + 6] = e.storageTexture?.access === "write-only" ? 1 : e.storageTexture?.access === "read-only" ? 3 : e.storageTexture?.access === "read-write" ? 4 : 0;
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
   */
  private createAutoBindGroupLayouts(shaderSources: string[]): WgpuBindGroupLayout[] {
    // Collect all bindings grouped by group index
    const groups: Map<number, Map<number, { type: string; visibility: number }>> = new Map();

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
        let visibility = 0; // Will be set to VERTEX | FRAGMENT by default
        let viewDimension = "2d"; // default for textures

        if (line.includes("var<uniform>")) {
          bindingType = "uniform";
        } else if (line.includes("var<storage,")) {
          if (line.includes("read")) bindingType = "read-only-storage";
          else bindingType = "storage";
        } else if (line.includes("var<storage>")) {
          bindingType = "storage";
        } else if (line.includes("texture_2d_array") || line.includes("texture_2d_array")) {
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
        }

        // Visibility: both vertex and fragment can see it (conservative default)
        visibility = 0x0001 | 0x0002; // VERTEX | FRAGMENT

        group.set(bindingIdx, { type: bindingType, visibility, viewDimension });
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
          entry.texture = { sampleType: "float", viewDimension: (info as any).viewDimension ?? "2d" };
        } else if (info.type === "sampler") {
          entry.sampler = { type: "filtering" };
        } else if (info.type === "comparison-sampler") {
          entry.sampler = { type: "comparison" };
        } else if (info.type === "storage-texture") {
          entry.storageTexture = { access: "write-only", format: "rgba8unorm" } as any;
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

    const colorFormat = fragment?.targets?.[0]?.format ? parseFormat(fragment.targets[0].format) : 0;
    const depthFormat = descriptor.depthStencil?.format ? parseFormat(descriptor.depthStencil.format) : 0;

    const topology = descriptor.primitive?.topology === "point-list" ? 1
      : descriptor.primitive?.topology === "line-list" ? 2
      : descriptor.primitive?.topology === "line-strip" ? 3
      : descriptor.primitive?.topology === "triangle-strip" ? 5
      : 4; // triangle-list (default)

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

    // Parse blend state from fragment target
    const blendState = fragment?.targets?.[0]?.blend;
    const hasBlend = blendState ? 1 : 0;
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
    const colorSrcFactor = parseBlendFactor(blendState?.color?.srcFactor);
    const colorDstFactor = parseBlendFactor(blendState?.color?.dstFactor);
    const colorOperation = parseBlendOp(blendState?.color?.operation);
    const alphaSrcFactor = parseBlendFactor(blendState?.alpha?.srcFactor);
    const alphaDstFactor = parseBlendFactor(blendState?.alpha?.dstFactor);
    const alphaOperation = parseBlendOp(blendState?.alpha?.operation);

    const pipelinePtr = wgpu.wgpu_shim_create_render_pipeline(
      this.ptr,
      vertexShader.ptr,
      vertexEntry,
      fragmentShader?.ptr ?? null as any,
      fragmentEntry,
      colorFormat,
      depthFormat,
      topology,
      sampleCount,
      layout?.ptr ?? null as any,
      cullMode,
      frontFace,
      vertexBufferCount,
      vertexBufferFlat?.buffer ?? new ArrayBuffer(0),
      hasBlend,
      colorSrcFactor, colorDstFactor, colorOperation,
      alphaSrcFactor, alphaDstFactor, alphaOperation,
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

  createQuerySet(_descriptor: GPUQuerySetDescriptor): any {
    // TODO: implement query sets for timestamp profiling
    return { destroy: () => {} };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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

  copyExternalImageToTexture(_source: GPUCopyExternalImageSourceInfo, _destination: GPUCopyExternalImageTextureInfo, _copySize: GPUExtent3D): void {
    // TODO: implement for image bitmap → texture copies
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

  constructor(ptr: number, size: number, queue: WgpuQueue) {
    this.ptr = ptr;
    this.size = size;
    this.queue = queue;
    this.mapped = false;
  }

  get mapState(): GPUBufferMapState {
    return this.mapped ? "mapped" : "unmapped";
  }

  async mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void> {
    const mapMode = mode === 1 ? 1 : mode === 2 ? 2 : 1; // read=1, write=2
    wgpu.wgpu_shim_buffer_map_async(this.ptr, mapMode, BigInt(offset ?? 0), BigInt(size ?? this.size));
    this.mapped = true;
  }

  getMappedRange(offset?: number, size?: number): ArrayBuffer {
    const byteLength = size ?? this.size;
    const result = new ArrayBuffer(byteLength);
    const outBuf = new Uint8Array(result);
    const status = wgpu.wgpu_shim_buffer_read_mapped(
      this.ptr,
      BigInt(offset ?? 0),
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
    wgpu.wgpu_shim_buffer_unmap(this.ptr);
    this.mapped = false;
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
    this.width = desc.size.width;
    this.height = desc.size.height;
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
    const aspect = descriptor?.aspect === "stencil-only" ? 1 : descriptor?.aspect === "depth-only" ? 2 : 0;
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
// WgpuShaderModule
// ============================================================================

export class WgpuShaderModule implements GPUShaderModule {
  readonly ptr: number;
  readonly code: string;

  constructor(ptr: number, code: string = "") {
    this.ptr = ptr;
    this.code = code;
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
    const colorAttachment = descriptor.colorAttachments[0];
    const colorView = colorAttachment.view as WgpuTextureView;
    const clearValue = colorAttachment.clearValue ?? { r: 0, g: 0, b: 0, a: 0 };
    const loadOp = colorAttachment.loadOp === "load" ? 1 : 2; // 1=load, 2=clear
    const storeOp = colorAttachment.storeOp === "discard" ? 2 : 1; // 1=store, 2=discard

    const depthAttachment = descriptor.depthStencilAttachment;
    const depthView = depthAttachment ? depthAttachment.view as WgpuTextureView : null;

    const passPtr = wgpu.wgpu_shim_begin_render_pass(
      this.ptr,
      colorView.ptr,
      clearValue.r ?? 0, clearValue.g ?? 0, clearValue.b ?? 0, clearValue.a ?? 0,
      loadOp, storeOp,
      depthView?.ptr ?? null as any,
    ) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin render pass");
    return new WgpuRenderPassEncoder(passPtr);
  }

  beginComputePass(_descriptor?: GPUComputePassDescriptor): WgpuComputePassEncoder {
    const passPtr = wgpu.wgpu_shim_begin_compute_pass(this.ptr) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin compute pass");
    return new WgpuComputePassEncoder(passPtr);
  }

  copyBufferToBuffer(source: WgpuBuffer, sourceOffset: number, destination: WgpuBuffer, destinationOffset: number, size: number): void {
    wgpu.wgpu_shim_copy_buffer_to_buffer(this.ptr, source.ptr, BigInt(sourceOffset), destination.ptr, BigInt(destinationOffset), BigInt(size));
  }

  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, copySize: GPUExtent3D): void {
    // TODO: implement via wgpu_shim_copy_texture_to_buffer
    // For now, use the screenshot-specific function
    const srcTexture = source.texture as WgpuTexture;
    const dstBuffer = destination.buffer as WgpuBuffer;
    wgpu.wgpu_shim_copy_texture_to_buffer(
      this.ptr,
      srcTexture.ptr,
      dstBuffer.ptr,
      copySize.width,
      copySize.height,
      destination.layout.bytesPerRow,
    );
  }

  copyBufferToTexture(_source: GPUTexelCopyBufferInfo, _destination: GPUTexelCopyTextureInfo, _copySize: GPUExtent3D): void {
    // TODO: implement
  }

  copyTextureToTexture(_source: GPUTexelCopyTextureInfo, _destination: GPUTexelCopyTextureInfo, _copySize: GPUExtent3D): void {
    // TODO: implement
  }

  finish(_descriptor?: GPUCommandBufferDescriptor): WgpuCommandBuffer {
    const cmdPtr = wgpu.wgpu_shim_command_encoder_finish(this.ptr) as unknown as number;
    if (!cmdPtr) throw new Error("Failed to finish command encoder");
    const cmd = new WgpuCommandBuffer(cmdPtr);
    registry.register(cmd, { ptr: cmdPtr, release: () => wgpu.wgpu_shim_release_command_buffer(cmdPtr) }, cmd);
    return cmd;
  }

  clearBuffer(_buffer: WgpuBuffer, _offset?: number, _size?: number): void {
    // TODO: implement
  }

  pushDebugGroup(_groupLabel: string): void {}
  popDebugGroup(): void {}
  insertDebugMarker(_markerLabel: string): void {}
  writeTimestamp(_querySet: any, _queryIndex: number): void {}
  resolveQuerySet(_querySet: any, _firstQuery: number, _queryCount: number, _destination: WgpuBuffer, _destinationOffset: number): void {}
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

  drawIndirect(_indirectBuffer: WgpuBuffer, _indirectOffset: number): void {
    // TODO: implement
  }

  drawIndexedIndirect(_indirectBuffer: WgpuBuffer, _indirectOffset: number): void {
    // TODO: implement
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

  // Stubs for methods the engine may call
  setBlendConstant(_color: GPUColor): void {}
  setStencilReference(_reference: number): void {}
  pushDebugGroup(_groupLabel: string): void {}
  popDebugGroup(): void {}
  insertDebugMarker(_markerLabel: string): void {}
  beginOcclusionQuery(_queryIndex: number): void {}
  endOcclusionQuery(): void {}
  executeBundles(_bundles: any[]): void {}
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

  dispatchWorkgroupsIndirect(_indirectBuffer: WgpuBuffer, _indirectOffset: number): void {
    // TODO: implement
  }

  end(): void {
    if (this.ended) return;
    wgpu.wgpu_shim_compute_pass_end(this.ptr);
    this.ended = true;
  }

  pushDebugGroup(_groupLabel: string): void {}
  popDebugGroup(): void {}
  insertDebugMarker(_markerLabel: string): void {}
}
