// ============================================================================
// Hash utilities — true XXH3-128 hashing for save integrity
// ============================================================================
//
// Uses xxh3-ts (pure TypeScript, no native deps) to compute a true 128-bit
// XXH3 hash. The result is returned as a 16-byte Uint8Array (little-endian),
// matching the binary format header's XXH128 field.
//
// All three save stores (File, OPFS, IndexedDB) share this utility as the
// default hash implementation. The `hash128` injection option remains for
// testing or custom hash providers.
//

import { Buffer } from "buffer";

// xxh3-ts ships .ts source files that have a BigUint64Array generic
// incompatibility with TypeScript 5.9+. We use a non-static import path
// so TypeScript doesn't follow into the library source for type-checking.
const _moduleName = "xxh3-ts";
type Xxh3Module = { XXH3_128: (data: Uint8Array, seed?: bigint) => bigint };

let _cached: Xxh3Module | null = null;
async function getXxh3(): Promise<Xxh3Module> {
  if (_cached) return _cached;
  _cached = (await import(_moduleName)) as unknown as Xxh3Module;
  return _cached;
}

/**
 * Compute a true XXH3-128 hash of the input data.
 * Returns a 16-byte Uint8Array (little-endian: low 64 bits at offset 0, high 64 bits at offset 8).
 */
export async function xxh3_128(data: Uint8Array): Promise<Uint8Array> {
  // Buffer.from(uint8array) works in both Node.js (native Buffer) and browser (polyfill).
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const mod = await getXxh3();
  const hash = mod.XXH3_128(buf);
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  // Low 64 bits at offset 0, high 64 bits at offset 8 (little-endian).
  view.setBigUint64(0, hash & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, (hash >> 64n) & 0xFFFFFFFFFFFFFFFFn, true);
  return result;
}
