

import { isGpuTimestampSafe } from "./gpu-timestamp-gate";

/**
 * GPU timestamp query helper for measuring GPU execution time.
 *
 * Requires the "timestamp-query" feature on the GPUDevice.
 * If the feature is not available, all methods are no-ops and getTimeMs returns 0.
 */
export class GPUTimer {
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private readBuffer: GPUBuffer | null = null;
  private supported: boolean = false;
  private pending: boolean = false;
  private lastTimeMs: number = 0;
  private queryCount: number = 2; // begin + end

  constructor(device: GPUDevice) {
    this.init(device);
  }

  private init(device: GPUDevice): void {
    const features = device.features;
    if (!features.has("timestamp-query") || !isGpuTimestampSafe(device)) {
      this.supported = false;
      return;
    }

    try {
      this.querySet = device.createQuerySet({
        type: "timestamp",
        count: this.queryCount,
      });

      this.resolveBuffer = device.createBuffer({
        size: this.queryCount * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      this.readBuffer = device.createBuffer({
        size: this.queryCount * 8,
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

  /**
   * Write timestamp markers into a render pass.
   * Call begin() at the start of the pass and end() at the end.
   */
  begin(pass: GPURenderPassEncoder | GPUComputePassEncoder): void {
    if (!this.supported || !this.querySet) return;
    const write = (pass as { writeTimestamp?: unknown }).writeTimestamp;
    if (typeof write !== "function") { this.supported = false; return; }
    (write as (this: unknown, qs: GPUQuerySet, i: number) => void).call(pass, this.querySet, 0);
  }

  end(pass: GPURenderPassEncoder | GPUComputePassEncoder): void {
    if (!this.supported || !this.querySet) return;
    const write = (pass as { writeTimestamp?: unknown }).writeTimestamp;
    if (typeof write !== "function") { this.supported = false; return; }
    (write as (this: unknown, qs: GPUQuerySet, i: number) => void).call(pass, this.querySet, 1);
  }

  /**
   * Resolve the timestamp queries and copy to the read buffer.
   * Call this after the pass ends, on the same command encoder.
   */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.supported || !this.querySet || !this.resolveBuffer || !this.readBuffer) return;
    encoder.resolveQuerySet(this.querySet, 0, this.queryCount, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, this.queryCount * 8);
    this.pending = true;
  }

  /**
   * Map the read buffer and compute the GPU time in milliseconds.
   * Returns a promise that resolves to the time in ms, or 0 if unsupported.
   */
  async readTimeMs(): Promise<number> {
    if (!this.supported || !this.readBuffer || !this.pending) return 0;
    this.pending = false;

    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigUint64Array(this.readBuffer.getMappedRange());
      const begin = Number(data[0]);
      const end = Number(data[1]);
      this.readBuffer.unmap();

      if (end > begin) {
        this.lastTimeMs = (end - begin) / 1_000_000;
      }
      return this.lastTimeMs;
    } catch {
      return this.lastTimeMs;
    }
  }

  getTimeMs(): number {
    return this.lastTimeMs;
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
}
