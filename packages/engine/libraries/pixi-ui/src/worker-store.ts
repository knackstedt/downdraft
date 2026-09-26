// ============================================================================
// worker-store — factory for the worker-side reactive store mirror.
//
// @pixi/react scenes running inside the pixi-ui Web Worker can't read the
// main-thread zustand store. Each game re-implemented the same ~110-line
// pattern: a mutable state object + Set of listeners + useSyncExternalStore
// selector hook + postAction plumbing (worker→main action requests).
//
// This factory centralizes it. Games call createWorkerStore(initial) at
// module scope inside their scene module and destructure the pieces:
//
//   const store = createWorkerStore<MyState>({ fps: 0, ... });
//   export const useWorkerState = store.useWorkerState;
//   export const postAction = store.postAction;
//
// The scene's update() calls store.setState(partial) when SAB stats or
// postMessage events arrive; components re-render via useWorkerState.
//
// NOTE: imports react eagerly — only @pixi/react games should import this
// module (it ships under the /react subpath surface). Raw-PixiJS scenes
// don't need it (they read `stats` directly in update()).
// ============================================================================

import { useSyncExternalStore } from "react";

export interface WorkerStore<T extends object> {
  /** Current state snapshot (mutable reference — replaced on each setState). */
  getState(): T;
  /** Merge a partial (or updater fn) into state and notify subscribers. */
  setState(partial: Partial<T> | ((state: T) => Partial<T>)): void;
  /** Subscribe to state changes. Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** React hook: select a derived value; re-renders when the selection changes. */
  useWorkerState<S>(selector: (state: T) => S): S;
  /**
   * Post a worker→main action (side-effect request). The host's onAction
   * handler receives it. Wired via setPostAction — the scene calls
   * setPostAction(ctx.postAction) during scene init.
   * `any` — actions cross a postMessage boundary and are game-typed on the
   * other side; a narrower param type would reject game action unions.
   */
  postAction(action: any): void;
  /** Install the action sink (called by the scene during init). */
  setPostAction(fn: (action: any) => void): void;
}

export function createWorkerStore<T extends object>(initialState: T): WorkerStore<T> {
  let state = initialState;
  const listeners = new Set<() => void>();
  let postActionFn: ((action: any) => void) | null = null;

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return {
    getState: () => state,

    setState(partial) {
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
      for (const l of listeners.values()) l();
    },

    subscribe,

    useWorkerState<S>(selector: (state: T) => S): S {
      return useSyncExternalStore(
        subscribe,
        () => selector(state),
        () => selector(initialState),
      );
    },

    postAction(action) {
      postActionFn?.(action);
    },

    setPostAction(fn) {
      postActionFn = fn;
    },
  };
}
