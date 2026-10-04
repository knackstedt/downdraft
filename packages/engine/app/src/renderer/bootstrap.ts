// ============================================================================
// bootstrapGame() — framework-orchestrated renderer bootstrap
//
// Centralizes the common bootstrap sequence shared by all games (both
// sim-worker and renderer-only topologies):
//   1. Get the render surface
//   2. Create + init renderer
//   3. Wire DevTools (if provided)
//   4. Start the render loop immediately (don't block on autosave)
//   5. Feature log (renderer process)
//   6. FPS polling (if onFpsUpdate provided)
//   7. Display info wiring (if onDisplayInfo provided)
//   8. Autosave load with 5s timeout + interval (if autosave provided,
//      skip in deterministic mode)
//   9. MCP setup (if provided)
//  10. Hot-reload dispose (if provided)
//  11. Deterministic callbacks (if onDeterministic provided)
//
// `startGame()` wraps this and adds sim worker spawn, SAB capture, event
// routing, engine library auto-wiring, and save store initialization. Games
// that need full control can call `bootstrapGame()` directly.
// ============================================================================

import { encodeFeatureLogLine, isDevMode, type RenderSurface } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { collectRendererFeatureLog } from "./feature-log";
import { downdraft, getSurface } from "./index";

const log = createLogger("info");

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
  /** Custom scene-inspector bridge class (extends BaseSceneInspector).
   *  Forwarded to initDevTools — implies sceneInspector. */
  bridgeClass?: new () => any;
  /** Worker hosts to sync devtools manifests from (evaluated after
   *  renderer init — a factory runs when the game's sim worker is already
   *  started, e.g. by an overridden onInit). */
  workerHosts?: any[] | ((renderer: any) => any[]);
  /** Extra game-level rows for the Input panel. */
  inputInfo?: () => { key: string; value: string; flags?: number }[];
  /**
   * Enable the profiling system (ProfilingSAB + ProfilingBridge + built-in views).
   * When true, a ProfilingBridge is created and the ProfilingSAB is shared
   * with all workers + devtools views. Pass `{ sharedSAB }` to attach a
   * pre-allocated buffer. Default: false.
   */
  profiling?: boolean | { sharedSAB?: { sab: SharedArrayBuffer; layout: unknown } };
  /**
   * Devtools UI frontend. "blitz" (default) mounts the docked in-window UI
   * (F12 toggles); "web" starts the loopback browser frontend
   * (WebDevtoolsHost, requires Bun); "none" wires data only.
   * Object form: `{ kind: "blitz", dockFraction?, autoShow?, toggleKey? }`.
   * `DOWNDRAFT_DISABLE_DEVTOOLS=1` forces "none".
   */
  ui?: "blitz" | "web" | "none" | {
    kind?: "blitz" | "web";
    dockFraction?: number;
    autoShow?: boolean;
    toggleKey?: string | null;
  };
}

export interface BootstrapGameOptions {
  // --- Surface ---
  /** Surface layer index. Default: 0 — the only layer on native hosts. */
  canvasLayer?: number;

  // --- Renderer ---
  /** Factory that creates the renderer from the render surface. */
  createRenderer: (surface: RenderSurface) => any;
  /** Called after renderer creation to initialize it. Should return false on failure. */
  initRenderer?: (renderer: any) => Promise<boolean> | boolean;
  /** Called after renderer init to let the game wire the renderer to its store. */
  onRendererInit?: (renderer: any) => Promise<void> | void;

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
  const deterministic = downdraft?.deterministic === true;

  // 1. Get the render surface
  const surface = getSurface(canvasLayer);

  // 3. Create + init renderer
  const renderer = opts.createRenderer(surface);
  if (opts.initRenderer) {
    const ok = await opts.initRenderer(renderer);
    if (!ok) {
      log.error("bootstrapGame", "Renderer init failed");
      return;
    }
  }

  // 4. Wire DevTools (if provided) — runs BEFORE onRendererInit so that
  //    games can access the ProfilingBridge + __sceneInspector API in onReady.
  if (opts.devtools) {
    const { initDevTools } = await import("@downdraft/engine/modules/devtools");
    const simStatsProvider = opts.devtools.createSimStatsProvider?.(renderer);
    const panels = typeof opts.devtools.panels === "function"
      ? opts.devtools.panels(renderer)
      : opts.devtools.panels ?? [];
    const workerHosts = typeof opts.devtools.workerHosts === "function"
      ? opts.devtools.workerHosts(renderer)
      : opts.devtools.workerHosts;
    await initDevTools(renderer, {
      simStatsProvider,
      panels,
      sceneInspector: opts.devtools.sceneInspector,
      bridgeClass: opts.devtools.bridgeClass,
      workerHosts,
      profiling: opts.devtools.profiling as any,
    });

    // 4a. Devtools UI frontend — the Blitz dock is the default surface.
    const disabled = typeof process !== "undefined" && !!process.env?.DOWNDRAFT_DISABLE_DEVTOOLS;
    const uiOpt = opts.devtools.ui ?? "blitz";
    const uiKind = disabled ? "none" : (typeof uiOpt === "string" ? uiOpt : uiOpt.kind ?? "blitz");
    if (uiKind !== "none" && typeof renderer.useRendererModule === "function") {
      try {
        const uiCfg = typeof uiOpt === "object" ? uiOpt : {};
        const profilingSAB =
          (globalThis as Record<string, any>).window?.__sceneInspector?.__getProfilingBridge?.()?.getProfilingSAB?.()
          ?? (globalThis as Record<string, any>).__sceneInspector?.__getProfilingBridge?.()?.getProfilingSAB?.()
          ?? null;
        if (uiKind === "blitz") {
          const { createDevtoolsUiModule } = await import("@downdraft/engine/modules/devtools");
          renderer.useRendererModule(createDevtoolsUiModule({
            renderer,
            profilingSAB,
            dockFraction: uiCfg.dockFraction,
            autoShow: uiCfg.autoShow,
            toggleKey: uiCfg.toggleKey,
            onHost: (host) => {
              renderer.nativeDebugger = host;
              wireDevtoolsFrontend(host.devtoolsMirror, host, renderer, workerHosts, profilingSAB, opts.devtools?.inputInfo);
            },
          }));
        } else {
          // "web" — loopback browser frontend (Bun-only transport).
          const { WebDevtoolsHost } = await import("@downdraft/engine/libraries/devtools");
          const webHost = new WebDevtoolsHost({
            device: renderer.getDevice?.() as GPUDevice,
            adapter: null as any,
            targetFormat: renderer.getFormat?.() ?? "bgra8unorm",
            width: 0, height: 0,
            renderer,
            profilingSAB,
          });
          await webHost.start();
          renderer.nativeDebugger = webHost;
          wireDevtoolsFrontend(webHost.devtoolsMirror, webHost, renderer, workerHosts, profilingSAB, opts.devtools?.inputInfo);
          // Per-frame pump + F12 through the renderer's input bus, same as
          // the Blitz module's wiring.
          renderer.setCallbacks?.({
            ...renderer.getCallbacks?.(),
            beforeFrame: ((prev: any) => (dt: number, t: number) => {
              try { webHost.update(); } catch { /* ignore */ }
              prev?.(dt, t);
            })(renderer.getCallbacks?.().beforeFrame),
          });
        }
      } catch (err) {
        log.error("bootstrapGame", `Devtools UI init failed: ${err}`);
      }
    }
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
  const isDev = !!(downdraft?.isDev) || isDevMode;
  const renderFeatureLog = collectRendererFeatureLog({
    renderer,
    isDev,
    deterministic,
    getActiveModules: opts.getActiveModules,
  });
  log.info("bootstrapGame", encodeFeatureLogLine(renderFeatureLog));

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
      log.warn("bootstrapGame", `Autosave load failed: ${e}`);
    }

    let saveInProgress = false;
    setInterval(async () => {
      if (saveInProgress) return;
      saveInProgress = true;
      try {
        await autosaveOpts.save();
      } catch (e) {
        log.warn("bootstrapGame", `Autosave save failed: ${e}`);
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

/**
 * Shared wiring for a live devtools frontend (Blitz dock or web host):
 * engine-generic providers + thread evals derived from the devtools
 * workerHosts entries ({prefix, proxy} — proxies exposing __devtoolsEval
 * get a REPL target under their prefix name).
 */
async function wireDevtoolsFrontend(
  mirror: { registerProvider?: any; registerCommandHandler?: any },
  host: { registerThreadEval: (n: string, fn: (e: string) => Promise<{ result?: unknown; error?: string }>) => void },
  renderer: any,
  workerHosts: any[] | undefined,
  profilingSAB: SharedArrayBuffer | null,
  inputInfo?: () => { key: string; value: string; flags?: number }[],
): Promise<void> {
  const { registerEngineProviders } = await import("@downdraft/engine/libraries/devtools");
  const evalNames: string[] = ["main"];
  for (const wh of workerHosts ?? []) {
    const evalFn = wh?.proxy?.__devtoolsEval;
    if (typeof evalFn === "function" && wh.prefix) {
      host.registerThreadEval(wh.prefix, (expr) => evalFn.call(wh.proxy, expr));
      evalNames.push(wh.prefix);
    }
  }
  registerEngineProviders(mirror as any, {
    renderer,
    profilingSAB,
    simProxy: workerHosts?.[0]?.proxy ?? undefined,
    evalTargetNames: () => evalNames,
    inputInfo,
  });
}
