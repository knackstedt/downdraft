import { SABWriter } from "./writer.ts";
import { SABReader } from "./reader.ts";
import { SeqlockBuffer, createLayout } from "./seqlock.ts";
import { CHANNEL_LAYOUTS, createSABForChannel } from "./protocol.ts";

describe("SABWriter", () => {
  it("should create a channel and return a SeqlockBuffer", () => {
    const writer = new SABWriter();
    const buf = writer.createChannel("transform");

    expect(buf).toBeInstanceOf(SeqlockBuffer);
    expect(writer.getChannel("transform")).toBe(buf);
  });

  it("should write data via writeChannel", () => {
    const writer = new SABWriter();
    writer.createChannel("transform");

    writer.writeChannel("transform", (buf) => {
      buf.writeField("position", [1, 2, 3]);
      buf.writeField("rotation", [0, 1, 0, 0]);
      buf.writeField("scale", 1.5);
    });

    const buf = writer.getChannel("transform")!;
    const data = buf.read();
    expect(data).not.toBeNull();
    expect(data!.position).toEqual([1, 2, 3]);
    expect(data!.scale).toBe(1.5);
  });

  it("should attach to an existing SAB", () => {
    const writer = new SABWriter();
    const sab = createSABForChannel("input");
    const buf = writer.attachChannel("input", sab);

    expect(buf).toBeInstanceOf(SeqlockBuffer);
    expect(writer.getBuffer("input")).toBe(sab);
  });

  it("should return all buffers via getAllBuffers", () => {
    const writer = new SABWriter();
    writer.createChannel("transform");
    writer.createChannel("input");

    const all = writer.getAllBuffers();
    expect(all.size).toBe(2);
    expect(all.get("transform")).toBeDefined();
    expect(all.get("input")).toBeDefined();
  });

  it("should handle writeChannel on non-existent channel gracefully", () => {
    const writer = new SABWriter();
    writer.writeChannel("transform", () => {});
    // Should not throw
    expect(true).toBe(true);
  });
});

describe("SABReader", () => {
  it("should attach to a SAB and read data", () => {
    const writer = new SABWriter();
    const buf = writer.createChannel("transform");

    writer.writeChannel("transform", (b) => {
      b.writeField("position", [10, 20, 30]);
      b.writeField("scale", 2.0);
    });

    const reader = new SABReader();
    reader.attachChannel("transform", buf.getBuffer() as SharedArrayBuffer);

    const data = reader.readChannel("transform");
    expect(data).not.toBeNull();
    expect(data!.position).toEqual([10, 20, 30]);
    expect(data!.scale).toBe(2.0);
  });

  it("should detect changes via hasChanged", () => {
    const writer = new SABWriter();
    const buf = writer.createChannel("transform");

    const reader = new SABReader();
    reader.attachChannel("transform", buf.getBuffer() as SharedArrayBuffer);

    expect(reader.hasChanged("transform")).toBe(false);

    writer.writeChannel("transform", (b) => {
      b.writeField("position", [1, 2, 3]);
    });

    expect(reader.hasChanged("transform")).toBe(true);
  });

  it("should read only if changed via readIfChanged", () => {
    const writer = new SABWriter();
    const buf = writer.createChannel("physics");

    const reader = new SABReader();
    reader.attachChannel("physics", buf.getBuffer() as SharedArrayBuffer);

    // No change yet — should return null
    let data = reader.readIfChanged("physics");
    expect(data).toBeNull();

    // Write data
    writer.writeChannel("physics", (b) => {
      b.writeField("velocity", [1, 0, 0]);
      b.writeField("contacts", 5);
    });

    data = reader.readIfChanged("physics");
    expect(data).not.toBeNull();
    expect(data!.velocity).toEqual([1, 0, 0]);
    expect(data!.contacts).toBe(5);

    // No new change — should return null
    data = reader.readIfChanged("physics");
    expect(data).toBeNull();
  });

  it("should return null for non-existent channel", () => {
    const reader = new SABReader();
    expect(reader.readChannel("transform")).toBeNull();
    expect(reader.hasChanged("transform")).toBe(false);
    expect(reader.readIfChanged("transform")).toBeNull();
  });

  it("should round-trip through writer → reader for all channels", () => {
    const channels = Object.keys(CHANNEL_LAYOUTS) as Array<keyof typeof CHANNEL_LAYOUTS>;

    for (const ch of channels) {
      const writer = new SABWriter();
      const buf = writer.createChannel(ch, 2);
      const reader = new SABReader();
      reader.attachChannel(ch, buf.getBuffer() as SharedArrayBuffer);

      // Write some data
      writer.writeChannel(ch, (b) => {
        const layout = CHANNEL_LAYOUTS[ch];
        for (const field of layout.fields) {
          const vals = Array.from({ length: field.count }, (_, i) => i + 1);
          b.writeField(field.name, vals);
        }
      });

      const data = reader.readChannel(ch);
      expect(data).not.toBeNull();
    }
  });
});
