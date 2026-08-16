// ============================================================================
// ui-worker — Web Worker that runs the React UI via undertow.
//
// This worker receives the undertow SAB from the main thread, installs the
// DOM polyfill, and renders the React app into the #root element (proxied
// through undertow back to the main thread's real DOM).
//
// The main thread must drain the host on every rAF + short interval for
// sync calls to work.
// ============================================================================

// Mark this as an undertow worker so App can skip main-thread-only logic
(self as any).__undertow = true;

// React Fast Refresh stubs must run before any other import (ES imports
// are hoisted + evaluated in order, so this file runs first).
import { installPolyfill } from "undertow/worker/polyfill";
import { WorkerRuntime } from "undertow/worker/runtime";
import "./refresh-stub";

let runtime: WorkerRuntime | null = null;

self.onmessage = (e: MessageEvent) => {
  if (e.data instanceof SharedArrayBuffer) {
    // Initialize the runtime + polyfill
    runtime = new WorkerRuntime(e.data);
    installPolyfill(runtime);

    // Tell the main thread we're ready
    ;(self as any).postMessage({ type: "undertow-ready" });

    // Start the rAF loop for the event pump
    const tick = () => {
      if (runtime) {
        runtime.drainReplies();
        runtime.eventPump.drain();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Also drain on a short interval — the worker's rAF is async (proxied
    // to the main thread) and can be delayed when the main thread is busy.
    // setInterval fires locally in the worker without main-thread cooperation.
    let intervalCount = 0;
    setInterval(() => {
      if (runtime) {
        runtime.drainReplies();
        runtime.eventPump.drain();
        // Also check the pointer lock flag — the main thread writes this
        // directly to the SAB (postMessage would be stuck while we're blocked).
        if (runtime.checkPointerLockFlag) runtime.checkPointerLockFlag();
        intervalCount++;
        if (intervalCount % 500 === 0) console.log(`[ui-worker] interval tick #${intervalCount}`);
      }
    }, 4);

    // Install the store bridge to sync Zustand state from the main thread
    import("./store-bridge-worker").then(({ installStoreBridgeWorker }) => {
      console.log("[ui-worker] store-bridge-worker loaded, installing...");
      installStoreBridgeWorker(runtime);
      console.log("[ui-worker] store bridge installed");
    }).catch((err) => {
      console.error("[ui-worker] Failed to load store bridge:", err);
    });

    // Dynamically import the app and render it
    import("./undertow-test").then(({ renderTestApp }) => {
      renderTestApp().catch((err) => {
        console.error("[ui-worker] Failed to render app:", err);
      });
    }).catch((err) => {
      console.error("[ui-worker] Failed to load undertow-test:", err);
    });
  }
};

export { };

