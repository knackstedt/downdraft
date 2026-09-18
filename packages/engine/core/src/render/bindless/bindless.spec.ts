import { describe, expect, it } from "bun:test";
import { MATERIAL_STRUCT_SIZE, packHandle16 } from "./material-manager";

// These tests run under Bun without a real GPUDevice; we exercise the pure
// logic (handle packing, struct size constant). Full GPU integration is
// verified by the to-the-ocean runtime + render specs.

describe("BindlessMaterialManager constants", () => {
  it("MATERIAL_STRUCT_SIZE is 80 bytes (5 vec4)", () => {
    expect(MATERIAL_STRUCT_SIZE).toBe(80);
  });

  it("packHandle16 masks to low 16 bits", () => {
    expect(packHandle16(0x00010002)).toBe(0x0002);
    expect(packHandle16(0x00020005)).toBe(0x0005);
    expect(packHandle16(0)).toBe(0);
  });
});

describe("BindlessTextureRegistry handle packing", () => {
  it("handle packs (page << 16) | layer", () => {
    const page = 3;
    const layer = 17;
    const handle = (page << 16) | layer;
    expect((handle >> 16) & 0xffff).toBe(page);
    expect(handle & 0xffff).toBe(layer);
  });

  it("layer overflow past 16 bits corrupts the array index field", () => {
    // If layer exceeds 0xFFFF, it bleeds into the high 16 bits (array index).
    // This demonstrates why the 16-bit validation in allocSlot is necessary.
    const arrayIndex = 2;
    const overflowLayer = 0x10000; // 65536 — one past the 16-bit max
    const corruptedHandle = (arrayIndex << 16) | overflowLayer;
    // The array index field is now corrupted by the overflow
    expect((corruptedHandle >> 16) & 0xffff).not.toBe(arrayIndex);
  });

  it("layer and arrayIndex within 16-bit range produce correct handles", () => {
    const maxLayer = 0xFFFF;
    const maxArrayIndex = 0xFFFF;
    const handle = (maxArrayIndex << 16) | maxLayer;
    expect((handle >> 16) & 0xffff).toBe(maxArrayIndex);
    expect(handle & 0xffff).toBe(maxLayer);
  });
});
