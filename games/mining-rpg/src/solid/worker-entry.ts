// ============================================================================
// worker-entry — the UI worker's main module.
//
// This runs inside a Web Worker spawned by the main-thread host
// (src/solid/host.ts). It:
//   1. Receives the init message (domSab, uiStatsSab, minimapSab).
//   2. Creates the undertow WorkerRuntime + installs the DOM polyfill.
//   3. Mounts the SolidApp into the worker-side document.body.
//   4. Runs a rAF loop that:
//        - drains undertow replies + events,
//        - ticks the UiStatsSAB → Solid store,
//        - processes incoming postMessage events from the main thread.
//   5. Forwards worker→main actions via postMessage.
//
// The worker entry is built as a separate Rollup chunk via `extraRollupInputs`
// in electron.vite.config.ts. This ensures the Solid JSX transform is applied
// to all .tsx files in the worker bundle (Vite's worker bundler doesn't
// reliably apply the Solid JSX transform).
//
// IMPORTANT: Solid components call `template()` and `delegateEvents()` at
// module load time, which need `document` and `window`. The undertow polyfill
// installs these on the global scope, but ESM imports are hoisted — so we
// MUST use dynamic imports for solid-js/web, the SolidApp, and the game store
// (which imports Solid components transitively). Only undertow and the bridge
// protocol types are safe to import statically (they don't reference DOM
// globals at module load time).
// ============================================================================

import { installPolyfill, WorkerRuntime } from "@downdraft/library-undertow";
import { isInitMessage, type MainToWorkerEvent, type WorkerInbound, type WorkerToMainAction } from "./bridge-protocol";

let rt: WorkerRuntime | null = null;
let rafId = 0;
let initialized = false;

// Queue of messages that arrived before init completed.
const pendingMessages: MainToWorkerEvent[] = [];

// These are loaded dynamically after the polyfill is installed.
let tickUiStats: () => void;
let applyMainEvent: (msg: MainToWorkerEvent) => void;
let connectUiStats: (sab: SharedArrayBuffer) => void;
let connectMinimap: (sab: SharedArrayBuffer) => void;
let setPostToMain: (fn: (action: WorkerToMainAction) => void) => void;

// --- rAF loop: drain undertow + tick UiStatsSAB each frame ---
function tick(): void {
  try {
    if (rt) {
      // Drain pending replies from the main thread (async op results)
      rt.drainReplies();
      // Drain incoming DOM events (keydown, click, etc.) dispatched by the
      // main thread's EventDispatcher
      rt.eventPump.drain();
    }
    // Read per-frame scalars from the UiStatsSAB and update the Solid store
    tickUiStats();
  } catch (err) {
    console.error("[worker-entry] tick error:", err);
  }
  rafId = requestAnimationFrame(tick);
}

// Catch unhandled errors
self.onerror = (e: any) => {
  console.error("[worker-entry] Unhandled error:", e?.message ?? e, e?.filename, e?.lineno);
};
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  console.error("[worker-entry] Unhandled rejection:", e.reason);
});

// --- Message handler: init + main→worker events ---
self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;

  if (isInitMessage(msg)) {
    try {
      // --- Init: create WorkerRuntime + polyfill FIRST, then load Solid ---
      rt = new WorkerRuntime(msg.domSab);
      installPolyfill(rt);
      console.log("[worker-entry] Polyfill installed");

      // Now that the polyfill is installed (document/window exist on globalThis),
      // dynamically import the Solid app and game store. These modules call
      // template() and delegateEvents() at module load time, which need
      // document.createElement and window.document respectively.
      const [solidWeb, appModule, storeModule] = await Promise.all([
        import("solid-js/web"),
        import("./app"),
        import("./stores/game-store"),
      ]);
      console.log("[worker-entry] Solid modules loaded", {
        hasRender: typeof solidWeb.render,
        hasSolidApp: typeof appModule.default,
        hasTickUiStats: typeof storeModule.tickUiStats,
      });
      const { render } = solidWeb;
      const SolidApp = appModule.default;
      ({
        applyMainEvent,
        connectMinimap,
        connectUiStats,
        setPostToMain,
        tickUiStats,
      } = storeModule);

      // Connect SABs to the store
      connectUiStats(msg.uiStatsSab);
      connectMinimap(msg.minimapSab);

      // Set up the postToMain callback so the store can forward actions
      setPostToMain((action: WorkerToMainAction) => {
        (self as unknown as Worker).postMessage(action);
      });

      // Mount SolidApp into the #root overlay div (not document.body).
      // The framework generates <div data-dd-overlay="0" id="root"> as a sibling
      // of the canvas. Rendering into body would place the UI alongside the
      // canvas/root instead of inside the root overlay.
      const doc = (globalThis as any).document;
      const root = doc.getElementById("root") ?? doc.body;
      console.log("[worker-entry] Rendering SolidApp into", root?.tagName ?? "no root", root?.getAttribute?.("id") ?? "");
      render(() => SolidApp(), root);
      console.log("[worker-entry] Render complete, root children:", root?.childNodes?.length ?? 0);

      // Start the rAF loop + a high-frequency setInterval watchdog.
      //
      // The proxied rAF relies on Atomics.waitAsync which may not wake the
      // worker reliably in all Electron/Chromium versions, and the rAF
      // round-trip (worker sends OP → main thread schedules rAF → rAF fires
      // → reply → worker wakes) takes ~2 frames (~32ms). This means events
      // and store updates would be delayed by up to 32ms even when working
      // correctly.
      //
      // The setInterval watchdog runs every 16ms and does the SAME work as
      // the rAF tick: drain replies, drain events, and tick the UiStatsSAB
      // → Solid store. This ensures:
      //   - Events are processed within 16ms of arriving in the event ring
      //     (not 32-50ms)
      //   - The Solid store is updated every 16ms from the UiStatsSAB
      //   - The rAF loop stays alive even if waitAsync stalls
      //
      // tickUiStats() is idempotent — it only writes to the store when a
      // value actually changed (via !== checks), so calling it from both
      // the watchdog and rAF is safe.
      rafId = requestAnimationFrame(tick);
      setInterval(() => {
        if (rt) {
          rt.drainReplies();
          rt.eventPump.drain();
          tickUiStats();
        }
      }, 16);

      // Mark as initialized and drain any messages that arrived during init
      initialized = true;
      for (const pending of pendingMessages) {
        applyMainEvent(pending);
      }
      pendingMessages.length = 0;
      console.log("[worker-entry] Init complete");
    } catch (err) {
      console.error("[worker-entry] Init FAILED:", err);
      (self as unknown as Worker).postMessage({ kind: "workerError", error: String(err) } as any);
    }
    return;
  }

  // --- Main→worker event ---
  if (!initialized) {
    // Queue messages that arrive before init completes
    pendingMessages.push(msg as MainToWorkerEvent);
    return;
  }
  applyMainEvent(msg as MainToWorkerEvent);
};
