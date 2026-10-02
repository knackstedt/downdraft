// ============================================================================
// wireProfilingBridge — shared profiling wiring.
//
// Generalized from to-the-ocean's main.tsx + sandjongg's game-module.tsx.
//
// wireProfilingBridge() connects the ProfilingBridge (created by
// initDevTools({ profiling: true }) and exposed via
// window.__sceneInspector.__getProfilingBridge()) into the render loop:
//   - wraps the renderer's beforeFrame/afterFrame callbacks with
//     bridge.tick() / bridge.endFrame()
//   - shares the ProfilingSAB with the given worker hosts so each can claim
//     a slot (worker-side profiling prelude patches prototypes + warning
//     engine + event-loop monitor)
// ============================================================================

import type { ProfilingBridge } from "./profiling-bridge";

/** Frame-callback surface used by wireProfilingBridge (duck-typed). */
export interface ProfilingLoopCallbacks {
  beforeFrame?: (dt: number, elapsedTime: number) => void;
  afterFrame?: (dt: number, elapsedTime: number) => void;
}

/** Renderer surface needed by wireProfilingBridge. */
export interface ProfilingWireRenderer {
  getCallbacks?(): ProfilingLoopCallbacks | undefined;
  setCallbacks(cb: ProfilingLoopCallbacks): void;
}

/** Worker host surface needed to share the ProfilingSAB. */
export interface ProfilingWireHost {
  attachProfilingSAB(
    sab: SharedArrayBuffer,
    opts?: {
      workerTag?: string;
      layout?: {
        maxSlots: number;
        iopsRingCap: number;
        warningRingCap: number;
        stringTableCap: number;
      };
    },
  ): Promise<void> | void;
}

export interface WireProfilingBridgeOptions {
  /** The game renderer (beforeFrame/afterFrame get wrapped). */
  renderer: ProfilingWireRenderer;
  /**
   * Worker hosts to share the ProfilingSAB with. Entries may be a bare host
   * or `{ host, workerTag }` to override the "sim" slot tag.
   */
  workerHosts?: Array<ProfilingWireHost | { host: ProfilingWireHost | null | undefined; workerTag?: string } | null | undefined>;
  /** Explicit bridge — defaults to window.__sceneInspector.__getProfilingBridge(). */
  bridge?: ProfilingBridge | null;
}

function getProfilingBridge(explicit?: ProfilingBridge | null): ProfilingBridge | null {
  if (explicit) return explicit;
  return (window as any).__sceneInspector?.__getProfilingBridge?.() ?? null;
}

/**
 * Wire the ProfilingBridge into the renderer's frame callbacks and share the
 * ProfilingSAB with the given worker hosts. Returns the bridge, or null when
 * profiling isn't enabled — callers can skip their profiling-only work.
 */
export function wireProfilingBridge(opts: WireProfilingBridgeOptions): ProfilingBridge | null {
  const bridge = getProfilingBridge(opts.bridge);
  if (!bridge) return null;

  const { renderer } = opts;
  const prevCallbacks: ProfilingLoopCallbacks =
    renderer.getCallbacks?.() ?? (renderer as any).callbacks ?? {};
  renderer.setCallbacks({
    ...prevCallbacks,
    beforeFrame: (dt: number, elapsedTime: number) => {
      bridge.tick();
      prevCallbacks.beforeFrame?.(dt, elapsedTime);
    },
    afterFrame: (dt: number, elapsedTime: number) => {
      prevCallbacks.afterFrame?.(dt, elapsedTime);
      bridge.endFrame();
    },
  });

  // Share the ProfilingSAB with each worker host so it can claim a slot.
  const sab = bridge.getProfilingSAB();
  const layout = bridge.getLayoutParams?.();
  for (let _i = 0, _it = opts.workerHosts ?? [], _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
    if (!entry) continue;
    const host = "attachProfilingSAB" in entry ? entry : entry.host;
    const workerTag = "attachProfilingSAB" in entry ? undefined : entry.workerTag;
    void host?.attachProfilingSAB(sab, { workerTag, layout });
  }

  return bridge;
}
