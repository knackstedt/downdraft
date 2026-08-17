// ============================================================================
// store-bridge-worker — worker side of the Zustand store bridge.
//
// Receives state updates from the main thread and applies them to the worker's
// useGameStore + useDebugStore. Wraps store actions that have main-thread side
// effects (e.g. togglePauseMenu calls simBridge.pauseGame()) and forwards them
// to the main thread instead of executing locally.
// ============================================================================

import { useDebugStore } from "@downdraft/plugin-devtools/debug-store";
import { useGameStore } from "./stores/game-store";

/** Actions that have main-thread side effects — forward to main thread. */
const FORWARDED_ACTIONS = new Set([
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
]);

let installed = false;

/**
 * Install the store bridge in the worker. Call after the polyfill is ready.
 * Listens for `store-sync` messages and applies them to the worker's stores.
 * Also patches the worker's store actions to forward side-effectful ones
 * to the main thread.
 */
export function installStoreBridgeWorker(runtime?: any): void {
  if (installed) return;
  installed = true;
  console.log("[store-bridge-worker] installing store bridge");

  // Register a callback on the runtime so that pointer lock changes (read from
  // the SAB flag after each callSync) update the worker's store directly.
  if (runtime && "_onPointerLockChange" in runtime) {
    runtime._onPointerLockChange = (locked: boolean) => {
      useGameStore.getState().setPointerLocked(locked);
    };
  }

  // Patch game store actions to forward to main thread.
  // For toggle actions, we apply an optimistic local update immediately so
  // the worker's onKey handler sees the correct state on the next keydown
  // (the store-sync from the main thread is async and may not arrive before
  // the next key event, causing stale-state bugs).
  const toggleStateKey: Record<string, string> = {
    toggleInventory: "showInventory",
    toggleMap: "showMap",
    toggleBuildMenu: "showBuildMenu",
    toggleCraftMenu: "showCraftMenu",
    toggleFishingMinigame: "showFishingMinigame",
    toggleTradeMenu: "showTradeMenu",
    toggleSettings: "showSettings",
    togglePauseMenu: "showPauseMenu",
    toggleCharacterCustomization: "showCharacterCustomization",
    toggleCredits: "showCredits",
  };

  // Track toggle state keys with pending optimistic updates.
  // When the worker applies an optimistic update (flipping a boolean), we add
  // the key here. Store-syncs from the main thread skip these keys for a short
  // window, because the sync may reflect stale state (the main thread hasn't
  // processed our action yet, or a sync from a previous action arrives late
  // and would overwrite our more recent optimistic update).
  const optimisticPending = new Set<string>();
  // How long to skip syncs for a key after an optimistic update. The main
  // thread processes actions within ~1ms, but pointerlockchange handlers
  // and other cascading events can trigger additional syncs up to 500ms
  // later. Use 1000ms to be safe.
  const OPTIMISTIC_SKIP_MS = 1000;

  const gameActions = [
    "toggleInventory", "toggleMap", "toggleBuildMenu", "toggleCraftMenu",
    "toggleFishingMinigame", "toggleTradeMenu", "toggleSettings",
    "togglePauseMenu", "toggleCharacterCustomization", "toggleCredits",
    "toggleHud", "setShowPauseMenu", "setHudHidden", "setSuppressPauseMenu",
    "setReticleSize", "setBuilderCellType", "setBuilderRotation",
    "setShowBuilderWheel", "addBookmark", "removeBookmark", "setWaypoint",
    "equipItem",
    // Pointer lock actions — forwarded to the main thread which has the
    // real renderer and can call requestPointerLock()/document.exitPointerLock().
    // Without these, togglePauseMenu's lockPointer() call in the worker is a no-op.
    "lockPointer", "exitPointerLock",
  ];
  for (const action of gameActions) {
    const original = (useGameStore.getState() as any)[action];
    if (typeof original !== "function") continue;
    // Replace with a forwarder
    (useGameStore as any).setState({
      [action]: (...args: any[]) => {
        try {
          // Optimistic update: flip the corresponding boolean immediately
          // so the next keydown in the worker sees the correct state.
          const stateKey = toggleStateKey[action];
          if (stateKey) {
            const current = (useGameStore.getState() as any)[stateKey];
            useGameStore.setState({ [stateKey]: !current }, false);
            // Mark this key as having a pending optimistic update so store-syncs
            // from the main thread don't overwrite it with stale state.
            optimisticPending.add(stateKey);
            setTimeout(() => { optimisticPending.delete(stateKey); }, OPTIMISTIC_SKIP_MS);
          }
          // Don't pass the event object to postMessage — it contains
          // non-cloneable references (SyncElement with WorkerRuntime).
          // Store actions don't need the event; they take no args or
          // simple primitives. Filter to only cloneable primitives.
          const safeArgs: any[] = [];
          for (const a of args) {
            const t = typeof a;
            if (t === "string" || t === "number" || t === "boolean") {
              safeArgs.push(a);
            }
            // Skip objects (event objects, DOM elements, etc.)
          }
          (self as any).postMessage({ type: "store-action", store: "game", action, args: safeArgs });
        } catch (e) {
          console.error(`[store-bridge-worker] Error in action "${action}":`, e);
        }
      },
    }, false);
  }
  console.log(`[store-bridge-worker] patched ${gameActions.length} game actions`);

  // Install a renderer stub in the worker's store. The real renderer lives on
  // the main thread and can't be synced via postMessage. Game code calls
  // `get().renderer?.lockPointer()`, `renderer.getFPS()`, etc. which need to
  // either forward to the main thread (for actions like lockPointer) or return
  // a safe default (for read-only methods like getFPS).
  // Without this stub, togglePauseMenu/toggleInventory/etc. can't re-acquire
  // pointer lock after closing, and app.tsx's FPS polling throws
  // "renderer.getFPS is not a function" every 500ms.
  const RENDERER_FORWARD_ACTIONS = new Set(["lockPointer", "exitPointerLock"]);
  const rendererStub = new Proxy({}, {
    get: (_target, prop: string) => {
      if (RENDERER_FORWARD_ACTIONS.has(prop)) {
        return () => { (self as any).postMessage({ type: "store-action", store: "game", action: prop, args: [] }); };
      }
      // For all other methods (getFPS, setBloomStrength, etc.), return a
      // no-op function that doesn't throw. These are either read-only (getFPS
      // returns 0) or settings that only matter on the main thread.
      if (prop === "getFPS") return () => 0;
      return () => {};
    },
  });
  (useGameStore as any).setState({ renderer: rendererStub }, false);

  // Patch debug store actions
  const debugActions = [
    "setDebugPage", "toggleDebugPage", "setShowHitboxes", "setHitboxLineWidth",
    "setShowLightGizmos", "setShowRaycast", "setGCConfig",
  ];
  for (const action of debugActions) {
    const original = (useDebugStore.getState() as any)[action];
    if (typeof original !== "function") continue;
    (useDebugStore as any).setState({
      [action]: (...args: any[]) => {
        (self as any).postMessage({ type: "store-action", store: "debug", action, args });
      },
    }, false);
  }

  // Listen for state sync from the main thread
  (self as any).addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type !== "store-sync") return;

    if (msg.game) {
      // Filter out toggle state keys that have pending optimistic updates.
      // The worker's optimistic update is more recent than the main thread's
      // sync (which may reflect stale state from before the action was processed).
      const filtered: Record<string, any> = {};
      for (const key in msg.game) {
        if (optimisticPending.has(key)) continue;
        filtered[key] = msg.game[key];
      }
      // Apply filtered state without triggering the actions we patched.
      // pointerLocked is NOT included in the sync — it's read from the SAB
      // flag by the runtime's checkPointerLockFlag() after each callSync.
      useGameStore.setState(filtered, false);
    }
    if (msg.debug) {
      useDebugStore.setState(msg.debug, false);
    }
  });
}
