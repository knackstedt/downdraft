// ============================================================================
// undertow-host — main-thread setup for the undertow UI worker.
//
// Creates the SAB, spawns the UI worker, and drains the host on rAF + a
// short interval. The short interval ensures that sync calls from the
// worker (via Atomics.wait) are serviced promptly.
// ============================================================================

import { MainThreadHost } from "undertow/main/host";
import { CTL_POINTER_LOCKED_IDX } from "undertow/shared/protocol";
// Vite worker import — bundles ui-worker.ts as a separate worker file
import { startStoreBridgeMain } from "./store-bridge-main";
import { useGameStore } from "./stores/game-store";
import UiWorker from "./ui-worker.ts?worker";

export interface UndertowHostHandle {
  host: MainThreadHost;
  worker: Worker;
  sab: SharedArrayBuffer;
  dispose: () => void;
}

/**
 * Create and start the undertow UI worker.
 * The worker will install the DOM polyfill and render React into #root.
 */
export function startUndertowHost(options?: { drainIntervalMs?: number }): UndertowHostHandle {
  // 1. Create the main-thread host (allocates the SAB internally).
  //    Uses DEFAULT_INITIAL_BYTES (16 MB) — large enough for the fixed regions
  //    (req/reply/event rings + string pool ≈ 3.4 MB) plus the payload heap.
  const host = new MainThreadHost();
  const sab = host.sab;

  // 2. Spawn the UI worker (Vite ?worker import creates a Worker constructor)
  const worker = new UiWorker();

  // 3. Send the SAB to the worker (SharedArrayBuffer is shared, not transferred)
  worker.postMessage(sab);

  // 4. Start the store bridge — forwards main-thread store state to the worker
  //    and receives action requests back.
  const disposeStoreBridge = startStoreBridgeMain(worker);

  // 4b. Register a user-gesture callback for pointer lock.
  //     requestPointerLock() must be called within a user gesture event handler.
  //     The worker → store-bridge round-trip loses the gesture context, causing
  //     WrongDocumentError. This callback runs directly in the click handler on
  //     the main thread, preserving the user gesture.
  // Get the control I32 array for setting the pointer lock flag
  // Control header I32 view — 128 bytes / 4 = 32 slots (index 16 = pointer lock flag)
  const controlI32 = new Int32Array(sab, 0, 128 / 4);

  // Track when pointer lock was last lost — browsers enforce a short cooldown
  // period after exiting pointer lock before it can be re-acquired.
  let lastUnlockTime = 0;
  // Set by the worker when Tab is pressed while pointer-locked. The worker
  // can't open the craft menu itself (pointerlockchange is handled here), so
  // it signals intent via a "tab-requested" postMessage. When pointer lock is
  // subsequently lost, we open the craft menu instead of the pause menu.
  let tabRequested = false;

  host.eventDispatcher.onUserGesture = () => {
    const s = useGameStore.getState();
    // Only lock if not already locked and no overlay menus are open
    if (!s.pointerLocked && !s.showPauseMenu && !s.showInventory && !s.showMap &&
        !s.showSettings && !s.showBuildMenu && !s.showCraftMenu &&
        !s.showTradeMenu && !s.showCharacterCustomization && !s.showCredits &&
        !s.playerDied) {
      // Browser enforces a cooldown after exiting pointer lock (~1.5s in Chromium)
      if (performance.now() - lastUnlockTime < 2000) return;
      const r = s.renderer;
      if (r) {
        r.lockPointer();
        // Set the SAB flag immediately — the worker reads this after each callSync.
        Atomics.store(controlI32, CTL_POINTER_LOCKED_IDX, 1);
      }
    }
  };

  // 4c. Register a pointerlockchange listener on the main thread.
  //     In undertow mode, App is NOT rendered on the main thread, so App's
  //     onPointerLockChange handler never runs here. We handle all pointer lock
  //     logic on the main thread and write the state to the SAB for the worker
  //     to read (postMessage would be stuck in the worker's event loop while
  //     it's blocked on callSync/Atomics.wait).
  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement !== null;
    Atomics.store(controlI32, CTL_POINTER_LOCKED_IDX, locked ? 1 : 0);
    useGameStore.getState().setPointerLocked(locked);
    if (!locked) {
      lastUnlockTime = performance.now();
      // Pointer lock lost — open the appropriate menu.
      const s = useGameStore.getState();
      // If Tab was requested, open the craft menu instead of the pause menu.
      if (tabRequested) {
        tabRequested = false;
        if (!s.showCraftMenu && !s.showSettings && !s.showPauseMenu &&
            !s.showInventory && !s.showMap && !s.showBuildMenu &&
            !s.showFishingMinigame && !s.showTradeMenu &&
            !s.showCharacterCustomization && !s.showCredits &&
            !s.showBuilderWheel) {
          s.toggleCraftMenu();
        }
        return;
      }
      // Otherwise open the pause menu (same logic as App's onPointerLockChange)
      if (!s.suppressPauseMenu && !s.playerDied &&
          !s.showSettings && !s.showPauseMenu && !s.showInventory &&
          !s.showMap && !s.showBuildMenu && !s.showCraftMenu && !s.showFishingMinigame &&
          !s.showTradeMenu && !s.showCharacterCustomization &&
          !s.showCredits && !s.showBuilderWheel) {
        s.togglePauseMenu();
      }
    } else {
      // Pointer lock gained — close pause menu if open and reset suppressPauseMenu.
      // suppressPauseMenu is set to true when a menu is closed (to prevent the
      // unlock from re-opening the pause menu). It must be reset when pointer
      // lock is re-acquired, otherwise subsequent ESC presses won't open the
      // pause menu (the guard above would skip it). This mirrors App's
      // onPointerLockChange behavior in non-undertow mode.
      const s = useGameStore.getState();
      if (s.showPauseMenu) s.setShowPauseMenu(false);
      if (s.suppressPauseMenu) s.setSuppressPauseMenu(false);
    }
  });

  // Listen for Tab-requested signals from the worker. The worker's keydown
  // handler sets tabRequested and calls document.exitPointerLock() (proxied
  // here). When pointer lock is lost, the pointerlockchange handler above
  // checks tabRequested and opens the craft menu instead of the pause menu.
  worker.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "tab-requested") {
      tabRequested = true;
    }
  });

  // 5. Drain on rAF (for normal operation)
  let rafId = 0;
  const drainOnRaf = () => {
    host.drain();
    rafId = requestAnimationFrame(drainOnRaf);
  };
  rafId = requestAnimationFrame(drainOnRaf);

  // 6. Also drain on a short interval (fallback for when rAF is paused).
  // The waitAsync mechanism in the host handles immediate notification,
  // but this serves as a safety net. In Electron, setInterval(0) is clamped
  // to ~1ms which gives us near-immediate drain latency.
  const intervalMs = options?.drainIntervalMs ?? 0;
  const intervalId = setInterval(() => {
    host.drain();
  }, intervalMs);

  return {
    host,
    worker,
    sab,
    dispose: () => {
      cancelAnimationFrame(rafId);
      clearInterval(intervalId);
      disposeStoreBridge();
      worker.terminate();
    },
  };
}
