import { defineChannel } from "./define";

const TestChannel = defineChannel({
  name: "test-record",
  magic: 0x52454330,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    x: { type: "f32" },
    y: { type: "f32" },
    vec3: { type: "f32", count: 3 },
    flags: { type: "u32" },
    flag: { type: "bool" },
  },
});

describe("RecordBuffer", () => {
  it("should write and read via direct views", () => {
    const sab = TestChannel.allocate();
    const writer = TestChannel.writer(sab);
    const reader = TestChannel.reader(sab);

    expect(reader.isValid()).toBe(true);

    writer.fields.x[0] = 42.5;
    writer.fields.y[0] = 99.0;
    writer.fields.vec3[0] = 1.0;
    writer.fields.vec3[1] = 2.0;
    writer.fields.vec3[2] = 3.0;
    writer.fields.flags[0] = 0xFF;
    writer.fields.flag[0] = 1;

    expect(reader.fields.x[0]).toBe(42.5);
    expect(reader.fields.y[0]).toBe(99.0);
    expect(reader.fields.vec3[0]).toBe(1.0);
    expect(reader.fields.vec3[1]).toBe(2.0);
    expect(reader.fields.vec3[2]).toBe(3.0);
    expect(reader.fields.flags[0]).toBe(0xFF);
    expect(reader.fields.flag[0]).toBe(1);
  });

  it("should detect changes via sequence", () => {
    const sab = TestChannel.allocate();
    const writer = TestChannel.writer(sab);
    const reader = TestChannel.reader(sab);

    const seq1 = reader.getSequence();
    writer.fields.x[0] = 10;
    writer.bumpSequence();

    expect(reader.hasChanged(seq1)).toBe(true);
    expect(reader.getSequence()).toBe(seq1 + 1);
  });

  it("should snapshot data as a copy", () => {
    const sab = TestChannel.allocate();
    const writer = TestChannel.writer(sab);
    const reader = TestChannel.reader(sab);

    writer.fields.x[0] = 1.5;
    writer.fields.vec3[0] = 10;
    writer.fields.vec3[1] = 20;
    writer.fields.vec3[2] = 30;
    writer.fields.flags[0] = 7;
    writer.bumpSequence();

    const snap = reader.snapshot();
    expect(snap.x).toBe(1.5);
    expect(snap.vec3).toEqual([10, 20, 30]);
    expect(snap.flags).toBe(7);
  });

  it("should validate magic on isValid", () => {
    const sab = TestChannel.allocate();
    const reader = TestChannel.reader(sab);
    expect(reader.isValid()).toBe(true);

    // Corrupt magic
    const u32 = new Uint32Array(sab);
    u32[0] = 0xDEAD;

    expect(reader.isValid()).toBe(false);
  });

  it("should write via write() helper with seqlock", () => {
    const sab = TestChannel.allocate();
    const writer = TestChannel.writer(sab) as any;
    const reader = TestChannel.reader(sab);

    writer.write({ x: 100, y: 200, vec3: [1, 2, 3], flags: 5, flag: true });

    expect(reader.fields.x[0]).toBe(100);
    expect(reader.fields.y[0]).toBe(200);
    expect(reader.fields.vec3[0]).toBe(1);
    expect(reader.fields.flags[0]).toBe(5);
  });

  it("should increment sequence by exactly 1 per write() call", () => {
    const sab = TestChannel.allocate();
    const writer = TestChannel.writer(sab) as any;
    const reader = TestChannel.reader(sab);

    const seqBefore = reader.getSequence();
    writer.write({ x: 1 });
    const seqAfter = reader.getSequence();

    expect(seqAfter).toBe(seqBefore + 1);
  });

  it("should expose typed offsets", () => {
    const offsets = TestChannel.offsets;
    expect(offsets.header.magic).toBe(0);
    expect(offsets.header.version).toBe(1);
    expect(offsets.header.sequence).toBe(2);
    expect(offsets.fields.x).toBe(16);
    expect(offsets.fields.y).toBe(17);
    expect(offsets.fields.vec3).toBe(18);
    expect(offsets.fields.flags).toBe(21);
  });
});
