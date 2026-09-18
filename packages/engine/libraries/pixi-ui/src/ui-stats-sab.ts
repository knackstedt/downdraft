// ============================================================================
// UiStatsSAB — fixed-layout SharedArrayBuffer for high-frequency per-frame
// UI scalars (health, fps, positions, ...).
//
// The main-thread PixiUiHost writes each frame; the worker reads each frame
// (zero-copy, no postMessage round-trip). Layout:
//
//   [0..3]    magic "PUI1" (4 bytes)
//   [4..7]    version (uint32 = 1)
//   [8..11]   frame counter (uint32, host increments each write)
//   [12..15]  slot count (uint32)
//   [16..]    float32 slots (slot count × 4 bytes)
//
// The slot order is defined by UiStatsLayout.slots (names → indices).
// ============================================================================

import type { UiStatsLayout } from "./library";
import type { StatsValues } from "./bridge-protocol";

const MAGIC = 0x31505549; // "PUI1" in little-endian
const VERSION = 1;
const HEADER_BYTES = 16; // magic + version + frameCounter + slotCount

/**
 * Allocate a UiStatsSAB sized for the given layout.
 */
export function allocateUiStatsSab(layout: UiStatsLayout): SharedArrayBuffer {
  const slotBytes = layout.slots.length * 4;
  const total = HEADER_BYTES + slotBytes;
  const sab = new SharedArrayBuffer(total);
  const u32 = new Uint32Array(sab);
  u32[0] = MAGIC;
  u32[1] = VERSION;
  u32[2] = 0; // frame counter
  u32[3] = layout.slots.length;
  return sab;
}

/**
 * Build a name → float32 index map for the given layout.
 */
export function buildSlotMap(layout: UiStatsLayout): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < layout.slots.length; i++) {
    map.set(layout.slots[i], i);
  }
  return map;
}

/**
 * Write per-frame scalar values into the SAB. Only slots present in the
 * layout are written; unknown keys are ignored.
 */
export function writeUiStats(
  sab: SharedArrayBuffer,
  layout: UiStatsLayout,
  values: StatsValues,
): void {
  const u32 = new Uint32Array(sab);
  const f32 = new Float32Array(sab, HEADER_BYTES);
  const slots = layout.slots;
  for (let i = 0; i < slots.length; i++) {
    const name = slots[i];
    const v = values[name];
    if (v !== undefined && v !== null) {
      f32[i] = Number(v);
    }
  }
  // Increment frame counter (release fence — worker reads it to detect updates).
  Atomics.store(u32, 2, u32[2] + 1);
}

/**
 * Read all scalar values from the SAB into a record keyed by slot name.
 * Called by the worker each frame.
 */
export function readUiStats(sab: SharedArrayBuffer, layout: UiStatsLayout): StatsValues {
  const f32 = new Float32Array(sab, HEADER_BYTES);
  const out: StatsValues = {};
  const slots = layout.slots;
  for (let i = 0; i < slots.length; i++) {
    out[slots[i]] = f32[i];
  }
  return out;
}

/**
 * Read a single named slot from the SAB. Returns undefined if the slot
 * isn't in the layout.
 */
export function readUiStat(sab: SharedArrayBuffer, layout: UiStatsLayout, name: string): number | undefined {
  const idx = layout.slots.indexOf(name);
  if (idx < 0) return undefined;
  const f32 = new Float32Array(sab, HEADER_BYTES);
  return f32[idx];
}

/**
 * Read the frame counter (for change detection).
 */
export function readFrameCounter(sab: SharedArrayBuffer): number {
  const u32 = new Uint32Array(sab);
  return Atomics.load(u32, 2);
}

/**
 * Validate that a SAB has the correct magic + version + slot count for the
 * given layout. Throws on mismatch.
 */
export function validateUiStatsSab(sab: SharedArrayBuffer, layout: UiStatsLayout): void {
  const u32 = new Uint32Array(sab);
  if (u32[0] !== MAGIC) {
    throw new Error(`UiStatsSAB magic mismatch: expected ${MAGIC.toString(16)}, got ${u32[0].toString(16)}`);
  }
  if (u32[1] !== VERSION) {
    throw new Error(`UiStatsSAB version mismatch: expected ${VERSION}, got ${u32[1]}`);
  }
  if (u32[3] !== layout.slots.length) {
    throw new Error(`UiStatsSAB slot count mismatch: expected ${layout.slots.length}, got ${u32[3]}`);
  }
}

export { HEADER_BYTES, MAGIC, VERSION };
