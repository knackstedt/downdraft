// ============================================================================
// bindDebugStore — bind debug-store fields to renderer setters.
//
// Generalized from to-the-ocean's main.tsx debug-visualization block:
//   useDebugStore.subscribe((s) => s.showHitboxes, (v) => renderer.setShowHitboxes(v));
//   ...
//
// Each binding maps a debug-store key to either a renderer method name or a
// callback. Returns an unsubscribe-all function — call it from onDispose.
//
//   bindDebugStore(renderer, {
//     showHitboxes: "setShowHitboxes",
//     hitboxLineWidth: "setHitboxLineWidth",
//     showDebugPage: (v) => { ... },   // escape hatch for custom logic
//   });
// ============================================================================

import { useDebugStore } from "./debug-store";

type DebugStoreState = ReturnType<typeof useDebugStore.getState>;

export type DebugStoreBindings<T> = {
  [K in keyof DebugStoreState]?: keyof T | ((value: DebugStoreState[K]) => void);
};

/**
 * Subscribe to debug-store keys and forward changes to the target.
 * `target` is typically the renderer; method-name bindings call
 * `target[name](value)`.
 */
export function bindDebugStore<T extends object>(
  target: T,
  bindings: DebugStoreBindings<T>,
): () => void {
  const unsubs: Array<() => void> = [];
  for (const [key, binding] of Object.entries(bindings)) {
    const fn =
      typeof binding === "function"
        ? (binding as (v: unknown) => void)
        : (v: unknown) => (target as any)[binding as string]?.(v);
    unsubs.push(
      useDebugStore.subscribe((s) => (s as any)[key], fn),
    );
  }
  return () => {
    for (const unsub of unsubs) unsub();
  };
}
