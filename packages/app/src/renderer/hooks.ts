// ============================================================================
// Individual composable hooks — fallback for games that need partial
// composition instead of the full bootstrapGame() orchestrator.
//
// These are plain functions (not React hooks) that return cleanup callbacks.
// ============================================================================

import { downdraft } from "./index";

/**
 * Poll the renderer's FPS and call the callback at the given interval.
 * Returns a cleanup function that clears the interval.
 */
export function useFpsPolling(
  renderer: { getFPS: () => number },
  onFps: (fps: number) => void,
  intervalMs: number = 500,
): () => void {
  const id = setInterval(() => {
    onFps(renderer.getFPS());
  }, intervalMs);
  return () => clearInterval(id);
}

/**
 * Set up autosave load + interval. Skips entirely in deterministic mode.
 * Returns a cleanup function that clears the interval.
 */
export function useAutosave(
  loadFn: () => Promise<any | null>,
  saveFn: () => Promise<void>,
  intervalMs: number = 3000,
  deterministic: boolean = false,
  onLoad?: (data: any) => Promise<void> | void,
): () => void {
  if (deterministic) return () => {};

  // Load with 5s timeout
  Promise.race([
    loadFn(),
    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
  ])
    .then(async (saved) => {
      if (saved && onLoad) await onLoad(saved);
    })
    .catch((e) => console.warn("[useAutosave] Load failed:", e));

  const id = setInterval(async () => {
    try {
      await saveFn();
    } catch (e) {
      console.warn("[useAutosave] Save failed:", e);
    }
  }, intervalMs);

  return () => clearInterval(id);
}

/**
 * In deterministic mode, pause the renderer's sim (so the e2e test can
 * control it via MCP). No-op in non-deterministic mode.
 */
export function useDeterministicRenderPause(
  renderer: { pause?: () => void },
  deterministic: boolean,
): void {
  if (deterministic && typeof renderer.pause === "function") {
    renderer.pause();
  }
}

/**
 * Wire display info refresh rate updates.
 * Returns a cleanup function that removes the listener.
 */
export function useDisplayInfo(
  onRefreshRate: (refreshRate: number) => void,
): () => void {
  if (!downdraft?.isAvailable) return () => {};

  downdraft.getDisplayInfo().then((info) => {
    if (info.refreshRate > 0) onRefreshRate(info.refreshRate);
  }).catch(() => { /* ignore */ });

  downdraft.onDisplayInfo((info: any) => {
    if (info?.refreshRate > 0) onRefreshRate(info.refreshRate);
  });

  // No way to remove the onDisplayInfo listener (preload API limitation),
  // so cleanup is a no-op.
  return () => {};
}

/**
 * Register a Vite hot-reload dispose callback.
 * In non-hot-reload environments, this is a no-op.
 */
export function useHotReloadDispose(
  disposeFn: () => Promise<void> | void,
): void {
  dispose(disposeFn);
}

/**
 * Internal: register a dispose callback via Vite's import.meta.hot API.
 * Exported for bootstrapGame() to use.
 */
export function dispose(disposeFn: () => Promise<void> | void): void {
  const hot = (import.meta as any).hot;
  if (hot?.dispose) {
    hot.dispose(disposeFn);
  }
}
