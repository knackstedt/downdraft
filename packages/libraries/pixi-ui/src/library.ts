// ============================================================================
// PixiUiLib — declarative engine library descriptor for
// @downdraft/library-pixi-ui.
//
// A worker-hosted PixiJS UI overlay: the library spawns a Web Worker that
// renders a GUI onto an OffscreenCanvas (via transferControlToOffscreen)
// stacked above the main game canvas. Games feed per-frame scalars via a
// SharedArrayBuffer and event-driven data via postMessage.
//
// Games declare `libraries: [PixiUiLib]` (or
// `[[PixiUiLib, { backend: "webgpu", sceneModuleUrl: "...", ... }]]` to
// override config) in their GameModule. The host creates the overlay canvas,
// transfers it to the worker, allocates the UiStatsSAB, and exposes the
// PixiUiHost via the PixiUiHostTok token.
//
// Games that need full control can still import PixiUiHost directly
// (escape hatch) and wire it in onReady.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { PixiUiHost, type PixiUiHostOptions } from "./host";
import { DEFAULT_STATS_LAYOUT } from "./bridge-protocol";

// ── Config ──

/**
 * Layout of the per-frame scalar slots in the UiStatsSAB. `slots` is an
 * ordered list of names — each maps to a float32 offset in the SAB.
 * Games can override this to match their HUD's data.
 */
export interface UiStatsLayout {
  slots: string[];
}

export interface PixiUiLibConfig extends PixiUiHostOptions {
  /**
   * Renderer backend for the PixiJS overlay. Default: "webgl2" (most
   * reliable for a 2D UI overlay; avoids dual-WebGPU-device concerns with
   * the main game canvas). "webgpu" uses PixiJS's WebGPU backend; "auto"
   * lets PixiJS choose (WebGPU preferred, WebGL2 fallback).
   */
  backend?: "webgl2" | "webgpu" | "auto";
  /**
   * Per-frame scalar slot names for the UiStatsSAB. Default: DEFAULT_STATS_LAYOUT.
   * Games override to match their HUD data (health, fps, positions, ...).
   */
  statsLayout?: UiStatsLayout;
  /**
   * URL of the game's scene module (dynamically imported inside the worker).
   * The module should export a PixiUiSceneFactory as the default export
   * (or via sceneExportName). If omitted, a default "PixiUI ready" label
   * scene is used.
   */
  sceneModuleUrl?: string;
  /** Named export of the scene factory in the scene module. Default: "default". */
  sceneExportName?: string;
  /** Opaque config passed to the scene factory via PixiUiSceneContext.sceneConfig. */
  sceneConfig?: unknown;
  /** Enable PixiJS debug logging in the worker. Default: false. */
  debug?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the main-thread PixiUI host. Inject in onReady to feed data. */
export const PixiUiHostTok = resourceToken<PixiUiHost>("pixi-ui:host");

// ── Descriptor ──

export const PixiUiLib: EngineLibrary<PixiUiLibConfig> = {
  name: "pixi-ui",
  version: "0.1.0",

  // The host allocates the UiStatsSAB itself (sized from the stats layout),
  // so we don't declare a sabChannel here — the host manages the SAB lifecycle.
  provides: [PixiUiHostTok],

  // Renderer-only library: uses `renderer.create` (the early hook that runs
  // before the GPU device is acquired). No sim-side system, no GPU passes.
  renderer: {
    create(config, ctx) {
      const fullConfig: PixiUiLibConfig = {
        backend: "webgl2",
        statsLayout: DEFAULT_STATS_LAYOUT,
        ...config,
      };
      const host = new PixiUiHost(fullConfig);
      ctx.provide(PixiUiHostTok, host);
      return host;
    },
    dispose(host) {
      (host as PixiUiHost).dispose();
    },
  },

  defaultConfig: {
    backend: "webgl2",
    statsLayout: DEFAULT_STATS_LAYOUT,
    debug: false,
  },
};
