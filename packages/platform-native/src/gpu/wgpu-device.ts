// ============================================================================
// wgpu-device.ts — WgpuGPU / WgpuAdapter / WgpuDevice / WgpuQueue
//
// These classes intentionally do NOT `implements` the @webgpu/types
// interfaces — newer versions of the types add a `__brand` marker that makes
// structural conformance impossible. The wrapper deliberately exposes
// runtime extras (`.ptr`, `.code`), so conformance is asserted at the
// boundary in install.ts via `as unknown as GPU` casts.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import {
    formatName,
    isBGRAFormat,
    parseAspect,
    parseBlendFactor,
    parseBlendOp,
    parseCompare,
    parseExtent3D,
    parseFormat,
    parseOrigin3D,
    parseStencilOp,
    parseTextureDimension,
    parseVertexFormat,
    parseViewDimension,
} from "./enums";
import {
    queryNativeFeatures,
    queryNativeLimits,
    serializeRequiredFeatures,
    serializeRequiredLimits,
} from "./limits";
import { trackForRelease, untrack } from "./registry";
import { WgpuCommandEncoder } from "./wgpu-encoder";
import { wgpu } from "./wgpu-ffi";
import {
    WgpuBindGroup,
    WgpuBindGroupLayout,
    WgpuBuffer,
    WgpuCommandBuffer,
    WgpuComputePipeline,
    WgpuPipelineLayout,
    WgpuQuerySet,
    WgpuRenderPipeline,
    WgpuSampler,
    WgpuShaderModule,
    WgpuTexture,
    WgpuTextureView,
} from "./wgpu-resources";

const log = createLogger("info");

// ── Live-device registry ──
// Every WgpuDevice registers itself so the window event loop can poll the
// native device-lost flag for ALL devices (the host's device, plus any device
// a renderer created itself — GameRenderer.init opens its own). Without this
// pump, device.lost never resolves on native and the entire loss-recovery
// path (GameRenderer.recoverDevice, game .lost handlers) is dead code.
const liveDevices = new Set<WgpuDevice>();

/** Poll the native device-lost flag on every live device. Called once per
 *  frame by the NativeWindow event loop. */
export function pollLiveDevicesLost(): void {
  for (const d of liveDevices.values()) d.pollLost();
}

/** Snapshot of currently-live devices — the dev shell diffs this set to
 *  destroy only session-created devices on an HMR session restart. */
export function getLiveDevices(): ReadonlySet<WgpuDevice> {
  return liveDevices;
}

// ============================================================================
// WgpuGPU — the navigator.gpu equivalent
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
    return formatName(fmt);
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

/** Parsed wgpu AdapterInfo — the structured counterpart to GPUAdapterInfo. */
export interface NativeAdapterInfo {
  name: string;
  vendor: number;
  device: number;
  /** "integrated-gpu" | "discrete-gpu" | "virtual-gpu" | "cpu" | "other". */
  deviceType: string;
  backend: string;
  driver: string;
  driverInfo: string;
}

/** Read the adapter's real info over FFI. Returns null on failure. */
export function queryNativeAdapterInfo(adapterPtr: number): NativeAdapterInfo | null {
  const buf = new Uint8Array(2048);
  const n = wgpu.wgpu_shim_adapter_get_info(adapterPtr, buf as any, buf.length);
  if (n <= 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf.subarray(0, n))) as NativeAdapterInfo;
  } catch {
    return null;
  }
}

export class WgpuAdapter {
  readonly ptr: number;
  private instancePtr: number;
  private _limits: GPUSupportedLimits | null = null;
  private _features: GPUSupportedFeatures | null = null;
  private _info: NativeAdapterInfo | null | undefined;

  constructor(ptr: number, instancePtr: number) {
    this.ptr = ptr;
    this.instancePtr = instancePtr;
  }

  /** Structured adapter info (deviceType, backend, driver) — null if the FFI query failed. */
  get nativeInfo(): NativeAdapterInfo | null {
    if (this._info === undefined) this._info = queryNativeAdapterInfo(this.ptr);
    return this._info;
  }

  get info(): GPUAdapterInfo {
    const n = this.nativeInfo;
    if (!n) {
      return {
        vendor: "wgpu-native",
        architecture: "unknown",
        description: "wgpu-native",
        subgroupMinSize: 0,
      } as GPUAdapterInfo;
    }
    return {
      // WebGPU spec fields: vendor/architecture are hex strings on web;
      // wgpu gives us numeric IDs + the real name instead.
      vendor: n.vendor ? `0x${n.vendor.toString(16)}` : "unknown",
      architecture: n.backend,
      device: n.name,
      description: [n.driver, n.driverInfo].filter(Boolean).join(" ") || n.name,
      subgroupMinSize: 0,
      // Non-standard extras (deviceType is the software-rasterizer signal
      // used to gate timestamp queries on lavapipe-class drivers).
      deviceType: n.deviceType,
      driver: n.driver,
      driverInfo: n.driverInfo,
    } as unknown as GPUAdapterInfo;
  }

  get limits(): GPUSupportedLimits {
    return (this._limits ??= queryNativeLimits(this.ptr, false));
  }

  get features(): GPUSupportedFeatures {
    return (this._features ??= queryNativeFeatures(this.ptr, false));
  }

  async requestDevice(descriptor?: GPUDeviceDescriptor): Promise<WgpuDevice> {
    // Serialize the full requiredLimits + requiredFeatures descriptor instead
    // of the previous four hardcoded limit fields.
    const limits = serializeRequiredLimits(
      descriptor?.requiredLimits as Record<string, number | bigint | undefined> | undefined,
    );
    const features = serializeRequiredFeatures(
      descriptor?.requiredFeatures as Iterable<string> | undefined,
    );

    const devicePtr = wgpu.wgpu_shim_request_device(
      this.ptr,
      limits as unknown as ptr,
      limits.length / 3,
      features as unknown as ptr,
      features.length,
    ) as unknown as number;

    if (!devicePtr) throw new Error("Failed to create GPU device");

    const device = new WgpuDevice(devicePtr, this.instancePtr);
    device.adapterInfo = this.nativeInfo;
    trackForRelease(device, () => wgpu.wgpu_shim_release_device(devicePtr));
    return device;
  }
}

// ============================================================================
// WgpuDevice
// ============================================================================

interface ParsedBinding {
  type: string;
  visibility: number;
  viewDimension?: string;
  storageFormat?: string;
  /** texture_depth_* — layout needs sampleType "depth", not "float". */
  depth?: boolean;
  /** texture_multisampled_* — layout needs multisampled: true. */
  multisampled?: boolean;
  hasDynamicOffset: boolean;
}

export class WgpuDevice {
  readonly ptr: number;
  /** The default queue. Public so callers can writeBuffer/submit directly. */
  readonly queue: WgpuQueue;
  label = "";
  /** Adapter info captured at requestDevice() — null on worker-attached views
   *  (the shared-device attach path never sees the adapter). */
  adapterInfo: NativeAdapterInfo | null = null;

  private instancePtr: number;
  /** False for worker-attached (non-owning) device views — destroy() only
   *  unwires local state and never releases the native device handle. */
  private readonly ownsHandle: boolean;
  /** Set by shareDevice() — an i64[2] SAB view [generation, alive]. When the
   *  owner observes device loss it stores 0 to cell 1 so attached workers
   *  can observe the death without a message round-trip. */
  sharedState: BigInt64Array | null = null;
  /** Generation this device was shared at (set by shareDevice) — guards
   *  liveness writes so a replaced device can't clobber a newer
   *  generation's cells. */
  sharedStateGen = 0n;
  private destroyed = false;
  private lostResolve: ((info: GPUDeviceLostInfo) => void) | null = null;
  readonly lost: Promise<GPUDeviceLostInfo>;
  private _limits: GPUSupportedLimits | null = null;
  private _features: GPUSupportedFeatures | null = null;
  private _lostReported = false;

  constructor(ptr: number, instancePtr: number, options?: { ownsHandle?: boolean }) {
    this.ptr = ptr;
    this.instancePtr = instancePtr;
    this.ownsHandle = options?.ownsHandle !== false;
    const queuePtr = wgpu.wgpu_shim_device_get_queue(ptr) as unknown as number;
    this.queue = new WgpuQueue(queuePtr);
    this.lost = new Promise((resolve) => { this.lostResolve = resolve; });
    liveDevices.add(this);
  }

  /**
   * Pump wgpu-native event processing. Called every frame by the window
   * loop. Also polls the device-lost flag the C shim records from the
   * device-lost callback.
   */
  processEvents(): void {
    wgpu.wgpu_shim_process_events(this.instancePtr as any);
    this.pollLost();
  }

  getInstancePtr(): number { return this.instancePtr; }

  /** Write the shared alive-cell to 0, unless the cells have moved on to a
   *  newer generation (a re-share) — guards a replaced device from clobbering
   *  the new device's liveness. */
  private writeDead(): void {
    const s = this.sharedState;
    if (s && Atomics.load(s as any, 0) === this.sharedStateGen) {
      Atomics.store(s as any, 1, 0n);
    }
  }

  /**
   * Poll the device-lost flag the C shim records from the device-lost
   * callback and resolve `.lost` when the device died. Called once per frame
   * by pollLiveDevicesLost() from the window loop — the instance-level
   * wgpuInstanceProcessEvents() pump does NOT cover this check on its own.
   */
  pollLost(): void {
    if (this._lostReported || this.destroyed) return;
    const msgBuf = new Uint8Array(512);
    const reason = wgpu.wgpu_shim_device_poll_lost(this.ptr, msgBuf as unknown as ptr, msgBuf.length);
    if (reason === 0) return;
    this._lostReported = true;
    this.writeDead();
    const message = new TextDecoder().decode(msgBuf).replace(/\0.*$/, "") || "wgpu device lost";
    // WGPUDeviceLostReason: Unknown=1, Destroyed=2, CallbackCancelled=3,
    // FailedCreation=4. GPUDeviceLostInfo only knows "unknown"/"destroyed".
    this.lostResolve?.({
      reason: reason === 2 ? "destroyed" : "unknown",
      message,
    } as GPUDeviceLostInfo);
  }

  get features(): GPUSupportedFeatures {
    return (this._features ??= queryNativeFeatures(this.ptr, true));
  }

  get limits(): GPUSupportedLimits {
    return (this._limits ??= queryNativeLimits(this.ptr, true));
  }

  pushErrorScope(filter: GPUErrorFilter): void {
    // WGPUErrorFilter: Validation=1, OutOfMemory=2, Internal=3
    const filterVal = filter === "validation" ? 1 : filter === "out-of-memory" ? 2 : filter === "internal" ? 3 : 1;
    wgpu.wgpu_shim_device_push_error_scope(this.ptr, filterVal);
  }

  async popErrorScope(): Promise<GPUError | null> {
    const msgBuf = new Uint8Array(4096);
    const errorType = wgpu.wgpu_shim_device_pop_error_scope(this.ptr, msgBuf as any, msgBuf.length);
    // WGPUErrorType: NoError=1, Validation=2, OutOfMemory=3, Internal=4, Unknown=5
    if (errorType === 1 || errorType === 0) return null;
    const msg = new TextDecoder().decode(msgBuf).replace(/\0+$/, "");
    const type = errorType === 2 ? "validation" : errorType === 3 ? "out-of-memory" : errorType === 4 ? "internal" : "unknown";
    return { type, message: msg } as GPUError;
  }

  createBuffer(descriptor: GPUBufferDescriptor): WgpuBuffer {
    const bufPtr = wgpu.wgpu_shim_create_buffer(
      this.ptr,
      BigInt(descriptor.size),
      descriptor.usage,
      descriptor.mappedAtCreation ? 1 : 0,
    ) as unknown as number;
    if (!bufPtr) throw new Error(`Failed to create buffer (size=${descriptor.size}, usage=${descriptor.usage})`);
    const buffer = new WgpuBuffer(bufPtr, descriptor.size, this.queue, !!descriptor.mappedAtCreation);
    trackForRelease(buffer, () => wgpu.wgpu_shim_release_buffer(bufPtr));
    return buffer;
  }

  createTexture(descriptor: GPUTextureDescriptor): WgpuTexture {
    const format = parseFormat(descriptor.format);
    const dimension = parseTextureDimension(descriptor.dimension);
    const { width, height, depthOrArrayLayers } = parseExtent3D(descriptor.size);

    // Forward viewFormats so callers can reinterpret the texture (e.g.
    // rgba8unorm surface viewed as rgba8unorm-srgb).
    let viewFormatsArr: Uint32Array | null = null;
    const vf = (descriptor as any).viewFormats as string[] | undefined;
    if (vf && vf.length > 0) {
      viewFormatsArr = new Uint32Array(vf.map((f) => parseFormat(f)));
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
      descriptor.usage,
      viewFormatsArr ? viewFormatsArr.length : 0,
      (viewFormatsArr ?? 0) as unknown as ptr,
    ) as unknown as number;
    if (!texPtr) throw new Error(`Failed to create texture (${width}x${height})`);
    const texture = new WgpuTexture(texPtr, descriptor);
    trackForRelease(texture, () => wgpu.wgpu_shim_release_texture(texPtr));
    return texture;
  }

  createSampler(descriptor?: GPUSamplerDescriptor): WgpuSampler {
    const magFilter = descriptor?.magFilter === "linear" ? 2 : 1;
    const minFilter = descriptor?.minFilter === "linear" ? 2 : 1;
    const mipmapFilter = descriptor?.mipmapFilter === "linear" ? 2 : 1;
    const addressU = descriptor?.addressModeU === "repeat" ? 2 : descriptor?.addressModeU === "mirror-repeat" ? 3 : 1;
    const addressV = descriptor?.addressModeV === "repeat" ? 2 : descriptor?.addressModeV === "mirror-repeat" ? 3 : 1;
    const addressW = descriptor?.addressModeW === "repeat" ? 2 : descriptor?.addressModeW === "mirror-repeat" ? 3 : 1;
    const lodMinClamp = descriptor?.lodMinClamp ?? 0;
    const lodMaxClamp = descriptor?.lodMaxClamp ?? 32;
    const compare = descriptor?.compare ? parseCompare(descriptor.compare) : 0;
    const maxAnisotropy = descriptor?.maxAnisotropy ?? 1;
    const samplerPtr = wgpu.wgpu_shim_create_sampler(
      this.ptr, magFilter, minFilter, mipmapFilter,
      addressU, addressV, addressW, lodMinClamp, lodMaxClamp, compare, maxAnisotropy,
    ) as unknown as number;
    const sampler = new WgpuSampler(samplerPtr);
    trackForRelease(sampler, () => wgpu.wgpu_shim_release_sampler(samplerPtr));
    return sampler;
  }

  createShaderModule(descriptor: GPUShaderModuleDescriptor): WgpuShaderModule {
    const shaderPtr = wgpu.wgpu_shim_create_shader_module(this.ptr, descriptor.code) as unknown as number;
    if (!shaderPtr) throw new Error("Failed to create shader module");
    const shader = new WgpuShaderModule(shaderPtr, descriptor.code);
    trackForRelease(shader, () => wgpu.wgpu_shim_release_shader_module(shaderPtr));
    return shader;
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): WgpuBindGroupLayout {
    const entries = Array.from(descriptor.entries);

    const seen = new Set<number>();
    entries.forEach((e) => {
      if (seen.has(e.binding)) {
        log.warn("createBindGroupLayout", `Duplicate binding ${e.binding} — entries: ${
          entries.map((e) => `b${e.binding}:${e.buffer ? "buf" : e.texture ? "tex" : e.sampler ? "smp" : e.storageTexture ? "stex" : "?"}`).join(", ")}`);
      }
      seen.add(e.binding);
    });

    // 11 u32 per entry: binding, visibility, buffer_type, sampler_type,
    // texture_sample_type, texture_view_dimension, storage_access,
    // storage_format, has_dynamic_offset, min_binding_size_lo, min_binding_size_hi
    const flat = new Uint32Array(entries.length * 11);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const base = i * 11;
      flat[base + 0] = e.binding;
      flat[base + 1] = e.visibility ?? 0;
      flat[base + 2] = e.buffer?.type === "uniform" ? 2 : e.buffer?.type === "storage" ? 3 : e.buffer?.type === "read-only-storage" ? 4 : e.buffer ? 1 : 0;
      flat[base + 3] = e.sampler?.type === "filtering" ? 2 : e.sampler?.type === "non-filtering" ? 3 : e.sampler?.type === "comparison" ? 4 : e.sampler ? 1 : 0;
      flat[base + 4] = e.texture?.sampleType === "float" ? 2 : e.texture?.sampleType === "unfilterable-float" ? 3 : e.texture?.sampleType === "depth" ? 4 : e.texture?.sampleType === "sint" ? 5 : e.texture?.sampleType === "uint" ? 6 : e.texture ? 1 : 0;
      const viewDim = e.texture?.viewDimension ?? e.storageTexture?.viewDimension;
      flat[base + 5] = viewDim ? parseViewDimension(viewDim) : (e.texture || e.storageTexture) ? 2 : 0;
      flat[base + 6] = e.storageTexture?.access === "write-only" ? 2 : e.storageTexture?.access === "read-only" ? 3 : e.storageTexture?.access === "read-write" ? 4 : 0;
      flat[base + 7] = e.storageTexture?.format ? parseFormat(e.storageTexture.format) : 0;
      flat[base + 8] = e.buffer?.hasDynamicOffset ? 1 : 0;
      const minSize = BigInt(e.buffer?.minBindingSize ?? 0);
      flat[base + 9] = Number(minSize & 0xFFFFFFFFn);
      flat[base + 10] = Number(minSize >> 32n);
    }
    const layoutPtr = wgpu.wgpu_shim_create_bind_group_layout(this.ptr, entries.length, flat as unknown as ptr) as unknown as number;
    if (!layoutPtr) throw new Error("Failed to create bind group layout");
    const layout = new WgpuBindGroupLayout(layoutPtr);
    trackForRelease(layout, () => wgpu.wgpu_shim_release_bind_group_layout(layoutPtr));
    return layout;
  }

  /**
   * Parse WGSL source for @group/@binding declarations and build bind group
   * layouts — used by the `layout: "auto"` pipeline path.
   *
   * Parsed bindings are cached per shader module (WeakMap) so pipelines
   * sharing a module don't re-scan the WGSL source.
   */
  private static bindingCache = new WeakMap<WgpuShaderModule, Map<number, Map<number, ParsedBinding>>>();

  private parseShaderBindings(shader: WgpuShaderModule): Map<number, Map<number, ParsedBinding>> {
    const cached = WgpuDevice.bindingCache.get(shader);
    if (cached) return cached;

    const groups = new Map<number, Map<number, ParsedBinding>>();
    const isCompute = shader.code.includes("@compute");
    const defaultVisibility = isCompute ? 0x0004 : 0x0001 | 0x0002;

    for (const line of shader.code.split("\n")) {
      const groupMatch = line.match(/@group\((\d+)\)\s*@binding\((\d+)\)/);
      if (!groupMatch) continue;
      const groupIdx = parseInt(groupMatch[1]);
      const bindingIdx = parseInt(groupMatch[2]);

      if (!groups.has(groupIdx)) groups.set(groupIdx, new Map());
      const group = groups.get(groupIdx)!;

      let bindingType = "uniform";
      let viewDimension = "2d";
      let storageFormat: string | undefined;
      let depth = false;
      let multisampled = false;

      if (line.includes("var<uniform>")) {
        bindingType = "uniform";
      } else if (line.includes("var<storage,")) {
        // read_write must be checked before "read" — `includes("read")` also
        // matches "read_write" and would silently demote it to read-only.
        bindingType = line.includes("read_write") ? "storage"
          : line.includes("read") ? "read-only-storage" : "storage";
      } else if (line.includes("var<storage>")) {
        bindingType = "storage";
      } else if (line.includes("texture_depth")) {
        // texture_depth_2d / _2d_array / _cube / _cube_array / _multisampled_2d
        bindingType = "texture"; depth = true;
        if (line.includes("texture_depth_2d_array")) viewDimension = "2d-array";
        else if (line.includes("texture_depth_cube_array")) viewDimension = "cube-array";
        else if (line.includes("texture_depth_cube")) viewDimension = "cube";
        if (line.includes("multisampled")) multisampled = true;
      } else if (line.includes("texture_multisampled_2d")) {
        bindingType = "texture"; viewDimension = "2d"; multisampled = true;
      } else if (line.includes("texture_2d_array")) {
        bindingType = "texture"; viewDimension = "2d-array";
      } else if (line.includes("texture_cube_array")) {
        bindingType = "texture"; viewDimension = "cube-array";
      } else if (line.includes("texture_cube")) {
        bindingType = "texture"; viewDimension = "cube";
      } else if (line.includes("texture_3d")) {
        bindingType = "texture"; viewDimension = "3d";
      } else if (line.includes("texture_1d")) {
        bindingType = "texture"; viewDimension = "1d";
      } else if (line.includes("texture_2d")) {
        bindingType = "texture"; viewDimension = "2d";
      } else if (line.includes("sampler")) {
        bindingType = line.includes("sampler_comparison") ? "comparison-sampler" : "sampler";
      } else if (line.includes("texture_storage")) {
        bindingType = "storage-texture";
        if (line.includes("texture_storage_2d_array")) viewDimension = "2d-array";
        else if (line.includes("texture_storage_3d")) viewDimension = "3d";
        const fmtMatch = line.match(/texture_storage_\w+d<(\w+)/);
        if (fmtMatch) storageFormat = fmtMatch[1];
      }

      // hasDynamicOffset is a layout-creation property, not discoverable from
      // WGSL — auto layouts leave it off; callers needing dynamic offsets
      // must use explicit createBindGroupLayout().
      group.set(bindingIdx, {
        type: bindingType,
        visibility: defaultVisibility,
        viewDimension,
        storageFormat,
        depth,
        multisampled,
        hasDynamicOffset: false,
      });
    }

    WgpuDevice.bindingCache.set(shader, groups);
    return groups;
  }

  private createAutoBindGroupLayouts(shaders: WgpuShaderModule[]): WgpuBindGroupLayout[] {
    // Merge per-module binding tables into a single group→binding map.
    const merged = new Map<number, Map<number, ParsedBinding>>();
    shaders.forEach((shader) => {
      for (const [groupIdx, bindings] of this.parseShaderBindings(shader)) {
        if (!merged.has(groupIdx)) merged.set(groupIdx, new Map());
        const group = merged.get(groupIdx)!;
        for (const [bindingIdx, info] of bindings.entries()) group.set(bindingIdx, info);
      }
    });

    const layouts: WgpuBindGroupLayout[] = [];
    for (const groupIdx of Array.from(merged.keys()).sort((a, b) => a - b)) {
      const group = merged.get(groupIdx)!;
      const entries: GPUBindGroupLayoutEntry[] = [];
      for (const bindingIdx of Array.from(group.keys()).sort((a, b) => a - b)) {
        const info = group.get(bindingIdx)!;
        const entry: GPUBindGroupLayoutEntry = { binding: bindingIdx, visibility: info.visibility };
        if (info.type === "uniform") entry.buffer = { type: "uniform" };
        else if (info.type === "storage") entry.buffer = { type: "storage" };
        else if (info.type === "read-only-storage") entry.buffer = { type: "read-only-storage" };
        else if (info.type === "texture") entry.texture = { sampleType: info.depth ? "depth" : "float", viewDimension: (info.viewDimension ?? "2d") as GPUTextureViewDimension, multisampled: info.multisampled === true };
        else if (info.type === "sampler") entry.sampler = { type: "filtering" };
        else if (info.type === "comparison-sampler") entry.sampler = { type: "comparison" };
        else if (info.type === "storage-texture") entry.storageTexture = { access: "write-only", format: (info.storageFormat ?? "rgba8unorm") as GPUTextureFormat };
        entries.push(entry);
      }
      layouts.push(this.createBindGroupLayout({ entries }));
    }
    return layouts;
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): WgpuPipelineLayout {
    const layouts = Array.from(descriptor.bindGroupLayouts) as unknown as WgpuBindGroupLayout[];
    const ptrs = new BigUint64Array(layouts.length);
    for (let i = 0; i < layouts.length; i++) {
      ptrs[i] = BigInt(layouts[i].ptr);
    }
    const layoutPtr = wgpu.wgpu_shim_create_pipeline_layout(this.ptr, layouts.length, ptrs as unknown as ptr) as unknown as number;
    if (!layoutPtr) throw new Error("Failed to create pipeline layout");
    const layout = new WgpuPipelineLayout(layoutPtr, layouts);
    trackForRelease(layout, () => wgpu.wgpu_shim_release_pipeline_layout(layoutPtr));
    return layout;
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): WgpuBindGroup {
    const entries = Array.from(descriptor.entries);
    // 8 u32 per entry: binding, type, ptr_lo, ptr_hi, offset_lo, offset_hi, size_lo, size_hi
    const flat = new Uint32Array(entries.length * 8);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const base = i * 8;
      flat[base + 0] = e.binding;
      const res = e.resource;
      if (res instanceof WgpuBuffer) {
        flat[base + 1] = 0;
        flat[base + 2] = res.ptr & 0xFFFFFFFF;
        flat[base + 3] = Math.floor(res.ptr / 0x100000000);
        flat[base + 6] = res.size & 0xFFFFFFFF;
        flat[base + 7] = Math.floor(res.size / 0x100000000);
      } else if (res instanceof WgpuSampler) {
        flat[base + 1] = 1;
        flat[base + 2] = res.ptr & 0xFFFFFFFF;
        flat[base + 3] = Math.floor(res.ptr / 0x100000000);
      } else if (res instanceof WgpuTextureView) {
        flat[base + 1] = 2;
        flat[base + 2] = res.ptr & 0xFFFFFFFF;
        flat[base + 3] = Math.floor(res.ptr / 0x100000000);
      } else if (typeof res === "object" && res !== null && "buffer" in res) {
        const buf = res.buffer as unknown as WgpuBuffer;
        flat[base + 1] = 0;
        flat[base + 2] = buf.ptr & 0xFFFFFFFF;
        flat[base + 3] = Math.floor(buf.ptr / 0x100000000);
        const offset = BigInt(res.offset ?? 0);
        const size = BigInt(res.size ?? buf.size);
        flat[base + 4] = Number(offset & 0xFFFFFFFFn);
        flat[base + 5] = Number(offset >> 32n);
        flat[base + 6] = Number(size & 0xFFFFFFFFn);
        flat[base + 7] = Number(size >> 32n);
      } else {
        throw new Error(`Unknown bind group resource type for binding ${e.binding}`);
      }
    }
    const layout = descriptor.layout as unknown as WgpuBindGroupLayout;
    const bgPtr = wgpu.wgpu_shim_create_bind_group(this.ptr, layout.ptr, entries.length, flat as unknown as ptr) as unknown as number;
    if (!bgPtr) throw new Error("Failed to create bind group");
    const bg = new WgpuBindGroup(bgPtr);
    trackForRelease(bg, () => wgpu.wgpu_shim_release_bind_group(bgPtr));
    return bg;
  }

  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): WgpuRenderPipeline {
    const vertex = descriptor.vertex;
    const vertexShader = vertex.module as unknown as WgpuShaderModule;
    const vertexEntry = vertex.entryPoint ?? "main";

    const fragment = descriptor.fragment;
    const fragmentShader = fragment ? (fragment.module as unknown as WgpuShaderModule) : null;
    const fragmentEntry = fragment?.entryPoint ?? "main";

    // Color targets: 9 u32 each
    // [format, hasBlend, colorSrc, colorDst, colorOp, alphaSrc, alphaDst, alphaOp, writeMask]
    const targets = fragment ? Array.from(fragment.targets) : [];
    const colorTargetCount = targets.length;
    let colorTargetsFlat: Uint32Array | null = null;
    if (colorTargetCount > 0) {
      colorTargetsFlat = new Uint32Array(colorTargetCount * 9);
      for (let i = 0; i < colorTargetCount; i++) {
        const t = targets[i];
        const bs = t?.blend;
        const base = i * 9;
        colorTargetsFlat[base + 0] = t?.format ? parseFormat(t.format) : 0;
        colorTargetsFlat[base + 1] = bs ? 1 : 0;
        colorTargetsFlat[base + 2] = parseBlendFactor(bs?.color?.srcFactor);
        colorTargetsFlat[base + 3] = parseBlendFactor(bs?.color?.dstFactor);
        colorTargetsFlat[base + 4] = parseBlendOp(bs?.color?.operation);
        colorTargetsFlat[base + 5] = parseBlendFactor(bs?.alpha?.srcFactor);
        colorTargetsFlat[base + 6] = parseBlendFactor(bs?.alpha?.dstFactor);
        colorTargetsFlat[base + 7] = parseBlendOp(bs?.alpha?.operation);
        // WGPUColorWriteMask: None=0, Red=1, Green=2, Blue=4, Alpha=8, All=0xF
        colorTargetsFlat[base + 8] = t?.writeMask === undefined ? 0xF : (t.writeMask & 0xF);
      }
    }

    // Depth-stencil: 16 u32 (see native-rs/src/gpu/mod.rs for layout)
    let depthStencilFlat: Uint32Array | null = null;
    const ds = descriptor.depthStencil;
    if (ds) {
      depthStencilFlat = new Uint32Array(16);
      depthStencilFlat[0] = ds.format ? parseFormat(ds.format) : 0;
      // WGPUOptionalBool: False=0, True=1, Undefined=2
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
      const scratch = new ArrayBuffer(4);
      new Int32Array(scratch)[0] = ds.depthBias ?? 0;
      depthStencilFlat[13] = new Uint32Array(scratch)[0];
      new Float32Array(scratch)[0] = ds.depthBiasSlopeScale ?? 0;
      depthStencilFlat[14] = new Uint32Array(scratch)[0];
      new Float32Array(scratch)[0] = ds.depthBiasClamp ?? 0;
      depthStencilFlat[15] = new Uint32Array(scratch)[0];
    }

    const topology = descriptor.primitive?.topology === "point-list" ? 1
      : descriptor.primitive?.topology === "line-list" ? 2
      : descriptor.primitive?.topology === "line-strip" ? 3
      : descriptor.primitive?.topology === "triangle-strip" ? 5
      : 4;

    const stripIndexFormat = descriptor.primitive?.stripIndexFormat === "uint16" ? 1
      : descriptor.primitive?.stripIndexFormat === "uint32" ? 2 : 0;

    const cullMode = descriptor.primitive?.cullMode === "front" ? 2 : descriptor.primitive?.cullMode === "back" ? 3 : 1;
    const frontFace = descriptor.primitive?.frontFace === "cw" ? 2 : 1;
    const sampleCount = descriptor.multisample?.count ?? 1;

    // layout: "auto" → parse the shader sources for @group/@binding
    let layout = descriptor.layout as unknown as WgpuPipelineLayout | "auto" | null;
    let autoBindGroupLayouts: WgpuBindGroupLayout[] = [];
    let layoutPtr: number = 0;
    if (layout === "auto") {
      const shaders = fragmentShader ? [vertexShader, fragmentShader] : [vertexShader];
      autoBindGroupLayouts = this.createAutoBindGroupLayouts(shaders);
      if (autoBindGroupLayouts.length > 0) {
        const autoLayout = this.createPipelineLayout({ bindGroupLayouts: autoBindGroupLayouts as unknown as Iterable<GPUBindGroupLayout> });
        layoutPtr = autoLayout.ptr;
        layout = autoLayout;
      }
    } else if (layout) {
      layoutPtr = (layout as WgpuPipelineLayout).ptr;
    }

    // Vertex buffers — flat: per buffer [arrayStride, stepMode, attrCount,
    //   then attrCount * 3 u32: format, offset, shaderLocation]
    // WebGPU allows null holes in vertex.buffers; the C shim has no null-slot
    // concept, so emit a zero-stride/zero-attr entry to keep the walk aligned.
    const buffers = vertex.buffers ? Array.from(vertex.buffers) : [];
    let vertexBufferCount = 0;
    let vertexBufferFlat: Uint32Array | null = null;
    if (buffers.length > 0) {
      let totalSize = 0;
      buffers.forEach((buf) => {
        totalSize += 3 + (buf?.attributes ? Array.from(buf.attributes).length : 0) * 3;
      });
      vertexBufferFlat = new Uint32Array(totalSize);
      let offset = 0;
      for (let _i29326 = 0, _it29326 = buffers, _n29326 = _it29326.length; _i29326 < _n29326; _i29326++) { const buf = _it29326[_i29326];
        vertexBufferFlat[offset++] = buf?.arrayStride ?? 0;
        vertexBufferFlat[offset++] = buf?.stepMode === "instance" ? 1 : 0;
        const attrs = buf?.attributes ? Array.from(buf.attributes) : [];
        vertexBufferFlat[offset++] = attrs.length;
        for (let _i29725 = 0, _it29725 = attrs, _n29725 = _it29725.length; _i29725 < _n29725; _i29725++) { const attr = _it29725[_i29725];
          vertexBufferFlat[offset++] = parseVertexFormat(attr.format);
          vertexBufferFlat[offset++] = attr.offset;
          vertexBufferFlat[offset++] = attr.shaderLocation;
        };
      };
      vertexBufferCount = buffers.length;
    }

    const pipelinePtr = wgpu.wgpu_shim_create_render_pipeline(
      this.ptr,
      vertexShader.ptr,
      vertexEntry,
      (fragmentShader?.ptr ?? 0) as unknown as ptr,
      fragmentEntry,
      colorTargetCount,
      (colorTargetsFlat ?? 0) as unknown as ptr,
      (depthStencilFlat ?? 0) as unknown as ptr,
      topology,
      stripIndexFormat,
      sampleCount,
      layoutPtr as ptr,
      cullMode,
      frontFace,
      vertexBufferCount,
      (vertexBufferFlat ?? 0) as unknown as ptr,
    ) as unknown as number;
    if (!pipelinePtr) throw new Error("Failed to create render pipeline");
    const pipeline = new WgpuRenderPipeline(
      pipelinePtr,
      (layout instanceof WgpuPipelineLayout ? layout.bindGroupLayouts : autoBindGroupLayouts),
    );
    trackForRelease(pipeline, () => wgpu.wgpu_shim_release_render_pipeline(pipelinePtr));
    return pipeline;
  }

  createComputePipeline(descriptor: GPUComputePipelineDescriptor): WgpuComputePipeline {
    const compute = descriptor.compute;
    const shader = compute.module as unknown as WgpuShaderModule;
    const entry = compute.entryPoint ?? "main";

    let layout = descriptor.layout as unknown as WgpuPipelineLayout | "auto" | null;
    let autoBindGroupLayouts: WgpuBindGroupLayout[] = [];
    let layoutPtr: number = 0;
    if (layout === "auto") {
      autoBindGroupLayouts = this.createAutoBindGroupLayouts([shader]);
      if (autoBindGroupLayouts.length > 0) {
        const autoLayout = this.createPipelineLayout({ bindGroupLayouts: autoBindGroupLayouts as unknown as Iterable<GPUBindGroupLayout> });
        layoutPtr = autoLayout.ptr;
        layout = autoLayout;
      }
    } else if (layout) {
      layoutPtr = (layout as WgpuPipelineLayout).ptr;
    }

    const pipelinePtr = wgpu.wgpu_shim_create_compute_pipeline(this.ptr, shader.ptr, entry, layoutPtr as ptr) as unknown as number;
    if (!pipelinePtr) throw new Error("Failed to create compute pipeline");
    const pipeline = new WgpuComputePipeline(
      pipelinePtr,
      (layout instanceof WgpuPipelineLayout ? layout.bindGroupLayouts : autoBindGroupLayouts),
    );
    trackForRelease(pipeline, () => wgpu.wgpu_shim_release_compute_pipeline(pipelinePtr));
    return pipeline;
  }

  createCommandEncoder(_descriptor?: GPUCommandEncoderDescriptor): WgpuCommandEncoder {
    const encPtr = wgpu.wgpu_shim_create_command_encoder(this.ptr) as unknown as number;
    if (!encPtr) throw new Error("Failed to create command encoder");
    return new WgpuCommandEncoder(encPtr, this.ptr);
  }

  createQuerySet(descriptor: GPUQuerySetDescriptor): WgpuQuerySet {
    // WGPUQueryType: Occlusion=1, Timestamp=2
    const type = descriptor.type === "timestamp" ? 2 : 1;
    const qsPtr = wgpu.wgpu_shim_create_query_set(this.ptr, type, descriptor.count) as unknown as number;
    if (!qsPtr) throw new Error("Failed to create query set");
    const qs = new WgpuQuerySet(qsPtr, descriptor.type, descriptor.count);
    trackForRelease(qs, () => wgpu.wgpu_shim_release_query_set(qsPtr));
    return qs;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    liveDevices.delete(this);
    if (!this._lostReported) {
      this._lostReported = true;
      this.lostResolve?.({ reason: "destroyed", message: "Device destroyed" } as GPUDeviceLostInfo);
    }
    untrack(this);
    // Signal attached workers before freeing handles — an alive=1 cell on a
    // released device is a use-after-free on the worker's next FFI call.
    this.writeDead();
    // wgpuDeviceGetQueue returns an owned box per call — this wrapper's clone
    // is always ours to release, regardless of device ownership.
    try { wgpu.wgpu_shim_release_queue(this.queue.ptr); } catch { /* best-effort */ }
    if (!this.ownsHandle) return; // worker-attached view — owner releases the device.
    wgpu.wgpu_shim_release_device(this.ptr);
  }
}

// ============================================================================
// WgpuQueue
// ============================================================================

export class WgpuQueue {
  readonly ptr: number;
  label = "";

  constructor(ptr: number) {
    this.ptr = ptr;
  }

  writeBuffer(buffer: WgpuBuffer, offset: number, data: BufferSource | SharedArrayBuffer, dataOffset?: number, size?: number): void {
    // Per WebGPU spec, dataOffset/size are in ELEMENTS for TypedArrays and
    // BYTES for ArrayBuffer/DataView.
    let arr: Uint8Array;
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) {
      arr = new Uint8Array(data, dataOffset ?? 0, size);
    } else if (data instanceof DataView) {
      arr = new Uint8Array(data.buffer, data.byteOffset + (dataOffset ?? 0), size ?? (data.byteLength - (dataOffset ?? 0)));
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView & { BYTES_PER_ELEMENT: number };
      const byteOffset = (dataOffset ?? 0) * view.BYTES_PER_ELEMENT;
      const byteLength = size !== undefined ? size * view.BYTES_PER_ELEMENT : view.byteLength - byteOffset;
      arr = new Uint8Array(view.buffer, view.byteOffset + byteOffset, byteLength);
    } else {
      throw new Error("writeBuffer: unsupported data type");
    }
    wgpu.wgpu_shim_queue_write_buffer(this.ptr, buffer.ptr, BigInt(offset), arr as unknown as ptr, BigInt(arr.byteLength));
  }

  writeTexture(destination: GPUTexelCopyTextureInfo, data: BufferSource | SharedArrayBuffer, dataLayout: GPUTexelCopyBufferLayout, size: GPUExtent3D): void {
    let arr: Uint8Array;
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)) {
      arr = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      arr = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else {
      throw new Error("writeTexture: unsupported data type");
    }
    const texture = destination.texture as unknown as WgpuTexture;
    texture.__ddWritten = true;
    const { width, height, depthOrArrayLayers } = parseExtent3D(size);
    const origin = parseOrigin3D(destination.origin);
    wgpu.wgpu_shim_queue_write_texture(
      this.ptr,
      texture.ptr,
      arr as unknown as ptr,
      BigInt(arr.byteLength),
      destination.mipLevel ?? 0,
      origin.x, origin.y, origin.z,
      parseAspect(destination.aspect),
      BigInt(dataLayout.offset ?? 0),
      dataLayout.bytesPerRow ?? 0,
      dataLayout.rowsPerImage ?? 0,
      width, height, depthOrArrayLayers,
    );
  }

  submit(commandBuffers: Iterable<WgpuCommandBuffer>): void {
    const all = Array.from(commandBuffers) as WgpuCommandBuffer[];
    // Skip buffers whose finish() captured a validation error — submitting
    // an errored buffer makes wgpu-native panic (process abort), not report
    // an uncaptured error.
    const skipped = all.filter((cb) => cb.invalid);
    const list = all.filter((cb) => !cb.invalid);
    skipped.forEach((cb) => { cb.dispose();; });
    if (list.length === 0) return;
    const ptrs = new BigUint64Array(list.length);
    for (let i = 0; i < list.length; i++) {
      ptrs[i] = BigInt(list[i].ptr);
    }
    wgpu.wgpu_shim_queue_submit(this.ptr, ptrs as unknown as ptr, list.length);
    // Command buffers are single-use — release the native handles now.
    list.forEach((cb) => { cb.dispose();; });
  }

  onSubmittedWorkDone(): Promise<undefined> {
    return new Promise((resolve) => {
      wgpu.wgpu_shim_queue_on_submitted_work_done(this.ptr);
      resolve(undefined);
    });
  }

  /**
   * copyExternalImageToTexture — uploads canvas/bitmap pixels (text rasters,
   * image assets). The source is a canvas (VirtualCanvas with a
   * NativeCanvas2D) or a NativeImageBitmap.
   *
   * The source pixels are always RGBA. When the destination texture is a
   * BGRA surface format we must swap R and B (the browser performs the
   * source→destination format conversion automatically). When
   * destination.premultipliedAlpha is set we premultiply RGB by alpha —
   * batch-style shaders typically expect premultiplied input.
   */
  copyExternalImageToTexture(source: GPUCopyExternalImageSourceInfo, destination: GPUCopyExternalImageDestInfo, copySize: GPUExtent3D): void {
    const img = (source as any).source ?? source;
    const texture = destination.texture as unknown as WgpuTexture;
    texture.__ddWritten = true;
    const { width, height } = parseExtent3D(copySize);

    let rgba: Uint8Array | Uint8ClampedArray | null = null;
    let srcW = width, srcH = height;
    if (img && typeof img.getContext === "function") {
      const ctx = img.getContext("2d");
      if (ctx && typeof ctx.getImageData === "function") {
        const id = ctx.getImageData(0, 0, img.width, img.height);
        rgba = id?.data ?? null;
        srcW = img.width; srcH = img.height;
      }
    } else if (img && typeof img.getPixelData === "function") {
      rgba = img.getPixelData();
      srcW = img.width; srcH = img.height;
    } else if (img && img.data && img.width && img.height) {
      rgba = img.data; srcW = img.width; srcH = img.height;
    }
    if (!rgba) {
      throw new Error("copyExternalImageToTexture: could not read pixels from source");
    }

    const isBGRA = isBGRAFormat(texture?.format);
    const premultiply = (destination as any)?.premultipliedAlpha === true;
    // destination.origin[2] selects the array layer — the bindless registry
    // relies on it (origin [0,0,layer]); ignoring it writes everything to
    // layer 0 and leaves other layers black.
    const origin = parseOrigin3D((destination as any).origin);

    // wgpu requires 256-byte-aligned row strides. When the source is already
    // aligned and needs no conversion, hand it to the queue as-is — the hot
    // path for raw RGBA uploads (html-ui panels, canvas text) skips a
    // full-frame copy.
    const srcRowBytes = srcW * 4;
    if (!isBGRA && !premultiply && srcRowBytes % 256 === 0) {
      wgpu.wgpu_shim_queue_write_texture(
        this.ptr,
        texture.ptr,
        rgba as unknown as ptr,
        BigInt(rgba.byteLength),
        destination.mipLevel ?? 0,
        origin.x, origin.y, origin.z,
        1, // all aspects
        0n,
        srcRowBytes,
        height,
        width, height, 1,
      );
      return;
    }
    const dstRowBytes = Math.ceil(srcRowBytes / 256) * 256;
    const copyRowBytes = width * 4;
    const padded = new Uint8Array(dstRowBytes * height);

    if (!isBGRA && !premultiply) {
      // Fast path: row-wise copy, no per-pixel work.
      for (let y = 0; y < height; y++) {
        padded.set(rgba.subarray(y * srcRowBytes, y * srcRowBytes + copyRowBytes), y * dstRowBytes);
      }
    } else {
      for (let y = 0; y < height; y++) {
        const srcOff = y * srcRowBytes;
        const dstOff = y * dstRowBytes;
        for (let x = 0; x < width; x++) {
          const s = srcOff + x * 4;
          const d = dstOff + x * 4;
          const a = rgba[s + 3];
          const af = a / 255;
          const r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
          const pr = premultiply && a < 255 ? Math.round(r * af) : r;
          const pg = premultiply && a < 255 ? Math.round(g * af) : g;
          const pb = premultiply && a < 255 ? Math.round(b * af) : b;
          if (isBGRA) {
            padded[d] = pb; padded[d + 1] = pg; padded[d + 2] = pr; padded[d + 3] = a;
          } else {
            padded[d] = pr; padded[d + 1] = pg; padded[d + 2] = pb; padded[d + 3] = a;
          }
        }
      }
    }
    wgpu.wgpu_shim_queue_write_texture(
      this.ptr,
      texture.ptr,
      padded as unknown as ptr,
      BigInt(padded.byteLength),
      destination.mipLevel ?? 0,
      origin.x, origin.y, origin.z,
      1, // all aspects
      0n,
      dstRowBytes,
      height,
      width, height, 1,
    );
  }
}
