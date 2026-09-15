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
