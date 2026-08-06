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

import { createLogger } from "../../util/logger";

const log = createLogger();

const STORAGE_USAGE = 0x80 | 0x08; // GPUBufferUsage.STORAGE | COPY_DST

/**
 * WGSL `struct Material` layout — must match `MATERIAL_STRUCT_WGSL` in
// bindless.wgsl.ts. 48 bytes (3 * vec4), std140-friendly.
 */
export const MATERIAL_STRUCT_SIZE = 48; // bytes

/**
 * Float view of one material struct (12 floats / 48 bytes).
 *  [0..3]   baseColor (vec4)
 *  [4]      roughness
 *  [5]      metallic
 *  [6]      emissiveIntensity
 *  [7]      _pad0
 *  [8]      albedoTexHandle   (u32 packed: arrayIndex<<16 | layerIndex)
 *  [9]      normalTexHandle   (u32)
 *  [10]     metallicRoughnessTexHandle (u32)
 *  [11]     packedAOEmissive  (aoTexHandle low 16 bits? — actually two u32s packed)
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
  /** Float32 view over the SSBO backing store (size = capacity * 12). */
  private backing: Float32Array;
  /** Uint32 view over the same ArrayBuffer as `backing` — for writing u32
   *  texture handles so the shader reads correct u32 bit patterns. */
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
    this.backing = new Float32Array(this.capacity * 12);
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
    this.backing.fill(0, index * 12, (index + 1) * 12);
    this.flushRange(index, 1);
    this.freeList.push(index);
  }

  /** Flush all pending writes to the GPU (call once per frame before draw). */
  flush(): void {
    if (this.nextSlot === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.backing.buffer as unknown as BufferSource, 0, this.nextSlot * 12 * 4);
  }

  destroy(): void {
    this.buffer.destroy();
  }

  // ── internal ──────────────────────────────────────────────────────────

  private writeMaterial(index: number, p: MaterialParams): void {
    const o = index * 12;
    this.backing[o + 0] = p.baseColor[0];
    this.backing[o + 1] = p.baseColor[1];
    this.backing[o + 2] = p.baseColor[2];
    this.backing[o + 3] = p.baseColor[3];
    this.backing[o + 4] = p.roughness;
    this.backing[o + 5] = p.metallic;
    this.backing[o + 6] = p.emissiveIntensity;
    this.backing[o + 7] = 0; // _pad0
    // Handle fields are u32; write via the Uint32Array view so the shader
    // reads correct u32 bit patterns (not float reinterpretations).
    this.backingU32[o + 8] = p.albedoTexHandle >>> 0;
    this.backingU32[o + 9] = p.normalTexHandle >>> 0;
    this.backingU32[o + 10] = p.metallicRoughnessTexHandle >>> 0;
    // Pack ao (low 16) + emissive (high 16) into one u32.
    this.backingU32[o + 11] =
      ((p.aoTexHandle & 0xffff) | ((p.emissiveTexHandle & 0xffff) << 16)) >>> 0;
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
    const newBacking = new Float32Array(newCapacity * 12);
    newBacking.set(this.backing);
    const newBuffer = this.device.createBuffer({
      size: newCapacity * MATERIAL_STRUCT_SIZE,
      usage: STORAGE_USAGE,
      label: "bindless_material_ssbo",
    });
    // Copy old data into the new buffer.
    this.device.queue.writeBuffer(newBuffer, 0, newBacking.buffer as unknown as BufferSource, 0, this.nextSlot * 12 * 4);
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
