import { InterpolationBuffer } from "./interpolation-buffer";

describe("InterpolationBuffer", () => {
  it("should assign and release slots", () => {
    const buf = new InterpolationBuffer(10);
    const slot = buf.assignSlot(0);
    expect(slot).toBe(0);
    const slot1 = buf.assignSlot(1);
    expect(slot1).toBe(1);
    // Re-assigning same entity returns same slot
    expect(buf.assignSlot(0)).toBe(0);
    buf.releaseSlot(0);
    buf.releaseSlot(1);
  });

  it("should return -1 when capacity exceeded", () => {
    const buf = new InterpolationBuffer(2);
    expect(buf.assignSlot(0)).toBe(0);
    expect(buf.assignSlot(1)).toBe(1);
    expect(buf.assignSlot(2)).toBe(-1);
  });

  it("should write a tick and read interpolated transforms", () => {
    const buf = new InterpolationBuffer(10);
    buf.assignSlot(0);

    // First tick: write pos=[0,0,0]
    const writeBuf = new Float32Array(10 * 8);
    writeBuf[0] = 0; writeBuf[1] = 0; writeBuf[2] = 0;
    writeBuf[3] = 0; writeBuf[4] = 0; writeBuf[5] = 0; writeBuf[6] = 1;
    buf.writeTick(0, (_realmId, b, _count) => { b.set(writeBuf, 0); }, 1);

    // Second tick: write pos=[10,0,0]
    const writeBuf2 = new Float32Array(10 * 8);
    writeBuf2[0] = 10; writeBuf2[1] = 0; writeBuf2[2] = 0;
    writeBuf2[3] = 0; writeBuf2[4] = 0; writeBuf2[5] = 0; writeBuf2[6] = 1;
    buf.writeTick(0, (_realmId, b, _count) => { b.set(writeBuf2, 0); }, 1);

    // Read at alpha=0.5 → pos should be [5,0,0]
    const out = new Float32Array(10 * 8);
    buf.readInterpolated(0.5, out, 1);
    expect(out[0]).toBeCloseTo(5, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it("should clamp alpha to [0, 1]", () => {
    const buf = new InterpolationBuffer(10);
    buf.assignSlot(0);
    const writeBuf = new Float32Array(10 * 8);
    writeBuf[0] = 0;
    buf.writeTick(0, (_r, b, _c) => { b.set(writeBuf, 0); }, 1);
    writeBuf[0] = 10;
    buf.writeTick(0, (_r, b, _c) => { b.set(writeBuf, 0); }, 1);

    const out = new Float32Array(10 * 8);
    buf.readInterpolated(2.0, out, 1); // alpha > 1 → clamped to 1
    expect(out[0]).toBeCloseTo(10, 5);

    buf.readInterpolated(-1.0, out, 1); // alpha < 0 → clamped to 0
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it("should reseed a body to avoid interpolation snap", () => {
    const buf = new InterpolationBuffer(10);
    buf.assignSlot(0);

    // Write tick 1: pos=[0,0,0]
    const w1 = new Float32Array(10 * 8);
    buf.writeTick(0, (_r, b, _c) => { b.set(w1, 0); }, 1);

    // Reseed to pos=[5,5,5]
    buf.reseed(0, [5, 5, 5], [0, 0, 0, 1]);

    // Write tick 2: pos=[5,5,5] (same as reseed)
    const w2 = new Float32Array(10 * 8);
    w2[0] = 5; w2[1] = 5; w2[2] = 5;
    buf.writeTick(0, (_r, b, _c) => { b.set(w2, 0); }, 1);

    // Read at alpha=0 → should be reseeded value [5,5,5] (no snap)
    const out = new Float32Array(10 * 8);
    buf.readInterpolated(0, out, 1);
    expect(out[0]).toBeCloseTo(5, 5);
    expect(out[1]).toBeCloseTo(5, 5);
    expect(out[2]).toBeCloseTo(5, 5);
  });

  it("should resize and clear slots", () => {
    const buf = new InterpolationBuffer(10);
    buf.assignSlot(0);
    expect(buf.getMaxEntities()).toBe(10);
    buf.resize(20);
    expect(buf.getMaxEntities()).toBe(20);
    // Slots cleared after resize
    expect(buf.assignSlot(0)).toBe(0);
  });
});
