import { describe, expect, it } from "bun:test";
import { usingRealSAB } from "./sab-polyfill";

describe("sab-polyfill", () => {
  it("usingRealSAB reflects whether real SharedArrayBuffer exists", () => {
    // In the test environment (Bun), real SharedArrayBuffer should be available.
    expect(usingRealSAB).toBe(true);
    expect(typeof SharedArrayBuffer).toBe("function");
  });

  it("SharedArrayBuffer can be subclassed as ArrayBuffer", () => {
    // Verify the polyfill approach works: ArrayBuffer subclass accepts typed array views
    class FakeSAB extends ArrayBuffer {
      constructor(size: number) { super(size); }
    }
    const buf = new FakeSAB(1024);
    expect(buf instanceof ArrayBuffer).toBe(true);
    expect(buf instanceof FakeSAB).toBe(true);

    // Typed array views work on ArrayBuffer subclasses
    const i32 = new Int32Array(buf, 0, 16);
    i32[0] = 42;
    expect(i32[0]).toBe(42);

    const f32 = new Float32Array(buf, 64, 16);
    f32[0] = 3.14;
    expect(f32[0]).toBeCloseTo(3.14, 5);
  });

  it("Atomics.load/add/store work on ArrayBuffer-backed typed arrays", () => {
    // V8 doesn't enforce the SAB requirement for load/add/store — they work
    // on plain ArrayBuffer-backed typed arrays (non-atomic, but correct
    // for single-threaded access patterns).
    class FakeSAB extends ArrayBuffer {
      constructor(size: number) { super(size); }
    }
    const buf = new FakeSAB(64);
    const i32 = new Int32Array(buf);

    // Atomics.load should not throw
    expect(Atomics.load(i32, 0)).toBe(0);

    // Atomics.store should not throw
    Atomics.store(i32, 0, 42);
    expect(i32[0]).toBe(42);

    // Atomics.add should not throw and return the old value
    const old = Atomics.add(i32, 0, 10);
    expect(old).toBe(42);
    expect(i32[0]).toBe(52);
  });

  it("structuredClone copies FakeSAB bytes correctly", () => {
    class FakeSAB extends ArrayBuffer {
      constructor(size: number) { super(size); }
    }
    const buf = new FakeSAB(64);
    const i32 = new Int32Array(buf);
    i32[0] = 12345;
    i32[1] = -999;

    const cloned = structuredClone({ buf });
    // Clone produces a plain ArrayBuffer (not FakeSAB)
    expect(cloned.buf instanceof ArrayBuffer).toBe(true);
    expect(cloned.buf instanceof FakeSAB).toBe(false);

    // Bytes match
    const clonedI32 = new Int32Array(cloned.buf);
    expect(clonedI32[0]).toBe(12345);
    expect(clonedI32[1]).toBe(-999);
  });

  it("copying received bytes into existing buffer preserves view references", () => {
    class FakeSAB extends ArrayBuffer {
      constructor(size: number) { super(size); }
    }
    const local = new FakeSAB(64);
    const i32 = new Int32Array(local);

    // Simulate receiving a copy from postMessage
    const received = new ArrayBuffer(64);
    const receivedI32 = new Int32Array(received);
    receivedI32[0] = 777;
    receivedI32[1] = 888;

    // Copy received bytes into local buffer
    new Uint8Array(local).set(new Uint8Array(received));

    // The existing i32 view sees the new data (no need to re-create views)
    expect(i32[0]).toBe(777);
    expect(i32[1]).toBe(888);
  });
});
