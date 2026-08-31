// ============================================================================
// bootstrapGame() — framework-orchestrated renderer bootstrap
//
// Centralizes the common bootstrap sequence shared by all games (both
// sim-worker and renderer-only topologies):
//   1. Mount UI (framework-agnostic: React, Solid, or none)
//   2. Get canvas
//   3. Create + init renderer
//   4. Wire DevTools (if provided)
//   5. Start the render loop immediately (don't block on autosave)
//   6. Feature log (renderer process)
//   7. FPS polling (if onFpsUpdate provided)
//   8. Display info wiring (if onDisplayInfo provided)
//   9. Autosave load with 5s timeout + interval (if autosave provided,
//      skip in deterministic mode)
//  10. MCP setup (if provided)
//  11. Hot-reload dispose (if provided)
//  12. Deterministic callbacks (if onDeterministic provided)
//
// This is NOT React-specific. Games provide a `mountUI` callback that can
// use any framework (React createRoot, Solid render, or nothing).
//
// `startGame()` wraps this and adds sim worker spawn, SAB capture, event
// routing, engine library auto-wiring, and save store initialization. Games
// that need full control can call `bootstrapGame()` directly.
// ============================================================================

import { encodeFeatureLogLine } from "@downdraft/core";
import { collectRendererFeatureLog } from "./feature-log";
import { downdraft, getCanvas, getOverlay } from "./index";

export interface BootstrapAutosaveOptions {
  /** Load saved state. Returns null if no save exists. */
  load: () => Promise<any | null>;
  /** Save current state. */
  save: () => Promise<void>;
  /** Autosave interval in milliseconds. Default: 3000. */
  intervalMs?: number;
  /** Called after a save is loaded successfully. */
  onLoad?: (data: any) => Promise<void> | void;
}

export interface BootstrapDevToolsOptions {
  /**
   * Factory that creates the sim stats provider from the renderer.
   * Called after the renderer is initialized.
   */
  createSimStatsProvider?: (renderer: any) => any;
  /** DevTools panels (game-specific). Can be a factory or static array. */
  panels?: any[] | ((renderer: any) => any[]);
  /** Whether to enable scene inspector. Default: false. */
  sceneInspector?: boolean;
  /**
   * Enable the profiling system (ProfilingSAB + ProfilingBridge + built-in views).
   * When true, a ProfilingBridge is created and the ProfilingSAB is shared
   * with all workers + the pixi-ui overlay. Default: false.
   */
  profiling?: boolean;
}

export interface BootstrapGameOptions {
  // --- Canvas/overlay ---
  /** Canvas layer index. Default: 0. */
  canvasLayer?: number;
  /** Overlay layer index. Default: 0. */
  overlayLayer?: number;

  // --- Renderer ---
  /** Factory that creates the renderer from a canvas element. */
  createRenderer: (canvas: HTMLCanvasElement) => any;
  /** Called after renderer creation to initialize it. Should return false on failure. */
  initRenderer?: (renderer: any) => Promise<boolean> | boolean;
  /** Called after renderer init to let the game wire the renderer to its store. */
  onRendererInit?: (renderer: any) => Promise<void> | void;

  // --- UI (framework-agnostic) ---
  /** Mount the UI framework (React: createRoot().render(), Solid: render(), etc). */
  mountUI?: (overlay: HTMLElement) => Promise<void> | void;

  // --- DevTools ---
  /** If provided, wires DevTools via initDevTools(). */
  devtools?: BootstrapDevToolsOptions;

  // --- Autosave ---
  /** If provided, sets up autosave load + interval. Skipped in deterministic mode. */
  autosave?: BootstrapAutosaveOptions;

  // --- MCP ---
  /** Called to register MCP tools (after renderer is started). */
  mcp?: () => void | Promise<void>;

  // --- Display info ---
  /** Called with the display refresh rate when available. */
  onDisplayInfo?: (refreshRate: number) => void;

  // --- Hot reload ---
  /** Called on Vite hot-reload dispose to clean up resources. */
  onHotReloadDispose?: () => Promise<void> | void;

  // --- Deterministic mode overrides ---
  /** Called in deterministic mode to apply overrides (e.g. skip title screen). */
  onDeterministic?: (renderer: any) => void;

  // --- FPS polling ---
  /** Called periodically with the current render FPS. Default interval: 500ms. */
  onFpsUpdate?: (fps: number) => void;
  /** FPS polling interval in milliseconds. Default: 500. */
  fpsPollIntervalMs?: number;

  // --- Feature log ---
  /** Optional getter for active plugin names (e.g. () => gameWorld.moduleHost.listModules()).
   *  Populates the `plug` field of the renderer feature log line. */
  getActiveModules?: () => string[];
}

/**
 * Bootstrap a game with the standard sequence.
 *
 * This orchestrator centralizes the common bootstrap pattern shared by all
 * games (both sim-worker and renderer-only topologies), eliminating ~1200
 * lines of duplicated boilerplate and closing the deterministic-mode variance
 * gap (all gates are centralized here).
 *
 * `startGame()` wraps this and adds sim worker spawn, SAB capture, event
 * routing, engine library auto-wiring, and save store initialization. Games
 * that need full control can call `bootstrapGame()` directly. Games that need
 * partial composition can use the individual hooks from `./hooks.ts` instead.
 */
export async function bootstrapGame(opts: BootstrapGameOptions): Promise<void> {
  const canvasLayer = opts.canvasLayer ?? 0;
  const overlayLayer = opts.overlayLayer ?? 0;
  const deterministic = downdraft?.deterministic === true;

  // 1. Mount UI (if provided) — before renderer init so the UI is visible
  //    while the renderer initializes (WebGPU adapter acquisition can take
  //    a moment on first launch).
  if (opts.mountUI) {
    await opts.mountUI(getOverlay(overlayLayer));
  }

  // 2. Get canvas
  const canvas = getCanvas(canvasLayer);

  // 3. Create + init renderer
  const renderer = opts.createRenderer(canvas);
  if (opts.initRenderer) {
    const ok = await opts.initRenderer(renderer);
    if (!ok) {
      console.error("[bootstrapGame] Renderer init failed");
      return;
    }
  }

  // 4. Wire DevTools (if provided) — runs BEFORE onRendererInit so that
  //    games can access the ProfilingBridge + __sceneInspector API in onReady.
  if (opts.devtools) {
    const { initDevTools } = await import("@downdraft/module-devtools");
    const simStatsProvider = opts.devtools.createSimStatsProvider?.(renderer);
    const panels = typeof opts.devtools.panels === "function"
      ? opts.devtools.panels(renderer)
      : opts.devtools.panels ?? [];
    await initDevTools(renderer, {
      simStatsProvider,
      panels,
      profiling: opts.devtools.profiling,
    });
  }

  // 4b. onRendererInit — library setup, sim start, game-specific wiring (onReady).
  //     DevTools is already wired, so games can access __sceneInspector +
  //     the ProfilingBridge from their onReady hook.
  if (opts.onRendererInit) {
    await opts.onRendererInit(renderer);
  }

  // 5. Start the render loop immediately — don't let a hung autosave load
  //    (e.g. IndexedDB locked by another process) block the canvas from rendering.
  if (typeof renderer.start === "function") {
    renderer.start();
  }

  // 6. Feature log (renderer process) — collect + emit the `dd-render|...`
  //    startup line. Synchronous; reads WebGPU adapter/features/limits,
  //    navigator, SAB/COOP-COEP, and active plugins (if getActiveModules
  //    provided). The main-process `dd-main|...` line is emitted separately
  //    from app.ts; both are fetched together via getCombinedFeatureLog()
  //    for the DevTools copy button and MCP get_features tool.
  const isDev = !!(downdraft?.isDev) || import.meta.env.DEV === true;
  const renderFeatureLog = collectRendererFeatureLog({
    renderer,
    isDev,
    deterministic,
    getActiveModules: opts.getActiveModules,
  });
  console.info(encodeFeatureLogLine(renderFeatureLog));

  // 7. FPS polling (if onFpsUpdate provided)
  if (opts.onFpsUpdate) {
    const fpsInterval = opts.fpsPollIntervalMs ?? 500;
    setInterval(() => {
      if (typeof renderer.getFPS === "function") {
        opts.onFpsUpdate!(renderer.getFPS());
      }
    }, fpsInterval);
  }

  // 8. Display info wiring (if onDisplayInfo provided)
  if (opts.onDisplayInfo && downdraft?.isAvailable) {
    downdraft.getDisplayInfo().then((info) => {
      if (info.refreshRate > 0) {
        opts.onDisplayInfo!(info.refreshRate);
      }
    }).catch(() => { /* ignore */ });
    downdraft.onDisplayInfo((info: any) => {
      if (info?.refreshRate > 0) {
        opts.onDisplayInfo!(info.refreshRate);
      }
    });
  }

  // 9. Autosave load + interval (skip in deterministic mode).
  //    The load has a 5s timeout so a locked IndexedDB doesn't block the
  //    autosave interval setup. The interval guards against overlapping
  //    saves — if a save takes longer than the interval (e.g. the worker is
  //    busy or OPFS is slow), the tick is skipped instead of piling up
  //    concurrent saves that can corrupt OPFS data or hang on file locks.
  if (opts.autosave && !deterministic) {
    const autosaveOpts = opts.autosave;
    const intervalMs = autosaveOpts.intervalMs ?? 3000;

    try {
      const saved = await Promise.race([
        autosaveOpts.load(),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (saved && autosaveOpts.onLoad) {
        await autosaveOpts.onLoad(saved);
      }
    } catch (e) {
      console.warn("[bootstrapGame] Autosave load failed:", e);
    }

    let saveInProgress = false;
    setInterval(async () => {
      if (saveInProgress) return;
      saveInProgress = true;
      try {
        await autosaveOpts.save();
      } catch (e) {
        console.warn("[bootstrapGame] Autosave save failed:", e);
      } finally {
        saveInProgress = false;
      }
    }, intervalMs);
  }

  // 10. MCP setup (if provided)
  if (opts.mcp) {
    await opts.mcp();
  }

  // 11. Hot-reload dispose (if provided)
  if (opts.onHotReloadDispose) {
    const { dispose } = await import("./hooks");
    dispose(opts.onHotReloadDispose);
  }

  // 12. Deterministic callbacks (if onDeterministic provided)
  if (deterministic && opts.onDeterministic) {
    opts.onDeterministic(renderer);
  }
}
