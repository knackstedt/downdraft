// ============================================================================
// Hash utilities — true XXH3-128 hashing for save integrity
// ============================================================================
//
// Uses xxh3-ts (pure TypeScript, no native deps) to compute a true 128-bit
// XXH3 hash. The result is returned as a 16-byte Uint8Array (little-endian),
// matching the binary format header's XXH128 field.
//
// All save stores (File, Directory) share this utility as the
// default hash implementation. The `hash128` injection option remains for
// testing or custom hash providers.
//
// The xxh3-ts import goes through ./xxh3 — a non-literal-specifier seam that
// keeps the package's shipped .ts sources out of the TypeScript program
// (they fail on TS 5.9+) while resolving the real CJS entry at runtime.
//

import { Buffer } from "buffer";
import { XXH3_128 } from "./xxh3";

/**
 * Compute a true XXH3-128 hash of the input data.
 * Returns a 16-byte Uint8Array (little-endian: low 64 bits at offset 0, high 64 bits at offset 8).
 */
export async function xxh3_128(data: Uint8Array): Promise<Uint8Array> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hash = await XXH3_128(buf);
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  // Low 64 bits at offset 0, high 64 bits at offset 8 (little-endian).
  view.setBigUint64(0, hash & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, (hash >> 64n) & 0xFFFFFFFFFFFFFFFFn, true);
  return result;
}
