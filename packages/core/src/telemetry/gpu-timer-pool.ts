import { createLogger } from "../util/logger.ts";

const log = createLogger();

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
  private maxPasses: number;
  private lastResults: Map<number, number> = new Map();

  constructor(device: GPUDevice, maxPasses: number = 16) {
    this.maxPasses = maxPasses;
    this.init(device);
  }

  private init(device: GPUDevice): void {
    const features = device.features;
    // writeTimestamp on GPURenderPassEncoder requires the inside-passes experimental feature
    if (!features.has("timestamp-query") || !features.has("chromium-experimental-timestamp-query-inside-passes")) {
      this.supported = false;
      return;
    }

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

  begin(pass: GPURenderPassEncoder | GPUComputePassEncoder, passIdx: number): void {
    if (!this.supported || !this.querySet || passIdx >= this.maxPasses) return;
    pass.writeTimestamp(this.querySet, passIdx * 2);
  }

  end(pass: GPURenderPassEncoder | GPUComputePassEncoder, passIdx: number): void {
    if (!this.supported || !this.querySet || passIdx >= this.maxPasses) return;
    pass.writeTimestamp(this.querySet, passIdx * 2 + 1);
  }

  resolve(encoder: GPUCommandEncoder): void {
    if (!this.supported || !this.querySet || !this.resolveBuffer || !this.readBuffer) return;
    if (this.bufferMapped) return; // skip if readBuffer is still mapped from previous readAll
    const queryCount = this.maxPasses * 2;
    encoder.resolveQuerySet(this.querySet, 0, queryCount, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, queryCount * 8);
    this.pending = true;
  }

  async readAll(): Promise<Map<number, number>> {
    if (!this.supported || !this.readBuffer || !this.pending) return this.lastResults;
    this.pending = false;
    this.bufferMapped = true;

    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigUint64Array(this.readBuffer.getMappedRange());
      const results = new Map<number, number>();

      for (let i = 0; i < this.maxPasses; i++) {
        const begin = Number(data[i * 2]);
        const end = Number(data[i * 2 + 1]);
        if (end > begin && end > 0 && begin > 0) {
          results.set(i, (end - begin) / 1_000_000);
        }
      }

      this.readBuffer.unmap();
      this.bufferMapped = false;
      this.lastResults = results;
      return results;
    } catch {
      this.bufferMapped = false;
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
}
