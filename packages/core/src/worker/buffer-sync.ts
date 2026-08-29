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

/**
 * Main-thread buffer sync manager.
 *
 * Sends input regions to the worker on requestAnimationFrame, and receives
 * sim data regions from the worker via onMessage. Uses rAF (not setInterval)
 * to adapt to the display refresh rate and pause when the tab is hidden.
 */
export class BufferSyncHost {
  private rafId = 0;
  private lastInputSeqs: Record<string, number> = {};

  constructor(
    private worker: Worker,
    private config: BufferSyncConfig,
  ) {}

  start(): void {
    this.worker.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
    this.syncInput(); // start rAF loop
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  /**
   * Sync input regions to the worker. Called on each rAF frame.
   * Copies only the writeRegions of each buffer, transfers the ArrayBuffers.
   */
  private syncInput = (): void => {
    const transfers: ArrayBuffer[] = [];
    const regions: Record<string, RegionCopy[]> = {};

    for (const [name, buf] of Object.entries(this.config.buffers)) {
      const regionDef = this.config.regions[name];
      if (!regionDef || regionDef.writeRegions.length === 0) continue;

      // Sequence gating: skip if nothing changed (only for buffers with seq fields)
      const seqField = this.config.seqFields?.[name];
      if (seqField) {
        const view = new Int32Array(buf, seqField.offset, 1);
        const seq = view[0];
        if (seq === this.lastInputSeqs[name]) continue;
        this.lastInputSeqs[name] = seq;
      }

      const copies: RegionCopy[] = [];
      for (const r of regionDef.writeRegions) {
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
        // Clear-after-send: zero the local region so we don't re-send stale
        // data on the next frame. Used for input regions (hand-off pattern).
        if (r.clearAfterSend) {
          new Uint8Array(buf, r.offset, r.length).fill(0);
        }
      }
      if (copies.length > 0) regions[name] = copies;
    }

    if (Object.keys(regions).length > 0) {
      this.worker.postMessage({ __bufferSync: true, regions } as BufferSyncMessage, transfers);
    }

    this.rafId = requestAnimationFrame(this.syncInput);
  };

  /**
   * Receive sim data regions from the worker. Copies only the readRegions
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
  private lastSimSeqs: Record<string, number> = {};

  constructor(private config: BufferSyncConfig) {}

  start(): void {
    self.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
  }

  /**
   * Post written regions to the main thread. Called after each tick batch.
   * Copies only the writeRegions of each buffer, transfers the ArrayBuffers.
   * Skips buffers whose sequence hasn't changed (if seqFields declared).
   */
  syncToMain(): void {
    const transfers: ArrayBuffer[] = [];
    const regions: Record<string, RegionCopy[]> = {};

    for (const [name, buf] of Object.entries(this.config.buffers)) {
      const regionDef = this.config.regions[name];
      if (!regionDef || regionDef.writeRegions.length === 0) continue;

      // Sequence gating: skip if nothing changed
      const seqField = this.config.seqFields?.[name];
      if (seqField) {
        const view = new Int32Array(buf, seqField.offset, 1);
        const seq = view[0];
        if (seq === this.lastSimSeqs[name]) continue;
        this.lastSimSeqs[name] = seq;
      }

      const copies: RegionCopy[] = [];
      for (const r of regionDef.writeRegions) {
        const copy = new ArrayBuffer(r.length);
        new Uint8Array(copy).set(new Uint8Array(buf, r.offset, r.length));
        copies.push({ offset: r.offset, data: copy });
        transfers.push(copy);
      }
      regions[name] = copies;
    }

    if (Object.keys(regions).length > 0) {
      (self as any).postMessage({ __bufferSync: true, regions } as BufferSyncMessage, transfers);
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
