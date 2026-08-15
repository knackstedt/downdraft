// ============================================================================
// dom-sab — resizable SharedArrayBuffer allocator with fixed region offsets.
//
// A single SAB is allocated with `maxByteLength` headroom so it can grow()
// without ever re-allocating or invalidating handles. Region offsets are
// written into the control header so both sides read the same layout after a
// grow. The SAB never shrinks.
// ============================================================================

import {
    CAP_GROW,
    CONTROL_BYTES,
    CTL_CAPABILITY_IDX,
    CTL_EVENT_BYTES_IDX,
    CTL_EVENT_OFFSET_IDX,
    CTL_GROW_VERSION_IDX,
    CTL_MAGIC,
    CTL_MAGIC_IDX,
    CTL_PAYLOAD_BYTES_IDX,
    CTL_PAYLOAD_OFFSET_IDX,
    CTL_REPLY_BYTES_IDX,
    CTL_REPLY_OFFSET_IDX,
    CTL_REQ_BYTES_IDX,
    CTL_REQ_OFFSET_IDX,
    CTL_STRING_BYTES_IDX,
    CTL_STRING_OFFSET_IDX,
    CTL_TOTAL_BYTES_IDX,
    CTL_VERSION,
    CTL_VERSION_IDX,
    DEFAULT_EVENT_RING_BYTES,
    DEFAULT_INITIAL_BYTES,
    DEFAULT_MAX_BYTES,
    DEFAULT_REPLY_RING_BYTES,
    DEFAULT_REQ_RING_BYTES,
    DEFAULT_STRING_POOL_BYTES,
    detectCapabilities
} from "../shared/protocol";

export interface DomSabRegions {
  reqOffset: number;
  reqBytes: number;
  replyOffset: number;
  replyBytes: number;
  eventOffset: number;
  eventBytes: number;
  stringOffset: number;
  stringBytes: number;
  payloadOffset: number;
  payloadBytes: number;
}

export interface DomSabOptions {
  initialBytes?: number;
  maxBytes?: number;
  reqRingBytes?: number;
  replyRingBytes?: number;
  eventRingBytes?: number;
  stringPoolBytes?: number;
  payloadHeapBytes?: number;
}

/**
 * Read the region layout from a SAB's control header. Both sides use this
 * after a grow to discover the new offsets/sizes.
 */
export function readRegions(sab: SharedArrayBuffer): DomSabRegions {
  const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
  return {
    reqOffset: u32[CTL_REQ_OFFSET_IDX],
    reqBytes: u32[CTL_REQ_BYTES_IDX],
    replyOffset: u32[CTL_REPLY_OFFSET_IDX],
    replyBytes: u32[CTL_REPLY_BYTES_IDX],
    eventOffset: u32[CTL_EVENT_OFFSET_IDX],
    eventBytes: u32[CTL_EVENT_BYTES_IDX],
    stringOffset: u32[CTL_STRING_OFFSET_IDX],
    stringBytes: u32[CTL_STRING_BYTES_IDX],
    payloadOffset: u32[CTL_PAYLOAD_OFFSET_IDX],
    payloadBytes: u32[CTL_PAYLOAD_BYTES_IDX],
  };
}

/**
 * Allocate a new resizable SAB and write the control header + region offsets.
 * Returns the SAB. Both sides then call readRegions() to discover layout.
 *
 * If `SharedArrayBuffer.grow()` is unavailable (old runtime), falls back to a
 * fixed-size SAB (maxBytes === initialBytes); overflow then routes through a
 * postMessage fallback (not implemented in this layer — handled by the host).
 */
export function allocateDomSab(options: DomSabOptions = {}): SharedArrayBuffer {
  const initialBytes = options.initialBytes ?? DEFAULT_INITIAL_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const reqRingBytes = options.reqRingBytes ?? DEFAULT_REQ_RING_BYTES;
  const replyRingBytes = options.replyRingBytes ?? DEFAULT_REPLY_RING_BYTES;
  const eventRingBytes = options.eventRingBytes ?? DEFAULT_EVENT_RING_BYTES;
  const stringPoolBytes = options.stringPoolBytes ?? DEFAULT_STRING_POOL_BYTES;
  let payloadHeapBytes =
    options.payloadHeapBytes ??
    initialBytes -
      CONTROL_BYTES -
      reqRingBytes -
      replyRingBytes -
      eventRingBytes -
      stringPoolBytes;

  const fixedRegions =
    CONTROL_BYTES +
    reqRingBytes +
    replyRingBytes +
    eventRingBytes +
    stringPoolBytes;
  if (payloadHeapBytes < 4096) {
    // Defaults don't fit in initialBytes — either the caller passed a small
    // initialBytes without scaling the ring sizes, or the explicit sizes
    // overflow. Recompute payloadHeapBytes as the remainder and validate.
    if (options.payloadHeapBytes !== undefined) {
      throw new Error(
        `[worker-dom] Explicit payloadHeapBytes (${options.payloadHeapBytes}) too small`,
      );
    }
    if (fixedRegions >= initialBytes) {
      throw new Error(
        `[worker-dom] Fixed regions (${fixedRegions}) + 4KB heap exceed initialBytes (${initialBytes}). Scale down reqRingBytes/replyRingBytes/eventRingBytes/stringPoolBytes or raise initialBytes.`,
      );
    }
    payloadHeapBytes = initialBytes - fixedRegions;
  }

  const totalInitial = fixedRegions + payloadHeapBytes;
  if (totalInitial > initialBytes) {
    throw new Error(
      `[worker-dom] Region sizes (${totalInitial}) exceed initialBytes (${initialBytes})`,
    );
  }

  const caps = detectCapabilities();
  const canGrow = (caps & CAP_GROW) !== 0;

  let sab: SharedArrayBuffer;
  if (canGrow) {
    // Resizable SAB: initial size now, can grow up to maxBytes.
    sab = new (SharedArrayBuffer as unknown as new (
      length: number,
      options?: { maxByteLength?: number },
    ) => SharedArrayBuffer)(initialBytes, { maxByteLength: maxBytes });
  } else {
    // Fallback: fixed-size SAB (no grow). Cap == initial.
    sab = new SharedArrayBuffer(initialBytes);
  }

  // Compute region offsets.
  let off = CONTROL_BYTES;
  const reqOffset = off; off += reqRingBytes;
  const replyOffset = off; off += replyRingBytes;
  const eventOffset = off; off += eventRingBytes;
  const stringOffset = off; off += stringPoolBytes;
  const payloadOffset = off; off += payloadHeapBytes;

  // Write control header.
  const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
  u32[CTL_MAGIC_IDX] = CTL_MAGIC;
  u32[CTL_VERSION_IDX] = CTL_VERSION;
  u32[CTL_GROW_VERSION_IDX] = 0;
  u32[CTL_REQ_OFFSET_IDX] = reqOffset;
  u32[CTL_REQ_BYTES_IDX] = reqRingBytes;
  u32[CTL_REPLY_OFFSET_IDX] = replyOffset;
  u32[CTL_REPLY_BYTES_IDX] = replyRingBytes;
  u32[CTL_EVENT_OFFSET_IDX] = eventOffset;
  u32[CTL_EVENT_BYTES_IDX] = eventRingBytes;
  u32[CTL_STRING_OFFSET_IDX] = stringOffset;
  u32[CTL_STRING_BYTES_IDX] = stringPoolBytes;
  u32[CTL_PAYLOAD_OFFSET_IDX] = payloadOffset;
  u32[CTL_PAYLOAD_BYTES_IDX] = payloadHeapBytes;
  u32[CTL_TOTAL_BYTES_IDX] = initialBytes;
  u32[CTL_CAPABILITY_IDX] = caps;

  return sab;
}

/**
 * Grow the SAB to at least `neededBytes` total. Only the allocating side
 * (main thread) should call this; the worker observes the new size via the
 * control header after a memory barrier.
 *
 * Growth strategy: double the current size, clamped to maxBytes. The new
 * bytes are appended to the PAYLOAD_HEAP region (its offset stays the same,
 * its byte length grows). Rings are not resized in v1 — they're sized for
 * worst-case throughput and overflow is a bug to fix, not a grow trigger.
 *
 * Returns true if the SAB was grown, false if it was already large enough
 * or grow is unavailable.
 */
export function growDomSab(
  sab: SharedArrayBuffer,
  neededBytes: number,
): boolean {
  const caps = new Uint32Array(sab, CTL_CAPABILITY_IDX * 4, 1)[0];
  if ((caps & CAP_GROW) === 0) return false;

  const cur = new Uint32Array(sab, CTL_TOTAL_BYTES_IDX * 4, 1)[0];
  if (neededBytes <= cur) return false;

  // Read maxByteLength from the SAB instance.
  const maxBytes = (sab as any).byteLength === sab.byteLength
    ? ((sab as any).maxByteLength ?? sab.byteLength)
    : (sab as any).maxByteLength ?? sab.byteLength;

  let target = Math.max(neededBytes, cur * 2);
  if (target > maxBytes) target = maxBytes;
  if (target <= cur) return false;

  (sab as any).grow(target);

  // Update control header: total bytes + payload region size grow together.
  const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
  const i32 = new Int32Array(sab, 0, CONTROL_BYTES / 4);
  const grown = (sab as any).byteLength;
  u32[CTL_TOTAL_BYTES_IDX] = grown;
  // Payload region grows by the delta (it's the last region).
  u32[CTL_PAYLOAD_BYTES_IDX] = u32[CTL_PAYLOAD_BYTES_IDX] + (grown - cur);
  // Bump grow version so observers re-read layout. Atomics.notify needs Int32Array.
  Atomics.add(i32, CTL_GROW_VERSION_IDX, 1);
  Atomics.notify(i32, CTL_GROW_VERSION_IDX, Infinity);
  return true;
}

/**
 * Validate a SAB looks like a dom-sab (magic + version). Used by both sides
 * on attach.
 */
export function validateDomSab(sab: SharedArrayBuffer): boolean {
  if (sab.byteLength < CONTROL_BYTES) return false;
  const u32 = new Uint32Array(sab, 0, CONTROL_BYTES / 4);
  return u32[CTL_MAGIC_IDX] === CTL_MAGIC && u32[CTL_VERSION_IDX] === CTL_VERSION;
}
