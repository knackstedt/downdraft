// ============================================================================
// Wave Sources — wake and shore source collection from game entities
// Ported from to-the-ocean's wake/shore source system
// ============================================================================

import type { ShoreSource } from "./shore-damping";
export type { ShoreSource };

export interface WakeSource {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
}

export interface WakeProvider {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface ShoreProvider {
  x: number;
  z: number;
  radius: number;
  cutoutRadius?: number;
}

export const MAX_WAKES = 16;
export const MAX_SHORES = 128;
export const WAKE_FLOATS = 6; // pos.x, pos.y, dir.x, dir.y, speed, _pad
export const SHORE_FLOATS = 4; // pos.x, pos.y, radius, cutoutRadius

export function collectWakeSources(
  providers: WakeProvider[],
  out: Float32Array,
): number {
  const maxByBuffer = Math.floor(out.length / WAKE_FLOATS);
  const n = Math.min(providers.length, MAX_WAKES, maxByBuffer);
  for (let i = 0; i < n; i++) {
    const p = providers[i];
    const off = i * WAKE_FLOATS;
    out[off] = p.x;
    out[off + 1] = p.z;
    out[off + 2] = Math.sin(p.heading);
    out[off + 3] = Math.cos(p.heading);
    out[off + 4] = p.speed;
    out[off + 5] = 0; // padding
  }
  return n;
}

export function collectShoreSources(
  providers: ShoreProvider[],
  out: ShoreSource[],
): number {
  const n = Math.min(providers.length, MAX_SHORES, out.length);
  for (let i = 0; i < n; i++) {
    const p = providers[i];
    out[i].x = p.x;
    out[i].z = p.z;
    out[i].radius = p.radius;
    out[i].cutoutRadius = p.cutoutRadius ?? 0;
  }
  return n;
}

export function packShoreSources(
  sources: ShoreSource[],
  count: number,
  out: Float32Array,
): void {
  const maxCount = Math.min(count, MAX_SHORES, Math.floor(out.length / SHORE_FLOATS));
  for (let i = 0; i < maxCount; i++) {
    const s = sources[i];
    const off = i * SHORE_FLOATS;
    out[off] = s.x;
    out[off + 1] = s.z;
    out[off + 2] = s.radius;
    out[off + 3] = s.cutoutRadius;
  }
}
