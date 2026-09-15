// ============================================================================
// buffer-sync — copy-based buffer synchronization for the SAB polyfill
// ============================================================================
//
// When SharedArrayBuffer is polyfilled (Android WebView), each thread has its
// own ArrayBuffer instance. This module synchronizes them via postMessage at
// tick/frame boundaries:
//
//   Main → Worker (input):  driven by requestAnimationFrame, copies only the
//     input region(s) the main thread writes, transfers the ArrayBuffer.
//   Worker → Main (sim):    event-driven (after each tick batch), copies only
//     the regions the worker writes, transfers the ArrayBuffer.
//
// Optimizations:
//   - Region-aware: only the declared write regions are copied, not the full
//     buffer. For sandjongg's embedded input (64 bytes), main→worker copies
//     64 bytes, not the full 1.3MB.
//   - Sequence-number gating: if a buffer has a sequence field, the sync is
//     skipped when the sequence hasn't changed since the last sync. Eliminates
//     all copy overhead when the sim is paused.
//   - Transferable ArrayBuffers: postMessage with a transfer list avoids the
//     structured-clone copy (transfer is zero-copy). Net: 1 copy (slice)
//     instead of 2 (slice + structured clone).
//
// Single-writer constraint:
//   Each buffer region must have exactly one writer. If both sides write to
//   the same region, the sync will overwrite one side's writes with stale data
//   from the other. The region declarations (writeRegions/readRegions) enforce
//   this — the sync manager only copies declared write regions.
//

/** A region within a buffer (offset + length in bytes). */
export interface BufferRegion {
  offset: number;
  length: number;
  name: string;
  /**
   * If true, the sender zeros this region in the local buffer after copying
   * it outbound. Used for input regions: the main thread writes input (e.g.
   * ACTION=1), rAF copies + sends it, then clears the local copy so it
   * doesn't re-send stale input on the next frame. The worker processes
   * the received input and ignores subsequent zeros (ACTION=0 = no action).
   *
   * This eliminates the race where the worker sends the cleared input back
   * to the main thread, overwriting a new click written between the worker's
   * sync message and the next rAF.
   */
  clearAfterSend?: boolean;
  /**
   * If true, the region is only sent when it contains non-zero data. Used
   * with clearAfterSend on input regions: after the input is sent and
   * cleared, subsequent rAF frames see all-zeros and skip sending — so
   * they don't overwrite the worker's pending input with zeros before
   * the worker's tick loop processes it.
   */
  skipIfAllZero?: boolean;
  /**
   * Throttle: only sync this region every N rAF frames (host side only).
   * Default 1 (every frame). Set to e.g. 3 for large grid data regions
   * to reduce copy overhead on mobile. The worker side ignores this field
   * (worker sync is event-driven, not rAF-based).
   */
  syncInterval?: number;
  /**
   * Dynamic length: if set, the actual region length is read from a Uint32
   * field at this byte offset in the buffer, multiplied by `lengthMultiplier`.
   * This enables syncing only the active portion of a fixed-size buffer
   * (e.g. instance data where only the first N entries are used). The
   * `length` field is treated as the maximum possible length.
   */
  lengthFieldOffset?: number;
  lengthMultiplier?: number;
}

/** Declares which regions of a buffer each side writes. */
export interface BufferSyncRegions {
  /** Regions this side writes — only these are copied outbound. */
  writeRegions: BufferRegion[];
  /** Regions the other side writes — only these are copied inbound. */
  readRegions: BufferRegion[];
}

/** Location of a sequence-number field for change gating. */
export interface SeqField {
  /** Byte offset of the i32 sequence field within the buffer. */
  offset: number;
}

/** Configuration for the buffer sync protocol. */
export interface BufferSyncConfig {
  /** Map of buffer name → ArrayBuffer (FakeSAB) instance on this side. */
  buffers: Record<string, ArrayBufferLike>;
  /** Region declarations per buffer (which regions each side writes). */
  regions: Record<string, BufferSyncRegions>;
  /** Sequence-number field locations per buffer (for change gating). Optional. */
  seqFields?: Record<string, SeqField>;
}

/** A single region copy in a sync message. */
interface RegionCopy {
  offset: number;
  data: ArrayBuffer;
}

/** Internal sync message format (posted via postMessage). */
export interface BufferSyncMessage {
  __bufferSync: true;
  /** Map of buffer name → list of region copies. */
  regions: Record<string, RegionCopy[]>;
}

/** Check if a message is a buffer-sync message. */
export function isBufferSyncMessage(msg: unknown): msg is BufferSyncMessage {
  return typeof msg === "object" && msg !== null && "__bufferSync" in msg;
}

// ---------------------------------------------------------------------------
// Main-thread side
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profiling support (lightweight, no deps)
// ---------------------------------------------------------------------------

/** Accumulates timing samples and logs a summary every N calls. */
class SyncProfiler {
  private samples: Array<{ label: string; ms: number; bytes: number }> = [];
  private logTimer = 0;
  private logInterval: number;

  constructor(logIntervalMs = 5000) {
    this.logInterval = logIntervalMs;
  }

  /** Record a timed operation. Call begin() before, end() after. */
  begin(): number { return performance.now(); }
  end(label: string, start: number, bytes: number): void {
    const ms = performance.now() - start;
    this.samples.push({ label, ms, bytes });
    const now = performance.now();
    if (now - this.logTimer >= this.logInterval) {
      this.logTimer = now;
      this.flush();
    }
  }

  private flush(): void {
    if (this.samples.length === 0) return;
    const byLabel: Record<string, { count: number; totalMs: number; totalBytes: number; maxMs: number }> = {};
    for (const s of this.samples) {
      const e = byLabel[s.label] ?? (byLabel[s.label] = { count: 0, totalMs: 0, totalBytes: 0, maxMs: 0 });
      e.count++;
      e.totalMs += s.ms;
      e.totalBytes += s.bytes;
      if (s.ms > e.maxMs) e.maxMs = s.ms;
    }
    const lines: string[] = [];
    for (const [label, e] of Object.entries(byLabel)) {
      const avgMs = (e.totalMs / e.count).toFixed(2);
      const maxMs = e.maxMs.toFixed(2);
      const totalKB = (e.totalBytes / 1024).toFixed(0);
      const avgKB = (e.totalBytes / e.count / 1024).toFixed(1);
      lines.push(`  ${label}: ${e.count}x avg=${avgMs}ms max=${maxMs}ms avgSize=${avgKB}KB total=${totalKB}KB`);
    }
    console.warn(`[BufferSync Profiling] ${this.samples.length} samples over last ${this.logInterval}ms:\n${lines.join("\n")}`);
    this.samples = [];
  }
}

/**
 * Main-thread buffer sync manager.
 *
 * Sends input regions to the worker on requestAnimationFrame, and receives
 * sim data regions from the worker via onMessage. Uses rAF (not setInterval)
 * to adapt to the display refresh rate and pause when the tab is hidden.
 */
export class BufferSyncHost {
  private rafId = 0;
  /** Per-region last-synced sequence: buffer name → region name → seq.
   *  Tracked per region (not per buffer) so throttled regions aren't starved
   *  when another region's sync consumes the buffer-level seq. */
  private lastRegionSeqs: Record<string, Record<string, number>> = {};
  private frameCount = 0;
  private profiler = new SyncProfiler(5000);
  private messageHandler: ((e: MessageEvent) => void) | null = null;

  constructor(
    private worker: Worker,
    private config: BufferSyncConfig,
  ) {}

  start(): void {
    if (!this.messageHandler) {
      this.messageHandler = (e: MessageEvent) => this.onMessage(e.data);
      this.worker.addEventListener("message", this.messageHandler);
    }
    cancelAnimationFrame(this.rafId); // guard against double-start
    this.syncInput(); // start rAF loop
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    if (this.messageHandler) {
      this.worker.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
  }

  /**
   * Sync input regions to the worker. Called on each rAF frame.
   * Copies only the writeRegions of each buffer, transfers the ArrayBuffers.
   * Regions with syncInterval > 1 are only synced every N frames (throttled).
   */
  private syncInput = (): void => {
    const transfers: ArrayBuffer[] = [];
    const regions: Record<string, RegionCopy[]> = {};
    this.frameCount++;
    let totalBytes = 0;
    const pStart = this.profiler.begin();

    for (const [name, buf] of Object.entries(this.config.buffers)) {
      const regionDef = this.config.regions[name];
      if (!regionDef || regionDef.writeRegions.length === 0) continue;

      // Sequence gating is per-region (see below) — read the current seq once.
      const seqField = this.config.seqFields?.[name];
      const seq = seqField ? new Int32Array(buf, seqField.offset, 1)[0] : 0;

      const copies: RegionCopy[] = [];
      for (const r of regionDef.writeRegions) {
        // Throttle: skip regions with syncInterval > 1 on most frames.
        // Only sync them every syncInterval frames.
        if (r.syncInterval && r.syncInterval > 1) {
          if (this.frameCount % r.syncInterval !== 0) continue;
        }
        // Per-region sequence gating: skip this region if its last-synced
        // seq matches the buffer's current seq. Per-region tracking (rather
        // than per-buffer) is required because interval-throttled regions
        // would otherwise never sync — a seq change consumed by a non-
        // throttled region would gate the throttled one out forever.
        if (seqField) {
          const lastSeqs = (this.lastRegionSeqs[name] ??= {});
          if (lastSeqs[r.name] === seq) continue;
        }
        const src = new Uint8Array(buf, r.offset, r.length);
        // skipIfAllZero: don't send zero-filled regions (e.g. input with
        // ACTION=0 after clearAfterSend). This prevents overwriting the
        // worker's pending input with zeros before it processes the input.
        if (r.skipIfAllZero) {
          let allZero = true;
          for (let i = 0; i < src.length; i++) {
            if (src[i] !== 0) { allZero = false; break; }
          }
          if (allZero) continue;
        }
        const copy = new ArrayBuffer(r.length);
        new Uint8Array(copy).set(src);
        copies.push({ offset: r.offset, data: copy });
        transfers.push(copy);
        totalBytes += r.length;
        // Clear-after-send: zero the local region so we don't re-send stale
        // data on the next frame. Used for input regions (hand-off pattern).
        if (r.clearAfterSend) {
          new Uint8Array(buf, r.offset, r.length).fill(0);
        }
        if (seqField) {
          this.lastRegionSeqs[name][r.name] = seq;
        }
      }
      if (copies.length > 0) regions[name] = copies;
    }

    if (Object.keys(regions).length > 0) {
      const postStart = performance.now();
      this.worker.postMessage({ __bufferSync: true, regions } as BufferSyncMessage, transfers);
      this.profiler.end("host→worker postMessage", postStart, totalBytes);
    }
    this.profiler.end("host→worker total", pStart, totalBytes);

    this.rafId = requestAnimationFrame(this.syncInput);
  };

  /**
   * Receive sim data regions from the worker. Copies only the readRegions
   * (regions the other side writes) into the local buffer.
   */
  private onMessage(msg: unknown): void {
    if (!isBufferSyncMessage(msg)) return;

    const pStart = this.profiler.begin();
    let totalBytes = 0;
    for (const [name, regionList] of Object.entries(msg.regions)) {
      const local = this.config.buffers[name];
      if (!local) continue;
      for (const { offset, data } of regionList) {
        new Uint8Array(local, offset, data.byteLength).set(new Uint8Array(data));
        totalBytes += data.byteLength;
      }
    }
    this.profiler.end("worker→host onMessage", pStart, totalBytes);
  }
}

// ---------------------------------------------------------------------------
// Worker-thread side
// ---------------------------------------------------------------------------

/**
 * Worker-thread buffer sync manager.
 *
 * Sends sim data regions to the main thread after each tick batch (event-
 * driven, no polling), and receives input regions from the main thread via
 * onMessage.
 */
export class BufferSyncWorker {
  /** Per-region last-synced sequence: buffer name → region name → seq.
   *  Tracked per region (not per buffer) so a filtered syncToMain() call
   *  can't consume the buffer seq and starve regions it filtered out —
   *  e.g. the fast/slow region pattern in sim-worker-base, where a
   *  fast-region sync followed by a full sync must still send slow regions. */
  private lastRegionSeqs: Record<string, Record<string, number>> = {};
  private profiler = new SyncProfiler(5000);
  private onAfterReceive: (() => void) | null = null;

  constructor(private config: BufferSyncConfig) {}

  /**
   * Start listening for sync messages from the main thread.
   * @param onAfterReceive - Optional callback fired after each received
   *   message is processed. Use this to trigger event-driven work (e.g.
   *   the grid builder calls build() here instead of polling on a timer,
   *   which avoids Android WebView's timer throttling in workers).
   */
  start(onAfterReceive?: () => void): void {
    this.onAfterReceive = onAfterReceive ?? null;
    self.addEventListener("message", (e: MessageEvent) => {
      this.onMessage(e.data);
      this.onAfterReceive?.();
    });
  }

  /**
   * Post written regions to the main thread. Called after each tick batch.
   * Copies only the writeRegions of each buffer, transfers the ArrayBuffers.
   * Skips buffers whose sequence hasn't changed (if seqFields declared).
   *
   * @param regionNames - If provided, only sync write regions whose `name`
   *   matches one of the given names. This enables throttled sync: sync small
   *   "fast" regions (header, entities) every tick, and large "slow" regions
   *   (grid data, render buffers) every N ticks. If omitted, sync all regions.
   */
  syncToMain(regionNames?: string[]): void {
    const transfers: ArrayBuffer[] = [];
    const regions: Record<string, RegionCopy[]> = {};
    const filter = regionNames ? new Set(regionNames) : null;
    const pStart = this.profiler.begin();
    let totalBytes = 0;

    for (const [name, buf] of Object.entries(this.config.buffers)) {
      const regionDef = this.config.regions[name];
      if (!regionDef || regionDef.writeRegions.length === 0) continue;

      // Sequence gating is per-region (see below) — read the current seq once.
      const seqField = this.config.seqFields?.[name];
      const seq = seqField ? new Int32Array(buf, seqField.offset, 1)[0] : 0;

      const copies: RegionCopy[] = [];
      for (const r of regionDef.writeRegions) {
        // Region name filter: skip regions not in the filter set.
        if (filter && !filter.has(r.name)) continue;
        // Per-region sequence gating: skip if this region's last-synced seq
        // matches the current buffer seq. Regions excluded by `filter` are
        // checked before this point, so a filtered call never consumes seq
        // for regions it didn't send.
        if (seqField) {
          const lastSeqs = (this.lastRegionSeqs[name] ??= {});
          if (lastSeqs[r.name] === seq) continue;
        }
        // Dynamic length: read actual length from a field in the buffer.
        let len = r.length;
        if (r.lengthFieldOffset !== undefined && r.lengthMultiplier) {
          const count = new Uint32Array(buf, r.lengthFieldOffset, 1)[0];
          len = Math.min(r.length, count * r.lengthMultiplier);
        }
        // Chunked transfer: if the region is large, split into chunks
        // and send with setTimeout between them so the main thread
        // can process rAF/render between chunks. This prevents 100-900ms
        // main-thread blocks on Android WebView (where SAB is unavailable
        // and postMessage structured clone is ~10MB/s).
        const CHUNK_SIZE = 64 * 1024; // 64KB per chunk — small enough to avoid >50ms blocks
        if (len > CHUNK_SIZE) {
          const numChunks = Math.ceil(len / CHUNK_SIZE);
          for (let i = 0; i < numChunks; i++) {
            const chunkStart = i * CHUNK_SIZE;
            const chunkLen = Math.min(CHUNK_SIZE, len - chunkStart);
            const chunkCopy = new ArrayBuffer(chunkLen);
            new Uint8Array(chunkCopy).set(new Uint8Array(buf, r.offset + chunkStart, chunkLen));
            copies.push({ offset: r.offset + chunkStart, data: chunkCopy });
            transfers.push(chunkCopy);
            totalBytes += chunkLen;
          }
        } else {
          const copy = new ArrayBuffer(len);
          new Uint8Array(copy).set(new Uint8Array(buf, r.offset, len));
          copies.push({ offset: r.offset, data: copy });
          transfers.push(copy);
          totalBytes += len;
        }
        if (seqField) {
          this.lastRegionSeqs[name][r.name] = seq;
        }
      }
      if (copies.length > 0) regions[name] = copies;
    }

    if (Object.keys(regions).length > 0) {
      const label = regionNames ? `worker→host syncToMain(${regionNames.join(",")})` : "worker→host syncToMain(all)";
      // Send all chunks in a single postMessage. The host's onMessage
      // handler copies each chunk to the correct offset in the local buffer.
      // We don't use setTimeout between chunks because the postMessage
      // itself is the blocking operation on the main thread — splitting
      // into multiple postMessage calls with setTimeout would allow the
      // main thread to render between them.
      const allCopies = Object.values(regions).flat();
      if (allCopies.length > 1 && totalBytes > 256 * 1024) {
        // Large transfer: send chunks with setTimeout between them
        // so the main thread can render between chunks.
        let chunkIdx = 0;
        const sendNextChunk = () => {
          if (chunkIdx >= allCopies.length) return;
          // Send 1 chunk per postMessage to minimize per-message block duration
          const batchTransfers: ArrayBuffer[] = [];
          const batchRegions: Record<string, RegionCopy[]> = {};
          const copy = allCopies[chunkIdx];
          // Find which buffer this chunk belongs to
          for (const [name, regionList] of Object.entries(regions)) {
            if (regionList.includes(copy)) {
              if (!batchRegions[name]) batchRegions[name] = [];
              batchRegions[name].push(copy);
              break;
            }
          }
          batchTransfers.push(copy.data);
          chunkIdx++;
          if (Object.keys(batchRegions).length > 0) {
            (self as any).postMessage({ __bufferSync: true, regions: batchRegions } as BufferSyncMessage, batchTransfers);
          }
          if (chunkIdx < allCopies.length) {
            setTimeout(sendNextChunk, 16); // 16ms delay lets main thread render between chunks
          }
        };
        sendNextChunk();
        this.profiler.end(label, pStart, totalBytes);
      } else {
        (self as any).postMessage({ __bufferSync: true, regions } as BufferSyncMessage, transfers);
        this.profiler.end(label, pStart, totalBytes);
      }
    }
  }

  /**
   * Receive input regions from the main thread. Copies only the readRegions
   * (regions the other side writes) into the local buffer.
   */
  private onMessage(msg: unknown): void {
    if (!isBufferSyncMessage(msg)) return;

    for (const [name, regionList] of Object.entries(msg.regions)) {
      const local = this.config.buffers[name];
      if (!local) continue;
      for (const { offset, data } of regionList) {
        new Uint8Array(local, offset, data.byteLength).set(new Uint8Array(data));
      }
    }
  }
}
