// ============================================================================
// payload-codec — structured-clone-lite codec for variable-length args/results.
//
// Encodes a small subset of JS values into a byte blob for the PAYLOAD_HEAP:
//   - null, boolean, number (f64), string (utf8)
//   - Uint8Array / Int32Array / Float32Array / Float64Array (typed arrays)
//   - arrays of the above
//   - plain objects { string: value } of the above
//
// No Map/Set/cyclic refs in v1. The format is a simple tagged stream:
//   [tag: u8][...payload]
// where tag is one of the PayloadTag values below.
// ============================================================================

import type { ArgValue } from "../shared/op-table";

export enum PayloadTag {
  Null = 0,
  True = 1,
  False = 2,
  F64 = 3, // 8 bytes
  String = 4, // u32 len + utf8
  Uint8Array = 5, // u32 len + bytes
  Int32Array = 6, // u32 count + 4*count bytes
  Float32Array = 7, // u32 count + 4*count bytes
  Float64Array = 8, // u32 count + 8*count bytes
  Array = 9, // u32 count + count encoded values
  Object = 10, // u32 count + count {u32 keyLen + utf8 key + value}
}

const te = new TextEncoder();
const td = new TextDecoder();

/** Encode an ArgValue into a fresh Uint8Array. */
export function encodePayload(v: ArgValue): Uint8Array {
  // Two-pass: encode into a growable array.
  const out: number[] = [];
  encodeInto(out, v);
  return new Uint8Array(out);
}

function encodeNum(out: number[], n: number): void {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) out.push(u8[i]);
}

function encodeU32(out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function encodeStr(out: number[], s: string): void {
  const b = te.encode(s);
  encodeU32(out, b.length);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

function encodeInto(out: number[], v: ArgValue): void {
  if (v === null || v === undefined) {
    out.push(PayloadTag.Null);
  } else if (v === true) {
    out.push(PayloadTag.True);
  } else if (v === false) {
    out.push(PayloadTag.False);
  } else if (typeof v === "number") {
    out.push(PayloadTag.F64);
    encodeNum(out, v);
  } else if (typeof v === "string") {
    out.push(PayloadTag.String);
    encodeStr(out, v);
  } else if (v instanceof Uint8Array) {
    out.push(PayloadTag.Uint8Array);
    encodeU32(out, v.length);
    for (let i = 0; i < v.length; i++) out.push(v[i]);
  } else if (v instanceof Int32Array) {
    out.push(PayloadTag.Int32Array);
    encodeU32(out, v.length);
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let i = 0; i < u8.length; i++) out.push(u8[i]);
  } else if (v instanceof Float32Array) {
    out.push(PayloadTag.Float32Array);
    encodeU32(out, v.length);
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let i = 0; i < u8.length; i++) out.push(u8[i]);
  } else if (v instanceof Float64Array) {
    out.push(PayloadTag.Float64Array);
    encodeU32(out, v.length);
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let i = 0; i < u8.length; i++) out.push(u8[i]);
  } else if (Array.isArray(v)) {
    out.push(PayloadTag.Array);
    encodeU32(out, v.length);
    for (const item of v) encodeInto(out, item);
  } else if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, ArgValue>);
    out.push(PayloadTag.Object);
    encodeU32(out, entries.length);
    for (const [k, val] of entries) {
      encodeStr(out, k);
      encodeInto(out, val);
    }
  } else {
    // Unknown — encode as null.
    out.push(PayloadTag.Null);
  }
}

/** Decode a blob into an ArgValue. */
export function decodePayload(bytes: Uint8Array): ArgValue {
  const dec = new Decoder(bytes);
  return dec.readValue();
}

class Decoder {
  private pos = 0;
  constructor(private bytes: Uint8Array) {}

  readU8(): number {
    return this.bytes[this.pos++];
  }

  readU32(): number {
    const b = this.bytes;
    const v = b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readF64(): number {
    const buf = new ArrayBuffer(8);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) u8[i] = this.bytes[this.pos + i];
    this.pos += 8;
    return new Float64Array(buf)[0];
  }

  readStr(): string {
    const len = this.readU32();
    const sub = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    // TextDecoder can't handle resizable SharedArrayBuffers — copy first.
    const copy = new Uint8Array(len);
    copy.set(sub);
    return td.decode(copy);
  }

  readBytes(n: number): Uint8Array {
    const sub = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return new Uint8Array(sub); // copy to detach from source
  }

  readValue(): ArgValue {
    const tag = this.readU8();
    switch (tag) {
      case PayloadTag.Null:
        return null;
      case PayloadTag.True:
        return true;
      case PayloadTag.False:
        return false;
      case PayloadTag.F64:
        return this.readF64();
      case PayloadTag.String:
        return this.readStr();
      case PayloadTag.Uint8Array: {
        const n = this.readU32();
        return this.readBytes(n);
      }
      case PayloadTag.Int32Array: {
        const n = this.readU32();
        const bytes = this.readBytes(n * 4);
        return new Int32Array(bytes.buffer, bytes.byteOffset, n);
      }
      case PayloadTag.Float32Array: {
        const n = this.readU32();
        const bytes = this.readBytes(n * 4);
        return new Float32Array(bytes.buffer, bytes.byteOffset, n);
      }
      case PayloadTag.Float64Array: {
        const n = this.readU32();
        const bytes = this.readBytes(n * 8);
        return new Float64Array(bytes.buffer, bytes.byteOffset, n);
      }
      case PayloadTag.Array: {
        const n = this.readU32();
        const arr: ArgValue[] = [];
        for (let i = 0; i < n; i++) arr.push(this.readValue());
        return arr;
      }
      case PayloadTag.Object: {
        const n = this.readU32();
        const obj: Record<string, ArgValue> = {};
        for (let i = 0; i < n; i++) {
          const k = this.readStr();
          obj[k] = this.readValue();
        }
        return obj;
      }
      default:
        return null;
    }
  }
}
