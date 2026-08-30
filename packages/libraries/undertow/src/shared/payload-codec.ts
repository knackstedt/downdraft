// ============================================================================
// payload-codec — structured-clone-lite codec for variable-length args/results.
//
// Encodes/decodes a small subset of JS values into a byte blob for the
// PAYLOAD_HEAP:
//   - null, boolean, number (f64), string (utf8)
//   - Uint8Array / Int32Array / Float32Array / Float64Array (typed arrays)
//   - arrays of the above
//   - plain objects { string: value } of the above
//
// Backed by cbor-x (RFC 8949 CBOR). Typed arrays are preserved on round-trip
// via built-in RFC 8746 CBOR tag extensions — no `structuredClone` needed
// (avoids its 25-30% overhead). Each blob is self-contained: the encoder and
// decoder are separate instances across the SAB boundary, so `useRecords` is
// disabled (shared record structure state would desync across instances).
// ============================================================================

import { Decoder, Encoder } from "cbor-x";
import type { ArgValue } from "../shared/op-table";

// Encoder: per-blob, no shared record state. `encodeUndefinedAsNil` maps
// undefined → CBOR null (matches the old codec's behavior).
const encoder = new Encoder({
  useRecords: false,
  mapsAsObjects: true,
  encodeUndefinedAsNil: true,
});

// Decoder: `copyBuffers` so decoded typed arrays/bytes don't alias the SAB
// view (the payload heap is bump-allocated and reset at frame boundaries).
const decoder = new Decoder({
  useRecords: false,
  mapsAsObjects: true,
  copyBuffers: true,
});

/** Encode an ArgValue into a fresh Uint8Array. */
export function encodePayload(v: ArgValue): Uint8Array {
  return encoder.encode(v) as Uint8Array;
}

/** Decode a blob into an ArgValue. */
export function decodePayload(bytes: Uint8Array): ArgValue {
  return decoder.decode(bytes) as ArgValue;
}
