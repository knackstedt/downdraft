// ============================================================================
// AppModule — declarative app definition + startApp() entry point
//
// An `AppModule` is a declarative description of an app's renderer-side
// bootstrap: the renderer factory, sim worker factory, UI mount, event
// routing, save config, devtools, and app-specific hooks. `startApp()`
// consumes a module and orchestrates the full bootstrap sequence, collapsing
// the ~700-line per-app `main.tsx` into a ~100-line module declaration.
//
// Design goals:
//   - Declarative: apps declare *what* they need, not *how* to wire it.
//   - Progressive: every field is optional except `renderer` and `sim`.
//     Simple apps get a 10-line module; complex apps add hooks.
//   - Typed: the `AppContext` passed to hooks carries typed references
//     (renderer, simWorker, SABs, saveStore, bridge) — no module-scope `let`.
//   - Escape hatches: `onInit` / `onReady` / `onDispose` hooks let apps
//     run bespoke logic at well-defined points in the sequence.
//
// `startApp()` wraps `bootstrapApp()` — apps that need full control can
// still call `bootstrapApp()` directly.
// ============================================================================

import {
    ENGINE_VERSION,
    LibraryHostImpl,
    PluginHost,
    WorkerPluginLoader,
    isDevMode,
    type AppRendererLike,
    type ISaveStore,
    type LibraryEntry,
    type LibraryHost,
    type PluginHostOptions,
    type PluginManifest,
    type PluginPermission,
    type PluginSource,
    type RenderSurface,
    type SaveMeta,
    type SaveState
} from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { bootstrapApp, type BootstrapDevToolsOptions } from "./bootstrap";
import { downdraft, getSurface } from "./index";
import { createSaveStore, type SaveStoreMode } from "./save-store-factory";

const log = createLogger("info");

// ── Types ──

/**
 * The sim worker abstraction. Apps provide a factory that creates a sim
 * worker; `startApp()` calls `start()`, captures SABs, wires event routing,
 * and exposes the worker via `AppContext.sim`.
 *
 * This is intentionally minimal — apps implement this interface on top of
 * their own sim worker class (e.g. an app's `SimWebWorker`).
 *
 * Apps that have a richer sim worker interface can pass their concrete type
 * as the generic parameter `T` to `AppModule<T>` — `AppContext.sim` will
 * then be typed as `T` (no casting needed).
 */
export interface SimWorker {
  /** Start the sim worker. Config is opaque to the framework (app-specific).
   *  Not called for renderer-owned workers (see `module.simFromRenderer`). */
  start(config: unknown): Promise<void>;
  /**
   * `SimWorkerHost`-style event subscription — the callback receives
   * `{ kind, data }` messages and the return value is an unsubscribe
   * function. Preferred over `onEvent` when both exist.
   *
   * NOTE: `onEvent(cb)` is intentionally NOT declared on this interface —
   * `SimWorkerHost`/`BaseWorkerHost` subclasses carry a *protected*
   * `onEvent(kind, data)` dispatcher, and a class with a protected member
   * can't satisfy an interface that declares the same name. Event wiring
   * probes `subscribeEvents` first, then a public `onEvent` at runtime, so
   * plain SimWorker implementations (a simpler app's worker host)
   * still work.
   */
  subscribeEvents?(cb: (msg: { kind: string; data: unknown }) => void): () => void;
  getSimBuffer(): SharedArrayBuffer;
  getInputBuffer(): SharedArrayBuffer;
  /** Optional additional SABs the app wants exposed via AppContext. */
  getExtraBuffers?(): Record<string, SharedArrayBuffer>;
  addPlayer?(playerId: number, name: string): Promise<void> | void;
  save?(slotName: string, opts?: unknown): Promise<{ stateJson: string; success: boolean; meta?: Partial<SaveMeta> } | null>;
  load?(slotName: string, stateJson?: string): Promise<boolean>;
  initSaveStore?(opts: unknown): Promise<void>;
  restoreFromState?(stateJson: string): Promise<void>;
  hotReload?(config: unknown, preserveState: boolean): Promise<void>;
  getDevToolsProxy?(): unknown;
  /** Stop and terminate the worker. Entry points call this on window close —
   *  an unstopped worker's loop pins the runtime and the process never exits.
   *  Optional: bespoke workers without it leak-stop via `worker.unref()`. */
  stop?(): Promise<void> | void;
  /** Alias for stop() on some host implementations (BaseWorkerHost). */
  shutdown?(): Promise<void> | void;
}

/** Optional seed passed to the sim worker factory. */
export interface SimWorkerSeed {
  /** SABs allocated by EngineLibrary descriptors (keyed by channel name). */
  libraryBuffers?: Record<string, SharedArrayBuffer>;
}

/** Factory that creates a sim worker. Receives a seed with library-allocated
 *  SABs (if any libraries declared). Apps can pass these to their sim worker
 *  constructor to avoid double-allocating SABs. */
export type SimWorkerFactory<T extends SimWorker = SimWorker> = (seed?: SimWorkerSeed) => T;

/** Factory that creates the renderer from the render surface. The return
 *  type narrows `AppContext.renderer` — inferred from the factory. */
export type RendererFactory<R extends AppRendererLike = AppRendererLike> = (surface: RenderSurface) => R;

/**
 * Renderer-side save source — an alternative to the sim worker for providing
 * serializable app state. Renderer-only apps (no sim worker) declare a
 * `saveSource` in their `AppModule` so the autosave wiring can call it
 * instead of `sim.save()`.
 *
 * Sim-worker apps do NOT need this — the sim worker's optional `save()`
 * method is used directly. An app that declares both `sim` and `saveSource`
 * is a configuration error; `saveSource` takes priority.
 */
export interface SaveSource {
  /** Serialize current state and return it as a JSON string. `meta` carries
   *  real SaveMeta for the renderer-side store write when available. */
  save(slotName: string): Promise<{ stateJson: string; success: boolean; meta?: Partial<SaveMeta> } | null>;
  /** Optional: load a previously saved state. If omitted, the save store's
   *  own load path is used (directory store / host bridge). */
  load?(slotName: string): Promise<string | null>;
}

/**
 * Declarative event handler map. Each key is a sim→renderer message `kind`;
 * each value is a handler that receives the message data and the app context.
 *
 * This replaces the manual `switch (msg.kind)` block in main.tsx. Unknown
 * message kinds are logged as warnings in dev mode.
 */
export type SimEventMap<C extends AppContext = AppContext> = Record<string, (data: any, ctx: C) => void>;

/** Save configuration. If omitted, no autosave is wired. */
export interface SaveConfig {
  /** Save mode. Default: "host" when a native host save store is installed
   *  (disk, stable). "auto" resolves to the host store or the JSON bridge
   *  fallback — see createSaveStore for resolution. */
  mode?: SaveStoreMode;
  /** Engine version string for save slots. */
  engineVersion: string;
  /** Max save generations to keep. Default: 3. */
  maxGenerations?: number;
  /** Autosave interval in ms. Default: 3000. */
  intervalMs?: number;
  /** Slot name for autosave. Default: "autosave". */
  slotName?: string;
  /**
   * Name of the save-state component that carries the app's data blob
   * (the key under `SaveState.components`, e.g. "sandbox"). Declared
   * explicitly so `ctx.load` forwards the right component to the sim —
   * without it, load falls back to guessing "the first component whose
   * data is an object", which silently picks the wrong blob when a save
   * has multiple object-valued components.
   */
  componentName?: string;
}

/**
 * Serialize the restore payload for a SaveState components map.
 * `explicit` (SaveConfig.componentName) selects a single component's
 * `data`. Otherwise: a single-component save unwraps to its `data` (the raw
 * payload restores expect), while a multi-component save forwards the whole
 * map — the worker's extractRestoreData passes component-map input through
 * to the app's restore, which selects the sections it owns. Picking the
 * first component would silently drop the rest of the world.
 */
export function serializeRestorePayload(
  components: Record<string, { data?: unknown } | null | undefined>,
  explicit: string | undefined,
): string | undefined {
  if (explicit) {
    const comp = components[explicit];
    if (!comp) {
      log.warn("start-app", `Save component "${explicit}" not found; available: ${Object.keys(components).join(", ")}`);
      return undefined;
    }
    return JSON.stringify(comp.data);
  }
  const keys = Object.keys(components).filter(
    (k) => components[k]?.data !== undefined && components[k]?.data !== null,
  );
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return JSON.stringify(components[keys[0]]!.data);
  return JSON.stringify(components);
}

/**
 * A framework-managed UI handle. Returned by `AppModule.ui` — startApp()
 * calls `start()` after renderer init (before `onReady`) and `dispose()` on
 * hot-reload. Any { start, dispose } object is compatible (html-ui hosts,
 * DOM-UI mounts, custom overlays).
 */
export interface UiHandle {
  /** Start the UI (spawn workers, mount overlays). Called after renderer init. */
  start(): Promise<void> | void;
  /** Tear down. Called on hot-reload dispose, before `module.onDispose`. */
  dispose(): void;
}

/**
 * The context passed to all app hooks. Carries typed references to every
 * framework-managed resource — no module-scope `let` variables needed.
 *
 * The `Sim` type parameter lets apps specify their concrete sim worker type
 * so `ctx.sim` is typed correctly (no casting). For renderer-only apps (no
 * `sim` declared in the `AppModule`), `Sim` defaults to `SimWorker` and
 * `ctx.sim` is `undefined` — hooks should not access it.
 *
 * Sim fields (`sim`, `simSAB`, `inputSAB`) are optional because renderer-only
 * apps don't have a sim worker. Apps that declare `sim` can safely use
 * non-null assertions (`ctx.sim!`) in their hooks — `startApp()` guarantees
 * the sim worker is created when `module.sim` is declared.
 */
export interface AppContext<Sim extends SimWorker = SimWorker, R extends AppRendererLike = AppRendererLike> {
  /** The renderer instance. Typed as `R` — inferred from the module's
   *  `renderer` factory, so app-specific members resolve without casts
   *  when the factory returns the concrete renderer class. */
  renderer: R;
  /** The render surface the renderer is attached to (NativeSurface on the
   *  native runtime). */
  surface: RenderSurface;
  /** The sim worker instance. Undefined for renderer-only apps (no `sim` declared). */
  sim?: Sim;
  /** The sim SAB (entity/component data, zero-copy shared with the sim worker).
   *  Undefined for renderer-only apps. */
  simSAB?: SharedArrayBuffer;
  /** The input SAB (renderer writes, sim worker reads).
   *  Undefined for renderer-only apps. */
  inputSAB?: SharedArrayBuffer;
  /** Extra SABs from `sim.getExtraBuffers()` (e.g. water, custom-app-data).
   *  For renderer-only apps, this contains only library-allocated SABs (if any). */
  extraBuffers: Record<string, SharedArrayBuffer>;
  /** The save store, if save config was provided and init succeeded. May be null. */
  saveStore: ISaveStore | null;
  /** The save mode that was actually selected (host store, or worker-owned). */
  saveMode: "host" | "worker";
  /**
   * Persists the current state via the resolved save backend (host store disk
   * on native, or the sim worker's own store in "worker" mode). Apps should
   * call this for manual saves instead of `sim.save()` directly — `sim.save()`
   * only serializes stateJson; nothing forwards it to disk in host mode.
   * Returns true if the save succeeded. Undefined when no save config was declared.
   */
  save?: (slotName: string) => Promise<boolean>;
  /**
   * Mode-aware load: restores state from the selected backend. Apps should
   * call this for manual loads instead of `sim.load()` directly.
   * Returns the loaded state (shape depends on the save source), or null if
   * no save exists. Undefined when no save config was declared.
   */
  load?: (slotName: string) => Promise<unknown | null>;
  /** The renderer-side save source, if `module.saveSource` was declared.
   *  Used by the autosave wiring for renderer-only apps. Undefined for
   *  sim-worker apps (which use `sim.save()` instead). */
  saveSource?: SaveSource;
  /** The typed downdraft bridge (globalThis.downdraft). */
  bridge: typeof downdraft;
  /** True if running in deterministic/test mode (DOWNDRAFT_DETERMINISTIC=1). */
  deterministic: boolean;
  /** True if running in dev mode (Vite dev or downdraft.isDev). */
  isDev: boolean;
  /** The library host (if engine libraries were declared). Apps can access
   *  library-provided resources via DI tokens from onReady. */
  libraryHost?: LibraryHost;
  /** The plugin host (if `module.plugins` was declared). Apps can access
   *  plugin diagnostics via `pluginHost.snapshot()` and trigger reloads. */
  pluginHost?: PluginHost;
  /** The UI handle created by `module.ui`. Set after renderer init, before
   *  `onReady` runs — hooks can `ctx.ui` to post events or wire
   *  subscriptions. */
  ui?: UiHandle;
}

/**
 * Plugin runtime configuration. Apps opt into the user-authored plugin
 * (modding) system by declaring a `plugins` field on their `AppModule`.
 *
 * The host constructs a renderer-side `PluginHost` and (for sim-thread
 * plugins) forwards manifests to the sim worker. Apps choose per-format
 * whether worker-js plugins run on the sim worker or in a dedicated plugin
 * worker; WASM is always forced to its own worker; QuickJS runs in-process on
 * the renderer; asset plugins are data-only.
 */
export interface PluginRuntimeConfig {
  /** Default thread for worker-js plugins: "sim" (inside the app's sim
   *  worker) or "own-worker" (dedicated sandboxed worker). Default: "own-worker". */
  workerJs?: "sim" | "own-worker";
  /** Discovery sources. Local plugin dirs + remote workshop stores. */
  sources?: PluginSource[];
  /** App-defined permission allowlist (further restricts tier). */
  permissions?: ReadonlySet<PluginPermission>;
  /** App-defined event catalog for the plugin event bus. */
  eventCatalog?: Record<string, unknown>;
  /** Pre-resolved manifests to load (in addition to discovered sources).
   *  Useful for tests and for bundling first-party plugins. */
  manifests?: PluginManifest[];
}

/**
 * A declarative app definition.
 *
 * Apps create a `AppModule` and pass it to `startApp()`. The module
 * describes the renderer, sim worker (optional), UI, event routing, save
 * config, devtools, and app-specific hooks. `startApp()` orchestrates the
 * full bootstrap sequence.
 *
 * The `Sim` generic parameter lets apps specify their concrete sim worker
 * type so `AppContext.sim` is typed correctly (no casting). For renderer-only
 * apps, omit `sim` and `simConfig` — `Sim` defaults to `SimWorker` and
 * the sim-related hooks (`events`, `onSimStart`) are ignored.
 *
 * Two topologies:
 *   - **Sim-worker**: declare `sim` + `simConfig`. `startApp()` spawns the
 *     worker, captures SABs, wires event routing, and starts the sim.
 *   - **Renderer-only**: omit `sim` + `simConfig`. All logic runs on the
 *     renderer thread. Declare `saveSource` if you need autosave. Use
 *     engine libraries (e.g. `WeatherFxLib`, `ModelsLib`) for GPU-side work.
 */
export interface AppModule<Sim extends SimWorker = SimWorker, R extends AppRendererLike = AppRendererLike> {
  // ── Required: renderer ──
  /** Factory that creates the renderer from a canvas. */
  renderer: RendererFactory<R>;

  // ── Optional: sim worker (omit for renderer-only apps) ──
  /** Factory that creates the sim worker. Omit for renderer-only apps. */
  sim?: SimWorkerFactory<Sim>;
  /** Config passed to `sim.start()`. Required when `sim` is declared. */
  simConfig?: Record<string, unknown>;
  /**
   * Renderer-owned sim worker. For apps where the renderer spawns and starts
   * its own worker internally during `renderer.init()` (an app may spawn
   * the renderer creates its own worker host). Declare this INSTEAD of `sim` — it
   * is called after renderer init to retrieve the worker, which is then
   * exposed as `ctx.sim` and wired into `module.events` routing like a
   * factory-created worker. This removes the need for no-op SimWorker
   * adapter classes.
   *
   * The returned object must satisfy SimWorker (start + getSimBuffer +
   * getInputBuffer, plus onEvent or subscribeEvents for event routing).
   * `SimWorkerHost` subclasses satisfy this directly via `subscribeEvents`:
   *   `simFromRenderer: (r) => r.getWorkerHost() ?? undefined`
   */
  simFromRenderer?: (renderer: R, ctx: AppContext<Sim, R>) => Sim | undefined | Promise<Sim | undefined>;

  // ── UI ──
  /**
   * Declarative UI lifecycle. Called once with the app context; the returned
   * handle is started after renderer init (before `onReady`) and disposed on
   * hot-reload (before `onDispose`). The handle is exposed as `ctx.ui`.
   */
  ui?: (ctx: AppContext<Sim, R>) => UiHandle | Promise<UiHandle>;

  // ── Event routing (sim-worker apps only) ──
  /** Declarative sim→renderer event handler map. Replaces the switch block.
   *  Ignored for renderer-only apps (no sim worker to emit events). */
  events?: SimEventMap<AppContext<Sim, R>>;
  /** Sim event kinds consumed outside the declarative `events` map (e.g. a
   *  session layer subscribing via worker.onSimEvent directly). Listed kinds
   *  skip the dev "Unhandled sim event kind" warning. */
  silentEvents?: readonly string[];

  // ── Save ──
  /** Save configuration. If omitted, no autosave is wired. */
  save?: SaveConfig;
  /** Renderer-side save source for renderer-only apps. When declared, the
   *  autosave wiring calls `saveSource.save()` instead of `sim.save()`.
   *  Ignored for sim-worker apps (the sim worker's `save()` is used). */
  saveSource?: SaveSource;

  // ── Engine libraries ──
  /**
   * Engine libraries to auto-wire (water, physics, terrain, etc.).
   * Each entry is either a bare `EngineLibrary` (uses default config) or
   * a `[library, config]` tuple to override config.
   *
   * The host allocates SABs, instantiates sim-side systems + renderer-side
   * passes, and registers provided resources in the DI graph.
   *
   * Apps can still import and wire library classes manually (escape hatch)
   * if they need more control than the descriptor provides.
   */
  libraries?: LibraryEntry[];

  // ── User-authored plugins (modding) ──
  /**
   * Plugin runtime configuration. When declared, `startApp()` constructs a
   * renderer-side `PluginHost`, discovers plugins from the configured sources,
   * and loads them after renderer init. Sim-thread plugins are forwarded to
   * the sim worker. See `PluginRuntimeConfig`.
   */
  plugins?: PluginRuntimeConfig;

  // ── DevTools ──
  /** DevTools config. If omitted, DevTools is not wired. */
  devtools?: BootstrapDevToolsOptions;

  // ── MCP ──
  /** Called to register MCP tools (after renderer is started). Receives ctx. */
  mcp?: (ctx: AppContext<Sim, R>) => void | Promise<void>;

  // ── Hooks ──
  /**
   * Called after renderer creation, before init. Use to wire sim-ready
   * listeners, capture early state, etc. The renderer exists but is not
   * initialized yet.
   */
  onBeforeInit?: (ctx: AppContext<Sim, R>) => Promise<void> | void;
  /**
   * Called to initialize the renderer. Should return false on failure.
   * Default: calls `renderer.init()`. The sim worker is started in parallel
   * (see `onSimStart`). Override to add LUT waits, player spawn, etc.
   */
  onInit?: (ctx: AppContext<Sim, R>) => Promise<boolean> | boolean;
  /**
   * Called to start the sim worker (only when `sim` is declared and `onInit`
   * is NOT overridden). Default: calls `sim.start(simConfig)`. Override to
   * add player spawn after sim is ready. Ignored for renderer-only apps.
   *
   * When `onInit` IS overridden, the app's `onInit` owns sim start — this
   * hook is not called. This lets apps start the sim in parallel with
   * `renderer.init()` (an app may do `Promise.all([renderer.init(),
   * sim.start(config)])` in its `onInit`).
   */
  onSimStart?: (ctx: AppContext<Sim, R>) => Promise<void> | void;
  /**
   * Called after renderer init + sim start succeed, before render loop.
   * This is the main app-specific wiring hook: setBuffers, OSR, sim bridge,
   * DevTools, gizmo handlers, HUD polling, debug toggles, hot-reload.
   */
  onReady?: (ctx: AppContext<Sim, R>) => Promise<void> | void;
  /** Called on Vite hot-reload dispose to clean up resources. */
  onDispose?: (ctx: AppContext<Sim, R>) => Promise<void> | void;
  /** Called in deterministic mode to apply overrides (e.g. pause render loop). */
  onDeterministic?: (ctx: AppContext<Sim, R>) => void;
  /** Called periodically with the current render FPS. */
  onFpsUpdate?: (fps: number, ctx: AppContext<Sim, R>) => void;
  /** Called with the display refresh rate when available. */
  onDisplayInfo?: (refreshRate: number, ctx: AppContext<Sim, R>) => void;

  // ── Surface ──
  /** Surface layer index. Default: 0 — the only layer on native hosts. */
  canvasLayer?: number;
  /** FPS polling interval in ms. Default: 500. */
  fpsPollIntervalMs?: number;

  // ── Feature log ──
  /** Optional getter for active plugin names (populates the `plug` field of the
   *  renderer feature log line). e.g. () => appWorld.moduleHost.listModules() */
  getActiveModules?: () => string[];
}

// ── startApp() ──

/**
 * Start an app from a declarative `AppModule`.
 *
 * This is the high-level entry point. It wraps `bootstrapApp()` and adds:
 *   - Engine library auto-wiring (SAB allocation, sim systems, renderer passes)
 *   - Sim worker spawn + SAB capture (skipped for renderer-only apps)
 *   - Declarative event routing (the `events` map — sim-worker apps only)
 *   - Save store initialization (sim-worker or renderer-side save source)
 *   - Typed `AppContext` passed to all hooks
 *
 * Two topologies are supported:
 *   - **Sim-worker**: `module.sim` is declared → worker spawned, SABs captured,
 *     events routed, sim started after renderer init.
 *   - **Renderer-only**: `module.sim` is omitted → no worker, no SABs, no
 *     event routing. All logic runs on the renderer thread. Declare
 *     `module.saveSource` for autosave support.
 *
 * Apps that need full control can call `bootstrapApp()` directly.
 */
export async function startApp<Sim extends SimWorker, R extends AppRendererLike = AppRendererLike>(module: AppModule<Sim, R>): Promise<void> {
  const deterministic = !!(downdraft as any)?.deterministic;
  const isDev = !!(downdraft?.isDev) || isDevMode;
  const hasSim = !!module.sim;

  // Dev-session guard: capture the session snapshot this boot belongs to.
  // If an HMR restart lands while a boot-stage await below is suspended, the
  // continuation belongs to a dead generation — and the tracker by then may
  // already host the NEXT session, which would happily track this dead gen's
  // listeners/timers (pinning its whole module graph for a generation). Bail
  // instead. No tracker → production mode → never aborts.
  const ddTracker = (globalThis as any).__ddSession;
  const bootSession = ddTracker?.session ?? null;
  const sessionAborted = () =>
    (!!ddTracker && (ddTracker.session !== bootSession || !bootSession || bootSession.dead))
    || typeof (globalThis as any).window === "undefined";

  // 0. Resolve the render surface (NativeSurface on the native runtime)
  const surface = getSurface(module.canvasLayer ?? 0);

  // 0b. Allocate library SABs (if any libraries declared) — before sim worker
  //     creation so the sim factory can receive externally-allocated SABs.
  let libHost: LibraryHost | null = null;
  let libBuffers: Record<string, SharedArrayBuffer> = {};
  if (module.libraries && module.libraries.length > 0) {
    libHost = new LibraryHostImpl(module.libraries);
    libBuffers = libHost.allocateBuffers();
  }

  // 0c. Construct the renderer-side plugin host (if plugins declared).
  //     Sim-thread plugins are forwarded to the sim worker after it starts;
  //     renderer/own-worker plugins load here. The host is exposed on ctx so
  //     apps + the doctor panel can query snapshots.
  let pluginHost: PluginHost | null = null;
  if (module.plugins) {
    const pCfg = module.plugins;
    const hostOpts: PluginHostOptions = {
      appId: (downdraft as any)?.appId ?? "unknown",
      engineVersion: ENGINE_VERSION,
      appAllow: pCfg.permissions,
      eventCatalog: pCfg.eventCatalog,
      sources: pCfg.sources,
    };
    pluginHost = new PluginHost(hostOpts);
    // Register the worker-js loader (handles own-worker plugins on renderer).
    pluginHost.registerLoader(new WorkerPluginLoader());
    // Pre-resolved manifests (tests / first-party plugins).
    for (let _i23990 = 0, _it23990 = (pCfg.manifests ?? []), _n23990 = _it23990.length; _i23990 < _n23990; _i23990++) { const m = _it23990[_i23990];
      pluginHost.discover(m, "inline");
    };
    // Manifests are discovered via the plugin host's discover() API. Here we
    // only load what's been discovered so far.
  }

  // 1. Create sim worker + capture SABs (renderer-only apps skip this).
  //    If libraries declared, pass the library-allocated SABs to the sim
  //    factory via a seed object so the sim can share them zero-copy.
  const simSeed = Object.keys(libBuffers).length > 0 ? { libraryBuffers: libBuffers } : undefined;
  const simWorker = hasSim ? module.sim!(simSeed) : null;
  const simSAB = simWorker?.getSimBuffer();
  const inputSAB = simWorker?.getInputBuffer();
  const extraBuffers = simWorker?.getExtraBuffers?.() ?? {};

  // 2. Create renderer
  const renderer = module.renderer(surface);

  // 3. Build the app context. Sim fields are undefined for renderer-only apps.
  const ctx: AppContext<Sim, R> = {
    renderer,
    surface,
    sim: simWorker as Sim | undefined,
    simSAB,
    inputSAB,
    extraBuffers,
    saveStore: null,
    saveMode: "host",
    saveSource: module.saveSource,
    bridge: downdraft,
    deterministic,
    isDev,
  };

  // 3b. Merge library SABs into extraBuffers + store host on ctx
  if (libHost) {
    for (const [name, sab] of Object.entries(libBuffers)) {
      if (name in ctx.extraBuffers) {
        log.warn("start-app", `library SAB channel "${name}" shadows a same-named sim extra buffer in ctx.extraBuffers`);
      }
      ctx.extraBuffers[name] = sab;
    }
    ctx.libraryHost = libHost;
  }

  // 3c. Expose the plugin host on ctx (if constructed).
  if (pluginHost) {
    ctx.pluginHost = pluginHost;
  }

  // Event kinds emitted by the engine itself (sim-worker-base lifecycle)
  // that apps are not required to handle — suppress the dev warning for
  // these so autosave doesn't spam the console when no handler is wired.
  const ENGINE_EMITTED_EVENT_KINDS = new Set(["ready", "saved", "loaded", "error", ...(module.silentEvents ?? [])]);

  // 4. Wire event routing from the declarative events map (sim-worker only).
  //    Supports both SimWorker.onEvent(cb) and SimWorkerHost's
  //    subscribeEvents(cb) (renderer-owned worker hosts).
  const wireSimEvents = (worker: Sim) => {
    if (!module.events || !worker) return;
    const events = module.events;
    // Prefer subscribeEvents when present: SimWorkerHost subclasses expose it
    // as the public registration API, while their protected onEvent(kind,data)
    // is the internal dispatcher (and would be incorrectly bound if we probed
    // onEvent first — it exists on the prototype at runtime).
    const onEvent: ((cb: (msg: any) => void) => void) | undefined =
      (worker as any).subscribeEvents
        ? (cb: (msg: any) => void) => { (worker as any).subscribeEvents(cb); }
        : (worker as any).onEvent?.bind(worker);
    if (!onEvent) return;
    onEvent((msg) => {
      const handler = events[msg.kind];
      if (handler) {
        try {
          handler(msg.data, ctx);
        } catch (err) {
          log.error("start-app", `Event handler error for "${msg.kind}": ${err}`);
        }
      } else if (isDev && !ENGINE_EMITTED_EVENT_KINDS.has(msg.kind)) {
        log.warn("start-app", `Unhandled sim event kind: "${msg.kind}"`);
      }
    });
  };
  if (simWorker) wireSimEvents(simWorker);

  // 5. Run onBeforeInit hook
  if (module.onBeforeInit) {
    await module.onBeforeInit(ctx);
    if (sessionAborted()) return;
  }

  // 6. Initialize save store (if configured) — runs before bootstrapApp so
  //    onReady can use it.
  if (module.save && !deterministic) {
    try {
      // Default to "host" (disk via the host's typed save store) — on native
      // this is HostSaveStore over HostServices → FileSaveStore. A sim worker
      // that wants worker-owned persistence constructs a DirectorySaveStore
      // itself; the main-thread store is always the host store.
      const saveMode = module.save.mode ?? (downdraft.saveStore ? "host" : "auto");
      const { store, mode: resolvedMode } = await createSaveStore({
        mode: saveMode,
        bridge: downdraft,
      });
      ctx.saveStore = store;
      ctx.saveMode = resolvedMode;
    } catch (e) {
      log.warn("start-app", `Save store init failed, falling back to host bridge: ${e}`);
      ctx.saveMode = "host";
    }
    if (sessionAborted()) return;
  }

  // 6b. Save/load helpers — exposed on ctx so apps can trigger manual
  //     saves/loads through the resolved backend. This is the same logic the
  //     autosave interval uses below. Apps MUST use ctx.save / ctx.load
  //     instead of sim.save / sim.load directly: sim.save only serializes
  //     stateJson and silently drops the save unless the sim worker owns its
  //     own store (DirectorySaveStore via initSaveStore).
  if (module.save && !deterministic) {
    ctx.save = async (slotName: string): Promise<boolean> => {
      try {
        // Renderer-side save source takes priority (renderer-only apps);
        // otherwise fall back to the sim worker's save() (sim-worker apps).
        // ctx.sim covers simFromRenderer apps, resolved after renderer init.
        const sim = ctx.sim ?? simWorker;
        const result = ctx.saveSource
          ? await ctx.saveSource.save(slotName)
          : sim?.save
            ? await sim.save(slotName)
            : null;
        // The sim worker's save() only serialized — the main thread owns
        // the store write. (A worker-owned DirectorySaveStore persists inside
        // save() itself and returns stateJson: null.)
        if (result?.stateJson && ctx.saveStore) {
          const components = JSON.parse(result.stateJson);
          const state: SaveState = {
            components,
            meta: {
              engineVersion: module.save?.engineVersion ?? "",
              timestamp: Date.now() / 1000,
              entityCount: 0,
              playerCount: 0,
              // Real SaveMeta from the worker's save.meta() hook wins.
              ...result.meta,
            },
          };
          const sr = await ctx.saveStore.save(slotName, state);
          return result.success !== false && sr.success;
        }
        return result?.success ?? false;
      } catch (e) {
        log.error("start-app", `Manual save failed: ${e}`);
        return false;
      }
    };

    ctx.load = async (slotName: string): Promise<unknown | null> => {
      try {
        // Renderer-side save source load (renderer-only apps)
        if (ctx.saveSource?.load) {
          const stateJson = await ctx.saveSource.load(slotName);
          return stateJson ? JSON.parse(stateJson) : null;
        }
        // ctx.sim covers simFromRenderer apps (resolved post renderer-init).
        const sim = ctx.sim ?? simWorker;
        // Worker-owned store: the sim worker's load() restores state
        // internally; a truthy return is enough for onLoad hooks to fire.
        if (ctx.saveMode === "worker" && sim?.load) {
          const success = await sim.load(slotName);
          return success ? { restored: true } : null;
        }
        if (ctx.saveStore) {
          const result = await ctx.saveStore.load(slotName);
          const state = result?.state ?? null;
          if (state && sim?.restoreFromState) {
            // The save store returns a SaveState with `components`. Each
            // component has { v, data } structure — forward the restore
            // payload to the sim worker.
            const components = (state as any).components;
            if (components) {
              const payload = serializeRestorePayload(components, module.save?.componentName);
              if (payload !== undefined) {
                await sim.restoreFromState(payload);
              }
            }
          }
          return state;
        }
        if (downdraft?.loadAppState) {
          const stateJson = await downdraft.loadAppState(slotName);
          if (!stateJson) return null;
          // The host bridge returns JSON.stringify(result.state.components),
          // so the parsed result is the components map directly (not a
          // SaveState). Find the app component (e.g. "sandbox") and
          // forward its `data` to the sim worker.
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(stateJson);
          } catch {
            // Non-JSON payload — fall through to raw restore.
          }
          if (sim?.restoreFromState) {
            const components = parsed as Record<string, { data?: unknown }> | null;
            const payload = components && typeof components === "object"
              ? serializeRestorePayload(components, module.save?.componentName)
              : undefined;
            if (payload !== undefined) {
              await sim.restoreFromState(payload);
            } else {
              // No recognizable components map — forward the raw payload.
              await sim.restoreFromState(stateJson);
            }
          }
          // Return the parsed payload (or the raw string when it isn't JSON)
          // — the previous version re-parsed unconditionally here, so a
          // successful raw restore still reported failure.
          return parsed ?? stateJson;
        }
        return null;
      } catch (e) {
        log.error("start-app", `Manual load failed: ${e}`);
        return null;
      }
    };
  }

  // 6c. Kick the default sim start early — `simWorker.start()` spawns the
  //     worker + sends init config and doesn't touch renderer state, so it
  //     can overlap renderer.init() instead of serializing behind it inside
  //     onRendererInit. `onInit` overrides own sim start entirely (e.g.
  //     an app's Promise.all); `onSimStart` overrides stay deferred
  //     since they may depend on post-init ctx state; renderer-owned workers
  //     (simFromRenderer) are untouched.
  let simStartPromise: Promise<void> | null = null;
  if (simWorker && !module.onInit && !module.onSimStart) {
    simStartPromise = Promise.resolve(simWorker.start(module.simConfig ?? {}));
    // Mark handled now — the real await (which re-throws on failure) happens
    // at the original join point inside onRendererInit.
    simStartPromise.catch(() => {});
  }

  // 7. Delegate to bootstrapApp() for the standard sequence
  await bootstrapApp({
    canvasLayer: module.canvasLayer,
    fpsPollIntervalMs: module.fpsPollIntervalMs,
    getActiveModules: module.getActiveModules,

    createRenderer: () => renderer,

    initRenderer: module.onInit
      ? () => module.onInit!(ctx)
      : (r) => r.init(),

    onRendererInit: async (r) => {
      // ── Library renderer setup ──
      // Early renderer-only library setup (hosts, workers — no GPU needed).
      // Runs before the GPU device is available so libraries can construct
      // their host + provide DI tokens.
      if (libHost && r) {
        const device = r.getDevice?.();
        const format = r.getFormat?.();
        const moduleHost = r.getRendererModuleHost?.();
        if (!moduleHost) {
          log.warn("start-app", "renderer does not expose getRendererModuleHost() — EngineLibrary DI provides will be silently dropped");
        }
        const libProvide = (token: any, value: unknown) => {
          if (moduleHost) moduleHost.provideExternal("library", token, value);
        };
        const libInject = (token: any) => {
          if (moduleHost) return moduleHost.injectResource(token);
          throw new Error(`Library inject("${token.key}") failed — no renderer plugin host available`);
        };
        const libInjectOptional = (token: any) => {
          if (moduleHost) return moduleHost.injectResourceOptional(token);
          return undefined;
        };
        libHost.createRenderer({ provide: libProvide, inject: libInject, injectOptional: libInjectOptional });
        // GPU-pass library init (after device is ready).
        if (device && format) {
          libHost.initRenderer({ device, format, provide: libProvide, inject: libInject, injectOptional: libInjectOptional });
          libHost.setRendererBuffers(libBuffers, { provide: libProvide });
        }
      }

      // ── Renderer-owned sim resolution ──
      // Apps whose renderer spawns/starts the sim worker internally (declared
      // via `module.simFromRenderer` instead of `module.sim`) get the worker
      // resolved here — after renderer.init() has created it. ctx.sim is
      // populated and declarative `events` routing is wired, matching the
      // factory-created path. startApp() never calls start() on it — the
      // renderer owns the lifecycle.
      if (module.simFromRenderer) {
        try {
          const owned = await module.simFromRenderer(r, ctx);
          if (owned) {
            ctx.sim = owned;
            ctx.simSAB = owned.getSimBuffer();
            ctx.inputSAB = owned.getInputBuffer();
            const extra = owned.getExtraBuffers?.() ?? {};
            for (const [name, sab] of Object.entries(extra)) {
              ctx.extraBuffers[name] = sab;
            }
            wireSimEvents(owned);
          }
        } catch (e) {
          log.warn("start-app", `simFromRenderer resolution failed: ${e}`);
        }
        if (sessionAborted()) return;
      }

      // ── Sim worker start ──
      // When `onInit` is NOT overridden, startApp owns sim start — it runs
      // here, after renderer.init() has succeeded. When `onInit` IS overridden,
      // the app's onInit owns sim start (an app may start the sim in
      // parallel with renderer.init() inside its onInit). Renderer-only apps
      // have no sim worker to start.
      if (simWorker && !module.onInit) {
        if (module.onSimStart) {
          await module.onSimStart(ctx);
        } else if (simStartPromise) {
          await simStartPromise;
        } else {
          await simWorker.start(module.simConfig ?? {});
        }
        if (sessionAborted()) return;
      }

      // ── Plugin loading ──
      // Load all discovered plugins (renderer + own-worker threads). Sim-
      // thread plugins are forwarded to the sim worker by the app's sim
      // bridge (the sim worker runs its own PluginHost); here we load the
      // renderer/own-worker subset. Failures are recorded on the plugin
      // snapshot (ctx.pluginHost.snapshot()) and do not abort startup.
      if (pluginHost) {
        try {
          // Wire the renderer's ModuleHost now that it exists — required for
          // native-tier plugins (their context bridges into the typed-DI
          // graph). Without it a native-tier mod fails with "no ModuleHost
          // configured on this thread".
          const mh = r?.getRendererModuleHost?.();
          if (mh) pluginHost.setModuleHost(mh);
          await pluginHost.loadAll();
        } catch (e) {
          log.warn("start-app", `Plugin loading error: ${e}`);
        }
        if (sessionAborted()) return;
      }

      // ── Declarative UI lifecycle ──
      // Create + start the UI handle before onReady so
      // hooks can wire subscriptions against ctx.ui.
      if (module.ui) {
        try {
          ctx.ui = await module.ui(ctx);
          await ctx.ui.start();
        } catch (e) {
          // UI failure is non-fatal — the app canvas still runs.
          log.error("start-app", `UI start failed: ${e}`);
          ctx.ui = undefined;
        }
        if (sessionAborted()) return;
      }

      // ── App-specific wiring ──
      if (module.onReady) {
        await module.onReady(ctx);
      }
    },

    devtools: module.devtools,

    autosave: module.save && !deterministic
      ? {
          // Reuse the mode-aware ctx.save / ctx.load helpers so the autosave
          // interval and manual saves share one code path.
          load: async () => {
            const slotName = module.save!.slotName ?? "autosave";
            return ctx.load!(slotName);
          },
          save: async () => {
            const slotName = module.save!.slotName ?? "autosave";
            await ctx.save!(slotName);
          },
          intervalMs: module.save?.intervalMs,
        }
      : undefined,

    mcp: module.mcp ? () => module.mcp!(ctx) : undefined,

    onDisplayInfo: module.onDisplayInfo
      ? (rate) => module.onDisplayInfo!(rate, ctx)
      : undefined,

    onHotReloadDispose: () => {
      ctx.ui?.dispose();
      ctx.ui = undefined;
      pluginHost?.disposeAll();
      libHost?.disposeRenderer();
      if (module.onDispose) {
        module.onDispose(ctx);
      }
    },

    onDeterministic: module.onDeterministic
      ? () => module.onDeterministic!(ctx)
      : undefined,

    onFpsUpdate: module.onFpsUpdate
      ? (fps) => module.onFpsUpdate!(fps, ctx)
      : undefined,
  });
}
