// ============================================================================
// layout-channel — dedicated SAB channel for hot-path layout reads.
//
// The main thread writes viewport metrics (innerWidth, innerHeight, dpr,
// scrollX, scrollY) and subscribed element rects (clientWidth, clientHeight,
// boundingClientRect) into this SAB on every raf/resize/scroll. The worker
// reads them zero-copy via typed-array views — no round-trip, no JSON parse,
// no allocation. Values are at most one frame stale.
//
// This is the answer to the "hot-path JSON cache" question: a JSON cache
// would re-parse on every read and waste the SAB's zero-copy property. The
// layout channel gives fresh numeric data with no parse step and integrates
// with the existing seqlock change-detection the engine already uses.
// ============================================================================

import {
  ArgKind,
} from "../shared/protocol";

// Layout SAB layout (separate from the main dom-sab):
//
// [0..3]    MAGIC u32 = 0x4c415954 ("LAYT")
// [4..7]    VERSION u32 = 1
// [8..11]   SEQ u32 atomic — bumped by main on each update (seqlock)
// [12..15]  FRAME u32 — frame counter
// [16..19]  ELEMENT_COUNT u32 — number of subscribed elements (≤ MAX_ELEMENTS)
// [20..23]  VIEWPORT_INNER_WIDTH f32
// [24..27]  VIEWPORT_INNER_HEIGHT f32
// [28..31]  VIEWPORT_DPR f32
// [32..35]  VIEWPORT_SCROLL_X f32
// [36..39]  VIEWPORT_SCROLL_Y f32
// [40..43]  VIEWPORT_AVAIL_WIDTH f32
// [44..47]  VIEWPORT_AVAIL_HEIGHT f32
// [48..63]  reserved
// [64..]    ELEMENT_SLOTS — MAX_ELEMENTS * 32 bytes each:
//             [0..3]   handle u32
//             [4..7]   clientWidth f32
//             [8..11]  clientHeight f32
//             [12..15] rectX f32
//             [16..19] rectY f32
//             [20..23] rectW f32
//             [24..27] rectH f32
//             [28..31] flags u32 (1 = active, 0 = free slot)

export const LAYOUT_MAGIC = 0x4c415954;
export const LAYOUT_VERSION = 1;
export const LAYOUT_HEADER_BYTES = 64;
export const LAYOUT_ELEMENT_STRIDE = 32;
export const LAYOUT_MAX_ELEMENTS = 256;

// Header field offsets (byte offsets)
export const LAYOUT_MAGIC_OFF = 0;
export const LAYOUT_VERSION_OFF = 4;
export const LAYOUT_SEQ_OFF = 8;
export const LAYOUT_FRAME_OFF = 12;
export const LAYOUT_ELEMENT_COUNT_OFF = 16;
export const LAYOUT_VIEWPORT_INNER_WIDTH_OFF = 20;
export const LAYOUT_VIEWPORT_INNER_HEIGHT_OFF = 24;
export const LAYOUT_VIEWPORT_DPR_OFF = 28;
export const LAYOUT_VIEWPORT_SCROLL_X_OFF = 32;
export const LAYOUT_VIEWPORT_SCROLL_Y_OFF = 36;
export const LAYOUT_VIEWPORT_AVAIL_WIDTH_OFF = 40;
export const LAYOUT_VIEWPORT_AVAIL_HEIGHT_OFF = 44;

export const LAYOUT_ELEMENT_DATA_OFF = LAYOUT_HEADER_BYTES;

// Element slot field offsets (within a slot)
export const ELEM_HANDLE_OFF = 0;
export const ELEM_CLIENT_WIDTH_OFF = 4;
export const ELEM_CLIENT_HEIGHT_OFF = 8;
export const ELEM_RECT_X_OFF = 12;
export const ELEM_RECT_Y_OFF = 16;
export const ELEM_RECT_W_OFF = 20;
export const ELEM_RECT_H_OFF = 24;
export const ELEM_FLAGS_OFF = 28;
export const ELEM_FLAG_ACTIVE = 1;

export const LAYOUT_SAB_BYTES =
  LAYOUT_HEADER_BYTES + LAYOUT_MAX_ELEMENTS * LAYOUT_ELEMENT_STRIDE;

// --- Allocation ---
export function allocateLayoutSab(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(LAYOUT_SAB_BYTES);
  const u32 = new Uint32Array(sab);
  u32[LAYOUT_MAGIC_OFF / 4] = LAYOUT_MAGIC;
  u32[LAYOUT_VERSION_OFF / 4] = LAYOUT_VERSION;
  u32[LAYOUT_SEQ_OFF / 4] = 0;
  u32[LAYOUT_ELEMENT_COUNT_OFF / 4] = 0;
  return sab;
}

export function validateLayoutSab(sab: SharedArrayBuffer): boolean {
  if (sab.byteLength < LAYOUT_SAB_BYTES) return false;
  const u32 = new Uint32Array(sab);
  return u32[LAYOUT_MAGIC_OFF / 4] === LAYOUT_MAGIC && u32[LAYOUT_VERSION_OFF / 4] === LAYOUT_VERSION;
}

// --- Main-side writer ---
export class LayoutWriter {
  private readonly sab: SharedArrayBuffer;
  private readonly u32: Uint32Array;
  private readonly f32: Float32Array;
  private readonly i32: Int32Array;
  /** Map: handle → slot index */
  private readonly handleToSlot: Map<number, number> = new Map();
  private nextSlot = 0;

  constructor(sab: SharedArrayBuffer) {
    if (!validateLayoutSab(sab)) throw new Error("[worker-dom] LayoutWriter: invalid layout SAB");
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.i32 = new Int32Array(sab);
  }

  /** Subscribe an element handle to layout updates. Returns the slot index. */
  track(handle: number): number {
    const existing = this.handleToSlot.get(handle);
    if (existing !== undefined) return existing;
    if (this.nextSlot >= LAYOUT_MAX_ELEMENTS) {
      // Evict the oldest slot (simple LRU — just reuse slot 0).
      this.nextSlot = 0;
    }
    const slot = this.nextSlot++;
    this.handleToSlot.set(handle, slot);
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    this.u32[off / 4 + ELEM_HANDLE_OFF / 4] = handle;
    this.u32[off / 4 + ELEM_FLAGS_OFF / 4] = ELEM_FLAG_ACTIVE;
    this.u32[LAYOUT_ELEMENT_COUNT_OFF / 4] = this.handleToSlot.size;
    return slot;
  }

  /** Unsubscribe an element handle. */
  untrack(handle: number): void {
    const slot = this.handleToSlot.get(handle);
    if (slot === undefined) return;
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    this.u32[off / 4 + ELEM_FLAGS_OFF / 4] = 0;
    this.handleToSlot.delete(handle);
    this.u32[LAYOUT_ELEMENT_COUNT_OFF / 4] = this.handleToSlot.size;
  }

  /** Update viewport metrics. Called on raf/resize. */
  updateViewport(innerWidth: number, innerHeight: number, dpr: number, scrollX: number, scrollY: number): void {
    this.f32[LAYOUT_VIEWPORT_INNER_WIDTH_OFF / 4] = innerWidth;
    this.f32[LAYOUT_VIEWPORT_INNER_HEIGHT_OFF / 4] = innerHeight;
    this.f32[LAYOUT_VIEWPORT_DPR_OFF / 4] = dpr;
    this.f32[LAYOUT_VIEWPORT_SCROLL_X_OFF / 4] = scrollX;
    this.f32[LAYOUT_VIEWPORT_SCROLL_Y_OFF / 4] = scrollY;
  }

  /** Update an element's layout metrics. Called on raf. */
  updateElement(handle: number, clientWidth: number, clientHeight: number, rectX: number, rectY: number, rectW: number, rectH: number): void {
    const slot = this.handleToSlot.get(handle);
    if (slot === undefined) return;
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    const f32 = this.f32;
    const base = off / 4;
    f32[base + ELEM_CLIENT_WIDTH_OFF / 4] = clientWidth;
    f32[base + ELEM_CLIENT_HEIGHT_OFF / 4] = clientHeight;
    f32[base + ELEM_RECT_X_OFF / 4] = rectX;
    f32[base + ELEM_RECT_Y_OFF / 4] = rectY;
    f32[base + ELEM_RECT_W_OFF / 4] = rectW;
    f32[base + ELEM_RECT_H_OFF / 4] = rectH;
  }

  /** Bump the sequence counter (seqlock publish). Call after all updates. */
  publish(): void {
    Atomics.add(this.i32, LAYOUT_SEQ_OFF / 4, 1);
  }

  /** Bump frame counter. */
  bumpFrame(): void {
    this.u32[LAYOUT_FRAME_OFF / 4] = (this.u32[LAYOUT_FRAME_OFF / 4] + 1) >>> 0;
  }
}

// --- Worker-side reader ---
export class LayoutReader {
  private readonly sab: SharedArrayBuffer;
  private readonly u32: Uint32Array;
  private readonly f32: Float32Array;
  private readonly i32: Int32Array;
  private lastSeq = 0;

  constructor(sab: SharedArrayBuffer) {
    if (!validateLayoutSab(sab)) throw new Error("[worker-dom] LayoutReader: invalid layout SAB");
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.i32 = new Int32Array(sab);
  }

  /** Check if the layout data has changed since the last read. */
  hasChanged(): boolean {
    return Atomics.load(this.i32, LAYOUT_SEQ_OFF / 4) !== this.lastSeq;
  }

  /** Current sequence counter. */
  getSeq(): number {
    return Atomics.load(this.i32, LAYOUT_SEQ_OFF / 4);
  }

  // --- Viewport reads (zero-copy, no round-trip) ---
  get innerWidth(): number { return this.f32[LAYOUT_VIEWPORT_INNER_WIDTH_OFF / 4]; }
  get innerHeight(): number { return this.f32[LAYOUT_VIEWPORT_INNER_HEIGHT_OFF / 4]; }
  get devicePixelRatio(): number { return this.f32[LAYOUT_VIEWPORT_DPR_OFF / 4]; }
  get scrollX(): number { return this.f32[LAYOUT_VIEWPORT_SCROLL_X_OFF / 4]; }
  get scrollY(): number { return this.f32[LAYOUT_VIEWPORT_SCROLL_Y_OFF / 4]; }

  /** Mark the current seq as seen (for hasChanged). */
  ack(): void {
    this.lastSeq = Atomics.load(this.i32, LAYOUT_SEQ_OFF / 4);
  }

  // --- Element reads (zero-copy, no round-trip) ---
  /** Find the slot index for a handle. Returns -1 if not tracked. */
  findSlot(handle: number): number {
    const count = this.u32[LAYOUT_ELEMENT_COUNT_OFF / 4];
    for (let i = 0; i < count && i < LAYOUT_MAX_ELEMENTS; i++) {
      const off = LAYOUT_ELEMENT_DATA_OFF + i * LAYOUT_ELEMENT_STRIDE;
      if (this.u32[off / 4 + ELEM_FLAGS_OFF / 4] === ELEM_FLAG_ACTIVE &&
          this.u32[off / 4 + ELEM_HANDLE_OFF / 4] === handle) {
        return i;
      }
    }
    return -1;
  }

  getElementClientWidth(handle: number): number {
    const slot = this.findSlot(handle);
    if (slot < 0) return -1;
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    return this.f32[off / 4 + ELEM_CLIENT_WIDTH_OFF / 4];
  }

  getElementClientHeight(handle: number): number {
    const slot = this.findSlot(handle);
    if (slot < 0) return -1;
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    return this.f32[off / 4 + ELEM_CLIENT_HEIGHT_OFF / 4];
  }

  getElementRect(handle: number): { x: number; y: number; width: number; height: number } | null {
    const slot = this.findSlot(handle);
    if (slot < 0) return null;
    const off = LAYOUT_ELEMENT_DATA_OFF + slot * LAYOUT_ELEMENT_STRIDE;
    const base = off / 4;
    return {
      x: this.f32[base + ELEM_RECT_X_OFF / 4],
      y: this.f32[base + ELEM_RECT_Y_OFF / 4],
      width: this.f32[base + ELEM_RECT_W_OFF / 4],
      height: this.f32[base + ELEM_RECT_H_OFF / 4],
    };
  }
}

// Unused import guard — ArgKind is used by the wider protocol but not this file.
void ArgKind;
