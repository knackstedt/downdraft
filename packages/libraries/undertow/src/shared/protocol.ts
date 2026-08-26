// ============================================================================
// worker-dom protocol — wire layouts for the lock-free RPC over a resizable
// SharedArrayBuffer. Shared by the main-thread host and the worker runtime.
// ============================================================================
//
// All multi-byte values are little-endian (platform default for x86/arm64).
// Records are fixed-size so ring math is a single multiply + offset.
//
// Layout of the single SAB:
//
//   [0  .. CONTROL_BYTES)        Control header (region offsets, grow version)
//   [CONTROL .. +REQ_RING_BYTES) REQUEST_RING  (worker writes, main reads)
//   [+REPLY_RING_BYTES)          REPLY_RING    (main writes, worker reads)
//   [+EVENT_RING_BYTES)          EVENT_RING    (main writes, worker reads)
//   [+STRING_POOL_BYTES)         STRING_POOL   (atom-id ↔ utf8 bytes)
//   [+PAYLOAD_HEAP_BYTES)        PAYLOAD_HEAP  (variable-length arg/result blobs)
//
// Region offsets are stored in the control header so a grow() can broadcast
// new offsets to both sides without re-allocating the SAB or rebinding handles.
// ============================================================================

// --- Control header (64 bytes, all u32/i32 atomic-capable) ---
export const CONTROL_BYTES = 128; // 32 Int32 slots (was 64/16, expanded for pointer lock flag)
export const CTL_MAGIC = 0x574f4444; // "WODD"
export const CTL_VERSION = 1;

// u32 indices inside the control header (offset / 4)
export const CTL_MAGIC_IDX = 0;
export const CTL_VERSION_IDX = 1;
export const CTL_GROW_VERSION_IDX = 2; // bumped each time the SAB grows
export const CTL_REQ_OFFSET_IDX = 3;
export const CTL_REQ_BYTES_IDX = 4;
export const CTL_REPLY_OFFSET_IDX = 5;
export const CTL_REPLY_BYTES_IDX = 6;
export const CTL_EVENT_OFFSET_IDX = 7;
export const CTL_EVENT_BYTES_IDX = 8;
export const CTL_STRING_OFFSET_IDX = 9;
export const CTL_STRING_BYTES_IDX = 10;
export const CTL_PAYLOAD_OFFSET_IDX = 11;
export const CTL_PAYLOAD_BYTES_IDX = 12;
export const CTL_TOTAL_BYTES_IDX = 13; // current sab.byteLength (after grows)
export const CTL_CAPABILITY_IDX = 14; // bitmask: see CAP_*
export const CTL_DIRECTION_IDX = 15; // 0 = idle, 1 = main→worker in progress
export const CTL_POINTER_LOCKED_IDX = 16; // 0 = unlocked, 1 = locked (set by main thread)
// (17..63 reserved)

// Capability bits
export const CAP_GROW = 1 << 0; // SharedArrayBuffer.prototype.grow() available
export const CAP_WAIT_ASYNC = 1 << 1; // Atomics.waitAsync available

// --- ArgKind — tags every value flowing through the protocol ---
// (const object instead of enum — avoids enum import issues across modules)
export const ArgKind = {
  Null: 0,
  Bool: 1,
  I32: 2,
  U32: 3,
  F32: 4,
  F64: 5, // occupies two consecutive arg slots (lo, hi as u32 bits)
  Handle: 6,
  StringAtom: 7, // 32-bit atom id; main resolves via string pool
  PayloadRef: 8, // { payloadOff, payloadLen } in payload heap
  Void: 9, // result-only: no value
  Error: 10, // result-only: errorCode set, message in payload
} as const;

export type ArgKindValue = (typeof ArgKind)[keyof typeof ArgKind];

// --- OpRecord (32 bytes = 8 × u32) ---
//
//   [0]  opId        u32   index into OP_TABLE
//   [1]  handle      u32   target handle (0 = document/window sentinel)
//   [2]  argCount    u32   0..6 inline args
//   [3]  argKind0    u32   ArgKind for arg 0
//   [4]  arg0        u32   raw bits (lo for f64)
//   [5]  argKind1    u32
//   [6]  arg1        u32
//   [7]  reqId       u32   for matching replies
//
// For argCount > 2, or for f64 (which spans two slots), the remaining args
// spill into a small inline extension stored in the PAYLOAD_HEAP at
// payloadOff. The common case (0-2 small args) fits entirely in 32 bytes.
export const OP_RECORD_BYTES = 32;
export const OP_MAX_INLINE_ARGS = 2;

export const OP_OPID_OFF = 0;
export const OP_HANDLE_OFF = 4;
export const OP_ARGCOUNT_OFF = 8;
export const OP_ARGKIND0_OFF = 12;
export const OP_ARG0_OFF = 16;
export const OP_ARGKIND1_OFF = 20;
export const OP_ARG1_OFF = 24;
export const OP_REQID_OFF = 28;

// --- ReplyRecord (16 bytes = 4 × u32) ---
//
//   [0]  reqId       u32
//   [1]  resultKind  u32   ArgKind (Void if no return value)
//   [2]  result      u32   raw bits / handle / string atom
//   [3]  payloadOff  u32   for big results (payloadLen in next slot)
//   ... actually 20 bytes; see below
//
// We use 20 bytes (5 × u32) to carry payloadLen + errorCode cleanly.
export const REPLY_RECORD_BYTES = 20;
export const REPLY_REQID_OFF = 0;
export const REPLY_RESULTKIND_OFF = 4;
export const REPLY_RESULT_OFF = 8;
export const REPLY_PAYLOADOFF_OFF = 12;
export const REPLY_PAYLOADLEN_OFF = 16;

// Errors are signaled by resultKind === ArgKind.Error; the human-readable
// message lives in the payload at [payloadOff, payloadOff+payloadLen).
// For errors, `result` carries a small numeric errorCode (0 = generic).

// --- EventRecord (24 bytes = 6 × u32) ---
//
//   [0]  handle      u32   target handle
//   [1]  typeAtom    u32   string-atom id of event type ("click", ...)
//   [2]  payloadOff  u32   structured-clone-lite event blob
//   [3]  payloadLen  u32
//   [4]  seq         u32   per-ring monotonic sequence (for change detect)
//   [5]  flags       u32   reserved (bubbles/cancelable mirrors)
export const EVENT_RECORD_BYTES = 24;
export const EVENT_HANDLE_OFF = 0;
export const EVENT_TYPEATOM_OFF = 4;
export const EVENT_PAYLOADOFF_OFF = 8;
export const EVENT_PAYLOADLEN_OFF = 12;
export const EVENT_SEQ_OFF = 16;
export const EVENT_FLAGS_OFF = 20;

// --- Ring header (lives at the start of each ring region, 32 bytes) ---
//
//   [0]  head  u32 atomic — consumer reads next slot here
//   [4]  tail  u32 atomic — producer writes next slot here
//   [8]  cap   u32        — slot count (region bytes / record bytes)
//   [12] recBytes u32     — bytes per record (OP/REPLY/EVENT)
//   [16] seq  u32 atomic  — monotonic publish counter (for Atomics.notify)
//   [20..31] reserved
//
// SPSC invariant: (tail - head) mod cap == in-flight count.
// Full when (tail + 1) mod cap == head. Empty when tail == head.
// One slot is wasted to distinguish full from empty (classic ring).
export const RING_HEADER_BYTES = 32;
export const RING_HEAD_OFF = 0;
export const RING_TAIL_OFF = 4;
export const RING_CAP_OFF = 8;
export const RING_RECBYTES_OFF = 12;
export const RING_SEQ_OFF = 16;

// --- Reserved handles (allocated at host init, never recycled) ---
export const HANDLE_NULL = 0;
export const HANDLE_DOCUMENT = 1;
export const HANDLE_WINDOW = 2;
export const HANDLE_HTML = 3;
export const HANDLE_HEAD = 4;
export const HANDLE_BODY = 5;
export const HANDLE_FIRST_FREE = 6;

// --- Default SAB sizing (initial; can grow up to maxByteLength) ---
export const DEFAULT_INITIAL_BYTES = 16 * 1024 * 1024; // 16 MB
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024; // 256 MB cap

// Default region sizes (initial; regions grow proportionally on SAB grow).
export const DEFAULT_REQ_RING_BYTES = 1 * 1024 * 1024; // 1 MB
export const DEFAULT_REPLY_RING_BYTES = 1 * 1024 * 1024;
export const DEFAULT_EVENT_RING_BYTES = 1 * 1024 * 1024;
export const DEFAULT_STRING_POOL_BYTES = 256 * 1024;
export const DEFAULT_PAYLOAD_HEAP_BYTES =
  DEFAULT_INITIAL_BYTES -
  CONTROL_BYTES -
  DEFAULT_REQ_RING_BYTES -
  DEFAULT_REPLY_RING_BYTES -
  DEFAULT_EVENT_RING_BYTES -
  DEFAULT_STRING_POOL_BYTES;

// --- Helpers for f64 ↔ two u32 (little-endian bit copy) ---
const f64Buf = new Float64Array(1);
const u32Buf = new Uint32Array(f64Buf.buffer);

export function f64ToLoHi(v: number): [number, number] {
  f64Buf[0] = v;
  return [u32Buf[0], u32Buf[1]];
}

export function loHiToF64(lo: number, hi: number): number {
  u32Buf[0] = lo;
  u32Buf[1] = hi;
  return f64Buf[0];
}

// --- Capability detection (shared) ---
export function detectCapabilities(): number {
  let caps = 0;
  // Check if SharedArrayBuffer.prototype.grow exists (resizable SAB support).
  try {
    const proto = SharedArrayBuffer.prototype as unknown as { grow?: unknown };
    if (typeof proto.grow === "function") {
      caps |= CAP_GROW;
    }
  } catch { /* ignore */ }
  if (typeof (Atomics as any).waitAsync === "function") {
    caps |= CAP_WAIT_ASYNC;
  }
  return caps;
}
