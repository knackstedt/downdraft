import { SeqlockBuffer, createLayout } from "../sab/seqlock.ts";
import { CHANNEL_LAYOUTS, createSABForChannel } from "../sab/protocol.ts";

describe("SeqlockBuffer", () => {
  it("should write and read data correctly", () => {
    const layout = createLayout([
      { name: "value", type: "f32", count: 1 },
      { name: "vec3", type: "f32", count: 3 },
    ]);

    const sab = new SharedArrayBuffer(layout.totalBytes);
    const buf = new SeqlockBuffer(sab, layout);

    buf.beginWrite();
    buf.writeField("value", 42.5);
    buf.writeField("vec3", [1, 2, 3]);
    buf.endWrite();

    const data = buf.read();
    expect(data).not.toBeNull();
    expect(data!.value).toBe(42.5);
    expect(data!.vec3).toEqual([1, 2, 3]);
  });

  it("should detect changes via hasChanged", () => {
    const layout = CHANNEL_LAYOUTS.transform;
    const sab = createSABForChannel("transform");
    const buf = new SeqlockBuffer(sab, layout);

    const seq1 = buf.getSequence();
    buf.beginWrite();
    buf.writeField("position", [10, 20, 30]);
    buf.endWrite();

    expect(buf.hasChanged(seq1)).toBe(true);
  });

  it("should handle readInto", () => {
    const layout = createLayout([
      { name: "x", type: "f32", count: 1 },
      { name: "y", type: "f32", count: 1 },
    ]);

    const sab = new SharedArrayBuffer(layout.totalBytes);
    const buf = new SeqlockBuffer(sab, layout);

    buf.beginWrite();
    buf.writeField("x", 100);
    buf.writeField("y", 200);
    buf.endWrite();

    const target: Record<string, unknown> = {};
    const success = buf.readInto(target);

    expect(success).toBe(true);
    expect(target.x).toBe(100);
    expect(target.y).toBe(200);
  });

  it("should return last valid data on retry exhaustion", () => {
    const layout = createLayout([
      { name: "val", type: "f32", count: 1 },
    ]);

    const sab = new SharedArrayBuffer(layout.totalBytes);
    const buf = new SeqlockBuffer(sab, layout, 2);

    // Write once successfully
    buf.beginWrite();
    buf.writeField("val", 99);
    buf.endWrite();

    const firstRead = buf.read();
    expect(firstRead).not.toBeNull();
    expect(firstRead!.val).toBe(99);

    // Leave in writing state (odd seq) — read should return last valid
    buf.beginWrite();
    const staleRead = buf.read();
    expect(staleRead).not.toBeNull();
    expect(staleRead!.val).toBe(99); // last valid data
  });
});

describe("SAB Protocol", () => {
  it("should create SAB with correct size for each channel", () => {
    const transformSAB = createSABForChannel("transform");
    expect(transformSAB.byteLength).toBeGreaterThan(0);

    const inputSAB = createSABForChannel("input");
    expect(inputSAB.byteLength).toBeGreaterThan(0);

    // Input should be larger than transform due to more fields
    expect(inputSAB.byteLength).toBeGreaterThan(transformSAB.byteLength);
  });

  it("should round-trip data through transform channel", () => {
    const sab = createSABForChannel("transform");
    const buf = new SeqlockBuffer(sab, CHANNEL_LAYOUTS.transform);

    buf.beginWrite();
    buf.writeField("position", [1.5, 2.5, 3.5]);
    buf.writeField("rotation", [0, 0.707, 0, 0.707]);
    buf.writeField("scale", 2.0);
    buf.endWrite();

    const data = buf.read();
    expect(data).not.toBeNull();
    expect(data!.position).toEqual([1.5, 2.5, 3.5]);
    expect(data!.rotation[0]).toBeCloseTo(0);
    expect(data!.rotation[1]).toBeCloseTo(0.707);
    expect(data!.rotation[2]).toBeCloseTo(0);
    expect(data!.rotation[3]).toBeCloseTo(0.707);
    expect(data!.scale).toBe(2.0);
  });
});
