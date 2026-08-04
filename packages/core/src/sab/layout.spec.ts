import { ValidationError } from "./errors";
import { computeLayout } from "./layout";
import type { ChannelDef } from "./types";

describe("computeLayout", () => {
  it("should compute record layout with correct offsets", () => {
    const def: ChannelDef = {
      name: "test-record",
      magic: 0x12345678,
      version: 1,
      mode: "record",
      header: { size: 64, fields: {} },
      fields: {
        x: { type: "f32" },
        y: { type: "f32" },
        name: { type: "u32", count: 4 },
      },
    };
    const layout = computeLayout(def);

    expect(layout.mode).toBe("record");
    expect(layout.magic).toBe(0x12345678);
    expect(layout.version).toBe(1);
    expect(layout.byteLength).toBeGreaterThan(64);

    expect(layout.fields!.x.index).toBe(16); // starts at header.size / 4
    expect(layout.fields!.x.byteOffset).toBe(64);
    expect(layout.fields!.y.index).toBe(17);
    expect(layout.fields!.name.index).toBe(18);
    expect(layout.fields!.name.count).toBe(4);
  });

  it("should compute slots layout with multiple sections", () => {
    const def: ChannelDef = {
      name: "test-slots",
      magic: 0xABCD,
      version: 1,
      mode: "slots",
      header: { size: 64, fields: { count: { type: "u32" } } },
      sections: [
        {
          name: "entities",
          maxSlots: 100,
          slotSize: 32,
          fields: { posX: { type: "f32" }, posY: { type: "f32" } },
        },
        {
          name: "players",
          maxSlots: 4,
          slotSize: 64,
          fields: { health: { type: "f32" }, flags: { type: "u32" } },
        },
      ],
    };
    const layout = computeLayout(def);

    expect(layout.mode).toBe("slots");
    expect(layout.sections!.length).toBe(2);

    const entities = layout.sections![0];
    expect(entities.name).toBe("entities");
    expect(entities.maxSlots).toBe(100);
    expect(entities.slotSize).toBe(32);
    expect(entities.byteOffset).toBe(64); // after header
    expect(entities.slotStride).toBe(8); // 32 / 4
    expect(entities.fields.posX.index).toBe(0);
    expect(entities.fields.posY.index).toBe(1);

    const players = layout.sections![1];
    expect(players.name).toBe("players");
    expect(players.byteOffset).toBe(64 + 100 * 32);
    expect(players.slotStride).toBe(16); // 64 / 4

    expect(layout.byteLength).toBe(64 + 100 * 32 + 4 * 64);
  });

  it("should compute grid layout with layers", () => {
    const def: ChannelDef = {
      name: "test-grid",
      magic: 0x57415452,
      version: 1,
      mode: "grid",
      header: { size: 64, fields: { gridSize: { type: "u32" } } },
      grid: {
        size: 4,
        layers: {
          heights: { type: "f32", components: 1 },
          normals: { type: "f32", components: 3 },
        },
      },
    };
    const layout = computeLayout(def);

    expect(layout.mode).toBe("grid");
    expect(layout.grid!.size).toBe(4);

    const heights = layout.grid!.layers.heights;
    expect(heights.length).toBe(4 * 4 * 1); // 16
    expect(heights.byteOffset).toBe(64);

    const normals = layout.grid!.layers.normals;
    expect(normals.length).toBe(4 * 4 * 3); // 48
    expect(normals.byteOffset).toBe(64 + 16 * 4);

    expect(layout.byteLength).toBe(64 + 16 * 4 + 48 * 4);
  });

  it("should throw on header overflow", () => {
    const def: ChannelDef = {
      name: "overflow",
      magic: 1,
      version: 1,
      mode: "record",
      header: { size: 12, fields: { x: { type: "f32" } } },
      fields: { val: { type: "f32" } },
    };
    // header.size=12 but reserved area is 12 bytes, user field x needs 4 more
    expect(() => computeLayout(def)).toThrow(ValidationError);
  });

  it("should throw on slot section overflow", () => {
    const def: ChannelDef = {
      name: "slot-overflow",
      magic: 1,
      version: 1,
      mode: "slots",
      header: { size: 64, fields: {} },
      sections: [{
        name: "too-big",
        maxSlots: 1,
        slotSize: 8,
        fields: { big: { type: "f32", count: 10 } },
      }],
    };
    expect(() => computeLayout(def)).toThrow(ValidationError);
  });

  it("should throw on missing fields for record mode", () => {
    const def: ChannelDef = {
      name: "no-fields",
      magic: 1,
      version: 1,
      mode: "record",
      header: { size: 64, fields: {} },
    };
    expect(() => computeLayout(def)).toThrow(ValidationError);
  });

  it("should throw on missing sections for slots mode", () => {
    const def: ChannelDef = {
      name: "no-sections",
      magic: 1,
      version: 1,
      mode: "slots",
      header: { size: 64, fields: {} },
    };
    expect(() => computeLayout(def)).toThrow(ValidationError);
  });

  it("should throw on missing grid for grid mode", () => {
    const def: ChannelDef = {
      name: "no-grid",
      magic: 1,
      version: 1,
      mode: "grid",
      header: { size: 64, fields: {} },
    };
    expect(() => computeLayout(def)).toThrow(ValidationError);
  });

  it("should align f64 fields to 8 bytes", () => {
    const def: ChannelDef = {
      name: "align-test",
      magic: 1,
      version: 1,
      mode: "record",
      header: { size: 64, fields: {} },
      fields: {
        a: { type: "f32" },  // 4 bytes at offset 64
        b: { type: "f64" },  // needs 8-byte alignment → offset 72
      },
    };
    const layout = computeLayout(def);
    expect(layout.fields!.a.byteOffset).toBe(64);
    expect(layout.fields!.b.byteOffset).toBe(72); // aligned to 8
  });
});
