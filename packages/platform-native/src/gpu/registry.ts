// ============================================================================
// registry.ts — shared FinalizationRegistry for native GPU resources
//
// Each Wgpu* wrapper registers its native release function here so objects
// dropped without an explicit destroy() still release their native handle.
// The held value is the release *function* itself — the previous code stored
// a {ptr, release} object and called it as a function, which threw inside the
// registry callback and silently leaked every resource.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

// ── Leak diagnostics: count outstanding registrations per wrapper class ──
const liveByType = new Map<string, number>();
const releasedByType = new Map<string, number>();
let lastReport = 0;
function bump(map: Map<string, number>, key: string, d: number): void {
  map.set(key, (map.get(key) ?? 0) + d);
}
function reportIfDue(): void {
  const now = Date.now();
  if (now - lastReport < 10_000) return;
  lastReport = now;
  // Dev-shell only — the session tracker only exists under `draft dev`.
  if (!(globalThis as any).__ddSession) return;
  const parts: string[] = [];
  for (const [k, v] of liveByType.entries()) {
    if (v > 100) parts.push(`${k}=${v}(${releasedByType.get(k) ?? 0} rel)`);
  }
  if (parts.length) log.debug("gpu-registry", parts.join(" "));
}

const registry = new FinalizationRegistry<{ release: () => void; type: string }>((h) => {
  try {
    h.release();
  } catch {
    // Finalizers run during GC — never let them propagate.
  }
  bump(liveByType, h.type, -1);
  bump(releasedByType, h.type, 1);
});

/** Register `obj` so `release()` runs if the wrapper is GC'd without destroy(). */
export function trackForRelease(obj: object, release: () => void): void {
  const type = obj.constructor?.name ?? "?";
  registry.register(obj, { release, type }, obj);
  bump(liveByType, type, 1);
  reportIfDue();
}

/** Remove the GC fallback — call after an explicit destroy()/release(). */
export function untrack(obj: object): void {
  registry.unregister(obj);
  const type = obj.constructor?.name ?? "?";
  bump(liveByType, type, -1);
  bump(releasedByType, type, 1);
}

// ── Cross-thread ownership transfer ──
// A wrapper whose native handle was exported to another thread (see
// shared-device.ts exportGpuResource/exportCommandBuffer) must not release
// it locally — the receiving thread owns the handle now. The marker set
// lives here (rather than as a field on each wrapper) so every release path
// can check it uniformly without constructors growing a flag parameter.

const transferredOut = new WeakSet<object>();

/**
 * Mark a wrapper's native handle as owned by another thread. After this,
 * the wrapper's destroy()/dispose()/release() is a local no-op — only the
 * owning thread may free the handle.
 */
export function markTransferred(obj: object): void {
  transferredOut.add(obj);
  registry.unregister(obj);
}

/** True when this wrapper's native handle is owned by another thread. */
export function isTransferred(obj: object): boolean {
  return transferredOut.has(obj);
}
