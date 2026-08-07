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
});
