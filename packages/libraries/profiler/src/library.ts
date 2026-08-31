// ============================================================================
// ProfilerLib — declarative engine library descriptor for
// @downdraft/library-profiler.
//
// Games declare `libraries: [ProfilerLib]` (or
// `[[ProfilerLib, { sceneModuleUrl: "...", traceSource: "in-engine" }]]`)
// in their GameModule. The library descriptor creates a ProfilerOverlay that
// runs the ProfilerScene inside the pixi-ui worker, sharing the ProfilingSAB
// for zero-copy data reads.
//
// Requires the PixiUiLib to be declared alongside it (the profiler overlay
// uses the pixi-ui worker's OffscreenCanvas).
//
// Requires the devtools module to be initialized with `profiling: true`
// (which creates the ProfilingBridge + ProfilingSAB).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";

export interface ProfilerLibConfig {
  /**
   * URL of the profiler scene module (the ProfilerScene factory).
   * Games typically set this to `new URL("./profiler-scene.ts", import.meta.url).href`
   * or use the built-in scene from @downdraft/library-profiler/profiler-scene.
   * If omitted, the library uses the built-in scene URL.
   */
  sceneModuleUrl?: string;
  /** Trace source: "contentTracing" (Electron) or "in-engine". Default: "in-engine". */
  traceSource?: "contentTracing" | "in-engine";
  /** Whether to enable the event-loop monitor on the renderer. Default: true. */
  enableEventLoopMonitor?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the ProfilerOverlay. Inject in onReady to control the overlay. */
export const ProfilerOverlayTok = resourceToken<any>("profiler:overlay");

// ── Descriptor ──

export const ProfilerLib: EngineLibrary<ProfilerLibConfig> = {
  name: "profiler",
  version: "0.1.0",

  provides: [ProfilerOverlayTok],

  // Renderer-only library: uses `renderer.create` (the early hook that runs
  // before the GPU device is acquired). No sim-side system, no GPU passes.
  renderer: {
    create(config, ctx) {
      // Lazy-import to avoid pulling pixi-ui into the main bundle if unused
      const { ProfilerOverlay } = require("./profiler-overlay");
      const { PixiUiHost } = require("@downdraft/library-pixi-ui/host");

      // The ProfilingSAB is created by the ProfilingBridge (in initDevTools).
      // We access it via the devtools API.
      const { devtools } = require("@downdraft/module-devtools/api");
      const profilingSAB = devtools.getProfilingSAB();
      if (!profilingSAB) {
        console.warn("[ProfilerLib] No ProfilingSAB found — ensure initDevTools({ profiling: true }) is called before ProfilerLib");
        return null;
      }

      const views = devtools.getViews();
      const sceneModuleUrl = config.sceneModuleUrl
        ?? "TODO: built-in scene URL (requires vite alias)";

      // Create a PixiUiHost for the profiler overlay
      const pixiUiHost = new PixiUiHost({
        sceneModuleUrl,
        sceneConfig: { views, profilingSAB },
        extraSharedBuffers: { profiling: profilingSAB },
        canvasLayer: 2, // above the game's pixi-ui overlay (layer 1)
        canvasId: "profiler-canvas",
        backend: "webgl2",
      });

      const overlay = new ProfilerOverlay({
        pixiUiHost,
        profilingSAB,
        views,
      });

      ctx.provide(ProfilerOverlayTok, overlay);
      return overlay;
    },
    dispose(overlay) {
      (overlay as any)?.dispose?.();
    },
  },

  defaultConfig: {
    traceSource: "in-engine",
    enableEventLoopMonitor: true,
  },
};
