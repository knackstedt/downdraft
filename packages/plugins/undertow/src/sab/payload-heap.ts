// ============================================================================
// payload-heap — bump allocator over the PAYLOAD_HEAP region for variable-
// length arg/result/event blobs (typed arrays, structured-clone-lite objects).
//
// Layout:
//   [0 .. 4) highWater u32 atomic — bump pointer
//   [4 .. regionBytes) payload storage
//
// Allocation is bump-style: claim [highWater, highWater+len), advance. There
// is no free in v1; the heap is reset by the producer at frame boundaries
// (after the consumer has drained). Reset is coordinated via the control
// header's grow version / a per-frame epoch — v1 uses a simple "reset when
// both rings are empty" check on the main side.
// ============================================================================

import type { DomSabRegions } from "./dom-sab";

const HEADER = 4;

export interface PayloadRef {
  offset: number; // absolute SAB byte offset of the payload
  length: number;
}

export class PayloadHeap {
  readonly sab: SharedArrayBuffer;
  readonly regionOffset: number;
  readonly regionBytes: number;
  private readonly i32: Int32Array;

  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    this.sab = sab;
    this.regionOffset = regions.payloadOffset;
    this.regionBytes = regions.payloadBytes;
    this.i32 = new Int32Array(sab, regions.payloadOffset, HEADER / 4);
  }

  init(): void {
    Atomics.store(this.i32, 0, HEADER);
  }

  /**
   * Allocate `len` bytes from the heap. Returns the absolute SAB byte offset,
   * or throws if the heap is full (caller should trigger a grow).
   */
  alloc(len: number): number {
    if (len <= 0) return 0;
    const off = Atomics.add(this.i32, 0, len) as unknown as number;
    if (off + len > this.regionBytes) {
      // Out of heap — caller must grow the SAB. Roll back is not possible with
      // a pure bump allocator; signal by throwing. The host catches this and
      // calls growDomSab(), then retries.
      throw new Error(`[worker-dom] payload heap full: need ${off + len}, have ${this.regionBytes}`);
    }
    return this.regionOffset + off;
  }

  /** Write bytes into a freshly allocated slot. Returns the absolute offset. */
  writeBytes(bytes: Uint8Array): number {
    const off = this.alloc(bytes.length);
    if (off === 0) return 0;
    new Uint8Array(this.sab, off, bytes.length).set(bytes);
    return off;
  }

  /** Read `len` bytes at absolute offset `off`. */
  readBytes(off: number, len: number): Uint8Array {
    if (len === 0) return new Uint8Array(0);
    return new Uint8Array(this.sab, off, len);
  }

  /** Reset the bump pointer to HEADER. Only safe when no consumer is mid-read. */
  reset(): void {
    Atomics.store(this.i32, 0, HEADER);
  }

  /** Current high-water mark (for stats / grow decisions). */
  highWater(): number {
    return Atomics.load(this.i32, 0);
  }
}
