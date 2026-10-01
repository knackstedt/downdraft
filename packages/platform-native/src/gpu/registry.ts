// ============================================================================
// registry.ts — shared FinalizationRegistry for native GPU resources
//
// Each Wgpu* wrapper registers its native release function here so objects
// dropped without an explicit destroy() still release their native handle.
// The held value is the release *function* itself — the previous code stored
// a {ptr, release} object and called it as a function, which threw inside the
// registry callback and silently leaked every resource.
// ============================================================================

const registry = new FinalizationRegistry<() => void>((release) => {
  try {
    release();
  } catch {
    // Finalizers run during GC — never let them propagate.
  }
});

/** Register `obj` so `release()` runs if the wrapper is GC'd without destroy(). */
export function trackForRelease(obj: object, release: () => void): void {
  registry.register(obj, release, obj);
}

/** Remove the GC fallback — call after an explicit destroy()/release(). */
export function untrack(obj: object): void {
  registry.unregister(obj);
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
