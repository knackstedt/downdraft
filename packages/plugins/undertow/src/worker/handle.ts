// ============================================================================
// Handle — worker-side lightweight wrapper around an integer handle id.
// When a Handle is garbage-collected, it sends an OP_RELEASE to the main
// thread via FinalizationRegistry so the main-side handle table can free it.
//
// Worker DOM classes (WorkerElement, WorkerNode, ...) extend Handle.
// ============================================================================

import type { WorkerRuntime } from "./runtime";

let registry: FinalizationRegistry<ReleasePayload> | null = null;
const pendingReleases: Set<ReleasePayload> = new Set();
let flushScheduled = false;

interface ReleasePayload {
  runtime: WorkerRuntime;
  handle: number;
}

function ensureRegistry(): FinalizationRegistry<ReleasePayload> {
  if (registry) return registry;
  registry = new FinalizationRegistry((payload: ReleasePayload) => {
    // Queue the release; batch-flush on the next microtask to coalesce.
    pendingReleases.add(payload);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushReleases);
    }
  });
  return registry;
}

function flushReleases(): void {
  flushScheduled = false;
  if (pendingReleases.size === 0) return;
  for (const p of pendingReleases) {
    p.runtime.release(p.handle);
  }
  pendingReleases.clear();
}

export class Handle {
  /** The integer handle id used in the wire protocol. */
  readonly handleId: number;
  protected readonly rt: WorkerRuntime;

  constructor(handleId: number, rt: WorkerRuntime) {
    this.handleId = handleId;
    this.rt = rt;
    // Register for GC release. Skip reserved handles (< 6) — never released.
    if (handleId >= 6) {
      try {
        ensureRegistry().register(this, { runtime: rt, handle: handleId }, this);
      } catch {
        // FinalizationRegistry unavailable (very old runtime) — leak on main.
      }
    }
  }

  /** Manually release this handle immediately (skips the GC path). */
  dispose(): void {
    if (this.handleId < 6) return;
    try {
      ensureRegistry().unregister(this);
    } catch { /* ignore */ }
    this.rt.release(this.handleId);
  }
}
