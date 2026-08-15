// ============================================================================
// ring — SPSC (single-producer / single-consumer) lock-free ring buffer over
// a region of a SharedArrayBuffer, using Atomics for head/tail/seq.
//
// One slot is wasted to distinguish full from empty (classic bounded ring).
// Records are fixed-size (recBytes). The region layout:
//
//   [0  .. RING_HEADER_BYTES)   ring header (head, tail, cap, recBytes, seq)
//   [RING_HEADER_BYTES .. )     slot data: cap * recBytes bytes
//
// Producer API: tryPush() → slot index or null (full). publish(slot) advances tail.
// Consumer API: tryPop() → slot index or null (empty). release(slot) advances head.
//
// The caller reads/writes the record bytes directly via a typed-array view
// into the slot, so there is zero copy. Atomics.notify is fired on the seq
// counter after publish so a waiting consumer wakes; Atomics.wait/waitAsync
// is used by the consumer to block until publish.
// ============================================================================

import {
  RING_CAP_OFF,
  RING_HEADER_BYTES,
  RING_HEAD_OFF,
  RING_RECBYTES_OFF,
  RING_SEQ_OFF,
  RING_TAIL_OFF,
} from "../shared/protocol";

export interface RingOptions {
  /** Bytes per record (e.g. OP_RECORD_BYTES). Must divide region bytes - header. */
  recBytes: number;
}

/**
 * A view over one ring region of a SAB. Both producer and consumer construct
 * their own RingView over the same region; they share the SAB but have
 * distinct roles (one writes tail, one writes head).
 */
export class RingView {
  readonly sab: SharedArrayBuffer;
  readonly regionOffset: number;
  readonly regionBytes: number;
  readonly recBytes: number;
  private readonly i32: Int32Array;
  private readonly dataOffset: number;
  readonly cap: number;

  constructor(sab: SharedArrayBuffer, regionOffset: number, regionBytes: number, recBytes: number) {
    this.sab = sab;
    this.regionOffset = regionOffset;
    this.regionBytes = regionBytes;
    this.recBytes = recBytes;
    this.i32 = new Int32Array(sab, regionOffset, RING_HEADER_BYTES / 4);
    this.dataOffset = regionOffset + RING_HEADER_BYTES;
    const usable = regionBytes - RING_HEADER_BYTES;
    if (usable < recBytes) {
      throw new Error(
        `[worker-dom] Ring region too small: ${regionBytes} bytes, need at least ${RING_HEADER_BYTES + recBytes}`,
      );
    }
    this.cap = Math.floor(usable / recBytes);
  }

  /**
   * Initialize the ring header. Called once by the allocating side.
   */
  init(): void {
    Atomics.store(this.i32, RING_HEAD_OFF / 4, 0);
    Atomics.store(this.i32, RING_TAIL_OFF / 4, 0);
    Atomics.store(this.i32, RING_CAP_OFF / 4, this.cap);
    Atomics.store(this.i32, RING_RECBYTES_OFF / 4, this.recBytes);
    Atomics.store(this.i32, RING_SEQ_OFF / 4, 0);
  }

  // --- Producer side ---

  /** Reserve the next writable slot, or null if the ring is full. */
  tryPush(): number | null {
    const tail = Atomics.load(this.i32, RING_TAIL_OFF / 4);
    const head = Atomics.load(this.i32, RING_HEAD_OFF / 4);
    const next = (tail + 1) % this.cap;
    if (next === head) return null; // full
    return tail;
  }

  /** Publish the slot reserved by tryPush(). Advances tail, bumps seq, notifies. */
  publish(slot: number): void {
    const tail = Atomics.load(this.i32, RING_TAIL_OFF / 4);
    if (slot !== tail) {
      throw new Error(`[worker-dom] publish: slot ${slot} !== tail ${tail}`);
    }
    const next = (tail + 1) % this.cap;
    Atomics.store(this.i32, RING_TAIL_OFF / 4, next);
    Atomics.add(this.i32, RING_SEQ_OFF / 4, 1);
    Atomics.notify(this.i32, RING_SEQ_OFF / 4, Infinity);
  }

  // --- Consumer side ---

  /** Peek the next readable slot, or null if the ring is empty. */
  tryPop(): number | null {
    const tail = Atomics.load(this.i32, RING_TAIL_OFF / 4);
    const head = Atomics.load(this.i32, RING_HEAD_OFF / 4);
    if (head === tail) return null; // empty
    return head;
  }

  /** Release the slot returned by tryPop(). Advances head. */
  release(slot: number): void {
    const head = Atomics.load(this.i32, RING_HEAD_OFF / 4);
    if (slot !== head) {
      throw new Error(`[worker-dom] release: slot ${slot} !== head ${head}`);
    }
    const next = (head + 1) % this.cap;
    Atomics.store(this.i32, RING_HEAD_OFF / 4, next);
  }

  // --- Slot access ---

  /** Byte offset of a slot's record within the SAB. */
  slotByteOffset(slot: number): number {
    return this.dataOffset + slot * this.recBytes;
  }

  /** A Uint8Array view onto a slot's record bytes (zero copy). */
  slotBytes(slot: number): Uint8Array {
    return new Uint8Array(this.sab, this.slotByteOffset(slot), this.recBytes);
  }

  /** A Uint32Array view onto a slot's record (for u32 field reads/writes). */
  slotU32(slot: number): Uint32Array {
    return new Uint32Array(this.sab, this.slotByteOffset(slot), this.recBytes / 4);
  }

  // --- Waiting (consumer) ---

  /** Current seq counter (for wait/wake patterns). */
  getSeq(): number {
    return Atomics.load(this.i32, RING_SEQ_OFF / 4);
  }

  /**
   * Synchronously wait for the seq counter to change from `expectedSeq`,
   * up to `timeoutMs`. Returns true if woken (or already changed), false on timeout.
   * Only safe to call from a context that is allowed to block (a Worker, not
   * the main thread).
   */
  wait(expectedSeq: number, timeoutMs: number = 1000): boolean {
    const r = Atomics.wait(this.i32, RING_SEQ_OFF / 4, expectedSeq, timeoutMs);
    return r === "ok" || r === "not-equal";
  }

  /**
   * Asynchronously wait (Atomics.waitAsync). Returns a Promise<boolean>
   * resolving true if woken / already-changed, false on timeout.
   * Falls back to polling if waitAsync is unavailable.
   */
  waitAsync(expectedSeq: number, timeoutMs: number = 1000): Promise<boolean> {
    const waitAsync = (Atomics as any).waitAsync;
    if (typeof waitAsync === "function") {
      const res = waitAsync(this.i32, RING_SEQ_OFF / 4, expectedSeq, timeoutMs);
      if (res && typeof res.then === "function") {
        return res.then((r: string) => r === "ok" || r === "not-equal");
      }
      // Synchronous result (value not equal) — already changed.
      return Promise.resolve(res?.value === "ok" || res?.value === "not-equal" || res === "not-equal");
    }
    // Polling fallback.
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        if (this.getSeq() !== expectedSeq) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(poll, 1);
      };
      poll();
    });
  }

  // --- Stats ---

  /** Number of records currently in the ring (in-flight). */
  available(): number {
    const tail = Atomics.load(this.i32, RING_TAIL_OFF / 4);
    const head = Atomics.load(this.i32, RING_HEAD_OFF / 4);
    return (tail - head + this.cap) % this.cap;
  }

  /** Free slots (writable capacity remaining). */
  free(): number {
    return this.cap - 1 - this.available();
  }
}
