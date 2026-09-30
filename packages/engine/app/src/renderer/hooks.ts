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

  return downdraft.onDisplayInfo((info: any) => {
    if (info?.refreshRate > 0) onRefreshRate(info.refreshRate);
  });
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
 *
 * Under the native dev shell the callback also lands on the __ddSession
 * dispose registry — vite only fires hot.dispose on targeted invalidation,
 * NOT when a session restart clears the whole module cache, so the session
 * teardown must own the second copy. The wrapper unregisters from the
 * session when vite fires it (directed update) so it never runs twice.
 */
export function dispose(disposeFn: () => Promise<void> | void): void {
  const hot = (import.meta as any).hot;
  const session = (globalThis as any).__ddSession;
  if (!hot?.dispose && !session?.onDispose) return;
  let offSession: (() => void) | null = null;
  const wrapped = () => {
    offSession?.();
    offSession = null;
    return disposeFn();
  };
  if (hot?.dispose) hot.dispose(wrapped);
  if (session?.onDispose) offSession = session.onDispose(wrapped);
}
