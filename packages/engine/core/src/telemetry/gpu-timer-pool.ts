import { getHostCapabilities } from "../platform/runtime";

/**
 * Multi-pass GPU timestamp query pool.
 *
 * Requires the "timestamp-query" feature on the GPUDevice.
 * If the feature is not available, all methods are no-ops and readAll returns empty.
 *
 * Usage:
 *   const pool = new GPUTimerPool(device, maxPasses);
 *   pool.begin(passEncoder, 0);  // begin pass 0
 *   ... render pass 0 ...
 *   pool.end(passEncoder, 0);    // end pass 0
 *   pool.begin(passEncoder, 1);  // begin pass 1
 *   ... render pass 1 ...
 *   pool.end(passEncoder, 1);    // end pass 1
 *   pool.resolve(commandEncoder); // resolve all queries
 *   const results = await pool.readAll(); // read GPU times
 */
export class GPUTimerPool {
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private readBuffer: GPUBuffer | null = null;
  private supported: boolean = false;
  private pending: boolean = false;
  private bufferMapped: boolean = false;
  private pendingResolve: boolean = false;
  private maxPasses: number;
  private lastResults: Map<number, number> = new Map();

  constructor(device: GPUDevice, maxPasses: number = 16) {
    this.maxPasses = maxPasses;
    this.init(device);
  }

  private init(device: GPUDevice): void {
    const features = device.features;
    // writeTimestamp on GPURenderPassEncoder requires the inside-passes
    // experimental feature on Dawn/Chromium. wgpu (the native runtime)
    // supports inside-pass timestamps with plain "timestamp-query".
    // The wgpu-native shim's timestamp path is unsafe: encoder.writeTimestamp /
    // resolveQuerySet lose the device on lavapipe-class drivers, and the
    // synchronous map_async FFI then wedges the whole process. Keep the entire
    // timestamp path off on native unless explicitly opted in for debugging —
    // the correct reimplementation writes via pass-descriptor timestamp_writes
    // (the shim already accepts them), which is a larger refactor.
    const timestampsOk =
      getHostCapabilities().runtime !== "native" || !!process.env.DOWNDRAFT_GPU_TIMESTAMPS;
    const insidePassTimestamps =
      timestampsOk &&
      (features.has("chromium-experimental-timestamp-query-inside-passes") ||
        getHostCapabilities().runtime === "native");
    if (!features.has("timestamp-query") || !insidePassTimestamps) {
      this.supported = false;
      // Encoder-level timestamps may still be available (base "timestamp-query")
      this.initEncoderTimestamps(device);
      if (this.encoderTimestampSupported) {
        // Allocate query set for encoder-level timestamps even if inside-pass is unsupported
        try {
          const queryCount = this.maxPasses * 2;
          this.querySet = device.createQuerySet({ type: "timestamp", count: queryCount });
          this.resolveBuffer = device.createBuffer({
            size: queryCount * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          });
          this.readBuffer = device.createBuffer({
            size: queryCount * 8,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
        } catch {
          this.encoderTimestampSupported = false;
        }
      }
      return;
    }

    // Inside-pass timestamps supported → encoder timestamps also supported
    this.initEncoderTimestamps(device);

    try {
      const queryCount = this.maxPasses * 2; // begin + end per pass
      this.querySet = device.createQuerySet({
        type: "timestamp",
        count: queryCount,
      });

      this.resolveBuffer = device.createBuffer({
        size: queryCount * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      this.readBuffer = device.createBuffer({
        size: queryCount * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      this.supported = true;
    } catch {
      this.supported = false;
    }
  }

  isSupported(): boolean {
    return this.supported;
  }

  getMaxPasses(): number {
    return this.maxPasses;
  }

  begin(pass: GPURenderPassEncoder | GPUComputePassEncoder, passIdx: number): void {
    if (!this.supported || !this.querySet || passIdx >= this.maxPasses) return;
    const write = (pass as { writeTimestamp?: unknown }).writeTimestamp;
    if (typeof write !== "function") { this.supported = false; return; }
    (write as (this: unknown, qs: GPUQuerySet, i: number) => void).call(pass, this.querySet, passIdx * 2);
  }

  end(pass: GPURenderPassEncoder | GPUComputePassEncoder, passIdx: number): void {
    if (!this.supported || !this.querySet || passIdx >= this.maxPasses) return;
    const write = (pass as { writeTimestamp?: unknown }).writeTimestamp;
    if (typeof write !== "function") { this.supported = false; return; }
    (write as (this: unknown, qs: GPUQuerySet, i: number) => void).call(pass, this.querySet, passIdx * 2 + 1);
  }

  resolve(encoder: GPUCommandEncoder): void {
    // Encoder-level timestamps (blit/copy passes) can be resolved even when
    // inside-pass timestamps aren't supported.
    if ((!this.supported && !this.encoderTimestampSupported) || !this.querySet || !this.resolveBuffer || !this.readBuffer) return;
    if (this.bufferMapped) {
      // Queue the resolve for the next frame — readBuffer is still mapped.
      this.pendingResolve = true;
      return;
    }
    const queryCount = this.maxPasses * 2;
    encoder.resolveQuerySet(this.querySet, 0, queryCount, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, queryCount * 8);
    this.pending = true;
  }

  async readAll(): Promise<Map<number, number>> {
    if ((!this.supported && !this.encoderTimestampSupported) || !this.readBuffer || !this.pending) return this.lastResults;
    this.pending = false;
    this.bufferMapped = true;

    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigUint64Array(this.readBuffer.getMappedRange());
      // Reuse lastResults Map — clear() instead of new Map() to avoid per-read allocation
      const results = this.lastResults;
      results.clear();

      for (let i = 0; i < this.maxPasses; i++) {
        const begin = Number(data[i * 2]);
        const end = Number(data[i * 2 + 1]);
        if (end > begin && end > 0 && begin > 0) {
          results.set(i, (end - begin) / 1_000_000);
        }
      }

      this.readBuffer.unmap();
      this.bufferMapped = false;
      // If a resolve was queued while the buffer was mapped, mark pending so
      // the next resolve() call will actually execute.
      if (this.pendingResolve) {
        this.pendingResolve = false;
        this.pending = true;
      }
      return results;
    } catch {
      this.bufferMapped = false;
      if (this.pendingResolve) {
        this.pendingResolve = false;
        this.pending = true;
      }
      return this.lastResults;
    }
  }

  getPassGpuMs(passIdx: number): number {
    return this.lastResults.get(passIdx) ?? 0;
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    this.readBuffer?.destroy();
    this.querySet = null;
    this.resolveBuffer = null;
    this.readBuffer = null;
    this.supported = false;
  }

  // ─── Encoder-level timestamps (for blit/copy passes) ────────────────────
  //
  // Blit passes (buffer/texture copies, resolves) don't have a pass encoder —
  // they're commands on the GPUCommandEncoder. The "timestamp-query-inside-encoder"
  // feature (a.k.a. "timestamp-query" without the chromium-experimental variant)
  // allows writing timestamps directly on the command encoder.
  //
  // On browsers that only support "timestamp-query" (not the inside-passes
  // variant), begin()/end() above are no-ops, but these encoder methods work
  // because they use commandEncoder.writeTimestamp (a top-level timestamp).
  // We track encoder-level support separately.

  private encoderTimestampSupported: boolean = false;

  /** Check if encoder-level timestamps are available (for blit passes). */
  isEncoderTimestampSupported(): boolean {
    return this.encoderTimestampSupported;
  }

  /**
   * Initialize encoder-level timestamp support. Called automatically by init()
   * when the "timestamp-query" feature is present (even without the inside-passes
   * variant). Can also be called manually after construction.
   */
  initEncoderTimestamps(device: GPUDevice): void {
    // Encoder-level timestamps require "timestamp-query" (base feature).
    // The chromium-experimental variant is only needed for inside-pass timestamps.
    // Encoder-level timestamps require "timestamp-query" (base feature).
    // The chromium-experimental variant is only needed for inside-pass timestamps.
    // Native: same unsafe-path gate as init() — encoder writeTimestamp and
    // resolveQuerySet lose the wgpu device on lavapipe-class drivers.
    const timestampsOk =
      getHostCapabilities().runtime !== "native" || !!process.env.DOWNDRAFT_GPU_TIMESTAMPS;
    this.encoderTimestampSupported = device.features.has("timestamp-query") && timestampsOk;
  }

  /**
   * Write a begin timestamp on the command encoder (for blit passes).
   * Uses the same query set + pass index as begin().
   */
  beginEncoder(encoder: GPUCommandEncoder, passIdx: number): void {
    if (!this.encoderTimestampSupported || !this.querySet || passIdx >= this.maxPasses) return;
    (encoder as GPUCommandEncoder & { writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void }).writeTimestamp(this.querySet, passIdx * 2);
  }

  /**
   * Write an end timestamp on the command encoder (for blit passes).
   */
  endEncoder(encoder: GPUCommandEncoder, passIdx: number): void {
    if (!this.encoderTimestampSupported || !this.querySet || passIdx >= this.maxPasses) return;
    (encoder as GPUCommandEncoder & { writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void }).writeTimestamp(this.querySet, passIdx * 2 + 1);
  }
}
