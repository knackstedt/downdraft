// ============================================================================
// TaskLatencyHistogram — fixed-bucket histogram for task/tick latency.
//
// Updated by wrapping task execution in JS/TS (task-worker + sim tick),
// QuickJS (eval/callGlobal/tick), and WASM (tick/on_event). Computes
// p50/p95/p99/max for the ThreadMetrics block. Also retains a small ring
// of recent samples (name + duration + timestamp) for the flame-graph view.
// ============================================================================

const NUM_BUCKETS = 64;
const MAX_SAMPLE_RING = 128;

/** A single latency sample for the flame-graph view. */
export interface LatencySample {
  /** Task/tick name (e.g. "tick", "eval", "on_event", or a system name). */
  name: string;
  /** Duration in microseconds. */
  durationUs: number;
  /** Timestamp (performance.now()). */
  ts: number;
  /** Nesting depth for flame-graph stacking (0 = root). */
  depth: number;
}

export class TaskLatencyHistogram {
  private buckets: Uint32Array;
  private bucketMinUs: number;
  private bucketMaxUs: number;
  private count: number = 0;
  private minUs: number = Infinity;
  private maxUs: number = 0;
  private totalUs: number = 0;

  // Sample ring for the flame-graph view
  private sampleRing: LatencySample[];
  private sampleHead: number = 0;
  private sampleCount: number = 0;

  constructor(
    bucketMinUs: number = 0,
    bucketMaxUs: number = 300_000, // 300ms
  ) {
    this.buckets = new Uint32Array(NUM_BUCKETS);
    this.bucketMinUs = bucketMinUs;
    this.bucketMaxUs = bucketMaxUs;
    this.sampleRing = new Array(MAX_SAMPLE_RING);
  }

  /** Record a latency sample. */
  record(durationUs: number, name: string = "task", depth: number = 0): void {
    if (durationUs < 0) durationUs = 0;
    this.count++;
    this.totalUs += durationUs;
    if (durationUs < this.minUs) this.minUs = durationUs;
    if (durationUs > this.maxUs) this.maxUs = durationUs;

    // Bucket the value
    const bucketIdx = this.usToBucket(durationUs);
    this.buckets[bucketIdx]++;

    // Push to sample ring
    const sample: LatencySample = { name, durationUs, ts: performance.now(), depth };
    this.sampleRing[this.sampleHead] = sample;
    this.sampleHead = (this.sampleHead + 1) % MAX_SAMPLE_RING;
    if (this.sampleCount < MAX_SAMPLE_RING) this.sampleCount++;
  }

  /** Get the p50/p95/p99/max latency in microseconds. */
  getPercentiles(): { p50: number; p95: number; p99: number; max: number } {
    if (this.count === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
    const p50Count = Math.floor(this.count * 0.5);
    const p95Count = Math.floor(this.count * 0.95);
    const p99Count = Math.floor(this.count * 0.99);
    let cumulative = 0;
    let p50 = 0, p95 = 0, p99 = 0;
    for (let i = 0; i < NUM_BUCKETS; i++) {
      cumulative += this.buckets[i];
      if (p50 === 0 && cumulative >= p50Count) p50 = this.bucketToUs(i);
      if (p95 === 0 && cumulative >= p95Count) p95 = this.bucketToUs(i);
      if (p99 === 0 && cumulative >= p99Count) p99 = this.bucketToUs(i);
    }
    return { p50, p95, p99, max: this.maxUs };
  }

  getCount(): number {
    return this.count;
  }

  getMaxUs(): number {
    return this.maxUs;
  }

  /** Get recent samples for the flame-graph view (most recent first). */
  getSamples(): LatencySample[] {
    if (this.sampleCount === 0) return [];
    const result: LatencySample[] = [];
    for (let i = 0; i < this.sampleCount; i++) {
      const idx = (this.sampleHead - 1 - i + MAX_SAMPLE_RING * 2) % MAX_SAMPLE_RING;
      result.push(this.sampleRing[idx]);
    }
    return result;
  }

  /** Reset the histogram + samples (e.g. on hot-reload). */
  reset(): void {
    this.buckets.fill(0);
    this.count = 0;
    this.minUs = Infinity;
    this.maxUs = 0;
    this.totalUs = 0;
    this.sampleHead = 0;
    this.sampleCount = 0;
  }

  private usToBucket(us: number): number {
    if (us <= this.bucketMinUs) return 0;
    if (us >= this.bucketMaxUs) return NUM_BUCKETS - 1;
    // Logarithmic bucketing for better resolution at low latencies
    const logMin = Math.log(this.bucketMinUs + 1);
    const logMax = Math.log(this.bucketMaxUs);
    const logUs = Math.log(us + 1);
    const frac = (logUs - logMin) / (logMax - logMin);
    return Math.min(NUM_BUCKETS - 1, Math.max(0, Math.floor(frac * NUM_BUCKETS)));
  }

  private bucketToUs(idx: number): number {
    if (idx === 0) return this.bucketMinUs;
    if (idx === NUM_BUCKETS - 1) return this.bucketMaxUs;
    const logMin = Math.log(this.bucketMinUs + 1);
    const logMax = Math.log(this.bucketMaxUs);
    const logUs = logMin + (idx / NUM_BUCKETS) * (logMax - logMin);
    return Math.exp(logUs) - 1;
  }
}
