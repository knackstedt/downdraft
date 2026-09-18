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
// NOTE: xxh3-ts ships CJS .js files (with require()). A static import lets
// Vite pre-bundle the CJS→ESM conversion. A dynamic import with a variable
// name (the previous approach) broke Vite's pre-bundling — the browser got
// raw CJS with require() calls that fail at runtime, which blocked
// `loadWorld()` during renderer init and left the canvas black.
// See ./xxh3-ts.d.ts for the type override that avoids a TS 5.9+
// BigUint64Array incompatibility in the package's .ts source.
//

import { Buffer } from "buffer";
import { XXH3_128 } from "xxh3-ts";

/**
 * Compute a true XXH3-128 hash of the input data.
 * Returns a 16-byte Uint8Array (little-endian: low 64 bits at offset 0, high 64 bits at offset 8).
 */
export async function xxh3_128(data: Uint8Array): Promise<Uint8Array> {
  // Buffer.from(uint8array) works in both Node.js (native Buffer) and browser (polyfill).
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hash = XXH3_128(buf);
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  // Low 64 bits at offset 0, high 64 bits at offset 8 (little-endian).
  view.setBigUint64(0, hash & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, (hash >> 64n) & 0xFFFFFFFFFFFFFFFFn, true);
  return result;
}
