import { defineChannel } from "./define";
import { setDebug } from "./errors";

const SlotChannel = defineChannel({
  name: "test-slots",
  magic: 0x534c4f54,
  version: 1,
  mode: "slots",
  header: {
    size: 64,
    fields: {
      entityCount: { type: "u32" },
      playerCount: { type: "u32" },
      tick: { type: "u32", atomic: true },
    },
  },
  sections: [
    {
      name: "entities",
      maxSlots: 4,
      slotSize: 32,
      fields: {
        posX: { type: "f32" },
        posY: { type: "f32" },
        posZ: { type: "f32" },
        type: { type: "u32" },
        id: { type: "u32" },
      },
    },
    {
      name: "players",
      maxSlots: 2,
      slotSize: 16,
      fields: {
        health: { type: "f32" },
        playerId: { type: "u32" },
      },
    },
  ],
});

describe("SlotBuffer", () => {
  it("should write and read slot data via views", () => {
    const sab = SlotChannel.allocate();
    const writer = SlotChannel.writer(sab);
    const reader = SlotChannel.reader(sab);

    expect(reader.isValid()).toBe(true);

    // Write entity slot 0
    const ent0 = writer.sections.entities.slot(0);
    const entOffsets = SlotChannel.offsets.sections.entities.fields;
    ent0.f32[entOffsets.posX] = 10.5;
    ent0.f32[entOffsets.posY] = 20.5;
    ent0.f32[entOffsets.posZ] = 30.5;
    ent0.u32[entOffsets.type] = 3;
    ent0.u32[entOffsets.id] = 42;

    // Read back
    const rent0 = reader.sections.entities.slot(0);
    expect(rent0.f32[entOffsets.posX]).toBe(10.5);
    expect(rent0.f32[entOffsets.posY]).toBe(20.5);
    expect(rent0.f32[entOffsets.posZ]).toBe(30.5);
    expect(rent0.u32[entOffsets.type]).toBe(3);
    expect(rent0.u32[entOffsets.id]).toBe(42);
  });

  it("should write and read from multiple sections", () => {
    const sab = SlotChannel.allocate();
    const writer = SlotChannel.writer(sab);
    const reader = SlotChannel.reader(sab);

    const ent0 = writer.sections.entities.slot(0);
    const entOffsets = SlotChannel.offsets.sections.entities.fields;
    ent0.u32[entOffsets.id] = 100;

    const plr0 = writer.sections.players.slot(0);
    const plrOffsets = SlotChannel.offsets.sections.players.fields;
    plr0.f32[plrOffsets.health] = 75.5;
    plr0.u32[plrOffsets.playerId] = 1;

    const rplr0 = reader.sections.players.slot(0);
    expect(rplr0.f32[plrOffsets.health]).toBe(75.5);
    expect(rplr0.u32[plrOffsets.playerId]).toBe(1);

    const rent0 = reader.sections.entities.slot(0);
    expect(rent0.u32[entOffsets.id]).toBe(100);
  });

  it("should cache slot views", () => {
    const sab = SlotChannel.allocate();
    const reader = SlotChannel.reader(sab);

    const v1 = reader.sections.entities.slot(0);
    const v2 = reader.sections.entities.slot(0);
    expect(v1).toBe(v2); // same object reference
  });

  it("should detect changes via sequence", () => {
    const sab = SlotChannel.allocate();
    const writer = SlotChannel.writer(sab);
    const reader = SlotChannel.reader(sab);

    const seq1 = reader.getSequence();
    writer.bumpSequence();
    expect(reader.hasChanged(seq1)).toBe(true);
  });

  it("should handle header fields", () => {
    const sab = SlotChannel.allocate();
    const writer = SlotChannel.writer(sab);
    const reader = SlotChannel.reader(sab);

    const hdrOffsets = SlotChannel.offsets.header;
    writer.header.u32[hdrOffsets.entityCount] = 3;
    writer.header.u32[hdrOffsets.playerCount] = 1;

    expect(reader.header.u32[hdrOffsets.entityCount]).toBe(3);
    expect(reader.header.u32[hdrOffsets.playerCount]).toBe(1);
  });

  it("should throw on out-of-bounds slot access", () => {
    setDebug(true);
    const sab = SlotChannel.allocate();
    const reader = SlotChannel.reader(sab);

    // Should throw RangeError on OOB access (both debug and production)
    expect(() => reader.sections.entities.slot(999)).toThrow(RangeError);

    // Access slot 0 (valid, maxSlots-1 = 3)
    const validSlot = reader.sections.entities.slot(3);
    expect(validSlot).toBeDefined();
    setDebug(false);
  });

  it("should expose correct section metadata", () => {
    expect(SlotChannel.offsets.sections.entities.slotStride).toBe(8); // 32/4
    expect(SlotChannel.offsets.sections.players.slotStride).toBe(4); // 16/4
  });

  it("should allocate correct buffer size", () => {
    // header(64) + entities(4*32=128) + players(2*16=32) = 224
    expect(SlotChannel.byteLength).toBe(224);
  });
});
