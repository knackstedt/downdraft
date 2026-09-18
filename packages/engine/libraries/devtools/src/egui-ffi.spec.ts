// egui-ffi.spec.ts — unit tests for the generic snapshot wire encoder.
// The decoder is decode_snapshot() in native/src/lib.rs; these tests assert
// the byte layout contract stays in sync.

import { describe, expect, test } from "bun:test";
import { encodeSnapshot, SNAP_FLAG } from "./egui-ffi";

class R {
  constructor(public buf: Uint8Array, public off = 0) {}
  u8() { return this.buf[this.off++]; }
  u16() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getUint16(0, true); this.off += 2; return v; }
  u32() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getUint32(0, true); this.off += 4; return v; }
  f32() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getFloat32(0, true); this.off += 4; return v; }
  s16() { const n = this.u16(); const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + n)); this.off += n; return s; }
}

describe("encodeSnapshot", () => {
  test("status + kv section", () => {
    const buf = encodeSnapshot({
      status: "unsupported",
      statusMsg: "no timestamps",
      sections: [
        { kind: "kv", name: "Adapter", rows: [
          { key: "HDR", value: "", flags: SNAP_FLAG.header },
          { key: "err", value: "boom", flags: SNAP_FLAG.error },
        ] },
      ],
    });
    const r = new R(buf);
    expect(r.u8()).toBe(2);            // unsupported
    expect(r.s16()).toBe("no timestamps");
    expect(r.u32()).toBe(1);           // section count
    expect(r.s16()).toBe("Adapter");
    expect(r.u8()).toBe(0);            // kind kv
    expect(r.u32()).toBe(2);           // rows
    expect(r.u8()).toBe(1); expect(r.s16()).toBe("HDR"); expect(r.s16()).toBe("");
    expect(r.u8()).toBe(4); expect(r.s16()).toBe("err"); expect(r.s16()).toBe("boom");
    expect(r.off).toBe(buf.length);    // exact size — no trailing bytes
  });

  test("table + series + lines + controls", () => {
    const buf = encodeSnapshot({
      sections: [
        { kind: "table", name: "T", cols: ["a", "b"], rows: [["1", "2"], ["3", "4"]] },
        { kind: "series", name: "S", series: [{ name: "MB", values: [1, 2, 3] }] },
        { kind: "lines", name: "L", lines: [{ text: "w", flags: SNAP_FLAG.warn }] },
        { kind: "controls", name: "C", controls: [
          { type: "button", id: "gc", label: "GC", payload: "" },
          { type: "checkbox", id: "bloom", label: "Bloom", checked: true },
          { type: "slider", id: "s", label: "S", value: 0.5, min: 0, max: 2 },
        ] },
      ],
    });
    const r = new R(buf);
    expect(r.u8()).toBe(0);            // ok
    expect(r.s16()).toBe("");          // no status msg
    expect(r.u32()).toBe(4);           // sections

    // table
    expect(r.s16()).toBe("T");
    expect(r.u8()).toBe(1);
    expect(r.u16()).toBe(2); expect(r.s16()).toBe("a"); expect(r.s16()).toBe("b");
    expect(r.u32()).toBe(2);
    expect(r.s16()).toBe("1"); expect(r.s16()).toBe("2");
    expect(r.s16()).toBe("3"); expect(r.s16()).toBe("4");

    // series
    expect(r.s16()).toBe("S");
    expect(r.u8()).toBe(2);
    expect(r.u16()).toBe(1);
    expect(r.s16()).toBe("MB");
    expect(r.u32()).toBe(3);
    expect(r.f32()).toBe(1); expect(r.f32()).toBe(2); expect(r.f32()).toBe(3);

    // lines
    expect(r.s16()).toBe("L");
    expect(r.u8()).toBe(3);
    expect(r.u32()).toBe(1);
    expect(r.u8()).toBe(2); expect(r.s16()).toBe("w");

    // controls
    expect(r.s16()).toBe("C");
    expect(r.u8()).toBe(4);
    expect(r.u16()).toBe(3);
    expect(r.u8()).toBe(0); expect(r.s16()).toBe("gc"); expect(r.s16()).toBe("GC"); expect(r.s16()).toBe("");
    expect(r.u8()).toBe(1); expect(r.s16()).toBe("bloom"); expect(r.s16()).toBe("Bloom"); expect(r.u8()).toBe(1);
    expect(r.u8()).toBe(2); expect(r.s16()).toBe("s"); expect(r.s16()).toBe("S");
    expect(r.f32()).toBe(0.5); expect(r.f32()).toBe(0); expect(r.f32()).toBe(2);

    expect(r.off).toBe(buf.length);
  });

  test("empty snapshot", () => {
    const buf = encodeSnapshot({ sections: [] });
    const r = new R(buf);
    expect(r.u8()).toBe(0);
    expect(r.s16()).toBe("");
    expect(r.u32()).toBe(0);
    expect(r.off).toBe(buf.length);
  });
});
