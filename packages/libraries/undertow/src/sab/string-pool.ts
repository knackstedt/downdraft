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
//
// Overflow handling: when the pool fills up (e.g. from dynamic CSS values like
// "123px" that change every frame), intern() resets the pool — clears all
// entries, resets the highWater bump pointer, and increments a generation
// counter in the control header. The other side detects the generation change
// in resolve() and invalidates its cache. The atomId counter is NOT reset
// (keeps growing) to avoid atom-id reuse races with in-flight requests that
// reference old atoms. Old atoms simply become unresolvable (resolve returns
// null → caller falls back to "").
// ============================================================================

import { CTL_STRING_GEN_IDX } from "../shared/protocol";
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
  /** View of the generation counter in the control header (shared atomic). */
  private readonly genI32: Int32Array;
  /** Last seen generation — used to detect pool resets by the other side. */
  private lastGen = 0;

  constructor(sab: SharedArrayBuffer, regions: DomSabRegions) {
    this.sab = sab;
    this.regionOffset = regions.stringOffset;
    this.regionBytes = regions.stringBytes;
    this.i32 = new Int32Array(sab, regions.stringOffset, HEADER / 4);
    this.u8 = new Uint8Array(sab, regions.stringOffset, regions.stringBytes);
    this.genI32 = new Int32Array(sab, CTL_STRING_GEN_IDX * 4, 1);
  }

  init(): void {
    Atomics.store(this.i32, 0, FIRST_ATOM);
    Atomics.store(this.i32, 1, HEADER);
    Atomics.store(this.genI32, 0, 0);
    this.lastGen = 0;
  }

  /**
   * Intern a JS string → atom id. Writes the entry if new. Returns the id.
   * Returns 0 if the string is too large to fit in the pool even after a reset
   * (caller should fall back to the payload heap).
   * Producer side (either side may intern; both sides have SAB access).
   */
  intern(str: string): number {
    // Check generation — if the other side reset the pool, both caches are stale.
    // Old atoms are gone from the SAB, so cached atomIds would point to garbage.
    const gen = Atomics.load(this.genI32, 0);
    if (gen !== this.lastGen) {
      this.lastGen = gen;
      this.cache.clear();
      this.reverse.clear();
    }

    const cached = this.reverse.get(str);
    if (cached !== undefined) return cached;

    const bytes = utf8Encode(str);
    const needed = ENTRY_HEADER + bytes.length;
    const atomId = Atomics.add(this.i32, 0, 1) as unknown as number;
    const off = Atomics.add(this.i32, 1, needed) as unknown as number;

    // Bounds check: if this entry would overflow the string pool region,
    // reset the pool and re-intern. Without this check, the write would
    // silently corrupt the adjacent PAYLOAD_HEAP region (the string pool is
    // laid out immediately before the payload heap in the SAB), causing
    // garbage high-water pointers, request-ring corruption, and cascading
    // crashes (payload-heap full: need 857MB, string-pool RangeError, etc.).
    if (off + needed > this.regionBytes) {
      return this.resetAndIntern(str, bytes);
    }

    const abs = this.regionOffset + off;
    const view = new DataView(this.sab, abs, needed);
    view.setUint32(0, atomId, true);
    view.setUint32(4, bytes.length, true);
    new Uint8Array(this.sab, abs + ENTRY_HEADER, bytes.length).set(bytes);

    this.cache.set(atomId, str);
    this.reverse.set(str, atomId);
    return atomId;
  }

  /**
   * Reset the string pool after an overflow, then intern the string.
   * Resets the highWater bump pointer and clears local caches. Increments
   * the generation counter so the other side invalidates its cache.
   * The atomId counter is NOT reset (keeps growing) to avoid atom-id reuse
   * races with in-flight requests referencing old atoms.
   */
  private resetAndIntern(str: string, bytes: Uint8Array): number {
    // Increment generation — the other side checks this in resolve() and
    // clears its cache when it changes.
    Atomics.add(this.genI32, 0, 1);
    this.lastGen = Atomics.load(this.genI32, 0);

    // Reset the bump pointer (atomId keeps growing — no reset).
    Atomics.store(this.i32, 1, HEADER);

    // Clear local caches — all old atoms are now invalid.
    this.cache.clear();
    this.reverse.clear();

    // Re-intern the string that triggered the overflow.
    const needed = ENTRY_HEADER + bytes.length;
    const atomId = Atomics.add(this.i32, 0, 1) as unknown as number;
    const off = Atomics.add(this.i32, 1, needed) as unknown as number;

    if (off + needed > this.regionBytes) {
      // String is too large for the entire pool — return 0 so the caller
      // can fall back to the payload heap.
      return 0;
    }

    const abs = this.regionOffset + off;
    const view = new DataView(this.sab, abs, needed);
    view.setUint32(0, atomId, true);
    view.setUint32(4, bytes.length, true);
    new Uint8Array(this.sab, abs + ENTRY_HEADER, bytes.length).set(bytes);

    this.cache.set(atomId, str);
    this.reverse.set(str, atomId);
    return atomId;
  }

  /** Resolve an atom id → JS string. Caches after first read. */
  resolve(atomId: number): string | null {
    // Check generation — if the other side reset the pool, our cache is stale.
    const gen = Atomics.load(this.genI32, 0);
    if (gen !== this.lastGen) {
      this.lastGen = gen;
      this.cache.clear();
    }

    const cached = this.cache.get(atomId);
    if (cached !== undefined) return cached;

    // Linear scan of entries. Clamp highWater to regionBytes to prevent
    // out-of-bounds reads if the bump pointer was advanced past the region
    // by an overflow (before the reset takes effect).
    let off = HEADER;
    const highWater = Math.min(Atomics.load(this.i32, 1), this.regionBytes);
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
