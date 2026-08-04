import { defineChannel, defineManifest } from "./define";

const ChannelA = defineChannel({
  name: "a",
  magic: 0xAAAA,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: { value: { type: "f32" } },
});

const ChannelB = defineChannel({
  name: "b",
  magic: 0xBBBB,
  version: 1,
  mode: "slots",
  header: { size: 64, fields: { count: { type: "u32" } } },
  sections: [{
    name: "items",
    maxSlots: 8,
    slotSize: 16,
    fields: { x: { type: "f32" }, id: { type: "u32" } },
  }],
});

describe("defineChannel", () => {
  it("should create a channel with correct byte length", () => {
    expect(ChannelA.byteLength).toBe(68); // 64 header + 4 field
    expect(ChannelB.byteLength).toBe(64 + 8 * 16); // 192
  });

  it("should allocate a SharedArrayBuffer of correct size", () => {
    const sab = ChannelA.allocate();
    expect(sab.byteLength).toBe(ChannelA.byteLength);
  });

  it("should create reader and writer from the same SAB", () => {
    const sab = ChannelA.allocate();
    const writer = ChannelA.writer(sab);
    const reader = ChannelA.reader(sab);

    writer.fields.value[0] = 42;
    expect(reader.fields.value[0]).toBe(42);
  });

  it("should validate magic on reader", () => {
    const sab = ChannelA.allocate();
    const reader = ChannelA.reader(sab);
    expect(reader.isValid()).toBe(true);

    const wrongSab = new SharedArrayBuffer(ChannelA.byteLength);
    const wrongReader = ChannelA.reader(wrongSab);
    expect(wrongReader.isValid()).toBe(false);
  });

  it("should expose typed offsets", () => {
    expect(ChannelA.offsets.header.magic).toBe(0);
    expect(ChannelA.offsets.header.sequence).toBe(2);
    expect(ChannelA.offsets.fields.value).toBe(16);

    expect(ChannelB.offsets.header.count).toBeDefined();
    expect(ChannelB.offsets.sections.items.fields.x).toBe(0);
    expect(ChannelB.offsets.sections.items.fields.id).toBe(1);
  });
});

describe("defineManifest", () => {
  const manifest = defineManifest({ a: ChannelA, b: ChannelB });

  it("should allocate all channel buffers", () => {
    const buffers = manifest.allocate();
    expect(buffers.a.byteLength).toBe(ChannelA.byteLength);
    expect(buffers.b.byteLength).toBe(ChannelB.byteLength);
  });

  it("should attach readers and writers to all channels", () => {
    const buffers = manifest.allocate();
    const attached = manifest.attach(buffers);

    expect(attached.a.reader).toBeDefined();
    expect(attached.a.writer).toBeDefined();
    expect(attached.b.reader).toBeDefined();
    expect(attached.b.writer).toBeDefined();

    // Verify data flows
    attached.a.writer.fields.value[0] = 99;
    expect(attached.a.reader.fields.value[0]).toBe(99);

    const slot = attached.b.writer.sections.items.slot(0);
    slot.f32[0] = 1.5;
    slot.u32[1] = 7;

    const rslot = attached.b.reader.sections.items.slot(0);
    expect(rslot.f32[0]).toBe(1.5);
    expect(rslot.u32[1]).toBe(7);
  });

  it("should throw on missing buffer for channel", () => {
    expect(() => manifest.attach({ a: ChannelA.allocate() })).toThrow();
  });

  it("should throw on undersized buffer", () => {
    const buffers = manifest.allocate();
    const tooSmall = { a: buffers.a, b: new SharedArrayBuffer(1) };
    expect(() => manifest.attach(tooSmall)).toThrow();
  });
});
