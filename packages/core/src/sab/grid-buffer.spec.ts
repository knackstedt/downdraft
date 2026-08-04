import { defineChannel } from "./define";

const GridChannel = defineChannel({
  name: "test-grid",
  magic: 0x47524944,
  version: 1,
  mode: "grid",
  header: {
    size: 64,
    fields: {
      gridSize: { type: "u32" },
      patchSize: { type: "u32" },
      originX: { type: "i32" },
      originZ: { type: "i32" },
    },
  },
  grid: {
    size: 4,
    layers: {
      heights: { type: "f32", components: 1 },
      normals: { type: "f32", components: 3 },
      flow: { type: "f32", components: 2 },
    },
  },
});

describe("GridBuffer", () => {
  it("should expose direct layer views", () => {
    const sab = GridChannel.allocate();
    const writer = GridChannel.writer(sab);
    const reader = GridChannel.reader(sab);

    expect(reader.isValid()).toBe(true);

    // heights: 4*4*1 = 16 elements
    expect(writer.layers.heights.length).toBe(16);
    expect(reader.layers.heights.length).toBe(16);

    // normals: 4*4*3 = 48 elements
    expect(writer.layers.normals.length).toBe(48);
    expect(reader.layers.normals.length).toBe(48);

    // flow: 4*4*2 = 32 elements
    expect(writer.layers.flow.length).toBe(32);
    expect(reader.layers.flow.length).toBe(32);
  });

  it("should write and read through layer views", () => {
    const sab = GridChannel.allocate();
    const writer = GridChannel.writer(sab);
    const reader = GridChannel.reader(sab);

    writer.layers.heights[0] = 1.5;
    writer.layers.heights[5] = 3.0;
    writer.layers.normals[0] = 0.5;
    writer.layers.normals[1] = 0.5;
    writer.layers.normals[2] = 0.707;
    writer.layers.flow[0] = 0.1;
    writer.layers.flow[1] = 0.2;

    expect(reader.layers.heights[0]).toBe(1.5);
    expect(reader.layers.heights[5]).toBe(3.0);
    expect(reader.layers.normals[0]).toBe(0.5);
    expect(reader.layers.normals[1]).toBe(0.5);
    expect(reader.layers.normals[2]).toBeCloseTo(0.707);
    expect(reader.layers.flow[0]).toBeCloseTo(0.1);
    expect(reader.layers.flow[1]).toBeCloseTo(0.2);
  });

  it("should share the same backing buffer (zero-copy)", () => {
    const sab = GridChannel.allocate();
    const writer = GridChannel.writer(sab);
    const reader = GridChannel.reader(sab);

    writer.layers.heights[10] = 42.0;
    // Reader should see the change immediately (same SAB)
    expect(reader.layers.heights[10]).toBe(42.0);
  });

  it("should handle header fields", () => {
    const sab = GridChannel.allocate();
    const writer = GridChannel.writer(sab);
    const reader = GridChannel.reader(sab);

    const hdr = GridChannel.offsets.header;
    writer.header.u32[hdr.gridSize] = 4;
    writer.header.u32[hdr.patchSize] = 16;
    writer.header.i32[hdr.originX] = -100;
    writer.header.i32[hdr.originZ] = 200;

    expect(reader.header.u32[hdr.gridSize]).toBe(4);
    expect(reader.header.u32[hdr.patchSize]).toBe(16);
    expect(reader.header.i32[hdr.originX]).toBe(-100);
    expect(reader.header.i32[hdr.originZ]).toBe(200);
  });

  it("should detect changes via sequence", () => {
    const sab = GridChannel.allocate();
    const writer = GridChannel.writer(sab);
    const reader = GridChannel.reader(sab);

    const seq1 = reader.getSequence();
    writer.bumpSequence();
    expect(reader.hasChanged(seq1)).toBe(true);
  });

  it("should expose grid layer offsets", () => {
    const gridOffsets = GridChannel.offsets.grid;
    expect(gridOffsets.heights.byteOffset).toBe(64);
    expect(gridOffsets.heights.length).toBe(16);
    expect(gridOffsets.normals.byteOffset).toBe(64 + 16 * 4);
    expect(gridOffsets.normals.length).toBe(48);
    expect(gridOffsets.flow.byteOffset).toBe(64 + 16 * 4 + 48 * 4);
    expect(gridOffsets.flow.length).toBe(32);
  });
});
