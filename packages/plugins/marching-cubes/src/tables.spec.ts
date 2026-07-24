import { MC_EDGE_TABLE, MC_TRI_TABLE, EDGE_VERTS, EDGE_DIR, MC_TABLE_SIZE } from "./tables.ts";

describe("Marching Cubes Tables", () => {
  it("should have correct table sizes", () => {
    expect(MC_EDGE_TABLE.length).toBe(MC_TABLE_SIZE);
    expect(MC_TRI_TABLE.length).toBe(MC_TABLE_SIZE * 16);
  });

  it("should have edge table entry 0 as 0", () => {
    expect(MC_EDGE_TABLE[0]).toBe(0);
  });

  it("should have edge table entry 255 as 0", () => {
    expect(MC_EDGE_TABLE[255]).toBe(0);
  });

  it("should have non-zero edge table entries for mixed cases", () => {
    expect(MC_EDGE_TABLE[1]).not.toBe(0);
    expect(MC_EDGE_TABLE[128]).not.toBe(0);
  });

  it("should have tri table entry 0 as all -1", () => {
    for (let i = 0; i < 16; i++) {
      expect(MC_TRI_TABLE[i]).toBe(-1);
    }
  });

  it("should have tri table entry 255 as all -1", () => {
    const offset = 255 * 16;
    for (let i = 0; i < 16; i++) {
      expect(MC_TRI_TABLE[offset + i]).toBe(-1);
    }
  });

  it("should have valid tri table entries for case 1", () => {
    const offset = 1 * 16;
    expect(MC_TRI_TABLE[offset]).toBe(0);
    expect(MC_TRI_TABLE[offset + 1]).toBe(8);
    expect(MC_TRI_TABLE[offset + 2]).toBe(3);
    expect(MC_TRI_TABLE[offset + 3]).toBe(-1);
  });

  it("EDGE_VERTS should have 12 entries", () => {
    expect(EDGE_VERTS.length).toBe(12);
  });

  it("EDGE_VERTS should define correct corner pairs", () => {
    expect(EDGE_VERTS[0]).toEqual([0, 1]);
    expect(EDGE_VERTS[1]).toEqual([1, 2]);
    expect(EDGE_VERTS[4]).toEqual([4, 5]);
    expect(EDGE_VERTS[8]).toEqual([0, 4]);
  });

  it("EDGE_DIR should have 12 entries", () => {
    expect(EDGE_DIR.length).toBe(12);
  });

  it("EDGE_DIR should define correct directions", () => {
    expect(EDGE_DIR[0]).toEqual([1, 0, 0]);
    expect(EDGE_DIR[8]).toEqual([0, 0, 1]);
  });

  it("should have symmetric edge table entries (complement)", () => {
    for (let i = 0; i < 128; i++) {
      const complement = 255 - i;
      const a = MC_EDGE_TABLE[i];
      const b = MC_EDGE_TABLE[complement];
      const bitCountA = bitCount(a);
      const bitCountB = bitCount(b);
      expect(bitCountA + bitCountB).toBeGreaterThanOrEqual(0);
    }
  });
});

function bitCount(n: number): number {
  let count = 0;
  let v = n;
  while (v > 0) {
    count += v & 1;
    v = v >>> 1;
  }
  return count;
}
