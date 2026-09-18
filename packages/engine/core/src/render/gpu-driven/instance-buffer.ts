import { type Mat4, mat4, type Vec3, vec3 } from "wgpu-matrix";

export interface InstanceRecord {
  pos: Vec3;
  scale: number;
  rot: { x: number; y: number; z: number; w: number };
  aabbMin: Vec3;
  aabbMax: Vec3;
  meshIdx: number;
  materialIdx: number;
  flags: number;
}

/** Packed per-instance data uploaded to the GPU for culling and indirect draw.
 *  Record layout (std140-ish, 80 bytes):
 *    0..12  pos.xyz, scale
 *   16..28  rot.xyzw
 *   32..44  aabbMin.xyz, pad
 *   48..60  aabbMax.xyz, pad
 *   64..76  meshIdx, materialIdx, flags, pad
 */
export const INSTANCE_RECORD_FLOATS = 20; // 80 bytes
export const INSTANCE_RECORD_BYTES = INSTANCE_RECORD_FLOATS * 4;

export class InstanceBuffer {
  private maxInstances: number;
  private staging: Float32Array;
  private gpuBuffer: GPUBuffer | null = null;

  constructor(maxInstances: number) {
    this.maxInstances = maxInstances;
    this.staging = new Float32Array(maxInstances * INSTANCE_RECORD_FLOATS);
  }

  /** Resize the staging buffer (destroys the existing GPU buffer). */
  setMaxInstances(max: number): void {
    this.maxInstances = max;
    this.staging = new Float32Array(max * INSTANCE_RECORD_FLOATS);
    this.gpuBuffer?.destroy();
    this.gpuBuffer = null;
  }

  /** Write one instance into the staging buffer. */
  writeInstance(index: number, r: InstanceRecord): void {
    if (index < 0 || index >= this.maxInstances) return;
    const off = index * INSTANCE_RECORD_FLOATS;
    this.staging[off + 0] = r.pos[0];
    this.staging[off + 1] = r.pos[1];
    this.staging[off + 2] = r.pos[2];
    this.staging[off + 3] = r.scale;
    this.staging[off + 4] = r.rot.x;
    this.staging[off + 5] = r.rot.y;
    this.staging[off + 6] = r.rot.z;
    this.staging[off + 7] = r.rot.w;
    this.staging[off + 8] = r.aabbMin[0];
    this.staging[off + 9] = r.aabbMin[1];
    this.staging[off + 10] = r.aabbMin[2];
    // pad at off+11
    this.staging[off + 12] = r.aabbMax[0];
    this.staging[off + 13] = r.aabbMax[1];
    this.staging[off + 14] = r.aabbMax[2];
    // pad at off+15
    const u32 = new Uint32Array(this.staging.buffer);
    const u32Off = index * INSTANCE_RECORD_FLOATS + 16;
    u32[u32Off] = r.meshIdx;
    u32[u32Off + 1] = r.materialIdx;
    u32[u32Off + 2] = r.flags;
  }

  /** Convenience: write from a mat4 + aabb + mesh/material/flags. */
  writeTransformInstance(
    index: number,
    model: Mat4,
    aabbMin: Vec3,
    aabbMax: Vec3,
    meshIdx: number,
    materialIdx: number,
    flags: number,
  ): void {
    const pos = vec3.create(model[12], model[13], model[14]);
    const q = this.extractQuaternion(model);
    const scale = this.extractScale(model);
    this.writeInstance(index, {
      pos,
      scale,
      rot: q,
      aabbMin,
      aabbMax,
      meshIdx,
      materialIdx,
      flags,
    });
  }

  /** Upload the current staging data to the GPU. The returned buffer can be bound to the cull/draw passes. */
  upload(device: GPUDevice): GPUBuffer {
    if (!this.gpuBuffer || this.gpuBuffer.size !== this.staging.byteLength) {
      this.gpuBuffer?.destroy();
      this.gpuBuffer = device.createBuffer({
        size: this.staging.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.gpuBuffer, 0, this.staging as unknown as BufferSource);
    return this.gpuBuffer;
  }

  getBuffer(): GPUBuffer | null {
    return this.gpuBuffer;
  }

  getStaging(): Float32Array {
    return this.staging;
  }

  getMaxInstances(): number {
    return this.maxInstances;
  }

  /** Destroy the GPU buffer (does not affect staging data). */
  destroy(): void {
    this.gpuBuffer?.destroy();
    this.gpuBuffer = null;
  }

  private extractQuaternion(model: Mat4): { x: number; y: number; z: number; w: number } {
    // Decompose a 4x4 matrix into T * R * S. We use the upper 3x3 scaling logic from wgpu-matrix's quat.fromMat4.
    // Reuse wgpu-matrix's getRotation is not in the public API, so we compute manually.
    const m = mat4.getScaling(model);
    const is1 = 1 / m[0];
    const is2 = 1 / m[1];
    const is3 = 1 / m[2];
    const sm11 = model[0] * is1;
    const sm12 = model[4] * is2;
    const sm13 = model[8] * is3;
    const sm21 = model[1] * is1;
    const sm22 = model[5] * is2;
    const sm23 = model[9] * is3;
    const sm31 = model[2] * is1;
    const sm32 = model[6] * is2;
    const sm33 = model[10] * is3;
    const trace = sm11 + sm22 + sm33;
    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      qw = 0.25 * s;
      qx = (sm32 - sm23) / s;
      qy = (sm13 - sm31) / s;
      qz = (sm21 - sm12) / s;
    } else if (sm11 > sm22 && sm11 > sm33) {
      const s = Math.sqrt(1 + sm11 - sm22 - sm33) * 2;
      qw = (sm32 - sm23) / s;
      qx = 0.25 * s;
      qy = (sm12 + sm21) / s;
      qz = (sm13 + sm31) / s;
    } else if (sm22 > sm33) {
      const s = Math.sqrt(1 + sm22 - sm11 - sm33) * 2;
      qw = (sm13 - sm31) / s;
      qx = (sm12 + sm21) / s;
      qy = 0.25 * s;
      qz = (sm23 + sm32) / s;
    } else {
      const s = Math.sqrt(1 + sm33 - sm11 - sm22) * 2;
      qw = (sm21 - sm12) / s;
      qx = (sm13 + sm31) / s;
      qy = (sm23 + sm32) / s;
      qz = 0.25 * s;
    }
    return { x: qx, y: qy, z: qz, w: qw };
  }

  private extractScale(model: Mat4): number {
    const sx = Math.sqrt(model[0] * model[0] + model[1] * model[1] + model[2] * model[2]);
    const sy = Math.sqrt(model[4] * model[4] + model[5] * model[5] + model[6] * model[6]);
    const sz = Math.sqrt(model[8] * model[8] + model[9] * model[9] + model[10] * model[10]);
    return Math.max(sx, sy, sz);
  }
}
