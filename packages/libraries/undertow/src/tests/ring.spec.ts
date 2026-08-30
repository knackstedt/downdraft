// ============================================================================
// ring.spec — SPSC ring correctness under Atomics, including grow().
// Exercises the protocol + dom-sab + ring layers with no DOM yet.
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    allocateDomSab,
    growDomSab,
    readRegions,
    validateDomSab,
} from "../sab/dom-sab";
import { EventRing } from "../sab/event-ring";
import { PayloadHeap } from "../sab/payload-heap";
import { ReplyRing } from "../sab/reply-ring";
import { RequestRing } from "../sab/request-ring";
import { StringPool } from "../sab/string-pool";
import {
    CONTROL_BYTES,
    CTL_GROW_VERSION_IDX,
    CTL_MAGIC,
    CTL_MAGIC_IDX,
    CTL_TOTAL_BYTES_IDX,
    EVENT_RECORD_BYTES,
    REPLY_RECORD_BYTES
} from "../shared/protocol";

describe("dom-sab", () => {
  it("allocates a valid SAB with correct magic/version and regions", () => {
    const sab = allocateDomSab();
    expect(validateDomSab(sab)).toBe(true);
    const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
    expect(u32[CTL_MAGIC_IDX]).toBe(CTL_MAGIC);
    expect(u32[CTL_TOTAL_BYTES_IDX]).toBe(16 * 1024 * 1024);

    const r = readRegions(sab);
    expect(r.reqOffset).toBeGreaterThanOrEqual(CONTROL_BYTES);
    expect(r.reqBytes).toBeGreaterThan(0);
    expect(r.replyOffset).toBe(r.reqOffset + r.reqBytes);
    expect(r.eventOffset).toBe(r.replyOffset + r.replyBytes);
    expect(r.stringOffset).toBe(r.eventOffset + r.eventBytes);
    expect(r.payloadOffset).toBe(r.stringOffset + r.stringBytes);
    expect(r.payloadOffset + r.payloadBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("grow increases total bytes and payload region, bumps grow version", () => {
    const sab = allocateDomSab();
    const caps = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
    const canGrow = (caps[14] & 1) !== 0; // CAP_GROW
    if (!canGrow) {
      console.warn("[ring.spec] SharedArrayBuffer.grow() unavailable — skipping grow test");
      return;
    }
    const before = readRegions(sab);
    const v0 = Atomics.load(new Int32Array(sab, 0, CONTROL_BYTES / 4), CTL_GROW_VERSION_IDX);
    const ok = growDomSab(sab, 32 * 1024 * 1024);
    expect(ok).toBe(true);
    const after = readRegions(sab);
    const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
    expect(u32[CTL_TOTAL_BYTES_IDX]).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(after.payloadBytes).toBeGreaterThan(before.payloadBytes);
    expect(Atomics.load(new Int32Array(sab, 0, CONTROL_BYTES / 4), CTL_GROW_VERSION_IDX)).toBe(v0 + 1);
  });
});

describe("RingView (request ring)", () => {
  function makeRings() {
    const sab = allocateDomSab();
    const regions = readRegions(sab);
    const req = new RequestRing(sab, regions);
    req.init();
    return { sab, regions, req };
  }

  it("starts empty", () => {
    const { req } = makeRings();
    expect(req.available()).toBe(0);
    expect(req.tryPop()).toBeNull();
  });

  it("push + pop round-trips a record", () => {
    const { req } = makeRings();
    const slot = req.tryPush();
    expect(slot).not.toBeNull();
    // Write a sentinel into the record.
    const u32 = req.slotU32(slot!);
    u32[0] = 0xdeadbeef;
    req.publish(slot!);
    expect(req.available()).toBe(1);

    const got = req.tryPop();
    expect(got).toBe(slot);
    expect(req.slotU32(got!)[0]).toBe(0xdeadbeef);
    req.release(got!);
    expect(req.available()).toBe(0);
  });

  it("reports full when one slot remains free (wasted-slot invariant)", () => {
    const sab = allocateDomSab({
      initialBytes: 64 * 1024,
      maxBytes: 128 * 1024,
      reqRingBytes: 4096,
      replyRingBytes: 4096,
      eventRingBytes: 4096,
      stringPoolBytes: 1024,
      payloadHeapBytes: 4096,
    });
    const regions = readRegions(sab);
    const req = new RequestRing(sab, regions);
    req.init();
    const cap = req.cap;
    // Fill cap-1 slots (the last is wasted).
    for (let i = 0; i < cap - 1; i++) {
      const s = req.tryPush();
      expect(s).not.toBeNull();
      req.publish(s!);
    }
    expect(req.tryPush()).toBeNull(); // full
    expect(req.available()).toBe(cap - 1);
  });

  it("drains in FIFO order", () => {
    const { req } = makeRings();
    const N = Math.min(50, req.cap - 1);
    for (let i = 0; i < N; i++) {
      const s = req.tryPush();
      req.slotU32(s!)[0] = i;
      req.publish(s!);
    }
    for (let i = 0; i < N; i++) {
      const s = req.tryPop();
      expect(s).not.toBeNull();
      expect(req.slotU32(s!)[0]).toBe(i);
      req.release(s!);
    }
    expect(req.tryPop()).toBeNull();
  });
});

describe("reply + event rings", () => {
  it("reply ring round-trips with REPLY_RECORD_BYTES stride", () => {
    const sab = allocateDomSab();
    const regions = readRegions(sab);
    const reply = new ReplyRing(sab, regions);
    reply.init();
    expect(reply.recBytes).toBe(REPLY_RECORD_BYTES);
    const s = reply.tryPush();
    reply.slotU32(s!)[0] = 42;
    reply.publish(s!);
    expect(reply.tryPop()).toBe(s);
    expect(reply.slotU32(s!)[0]).toBe(42);
    reply.release(s!);
  });

  it("event ring round-trips with EVENT_RECORD_BYTES stride", () => {
    const sab = allocateDomSab();
    const regions = readRegions(sab);
    const ev = new EventRing(sab, regions);
    ev.init();
    expect(ev.recBytes).toBe(EVENT_RECORD_BYTES);
    const s = ev.tryPush();
    ev.slotU32(s!)[0] = 7;
    ev.publish(s!);
    expect(ev.tryPop()).toBe(s);
    expect(ev.slotU32(s!)[0]).toBe(7);
    ev.release(s!);
  });
});

describe("payload heap + string pool", () => {
  it("payload heap allocates and reads back bytes", () => {
    const sab = allocateDomSab();
    const regions = readRegions(sab);
    const heap = new PayloadHeap(sab, regions);
    heap.init();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const off = heap.writeBytes(data);
    expect(heap.readBytes(off, data.length)).toEqual(data);
  });

  it("string pool interns and resolves", () => {
    const sab = allocateDomSab();
    const regions = readRegions(sab);
    const pool = new StringPool(sab, regions);
    pool.init();
    const a1 = pool.intern("click");
    const a2 = pool.intern("click");
    expect(a1).toBe(a2);
    expect(pool.resolve(a1)).toBe("click");
    const a3 = pool.intern("keydown");
    expect(a3).not.toBe(a1);
    expect(pool.resolve(a3)).toBe("keydown");
  });

  it("string pool resets on overflow and continues interning", () => {
    // Use a tiny string pool to force overflow quickly.
    const sab = allocateDomSab({ stringPoolBytes: 256, payloadHeapBytes: 4096 });
    const regions = readRegions(sab);
    const pool = new StringPool(sab, regions);
    pool.init();

    // Fill the pool with unique strings until it overflows.
    const atoms: number[] = [];
    for (let i = 0; i < 100; i++) {
      const a = pool.intern(`str-${i}-padding-to-force-overflow-quickly`);
      atoms.push(a);
    }

    // After overflow + reset, new strings should still intern successfully.
    const lateAtom = pool.intern("after-overflow");
    expect(lateAtom).toBeGreaterThan(0);
    expect(pool.resolve(lateAtom)).toBe("after-overflow");

    // The late atom should be resolvable from a second pool instance (simulating
    // the other side reading from the same SAB).
    const pool2 = new StringPool(sab, regions);
    // pool2 hasn't called init() — it reads the existing SAB state.
    expect(pool2.resolve(lateAtom)).toBe("after-overflow");
  });

  it("string pool resolve clamps highWater to regionBytes", () => {
    // This test verifies that resolve() doesn't throw a RangeError even if
    // the highWater pointer was advanced past the region by an overflow.
    const sab = allocateDomSab({ stringPoolBytes: 128, payloadHeapBytes: 4096 });
    const regions = readRegions(sab);
    const pool = new StringPool(sab, regions);
    pool.init();

    // Intern a string to populate the pool.
    const a1 = pool.intern("test");
    expect(pool.resolve(a1)).toBe("test");

    // Simulate a corrupted highWater (past the region) by directly writing
    // to the SAB. resolve() should clamp it and not throw.
    const i32 = new Int32Array(sab, regions.stringOffset, 2);
    Atomics.store(i32, 1, 999999);

    // Should not throw a RangeError.
    expect(pool.resolve(999)).toBeNull();
  });
});

