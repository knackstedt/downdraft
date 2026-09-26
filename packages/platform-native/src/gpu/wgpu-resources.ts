// ============================================================================
// wgpu-resources.ts — WgpuBuffer / WgpuTexture / WgpuTextureView / WgpuSampler
//   / WgpuShaderModule / WgpuBindGroupLayout / WgpuPipelineLayout /
//   WgpuBindGroup / WgpuRenderPipeline / WgpuComputePipeline / WgpuQuerySet /
//   WgpuCommandBuffer
//
// Resource-owning wrappers around native handles. None of these implement
// the DOM interfaces (the @webgpu/types `__brand` marker prevents structural
// conformance) — see wgpu-device.ts for the boundary-cast strategy.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import { parseAspect, parseExtent3D, parseFormat, parseViewDimension } from "./enums";
import { trackForRelease, untrack } from "./registry";
import type { WgpuQueue } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";

const log = createLogger("info");

// ============================================================================
// WgpuBuffer
// ============================================================================

interface MappedRange {
  /** Absolute buffer offset the caller requested. */
  offset: number;
  /** JS copy of the mapped range. For read maps it's prefilled; for write
   *  maps it's flushed back into the native buffer on unmap(). */
  buffer: ArrayBuffer;
}

export class WgpuBuffer {
  readonly ptr: number;
  readonly size: number;
  label = "";

  private queue: WgpuQueue;
  private destroyed = false;
  private mapMode: "read" | "write" | null = null;
  private mapOffset = 0;
  private mapSize = 0;
  private mappedRanges: MappedRange[] = [];

  constructor(ptr: number, size: number, queue: WgpuQueue, mappedAtCreation = false) {
    this.ptr = ptr;
    this.size = size;
    this.queue = queue;
    if (mappedAtCreation) {
      this.mapMode = "write";
      this.mapOffset = 0;
      this.mapSize = size;
    }
  }

  get mapState(): GPUBufferMapState {
    return this.mapMode !== null ? "mapped" : "unmapped";
  }

  async mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number): Promise<void> {
    if (this.mapMode !== null) {
      throw new Error("mapAsync: buffer is already mapped");
    }
    const mapMode = mode === 2 ? "write" : "read"; // GPUMapMode.WRITE=2, READ=1
    const off = offset ?? 0;
    const sz = size ?? (this.size - off);
    const state = wgpu.wgpu_shim_buffer_map_async(this.ptr, mode, BigInt(off), BigInt(sz));
    if (state !== 3) { // WGPUBufferMapState_Mapped
      throw new Error(`mapAsync failed (map state ${state})`);
    }
    this.mapMode = mapMode;
    this.mapOffset = off;
    this.mapSize = sz;
  }

  getMappedRange(offset?: number, size?: number): ArrayBuffer {
    if (this.mapMode === null) {
      throw new Error("getMappedRange: buffer is not mapped");
    }
    const off = offset ?? this.mapOffset;
    const sz = size ?? (this.mapOffset + this.mapSize - off);
    const result = new ArrayBuffer(sz);
    if (this.mapMode === "read") {
      const status = wgpu.wgpu_shim_buffer_read_mapped(
        this.ptr,
        BigInt(off),
        BigInt(sz),
        new Uint8Array(result) as unknown as ptr,
        sz,
      );
      if (status !== 0) {
        throw new Error(`Failed to read mapped buffer (status ${status})`);
      }
    }
    // Track the range so unmap() can flush write-mapped ranges back to the
    // native buffer at their absolute offsets (fixes the previous
    // double-offset bug where the store slice start was reused as the
    // destination offset).
    this.mappedRanges.push({ offset: off, buffer: result });
    return result;
  }

  unmap(): void {
    if (this.mapMode === null) return;
    if (this.mapMode === "write") {
      this.mappedRanges.forEach((range) => {
        const status = wgpu.wgpu_shim_buffer_write_mapped(
          this.ptr,
          BigInt(range.offset),
          new Uint8Array(range.buffer) as unknown as ptr,
          BigInt(range.buffer.byteLength),
        );
        if (status !== 0) {
          log.error("WgpuBuffer", `write_mapped failed (status ${status})`);
        }
      });
    }
    this.mappedRanges.length = 0;
    wgpu.wgpu_shim_buffer_unmap(this.ptr);
    this.mapMode = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.mapMode !== null) {
      try { this.unmap(); } catch { /* already unmapped natively */ }
    }
    untrack(this);
    wgpu.wgpu_shim_release_buffer(this.ptr);
  }
}

// ============================================================================
// WgpuTexture
// ============================================================================

export class WgpuTexture {
  readonly ptr: number;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: GPUTextureDimension;
  readonly usage: number;
  label = "";
  /** Set by encoder ops that write to this texture (render attachment with
   *  storeOp=store, copy destination). Surface contexts use it to skip
   *  presenting acquired-but-untouched swapchain textures — presenting an
   *  unwritten texture shows a blank frame instead of retaining the last
   *  one, which breaks games with dirty-tracking. */
  __ddWritten = false;
  private destroyed = false;

  constructor(ptr: number, desc: GPUTextureDescriptor) {
    this.ptr = ptr;
    const ext = parseExtent3D(desc.size);
    this.width = ext.width;
    this.height = ext.height;
    this.depthOrArrayLayers = ext.depthOrArrayLayers;
    this.format = desc.format;
    this.mipLevelCount = desc.mipLevelCount ?? 1;
    this.sampleCount = desc.sampleCount ?? 1;
    this.dimension = desc.dimension ?? "2d";
    this.usage = desc.usage;
    this.label = desc.label ?? "";
  }

  createView(descriptor?: GPUTextureViewDescriptor): WgpuTextureView {
    const format = descriptor?.format ? parseFormat(descriptor.format) : 0;
    const dimension = parseViewDimension(descriptor?.dimension);
    const aspect = parseAspect(descriptor?.aspect);
    // Cube/cube-array views default to 6 / 6*N array layers when omitted.
    const isCube = dimension === 4 || dimension === 5;
    const defaultArrayLayerCount = isCube ? 6 : this.depthOrArrayLayers;
    const viewPtr = wgpu.wgpu_shim_texture_create_view(
      this.ptr,
      format,
      dimension,
      aspect,
      descriptor?.baseMipLevel ?? 0,
      descriptor?.mipLevelCount ?? this.mipLevelCount,
      descriptor?.baseArrayLayer ?? 0,
      descriptor?.arrayLayerCount ?? defaultArrayLayerCount,
    ) as unknown as number;
    if (!viewPtr) throw new Error("Failed to create texture view");
    const view = new WgpuTextureView(viewPtr, this);
    trackForRelease(view, () => wgpu.wgpu_shim_release_texture_view(viewPtr));
    return view;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    untrack(this);
    wgpu.wgpu_shim_release_texture(this.ptr);
  }
}

// ============================================================================
// WgpuTextureView
// ============================================================================

export class WgpuTextureView {
  readonly ptr: number;
  label = "";
  /** The texture this view was created from — lets encoder ops attribute
   *  writes back to the texture (see WgpuTexture.__ddWritten). */
  readonly sourceTexture: WgpuTexture | null;
  private released = false;

  constructor(ptr: number, sourceTexture: WgpuTexture | null = null) {
    this.ptr = ptr;
    this.sourceTexture = sourceTexture;
  }

  /** Explicitly release the native view handle (mirrors texture.destroy()). */
  release(): void {
    if (this.released) return;
    this.released = true;
    untrack(this);
    wgpu.wgpu_shim_release_texture_view(this.ptr);
  }
}

// ============================================================================
// WgpuSampler
// ============================================================================

export class WgpuSampler {
  readonly ptr: number;
  label = "";

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// WgpuQuerySet
// ============================================================================

export class WgpuQuerySet {
  readonly ptr: number;
  readonly type: GPUQueryType;
  readonly count: number;
  label = "";
  private destroyed = false;

  constructor(ptr: number, type: GPUQueryType, count: number) {
    this.ptr = ptr;
    this.type = type;
    this.count = count;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    untrack(this);
    wgpu.wgpu_shim_destroy_query_set(this.ptr);
  }
}

// ============================================================================
// WgpuShaderModule
// ============================================================================

export class WgpuShaderModule {
  readonly ptr: number;
  /** The WGSL source — kept for `layout: "auto"` bind group parsing. */
  readonly code: string;
  label = "";

  constructor(ptr: number, code: string = "") {
    this.ptr = ptr;
    this.code = code;
  }

  /**
   * Returns compilation info for this module. The shim short-circuits to
   * "[]" because wgpuShaderModuleGetCompilationInfo panics in this
   * wgpu-native build — out-of-band validation (tint) is handled by the
   * engine's shader-validation guard instead.
   */
  getCompilationInfo(): Promise<GPUCompilationInfo> {
    try {
      const jsonStr = wgpu.wgpu_shim_shader_get_compilation_info(this.ptr);
      const raw = JSON.parse(jsonStr || "[]") as Array<{
        type: string;
        message: string;
        line: number;
        col: number;
        offset: number;
        length: number;
      }>;
      const messages = raw.map((m) => ({
        type: m.type as GPUCompilationMessageType,
        message: m.message,
        lineNum: m.line,
        linePos: m.col,
        offset: m.offset,
        length: m.length,
        utf16LineOffset: 0,
      }));
      return Promise.resolve({ messages } as unknown as GPUCompilationInfo);
    } catch {
      return Promise.resolve({ messages: [] } as unknown as GPUCompilationInfo);
    }
  }
}

// ============================================================================
// Layouts and bind groups
// ============================================================================

export class WgpuBindGroupLayout {
  readonly ptr: number;
  label = "";

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

export class WgpuPipelineLayout {
  readonly ptr: number;
  readonly bindGroupLayouts: WgpuBindGroupLayout[];
  label = "";

  constructor(ptr: number, bindGroupLayouts: WgpuBindGroupLayout[] = []) {
    this.ptr = ptr;
    this.bindGroupLayouts = bindGroupLayouts;
  }
}

export class WgpuBindGroup {
  readonly ptr: number;
  label = "";

  constructor(ptr: number) {
    this.ptr = ptr;
  }
}

// ============================================================================
// Pipelines
// ============================================================================

export class WgpuRenderPipeline {
  readonly ptr: number;
  label = "";
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

export class WgpuComputePipeline {
  readonly ptr: number;
  label = "";
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
// WgpuCommandBuffer
// ============================================================================

export class WgpuCommandBuffer {
  readonly ptr: number;
  label = "";
  private released = false;
  /**
   * Set when finish() captured a validation error — the native handle is
   * technically valid but encodes no commands, and submitting an errored
   * buffer makes wgpu-native abort the process. WgpuQueue.submit() skips
   * invalid buffers.
   */
  invalid = false;

  constructor(ptr: number) {
    this.ptr = ptr;
  }

  /**
   * Release the native command buffer. Called automatically by
   * WgpuQueue.submit() — command buffers are single-use in WebGPU.
   */
  dispose(): void {
    if (this.released) return;
    this.released = true;
    untrack(this);
    wgpu.wgpu_shim_release_command_buffer(this.ptr);
  }
}
