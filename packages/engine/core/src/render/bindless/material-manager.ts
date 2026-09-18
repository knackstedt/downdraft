// ============================================================================
// BindlessMaterialManager — owns the material SSBO for bindless rendering
//
// Materials are flat structs in a read-only storage buffer. Each draw carries
// a `materialIndex` (instance/vertex attribute) that indexes this buffer. The
// struct holds scalar material params (baseColor, roughness, metallic, ...)
// plus packed texture handles (arrayIndex << 16 | layerIndex) for each texture
// slot the material uses.
//
// The SSBO grows in pages; the bind group is rebuilt only when it grows (rare).
// Freed material slots are returned to a free list and reused.
// ============================================================================

import type { StructView } from "@downdraft/engine/shader-graph";
import { createLogger } from "../../util/logger";
import { BINDLESS_MATERIAL_FLOATS, BINDLESS_MATERIAL_SIZE, BindlessMaterialStruct } from "./bindless-struct";

const log = createLogger();

const STORAGE_USAGE = 0x80 | 0x08; // GPUBufferUsage.STORAGE | COPY_DST

/**
 * Byte size of one BindlessMaterial struct (80). Re-exported from
 * bindless-struct.ts for back-compat — the layout is now the single source of
 * truth in `BindlessMaterialStruct`.
 */
export const MATERIAL_STRUCT_SIZE = BINDLESS_MATERIAL_SIZE;

/**
 * Float view of one material struct (20 floats / 80 bytes).
 *  [0..3]   baseColor (vec4)
 *  [4]      roughness
 *  [5]      metallic
 *  [6]      emissiveIntensity
 *  [7]      hasTexTransform (1.0 if texture transform present, 0.0 otherwise)
 *  [8]      albedoTexHandle   (u32 packed: arrayIndex<<16 | layerIndex)
 *  [9]      normalTexHandle   (u32)
 *  [10]     metallicRoughnessTexHandle (u32)
 *  [11]     packedAOEmissive  (aoTexHandle low 16 bits + emissiveTexHandle high 16)
 *  [12..13] texOffset (vec2)
 *  [14..15] texScale (vec2)
 *  [16]     texRotation
 *  [17..19] padding
 *
 * For simplicity we expose a typed setter; the SSBO is written as a Float32Array
 * view but the handle fields are reinterpreted as u32 by the shader.
 */
export interface MaterialParams {
  baseColor: [number, number, number, number];
  roughness: number;
  metallic: number;
  emissiveIntensity: number;
  albedoTexHandle: number;   // (arrayIndex << 16) | layerIndex
  normalTexHandle: number;
  metallicRoughnessTexHandle: number;
  aoTexHandle: number;
  emissiveTexHandle: number;
  /** KHR_texture_transform (optional). */
  textureTransform?: {
    offset: [number, number];
    rotation: number;
    scale: [number, number];
  };
}

export interface MaterialManagerOptions {
  /** Initial capacity in materials. SSBO is created at this size. */
  initialCapacity?: number;
  /** Grows by this factor when full. */
  growthFactor?: number;
  /** Max capacity (hard cap). */
  maxCapacity?: number;
}

const DEFAULT_INITIAL_CAPACITY = 256;
const DEFAULT_GROWTH_FACTOR = 2;
const DEFAULT_MAX_CAPACITY = 1 << 16; // 65536 materials

export class BindlessMaterialManager {
  private device: GPUDevice;
  private buffer: GPUBuffer;
  private capacity: number;
  private growthFactor: number;
  private maxCapacity: number;
  /** Float32 view over the SSBO backing store (size = capacity * floatsPerMaterial). */
  private backing: Float32Array;
  /** Uint32 view over the same ArrayBuffer as `backing` — kept for the flush
   *  path and any direct u32 reads. Field writes go through StructView which
   *  lazily creates its own Uint32Array view over the same buffer. */
  private backingU32: Uint32Array;
  /** Next free slot index, or -1 if none (then append). */
  private freeList: number[] = [];
  private nextSlot = 0;
  /** Bumped whenever the SSBO is reallocated — invalidates bind groups. */
  private bufferVersion = 0;

  constructor(device: GPUDevice, options: MaterialManagerOptions = {}) {
    this.device = device;
    this.capacity = options.initialCapacity ?? DEFAULT_INITIAL_CAPACITY;
    this.growthFactor = options.growthFactor ?? DEFAULT_GROWTH_FACTOR;
    this.maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    this.backing = new Float32Array(this.capacity * BINDLESS_MATERIAL_FLOATS);
    this.backingU32 = new Uint32Array(this.backing.buffer);
    this.buffer = device.createBuffer({
      size: this.capacity * MATERIAL_STRUCT_SIZE,
      usage: STORAGE_USAGE,
      label: "bindless_material_ssbo",
    });
  }

  getBuffer(): GPUBuffer {
    return this.buffer;
  }

  getBufferVersion(): number {
    return this.bufferVersion;
  }

  getCapacity(): number {
    return this.capacity;
  }

  getCount(): number {
    return this.nextSlot - this.freeList.length;
  }

  /**
   * Register a material. Returns a stable materialIndex. If the SSBO is full
   * and below maxCapacity, it is reallocated (bufferVersion bumps) and existing
   * data is copied — indices stay stable.
   */
  registerMaterial(params: MaterialParams): number {
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop()!;
    } else {
      if (this.nextSlot >= this.capacity) {
        this.grow();
      }
      index = this.nextSlot++;
    }
    this.writeMaterial(index, params);
    return index;
  }

  /** Update an existing material's params in place (no reallocation). */
  updateMaterial(index: number, params: MaterialParams): void {
    if (index < 0 || index >= this.nextSlot) {
      log.warn("Bindless", `updateMaterial: index ${index} out of range (nextSlot=${this.nextSlot})`);
      return;
    }
    this.writeMaterial(index, params);
  }

  /** Free a material slot; its index may be reused by a later registration. */
  unregisterMaterial(index: number): void {
    if (index < 0 || index >= this.nextSlot) return;
    // Zero the slot so stale data isn't sampled.
    this.backing.fill(0, index * BINDLESS_MATERIAL_FLOATS, (index + 1) * BINDLESS_MATERIAL_FLOATS);
    this.flushRange(index, 1);
    this.freeList.push(index);
  }

  /** Flush all pending writes to the GPU (call once per frame before draw). */
  flush(): void {
    if (this.nextSlot === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.backing.buffer as unknown as BufferSource, 0, this.nextSlot * BINDLESS_MATERIAL_FLOATS * 4);
  }

  destroy(): void {
    this.buffer.destroy();
  }

  // ── internal ──────────────────────────────────────────────────────────

  private writeMaterial(index: number, p: MaterialParams): void {
    const o = index * BINDLESS_MATERIAL_FLOATS;
    // Zero-copy subarray view over this slot's region of the backing store.
    // StructView writes field values at computed offsets; u32 handle fields
    // write through a shared Uint32Array view so the shader reads correct u32
    // bit patterns (not float reinterpretations).
    const view: StructView = BindlessMaterialStruct.view(
      this.backing.subarray(o, o + BINDLESS_MATERIAL_FLOATS),
    );
    view.set("baseColor", p.baseColor);
    view.set("roughness", p.roughness);
    view.set("metallic", p.metallic);
    view.set("emissiveIntensity", p.emissiveIntensity);
    view.set("hasTexTransform", p.textureTransform ? 1.0 : 0.0);
    view.setU32("albedoTex", p.albedoTexHandle >>> 0);
    view.setU32("normalTex", p.normalTexHandle >>> 0);
    view.setU32("metallicRoughnessTex", p.metallicRoughnessTexHandle >>> 0);
    // Pack ao (low 16) + emissive (high 16) into one u32.
    view.setU32(
      "aoEmissiveTex",
      ((p.aoTexHandle & 0xffff) | ((p.emissiveTexHandle & 0xffff) << 16)) >>> 0,
    );
    // Texture transform (KHR_texture_transform)
    if (p.textureTransform) {
      view.set("texOffset", p.textureTransform.offset);
      view.set("texScale", p.textureTransform.scale);
      view.set("texRotation", p.textureTransform.rotation);
    } else {
      view.set("texOffset", [0, 0]);
      view.set("texScale", [1, 1]);
      view.set("texRotation", 0);
    }
    view.set("_pad0", 0);
    view.set("_pad1", 0);
    view.set("_pad2", 0);
    this.flushRange(index, 1);
  }

  private flushRange(index: number, count: number): void {
    const byteOffset = index * MATERIAL_STRUCT_SIZE;
    const byteLength = count * MATERIAL_STRUCT_SIZE;
    this.device.queue.writeBuffer(
      this.buffer,
      byteOffset,
      this.backing.buffer as unknown as BufferSource,
      byteOffset,
      byteLength,
    );
  }

  private grow(): void {
    if (this.capacity >= this.maxCapacity) {
      throw new Error(`BindlessMaterialManager: maxCapacity ${this.maxCapacity} reached`);
    }
    const newCapacity = Math.min(Math.floor(this.capacity * this.growthFactor), this.maxCapacity);
    const newBacking = new Float32Array(newCapacity * BINDLESS_MATERIAL_FLOATS);
    newBacking.set(this.backing);
    const newBuffer = this.device.createBuffer({
      size: newCapacity * MATERIAL_STRUCT_SIZE,
      usage: STORAGE_USAGE,
      label: "bindless_material_ssbo",
    });
    // Copy old data into the new buffer.
    this.device.queue.writeBuffer(newBuffer, 0, newBacking.buffer as unknown as BufferSource, 0, this.nextSlot * BINDLESS_MATERIAL_FLOATS * 4);
    this.buffer.destroy();
    this.buffer = newBuffer;
    this.backing = newBacking;
    this.backingU32 = new Uint32Array(newBacking.buffer);
    this.capacity = newCapacity;
    this.bufferVersion++;
    log.debug("Bindless", `material SSBO grew to capacity ${newCapacity}`);
  }
}

/**
 * Pack a texture handle's low 16 bits (layerIndex only — assumes a single
 * array page, common case) into a u16 slot. Used when a material struct has
 * more texture slots than 32-bit fields.
 */
export function packHandle16(handle: number): number {
  return handle & 0xffff;
}
