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

import { encodeFeatureLogLine, getNativeHost, isDevMode, type RenderSurface } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { collectRendererFeatureLog } from "./feature-log";
import { downdraft, getSurface } from "./index";

const log = createLogger("info");

// Pre-warm the devtools chunks in dev mode. The dynamic imports below are
// awaited deep inside async bootstrap frames — if the fetch is still in
// flight when a dev-session restart clears the runner's module cache, the
// pending fetch can be dropped unresolved, leaving the async frame suspended
// forever and pinning the dead generation's renderer/devtools graph. Firing
// the import at module eval collapses the awaits to a settled-cache lookup.
const devtoolsModuleP = isDevMode
  ? import("@downdraft/engine/modules/devtools")
  : null;
const devtoolsLibP = isDevMode
  ? import("@downdraft/engine/libraries/devtools")
  : null;
// ./hooks is tiny and same-graph, but pre-warming it too keeps the await at
// the bottom of bootstrapGame() off the in-flight-fetch path as well.
const hooksP = import("./hooks");
// Attach benign handlers so a rejection before the first await isn't flagged
// as unhandled — awaiting the original promise still propagates the error.
devtoolsModuleP?.catch(() => {});
devtoolsLibP?.catch(() => {});
hooksP.catch(() => {});

/**
 * Race an awaited import against session teardown: under the dev shell a
 * fetch can be orphaned mid-flight (module-cache clear drops the pending
 * entry unresolved), which would suspend the awaiting async frame forever —
 * JSC retains suspended frames via their rooted executables, so the frame's
 * captured environment (renderer, module host, devtools host) leaks per
 * restart. Resolving to null lets the caller abandon the work cleanly.
 */
function importOrDead<T>(p: Promise<T>, expectedSession?: any): Promise<T | null> {
  const tracker = (globalThis as any).__ddSession;
  if (!tracker || typeof tracker.onDispose !== "function") return p;
  const s = tracker.session;
  // No live session — or a DIFFERENT session than the caller's generation —
  // at await time means this frame belongs to a generation that is already
  // dead. Resolve null now so it unwinds rather than parking on a
  // possibly-orphaned fetch or registering into the wrong session.
  if (!s || s.dead || (expectedSession !== undefined && s !== expectedSession)) {
    return Promise.resolve(null);
  }
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      tracker.onDispose(() => resolve(null));
      // The registration is dropped when the session is already dying —
      // re-check so the race can't park on a resolve that will never fire.
      if (s.dead || tracker.session !== s) resolve(null);
    }),
  ]);
}

/** Bail predicate for bootstrapGame's mid-boot awaits. The session snapshot
 *  captured at ENTRY is this generation's identity: after any await a restart
 *  may have torn it down AND begun a fresh session — checking the tracker's
 *  current session alone would let dead-generation continuations register
 *  timers/listeners into the new session (which tracks them faithfully,
 *  pinning the dead module graph for a whole generation). Also bails when a
 *  host restart stripped the DOM polyfill globals. */
function makeBootGuard(mySession: any): () => boolean {
  const tracker = (globalThis as any).__ddSession;
  return () => {
    if (tracker && (tracker.session !== mySession || !mySession || mySession.dead)) return true;
    return typeof (globalThis as any).window === "undefined";
  };
}

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
  const bootSession = (globalThis as any).__ddSession?.session ?? null;
  const bootAborted = makeBootGuard(bootSession);
  const canvasLayer = opts.canvasLayer ?? 0;
  const deterministic = downdraft?.deterministic === true;

  // 1. Get the render surface
  const surface = getSurface(canvasLayer);

  // 3. Create + init renderer
  const renderer = opts.createRenderer(surface);
  if (opts.initRenderer) {
    const ok = await importOrDead(Promise.resolve(opts.initRenderer(renderer)), bootSession);
    if (ok === null) return;
    if (!ok) {
      log.error("bootstrap-game", "Renderer init failed");
      return;
    }
  }
  if (bootAborted()) return;

  // 4. Wire DevTools (if provided) — runs BEFORE onRendererInit so that
  //    games can access the ProfilingBridge + __sceneInspector API in onReady.
  if (opts.devtools) {
    const devtoolsMod = await importOrDead(devtoolsModuleP ?? import("@downdraft/engine/modules/devtools"), bootSession);
    if (!devtoolsMod) return;
    const { initDevTools } = devtoolsMod;
    const simStatsProvider = opts.devtools.createSimStatsProvider?.(renderer);
    const panels = typeof opts.devtools.panels === "function"
      ? opts.devtools.panels(renderer)
      : opts.devtools.panels ?? [];
    const workerHosts = typeof opts.devtools.workerHosts === "function"
      ? opts.devtools.workerHosts(renderer)
      : opts.devtools.workerHosts;
    const devtoolsBridge = await importOrDead(initDevTools(renderer, {
      simStatsProvider,
      panels,
      sceneInspector: opts.devtools.sceneInspector,
      bridgeClass: opts.devtools.bridgeClass,
      workerHosts,
      profiling: opts.devtools.profiling as any,
    }), bootSession);
    if (!devtoolsBridge) return;
    if (bootAborted()) {
      try { devtoolsBridge.destroy(); } catch {}
      return;
    }
    // The bridge exposes `window.__sceneInspector` on the PERSISTENT window —
    // its methods close over `renderer`, so without a destroy on session
    // teardown the old session's renderer (and through it the whole module
    // graph) stays rooted across hot-reload restarts.
    const hooksMod = await importOrDead(hooksP, bootSession);
    if (!hooksMod) return;
    hooksMod.dispose(() => { try { devtoolsBridge.destroy(); } catch {} });

    // 4a. Profiling wiring — `profiling: true` allocates the SAB + bridge,
    //     but without this nothing ticks the bridge or shares the SAB with
    //     workers, so the perf tab would only ever report the main thread.
    //     wireProfilingBridge guards against games that also call it
    //     manually; worker-side attach is idempotent.
    if (opts.devtools.profiling) {
      try {
        const mod = await importOrDead(devtoolsModuleP ?? import("@downdraft/engine/modules/devtools"), bootSession);
        if (!mod) return;
        const { wireProfilingBridge } = mod;
        const bridge =
          (globalThis as Record<string, any>).window?.__sceneInspector?.__getProfilingBridge?.()
          ?? (globalThis as Record<string, any>).__sceneInspector?.__getProfilingBridge?.()
          ?? null;
        if (bridge) {
          // workerHosts entries are {prefix, proxy} — the devtools proxy
          // exposes __profilingAttach via exposeDevToolsApi → wrap each into
          // the ProfilingWireHost surface wireProfilingBridge expects.
          const hosts: Array<{ host: { attachProfilingSAB(sab: SharedArrayBuffer, o?: any): Promise<void> }; workerTag?: string }> = [];
          (workerHosts ?? []).forEach((wh: any) => {
            const proxy = wh?.proxy;
            if (typeof proxy?.__profilingAttach !== "function") return;
            const prefix = wh?.prefix;
            hosts.push({
              host: {
                attachProfilingSAB: async (sab, o) => {
                  await proxy.__profilingAttach(sab, {
                    workerTag: o?.workerTag ?? prefix ?? "worker",
                    layout: o?.layout,
                  });
                },
              },
              workerTag: prefix,
            });
          });
          // The native services worker (save + SQLite) exposes the same
          // profiling RPC — claim a slot for it too.
          const services = (getNativeHost() as any)?.services;
          if (typeof services?.api?.__profilingAttach === "function") {
            hosts.push({
              host: {
                attachProfilingSAB: async (sab, o) => {
                  await services.api.__profilingAttach(sab, {
                    workerTag: "services",
                    layout: o?.layout,
                  });
                },
              },
              workerTag: "services",
            });
          }
          wireProfilingBridge({ renderer, bridge, workerHosts: hosts });
        }
      } catch (err) {
        log.warn("bootstrap-game", `profiling wiring failed: ${err}`);
      }
    }

    // 4b. Devtools UI frontend — the Blitz dock is the default surface.
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
          const mod = await importOrDead(devtoolsModuleP ?? import("@downdraft/engine/modules/devtools"), bootSession);
          if (!mod) return;
          const { createDevtoolsUiModule } = mod;
          renderer.useRendererModule(createDevtoolsUiModule({
            renderer,
            profilingSAB,
            dockFraction: uiCfg.dockFraction,
            autoShow: uiCfg.autoShow,
            toggleKey: uiCfg.toggleKey,
            onHost: (host) => {
              renderer.nativeDebugger = host;
              wireDevtoolsFrontend(host.devtoolsMirror, host, renderer, workerHosts, profilingSAB, opts.devtools?.inputInfo, bootSession);
            },
          }));
        } else {
          // "web" — loopback browser frontend (Bun-only transport).
          const libMod = await importOrDead(devtoolsLibP ?? import("@downdraft/engine/libraries/devtools"), bootSession);
          if (!libMod) return;
          const { WebDevtoolsHost } = libMod;
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
          wireDevtoolsFrontend(webHost.devtoolsMirror, webHost, renderer, workerHosts, profilingSAB, opts.devtools?.inputInfo, bootSession);
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
        log.error("bootstrap-game", `Devtools UI init failed: ${err}`);
      }
    }
  }

  // 4c. onRendererInit — library setup, sim start, game-specific wiring (onReady).
  //     DevTools is already wired, so games can access __sceneInspector +
  //     the ProfilingBridge from their onReady hook.
  if (opts.onRendererInit) {
    await importOrDead(Promise.resolve(opts.onRendererInit(renderer)), bootSession);
    if (bootAborted()) return;
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
  log.info("bootstrap-game", encodeFeatureLogLine(renderFeatureLog));

  // 7. FPS polling (if onFpsUpdate provided). unref so the interval can't
  //    pin the runtime after the window closes (packaged mode has no session
  //    tracker to clear it).
  if (opts.onFpsUpdate) {
    const fpsInterval = opts.fpsPollIntervalMs ?? 500;
    const id = setInterval(() => {
      if (typeof renderer.getFPS === "function") {
        opts.onFpsUpdate!(renderer.getFPS());
      }
    }, fpsInterval);
    (id as any)?.unref?.();
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
      // The inner race's timeout leg is session-tracked — teardown sweeps it
      // unresolved — so the whole race is additionally raced against session
      // teardown via importOrDead (returns null → bootAborted bails below).
      const saved = await importOrDead(Promise.race([
        autosaveOpts.load(),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]), bootSession);
      if (saved && autosaveOpts.onLoad) {
        await autosaveOpts.onLoad(saved);
      }
    } catch (e) {
      log.warn("bootstrap-game", `Autosave load failed: ${e}`);
    }
    // A restart landing during the load await must not leave this dead
    // generation's save interval registered into the NEXT live session.
    if (bootAborted()) return;

    let saveInProgress = false;
    const id = setInterval(async () => {
      if (saveInProgress) return;
      saveInProgress = true;
      try {
        await autosaveOpts.save();
      } catch (e) {
        log.warn("bootstrap-game", `Autosave save failed: ${e}`);
      } finally {
        saveInProgress = false;
      }
    }, intervalMs);
    (id as any)?.unref?.();
  }
  if (bootAborted()) return;

  // 10. MCP setup (if provided)
  if (opts.mcp) {
    await importOrDead(Promise.resolve(opts.mcp()), bootSession);
  }

  // 11. Hot-reload dispose (if provided)
  if (opts.onHotReloadDispose) {
    const hooksMod = await importOrDead(hooksP, bootSession);
    if (!hooksMod) return;
    hooksMod.dispose(opts.onHotReloadDispose);
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
  bootSession?: any,
): Promise<void> {
  const mod = await importOrDead(devtoolsLibP ?? import("@downdraft/engine/libraries/devtools"), bootSession);
  // If the dev session died while the import was in flight, abandon the
  // wiring — registering providers now would root the dead generation's
  // context through persistent host closures.
  if (!mod) return;
  const { registerEngineProviders } = mod;
  // Main-thread REPL evaluates directly in this context — Bun's inspector
  // doesn't implement Runtime.evaluate, and a direct eval works on every
  // runtime. Registered evals take precedence over the CDP fallback.
  host.registerThreadEval("main", async (expr) => {
    try {
      return { result: (0, eval)(expr) };
    } catch (e) {
      return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  });
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

