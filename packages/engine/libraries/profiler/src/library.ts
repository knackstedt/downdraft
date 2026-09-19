// ============================================================================
// ProfilerLib — declarative engine library descriptor for
// @downdraft/engine/libraries/profiler.
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
// (which creates the ProfilingBridge + ProfilingSAB). The DevTools API is
// injected via the DevToolsAPITok token — initDevTools() provides it into
// the renderer module host before library `create` hooks run.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { PixiUiHost } from "@downdraft/engine/libraries/pixi-ui/host";
import { DevToolsAPITok } from "@downdraft/engine/modules/devtools/api";
import { ProfilerOverlay } from "./profiler-overlay";

export interface ProfilerLibConfig {
  /**
   * URL of the profiler scene module (the ProfilerScene factory).
   * Games typically set this to `new URL("./profiler-scene.ts", import.meta.url).href`
   * or use the built-in scene from @downdraft/engine/libraries/profiler/profiler-scene.
   * Default: the built-in ProfilerScene shipped with this library.
   */
  sceneModuleUrl?: string;
  /** Trace source: "contentTracing" (Electron) or "in-engine". Default: "in-engine". */
  traceSource?: "contentTracing" | "in-engine";
  /** Whether to enable the event-loop monitor on the renderer. Default: true. */
  enableEventLoopMonitor?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the ProfilerOverlay. Inject in onReady to control the overlay. */
export const ProfilerOverlayTok = resourceToken<ProfilerOverlay>("profiler:overlay");

// ── Descriptor ──

export const ProfilerLib: EngineLibrary<ProfilerLibConfig, unknown, ProfilerOverlay> = {
  name: "profiler",
  version: "0.1.0",

  provides: [ProfilerOverlayTok],

  // Renderer-only library: uses `renderer.create` (the early hook that runs
  // before the GPU device is acquired). No sim-side system, no GPU passes.
  renderer: {
    create(config, ctx) {
      // The ProfilingSAB is created by the ProfilingBridge (in initDevTools)
      // and exposed through the DevTools API token provided via DI.
      const devtools = ctx.injectOptional(DevToolsAPITok);
      const profilingSAB = devtools?.getProfilingSAB() ?? null;
      if (!devtools || !profilingSAB) {
        console.warn("[ProfilerLib] No ProfilingSAB found — ensure initDevTools({ profiling: true }) is called before ProfilerLib");
        return null;
      }

      const views = devtools.getViews();
      // Default: the ProfilerScene shipped in this library directory. With
      // raw-TS publishing this resolves to the installed file; bundlers may
      // still need an alias — games can override via config.sceneModuleUrl.
      const sceneModuleUrl = config.sceneModuleUrl
        ?? new URL("./profiler-scene.ts", import.meta.url).href;

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
      overlay.dispose();
      overlay.getPixiUiHost().dispose();
    },
  },

  defaultConfig: {
    traceSource: "in-engine",
    enableEventLoopMonitor: true,
  },
};
