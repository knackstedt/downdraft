// ============================================================================
// payload-codec.spec — round-trip every ArgValue variant through
// encodePayload/decodePayload. Validates that the cbor-x-backed codec
// preserves value equality and typed-array identity (instanceof) for all
// types in the ArgValue contract.
// ============================================================================

import { describe, expect, it } from "bun:test";
import type { ArgValue } from "../shared/op-table";
import { decodePayload, encodePayload } from "../shared/payload-codec";

function roundTrip(v: ArgValue): ArgValue {
  return decodePayload(encodePayload(v));
}

describe("payload-codec round-trip", () => {
  describe("primitives", () => {
    it("null", () => {
      expect(roundTrip(null)).toBeNull();
    });

    it("undefined → undefined (encodeUndefinedAsNil)", () => {
      // cbor-x maps undefined → CBOR nil → JS undefined. The ArgValue contract
      // only includes null (not undefined), so this is defensive behavior.
      expect(roundTrip(undefined as unknown as ArgValue)).toBeUndefined();
    });

    it("booleans", () => {
      expect(roundTrip(true)).toBe(true);
      expect(roundTrip(false)).toBe(false);
    });

    it("numbers", () => {
      expect(roundTrip(0)).toBe(0);
      expect(roundTrip(42)).toBe(42);
      expect(roundTrip(-7)).toBe(-7);
      expect(roundTrip(3.14159)).toBeCloseTo(3.14159);
      // CBOR float encoding does not distinguish -0 from +0 (standard IEEE 754
      // CBOR behavior). The old codec preserved -0 via Float64Array bit-copy;
      // cbor-x normalizes to +0. -0 is not a meaningful DOM-op value.
      expect(roundTrip(-0)).toBe(0);
      expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
      expect(roundTrip(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
      expect(roundTrip(1e21)).toBe(1e21);
    });
  });

  describe("strings", () => {
    it("empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("ascii", () => {
      expect(roundTrip("hello world")).toBe("hello world");
    });

    it("unicode", () => {
      const s = "héllo 世界 🎮";
      expect(roundTrip(s)).toBe(s);
    });
  });

  describe("typed arrays", () => {
    it("Uint8Array preserves type + contents", () => {
      const arr = Uint8Array.of(0, 1, 127, 200, 255);
      const out = roundTrip(arr as ArgValue);
      expect(out).toBeInstanceOf(Uint8Array);
      expect(Array.from(out as Uint8Array)).toEqual([0, 1, 127, 200, 255]);
    });

    it("Int32Array preserves type + contents", () => {
      const arr = Int32Array.of(-2147483648, 0, 2147483647);
      const out = roundTrip(arr as ArgValue);
      expect(out).toBeInstanceOf(Int32Array);
      expect(Array.from(out as Int32Array)).toEqual([-2147483648, 0, 2147483647]);
    });

    it("Float32Array preserves type + contents", () => {
      const arr = Float32Array.of(1.5, -2.25, 0, 100.625);
      const out = roundTrip(arr as ArgValue);
      expect(out).toBeInstanceOf(Float32Array);
      expect(Array.from(out as Float32Array)).toEqual(Array.from(arr));
    });

    it("Float64Array preserves type + contents", () => {
      const arr = Float64Array.of(1.1, -2.2, 3.141592653589793, 0);
      const out = roundTrip(arr as ArgValue);
      expect(out).toBeInstanceOf(Float64Array);
      expect(Array.from(out as Float64Array)).toEqual(Array.from(arr));
    });

    it("typed array with byteOffset (subarray view) round-trips contents", () => {
      const backing = new ArrayBuffer(16);
      const full = new Int32Array(backing);
      full.set([10, 20, 30, 40]);
      const view = full.subarray(1, 3); // [20, 30]
      const out = roundTrip(view as ArgValue);
      expect(out).toBeInstanceOf(Int32Array);
      expect(Array.from(out as Int32Array)).toEqual([20, 30]);
    });

    it("empty typed arrays", () => {
      for (const Ctor of [Uint8Array, Int32Array, Float32Array, Float64Array]) {
        const empty = new Ctor(0);
        const out = roundTrip(empty as unknown as ArgValue);
        expect(out).toBeInstanceOf(Ctor);
        expect((out as { length: number }).length).toBe(0);
      }
    });
  });

  describe("arrays", () => {
    it("empty array", () => {
      expect(roundTrip([] as ArgValue[])).toEqual([]);
    });

    it("mixed-type array", () => {
      const arr: ArgValue[] = [null, true, 1, "x", Uint8Array.of(1, 2)];
      const out = roundTrip(arr) as ArgValue[];
      expect(out).toBeInstanceOf(Array);
      expect(out[0]).toBeNull();
      expect(out[1]).toBe(true);
      expect(out[2]).toBe(1);
      expect(out[3]).toBe("x");
      expect(out[4]).toBeInstanceOf(Uint8Array);
      expect(Array.from(out[4] as Uint8Array)).toEqual([1, 2]);
    });

    it("nested array", () => {
      const arr: ArgValue[] = [[1, 2], ["a", "b"]];
      const out = roundTrip(arr) as ArgValue[][];
      expect(out).toEqual([[1, 2], ["a", "b"]]);
    });
  });

  describe("objects", () => {
    it("empty object", () => {
      expect(roundTrip({} as ArgValue)).toEqual({});
    });

    it("object with all value types", () => {
      const obj: Record<string, ArgValue> = {
        n: null,
        b: true,
        i: 42,
        f: 3.14,
        s: "hi",
        u8: Uint8Array.of(1),
        arr: [1, 2],
        nested: { x: 1 },
      };
      const out = roundTrip(obj) as Record<string, ArgValue>;
      expect(out.n).toBeNull();
      expect(out.b).toBe(true);
      expect(out.i).toBe(42);
      expect(out.f).toBeCloseTo(3.14);
      expect(out.s).toBe("hi");
      expect(out.u8).toBeInstanceOf(Uint8Array);
      expect(out.arr).toEqual([1, 2]);
      expect(out.nested).toEqual({ x: 1 });
    });

    it("deeply nested structure", () => {
      const v: ArgValue = {
        outer: {
          list: [
            { id: 1, data: Int32Array.of(10, 20) },
            { id: 2, data: Int32Array.of(30, 40) },
          ],
        },
      };
      const out = roundTrip(v) as Record<string, ArgValue>;
      const list = (out.outer as Record<string, ArgValue>).list as Record<string, ArgValue>[];
      expect(list[0].id).toBe(1);
      expect(list[0].data).toBeInstanceOf(Int32Array);
      expect(Array.from(list[0].data as Int32Array)).toEqual([10, 20]);
      expect(list[1].id).toBe(2);
      expect(Array.from(list[1].data as Int32Array)).toEqual([30, 40]);
    });
  });
});
