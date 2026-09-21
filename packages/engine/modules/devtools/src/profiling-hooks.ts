// ============================================================================
// wireProfilingBridge / attachProfilerOverlay — shared profiling wiring.
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
//
// attachProfilerOverlay() starts the pixi-ui profiler overlay (a second
// PixiUiHost rendering ProfilerScene above the game UI) with a hotkey to
// toggle visibility.
// ============================================================================

import { PixiUiHost } from "@downdraft/engine/libraries/pixi-ui";
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
  for (const entry of opts.workerHosts ?? []) {
    if (!entry) continue;
    const host = "attachProfilingSAB" in entry ? entry : entry.host;
    const workerTag = "attachProfilingSAB" in entry ? undefined : entry.workerTag;
    void host?.attachProfilingSAB(sab, { workerTag, layout });
  }

  return bridge;
}

export interface ProfilerOverlayOptions {
  /**
   * URL of the scene module the pixi-ui worker imports — a tiny factory
   * wrapper around ProfilerScene:
   *   export default (ctx) => new ProfilerScene(ctx);
   * Typically `new URL("./profiler-scene.ts", import.meta.url).href`.
   */
  sceneModuleUrl: string;
  /** Explicit bridge — defaults to window.__sceneInspector.__getProfilingBridge(). */
  bridge?: ProfilingBridge | null;
  /** Canvas element id (default: "profiler-canvas"). */
  canvasId?: string;
  /** Canvas layer index (default: 2 — above the game's pixi-ui layer 1). */
  canvasLayer?: number;
  /** Key that toggles overlay visibility (default: "F10"). */
  toggleKey?: string;
  /** Start visible (default: false). */
  startVisible?: boolean;
  /** Extra PixiUiHost config overrides. */
  hostConfig?: Record<string, unknown>;
}

export interface ProfilerOverlayHandle {
  host: PixiUiHost;
  /** Stop the overlay + remove the hotkey listener. */
  dispose(): void;
}

/**
 * Start the profiler overlay: a PixiUiHost rendering ProfilerScene on a
 * separate canvas layer, toggled by a hotkey (F10 by default). Returns null
 * when profiling isn't enabled.
 */
export function attachProfilerOverlay(opts: ProfilerOverlayOptions): ProfilerOverlayHandle | null {
  const bridge = getProfilingBridge(opts.bridge);
  if (!bridge) return null;

  const canvasId = opts.canvasId ?? "profiler-canvas";
  const toggleKey = opts.toggleKey ?? "F10";

  const host = new PixiUiHost({
    backend: "webgl2",
    sceneModuleUrl: opts.sceneModuleUrl,
    sceneConfig: {
      views: (window as any).__sceneInspector?.__getViews?.() ?? [],
      layout: bridge.getLayoutParams?.(),
    },
    extraSharedBuffers: { profiling: bridge.getProfilingSAB() },
    passThrough: true,
    canvasLayer: opts.canvasLayer ?? 2,
    canvasId,
    ...(opts.hostConfig ?? {}),
  } as any);

  host.start().then(() => {
    console.log(`[profiler] Profiler overlay started — press ${toggleKey} to toggle`);
    if (!opts.startVisible) {
      const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
      if (canvas) canvas.style.display = "none";
      // Suspend the worker's render loop while hidden — otherwise the pixi
      // worker rebuilds + renders the scene every frame (invisible), which
      // floods the GPU channel and churns heap into constant GC pauses.
      host.setPaused(true);
    }
  }, (e) => console.error("[profiler] Profiler overlay failed to start:", e));

  const toggle = (e: KeyboardEvent) => {
    if (e.key === toggleKey) {
      e.preventDefault();
      const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
      if (canvas) {
        const show = canvas.style.display === "none";
        canvas.style.display = show ? "block" : "none";
        host.setPaused(!show);
      }
    }
  };
  window.addEventListener("keydown", toggle);

  return {
    host,
    dispose() {
      window.removeEventListener("keydown", toggle);
      host.dispose();
    },
  };
}
