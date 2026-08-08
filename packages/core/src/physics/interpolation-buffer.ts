import type { PhysicsBody } from "./interface";

/**
 * Double-buffered interpolation buffer for smooth rendering between
 * fixed-timestep physics ticks.
 *
 * Two preallocated `Float32Array` slots (`prev`, `curr`), each sized
 * `maxEntities × 8` (pos.xyz + rot.xyzw + 1 pad). No per-entity per-frame
 * allocation in the hot path.
 *
 * The rendered state is ~1 tick behind (no extrapolation): we interpolate
 * between `prev` and `curr` using the accumulator's alpha.
 */
export class InterpolationBuffer {
  private maxEntities: number;
  private prev: Float32Array;
  private curr: Float32Array;
  /** Map from entity index → slot offset in the buffer. */
  private entityToSlot: Map<number, number> = new Map();
  /** Reverse map: slot → entity index. */
  private slotToEntity: Map<number, number> = new Map();
  private nextSlot = 0;
  /** Whether writeTick has been called at least once. */
  private initialized: boolean = false;

  constructor(maxEntities: number) {
    this.maxEntities = maxEntities;
    this.prev = new Float32Array(maxEntities * 8);
    this.curr = new Float32Array(maxEntities * 8);
  }

  /**
   * Assign a slot for an entity. Called when a body is registered.
   * Returns the slot index, or -1 if capacity is exceeded.
   */
  assignSlot(entityIndex: number): number {
    if (this.entityToSlot.has(entityIndex)) return this.entityToSlot.get(entityIndex)!;
    if (this.nextSlot >= this.maxEntities) return -1;
    const slot = this.nextSlot++;
    this.entityToSlot.set(entityIndex, slot);
    this.slotToEntity.set(slot, entityIndex);
    return slot;
  }

  /**
   * Release the slot for an entity. The slot is not reclaimed (simple
   * bump allocator); call `resize` to compact if needed.
   */
  releaseSlot(entityIndex: number): void {
    const slot = this.entityToSlot.get(entityIndex);
    if (slot === undefined) return;
    this.entityToSlot.delete(entityIndex);
    this.slotToEntity.delete(slot);
  }

  /**
   * Write the current tick's transforms into `curr`, then swap `prev ↔ curr`.
   * Uses `readTransforms` from the backend (one FFI pass per realm).
   *
   * The caller provides a `readFn(realmId, buffer, count)` that delegates to
   * `PhysicsBackend.readTransforms`.
   */
  writeTick(realmId: number, readFn: (realmId: number, buffer: Float32Array, count: number) => void, entityCount: number): void {
    const count = Math.min(entityCount, this.maxEntities);
    // On the first tick, copy data to both prev and curr so interpolation
    // produces correct values instead of interpolating from zeros.
    if (!this.initialized) {
      readFn(realmId, this.curr, count);
      this.prev.set(this.curr);
      this.initialized = true;
      return;
    }
    // Read into prev (reused as scratch), then swap so curr = new data
    readFn(realmId, this.prev, count);
    // Swap: the new data is in prev; we want curr = new, prev = old curr
    const tmp = this.curr;
    this.curr = this.prev;
    this.prev = tmp;
  }

  /**
   * Read interpolated transforms into `outBuffer`.
   * Linear interpolation for position, nlerp for rotation quaternions.
   * `alpha` is in [0, 1] — the fraction between prev and curr.
   */
  readInterpolated(alpha: number, outBuffer: Float32Array, entityCount: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    const invA = 1 - a;
    const count = Math.min(entityCount, this.maxEntities);

    for (let i = 0; i < count; i++) {
      const offset = i * 8;
      // Position: linear interp
      outBuffer[offset] = this.prev[offset] * invA + this.curr[offset] * a;
      outBuffer[offset + 1] = this.prev[offset + 1] * invA + this.curr[offset + 1] * a;
      outBuffer[offset + 2] = this.prev[offset + 2] * invA + this.curr[offset + 2] * a;

      // Rotation: nlerp (normalized lerp) — good enough for smooth visuals
      const px = this.prev[offset + 3];
      const py = this.prev[offset + 4];
      const pz = this.prev[offset + 5];
      const pw = this.prev[offset + 6];
      const cx = this.curr[offset + 3];
      const cy = this.curr[offset + 4];
      const cz = this.curr[offset + 5];
      const cw = this.curr[offset + 6];

      // Choose the shorter arc (negate curr if dot < 0)
      const dot = px * cx + py * cy + pz * cz + pw * cw;
      const sign = dot < 0 ? -1 : 1;

      let rx = px * invA + cx * a * sign;
      let ry = py * invA + cy * a * sign;
      let rz = pz * invA + cz * a * sign;
      let rw = pw * invA + cw * a * sign;

      // Normalize
      const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
      if (len > 1e-9) {
        rx /= len; ry /= len; rz /= len; rw /= len;
      } else {
        rx = 0; ry = 0; rz = 0; rw = 1;
      }

      outBuffer[offset + 3] = rx;
      outBuffer[offset + 4] = ry;
      outBuffer[offset + 5] = rz;
      outBuffer[offset + 6] = rw;
      // offset + 7 is padding (scale or unused)
      outBuffer[offset + 7] = this.curr[offset + 7];
    }
  }

  /**
   * Reseed both prev and curr slots for a body (post-transfer).
   * Writes identical values to avoid interpolation snap.
   */
  reseed(entityIndex: number, pos: [number, number, number], rot: [number, number, number, number]): void {
    const slot = this.entityToSlot.get(entityIndex);
    if (slot === undefined) return;
    const offset = slot * 8;
    for (const buf of [this.prev, this.curr]) {
      buf[offset] = pos[0];
      buf[offset + 1] = pos[1];
      buf[offset + 2] = pos[2];
      buf[offset + 3] = rot[0];
      buf[offset + 4] = rot[1];
      buf[offset + 5] = rot[2];
      buf[offset + 6] = rot[3];
    }
  }

  /**
   * Reseed from a PhysicsBody's current state (post-transfer convenience).
   * Reads pos/rot via the provided getter functions.
   */
  reseedBody(
    body: PhysicsBody,
    getPos: (body: PhysicsBody) => [number, number, number],
    getRot: (body: PhysicsBody) => [number, number, number, number],
  ): void {
    this.reseed(body.entity.index, getPos(body), getRot(body));
  }

  resize(maxEntities: number): void {
    if (maxEntities === this.maxEntities) return;
    this.maxEntities = maxEntities;
    this.prev = new Float32Array(maxEntities * 8);
    this.curr = new Float32Array(maxEntities * 8);
    this.entityToSlot.clear();
    this.slotToEntity.clear();
    this.nextSlot = 0;
  }

  getMaxEntities(): number {
    return this.maxEntities;
  }
}
