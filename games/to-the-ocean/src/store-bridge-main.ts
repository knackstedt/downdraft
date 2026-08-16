// ============================================================================
// store-bridge-main — main-thread side of the Zustand store bridge.
//
// Forwards serializable state from the main thread's useGameStore + useDebugStore
// to the UI worker via postMessage. Receives action requests from the worker
// and dispatches them on the main thread's stores.
// ============================================================================

import { useDebugStore } from "@downdraft/plugin-devtools";
import { useGameStore } from "./stores/game-store";

/** Keys that are not serializable (objects/functions that live on the main thread). */
const NON_SERIALIZABLE_KEYS = new Set([
  "renderer",
  "simBridge",
  "setRenderer",
  "setSimBridge",
  // pointerLocked is managed by the event pump's pointerlockchange handler,
  // not the store sync. Syncing it causes stale values to overwrite the
  // correct value from the event pump.
  "pointerLocked",
  // Actions that have main-thread side effects are forwarded back, not synced
]);

/** Extract only serializable state from the game store. */
function getSerializableGameStore(): Record<string, any> {
  const s = useGameStore.getState() as any;
  const out: Record<string, any> = {};
  for (const key in s) {
    if (NON_SERIALIZABLE_KEYS.has(key)) continue;
    const v = s[key];
    if (typeof v === "function") continue; // actions are handled separately
    try {
      // Test serializability
      JSON.stringify(v);
      out[key] = v;
    } catch {
      // Skip non-serializable values
    }
  }
  return out;
}

/** Extract only serializable state from the debug store. */
function getSerializableDebugStore(): Record<string, any> {
  const s = useDebugStore.getState() as any;
  const out: Record<string, any> = {};
  for (const key in s) {
    const v = s[key];
    if (typeof v === "function") continue;
    try {
      JSON.stringify(v);
      out[key] = v;
    } catch {
      // Skip non-serializable values
    }
  }
  return out;
}

/**
 * Actions the worker can request. These are actions that have main-thread
 * side effects (e.g. togglePauseMenu calls simBridge.pauseGame()).
 */
const WORKER_ACTIONS = new Set([
  "toggleInventory",
  "toggleMap",
  "toggleBuildMenu",
  "toggleCraftMenu",
  "toggleFishingMinigame",
  "toggleTradeMenu",
  "toggleSettings",
  "togglePauseMenu",
  "toggleCharacterCustomization",
  "toggleCredits",
  "toggleHud",
  "setShowPauseMenu",
  "setHudHidden",
  "setSuppressPauseMenu",
  "setReticleSize",
  "setBuilderCellType",
  "setBuilderRotation",
  "setShowBuilderWheel",
  "addBookmark",
  "removeBookmark",
  "setWaypoint",
  "equipItem",
  "setDebugPage",
  "toggleDebugPage",
  "setShowHitboxes",
  "setHitboxLineWidth",
  "setShowLightGizmos",
  "setShowRaycast",
  "setGCConfig",
  "lockPointer",
  "exitPointerLock",
]);

/**
 * Start the store bridge on the main thread.
 * Call this after the UI worker has been spawned.
 */
export interface StoreBridgeHandle {
  dispose: () => void;
  flushImmediate: () => void;
}

/**
 * Start the store bridge on the main thread.
 * Call this after the UI worker has been spawned.
 * Returns a handle with dispose() and flushImmediate() (bypasses the 16ms throttle).
 */
export function startStoreBridgeMain(worker: Worker): StoreBridgeHandle {
  // Forward state updates to the worker — throttled to avoid flooding the
  // worker with postMessage calls when the store changes rapidly (e.g., FPS
  // updates, mouse move handlers, etc.). We coalesce changes and flush at most
  // once per ~16ms (60fps). For user-initiated actions (store-action from the
  // worker) we flush immediately via flushImmediate() to minimize input latency.
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;
  const doFlush = () => {
    flushTimeout = null;
    worker.postMessage({
      type: "store-sync",
      game: getSerializableGameStore(),
      debug: getSerializableDebugStore(),
    });
  };
  const sendState = () => {
    if (flushTimeout !== null) return; // already scheduled
    flushTimeout = setTimeout(doFlush, 16);
  };
  /** Flush immediately, cancelling any pending throttled flush. Use this after
   *  processing a user-initiated store-action so the worker sees the state
   *  change without waiting for the 16ms throttle window. */
  const flushImmediate = () => {
    if (flushTimeout !== null) { clearTimeout(flushTimeout); flushTimeout = null; }
    doFlush();
  };

  // Subscribe to both stores — send on any change
  const unsubGame = useGameStore.subscribe(sendState);
  const unsubDebug = useDebugStore.subscribe(sendState);

  // Send initial state immediately (not throttled)
  worker.postMessage({
    type: "store-sync",
    game: getSerializableGameStore(),
    debug: getSerializableDebugStore(),
  });

  // Listen for action requests from the worker
  const onMessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type !== "store-action") return;
    const { store, action, args } = msg;
    if (!WORKER_ACTIONS.has(action)) {
      return;
    }

    // Special actions that need direct main-thread handling
    if (action === "lockPointer") {
      const r = useGameStore.getState().renderer;
      if (r) r.lockPointer();
      flushImmediate();
      return;
    }
    if (action === "exitPointerLock") {
      document.exitPointerLock?.();
      flushImmediate();
      return;
    }

    if (store === "game") {
      const fn = (useGameStore.getState() as any)[action];
      if (typeof fn === "function") fn(...args);
    } else if (store === "debug") {
      const fn = (useDebugStore.getState() as any)[action];
      if (typeof fn === "function") fn(...args);
    }
    // Flush the resulting state change immediately — the worker is waiting for
    // the DOM to reflect this user input, so don't let the 16ms throttle add
    // latency.
    flushImmediate();
  };
  worker.addEventListener("message", onMessage);

  return {
    dispose: () => {
      unsubGame();
      unsubDebug();
      worker.removeEventListener("message", onMessage);
      if (flushTimeout !== null) clearTimeout(flushTimeout);
    },
    /** Flush pending store state to the worker immediately, bypassing the
     *  16ms throttle. Call this after main-thread-initiated store changes
     *  that the worker needs to see promptly (e.g. pointerlockchange opening
     *  the pause menu). */
    flushImmediate,
  };
}
