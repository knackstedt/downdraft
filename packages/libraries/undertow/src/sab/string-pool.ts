// ============================================================================
// string-pool — atom-id ↔ UTF-8 bytes interning over the STRING_POOL region.
//
// Layout:
//   [0 .. 4)     nextAtomId  u32 atomic — next atom id to assign (starts at 1)
//   [4 .. 8)     highWater   u32 atomic — bump pointer for new entries
//   [8 .. regionBytes) entry storage
//
// Each entry:
//   [0 .. 4) atomId   u32
//   [4 .. 8) byteLen  u32
//   [8 .. 8+byteLen) utf8 bytes (no null terminator)
//
// Lookup is by linear scan of the entry storage on the worker side (small N,
// hot atoms are cached in a JS Map by the runtime). The main side interns on
// behalf of the worker when it receives a StringAtom arg it doesn't recognize
// (rare; most strings flow worker → main as new atoms).
// ============================================================================

import type { DomSabRegions } from "./dom-sab";

const HEADER = 8;
const ENTRY_HEADER = 8;
const FIRST_ATOM = 1;

export class StringPool {
  readonly sab: SharedArrayBuffer;
  readonly regionOffset: number;
  readonly regionBytes: number;
  private readonly i32: Int32Array;
  private readonly u8: Uint8Array;
  private readonly cache: Map<number, string> = new Map();
  private readonly reverse: Map<string, number> = new Map();

  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    this.sab = sab;
    this.regionOffset = regions.stringOffset;
    this.regionBytes = regions.stringBytes;
    this.i32 = new Int32Array(sab, regions.stringOffset, HEADER / 4);
    this.u8 = new Uint8Array(sab, regions.stringOffset, regions.stringBytes);
  }

  init(): void {
    Atomics.store(this.i32, 0, FIRST_ATOM);
    Atomics.store(this.i32, 1, HEADER);
  }

  /**
   * Intern a JS string → atom id. Writes the entry if new. Returns the id.
   * Producer side (either side may intern; both sides have SAB access).
   */
  intern(str: string): number {
    const cached = this.reverse.get(str);
    if (cached !== undefined) return cached;

    const bytes = utf8Encode(str);
    const atomId = Atomics.add(this.i32, 0, 1) as unknown as number;
    const off = Atomics.add(this.i32, 1, bytes.length + ENTRY_HEADER) as unknown as number;
    // Atomics.add returns the previous value, so off is the slot start (relative).
    const abs = this.regionOffset + off;
    const view = new DataView(this.sab, abs, ENTRY_HEADER + bytes.length);
    view.setUint32(0, atomId, true);
    view.setUint32(4, bytes.length, true);
    new Uint8Array(this.sab, abs + ENTRY_HEADER, bytes.length).set(bytes);

    this.cache.set(atomId, str);
    this.reverse.set(str, atomId);
    return atomId;
  }

  /** Resolve an atom id → JS string. Caches after first read. */
  resolve(atomId: number): string | null {
    const cached = this.cache.get(atomId);
    if (cached !== undefined) return cached;

    // Linear scan of entries.
    let off = HEADER;
    const highWater = Atomics.load(this.i32, 1);
    const dv = new DataView(this.sab, this.regionOffset, this.regionBytes);
    while (off + ENTRY_HEADER <= highWater) {
      const id = dv.getUint32(off, true);
      const len = dv.getUint32(off + 4, true);
      if (id === atomId) {
        const bytes = new Uint8Array(this.sab, this.regionOffset + off + ENTRY_HEADER, len);
        const str = utf8Decode(bytes);
        this.cache.set(atomId, str);
        return str;
      }
      off += ENTRY_HEADER + len;
    }
    return null;
  }
}

// --- UTF-8 helpers (avoid TextEncoder/TextDecoder allocation churn where possible) ---
const te = new TextEncoder();
const td = new TextDecoder();

function utf8Encode(str: string): Uint8Array {
  return te.encode(str);
}

function utf8Decode(bytes: Uint8Array): string {
  // TextDecoder can't handle resizable ArrayBuffers/SharedArrayBuffers.
  // Copy into a standalone ArrayBuffer first.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return td.decode(copy);
}
