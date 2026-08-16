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

  // Patch game store actions to forward to main thread
  const gameActions = [
    "toggleInventory", "toggleMap", "toggleBuildMenu", "toggleCraftMenu",
    "toggleFishingMinigame", "toggleTradeMenu", "toggleSettings",
    "togglePauseMenu", "toggleCharacterCustomization", "toggleCredits",
    "toggleHud", "setShowPauseMenu", "setHudHidden", "setSuppressPauseMenu",
    "setReticleSize", "setBuilderCellType", "setBuilderRotation",
    "setShowBuilderWheel", "addBookmark", "removeBookmark", "setWaypoint",
    "equipItem",
  ];
  for (const action of gameActions) {
    const original = (useGameStore.getState() as any)[action];
    if (typeof original !== "function") continue;
    // Replace with a forwarder
    (useGameStore as any).setState({
      [action]: (...args: any[]) => {
        (self as any).postMessage({ type: "store-action", store: "game", action, args });
      },
    }, false);
  }
  console.log(`[store-bridge-worker] patched ${gameActions.length} game actions`);

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
      // Apply state without triggering the actions we patched.
      // pointerLocked is NOT included in the sync — it's read from the SAB
      // flag by the runtime's checkPointerLockFlag() after each callSync.
      useGameStore.setState(msg.game, false);
    }
    if (msg.debug) {
      useDebugStore.setState(msg.debug, false);
    }
  });
}
