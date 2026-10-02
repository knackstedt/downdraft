// ============================================================================
// GameModule — declarative game definition + startGame() entry point
//
// A `GameModule` is a declarative description of a game's renderer-side
// bootstrap: the renderer factory, sim worker factory, UI mount, event
// routing, save config, devtools, and game-specific hooks. `startGame()`
// consumes a module and orchestrates the full bootstrap sequence, collapsing
// the ~700-line per-game `main.tsx` into a ~100-line module declaration.
//
// Design goals:
//   - Declarative: games declare *what* they need, not *how* to wire it.
//   - Progressive: every field is optional except `renderer` and `sim`.
//     Simple games get a 10-line module; complex games add hooks.
//   - Typed: the `GameContext` passed to hooks carries typed references
//     (renderer, simWorker, SABs, saveStore, bridge) — no module-scope `let`.
//   - Escape hatches: `onInit` / `onReady` / `onDispose` hooks let games
//     run bespoke logic at well-defined points in the sequence.
//
// `startGame()` wraps `bootstrapGame()` — games that need full control can
// still call `bootstrapGame()` directly.
// ============================================================================

import {
    ENGINE_VERSION,
    LibraryHostImpl,
    PluginHost,
    WorkerPluginLoader,
    isDevMode,
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
import { bootstrapGame, type BootstrapDevToolsOptions } from "./bootstrap";
import { downdraft, getSurface } from "./index";
import { createSaveStore, isOpfsAvailable, type SaveStoreMode } from "./save-store-factory";

const log = createLogger("info");

// ── Types ──

/**
 * The sim worker abstraction. Games provide a factory that creates a sim
 * worker; `startGame()` calls `start()`, captures SABs, wires event routing,
 * and exposes the worker via `GameContext.sim`.
 *
 * This is intentionally minimal — games implement this interface on top of
 * their own sim worker class (e.g. a game's `SimWebWorker`).
 *
 * Games that have a richer sim worker interface can pass their concrete type
 * as the generic parameter `T` to `GameModule<T>` — `GameContext.sim` will
 * then be typed as `T` (no casting needed).
 */
export interface GameSimWorker {
  /** Start the sim worker. Config is opaque to the framework (game-specific).
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
   * plain GameSimWorker implementations (e.g. falling-sand's worker host)
   * still work.
   */
  subscribeEvents?(cb: (msg: { kind: string; data: unknown }) => void): () => void;
  getSimBuffer(): SharedArrayBuffer;
  getInputBuffer(): SharedArrayBuffer;
  /** Optional additional SABs the game wants exposed via GameContext. */
  getExtraBuffers?(): Record<string, SharedArrayBuffer>;
  addPlayer?(playerId: number, name: string): Promise<void> | void;
  save?(slotName: string, opts?: unknown): Promise<{ stateJson: string; success: boolean; meta?: Partial<SaveMeta> } | null>;
  load?(slotName: string, stateJson?: string): Promise<boolean>;
  initSaveStore?(opts: unknown): Promise<void>;
  restoreFromState?(stateJson: string): Promise<void>;
  hotReload?(config: unknown, preserveState: boolean): Promise<void>;
  getDevToolsProxy?(): unknown;
}

/** Optional seed passed to the sim worker factory. */
export interface SimWorkerSeed {
  /** SABs allocated by EngineLibrary descriptors (keyed by channel name). */
  libraryBuffers?: Record<string, SharedArrayBuffer>;
}

/** Factory that creates a sim worker. Receives a seed with library-allocated
 *  SABs (if any libraries declared). Games can pass these to their sim worker
 *  constructor to avoid double-allocating SABs. */
export type SimWorkerFactory<T extends GameSimWorker = GameSimWorker> = (seed?: SimWorkerSeed) => T;

/** Factory that creates the renderer from the render surface. */
export type RendererFactory = (surface: RenderSurface) => any;

/**
 * Renderer-side save source — an alternative to the sim worker for providing
 * serializable game state. Renderer-only games (no sim worker) declare a
 * `saveSource` in their `GameModule` so the autosave wiring can call it
 * instead of `sim.save()`.
 *
 * Sim-worker games do NOT need this — the sim worker's optional `save()`
 * method is used directly. A game that declares both `sim` and `saveSource`
 * is a configuration error; `saveSource` takes priority.
 */
export interface GameSaveSource {
  /** Serialize current state and return it as a JSON string. `meta` carries
   *  real SaveMeta for the renderer-side store write when available. */
  save(slotName: string): Promise<{ stateJson: string; success: boolean; meta?: Partial<SaveMeta> } | null>;
  /** Optional: load a previously saved state. If omitted, the save store's
   *  own load path is used (OPFS / host bridge). */
  load?(slotName: string): Promise<string | null>;
}

/**
 * Declarative event handler map. Each key is a sim→renderer message `kind`;
 * each value is a handler that receives the message data and the game context.
 *
 * This replaces the manual `switch (msg.kind)` block in main.tsx. Unknown
 * message kinds are logged as warnings in dev mode.
 */
export type SimEventMap<C extends GameContext = GameContext> = Record<string, (data: any, ctx: C) => void>;

/** Save configuration. If omitted, no autosave is wired. */
export interface GameSaveConfig {
  /** Save mode. Default: "host" when a native host save store is installed
   *  (disk, stable), "auto" in browser. Games should pin an explicit mode
   *  rather than relying on "auto" — see createSaveStore for resolution. */
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
   * Name of the save-state component that carries the game's data blob
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
 * `explicit` (GameSaveConfig.componentName) selects a single component's
 * `data`. Otherwise: a single-component save unwraps to its `data` (the raw
 * payload restores expect), while a multi-component save forwards the whole
 * map — the worker's extractRestoreData passes component-map input through
 * to the game's restore, which selects the sections it owns. Picking the
 * first component would silently drop the rest of the world.
 */
export function serializeRestorePayload(
  components: Record<string, { data?: unknown } | null | undefined>,
  explicit: string | undefined,
): string | undefined {
  if (explicit) {
    const comp = components[explicit];
    if (!comp) {
      log.warn("startGame", `Save component "${explicit}" not found; available: ${Object.keys(components).join(", ")}`);
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
 * A framework-managed UI handle. Returned by `GameModule.ui` — startGame()
 * calls `start()` after renderer init (before `onReady`) and `dispose()` on
 * hot-reload. Any { start, dispose } object is compatible (html-ui hosts,
 * DOM-UI mounts, custom overlays).
 */
export interface GameUiHandle {
  /** Start the UI (spawn workers, mount overlays). Called after renderer init. */
  start(): Promise<void> | void;
  /** Tear down. Called on hot-reload dispose, before `module.onDispose`. */
  dispose(): void;
}

/**
 * The context passed to all game hooks. Carries typed references to every
 * framework-managed resource — no module-scope `let` variables needed.
 *
 * The `Sim` type parameter lets games specify their concrete sim worker type
 * so `ctx.sim` is typed correctly (no casting). For renderer-only games (no
 * `sim` declared in the `GameModule`), `Sim` defaults to `GameSimWorker` and
 * `ctx.sim` is `undefined` — hooks should not access it.
 *
 * Sim fields (`sim`, `simSAB`, `inputSAB`) are optional because renderer-only
 * games don't have a sim worker. Games that declare `sim` can safely use
 * non-null assertions (`ctx.sim!`) in their hooks — `startGame()` guarantees
 * the sim worker is created when `module.sim` is declared.
 */
export interface GameContext<Sim extends GameSimWorker = GameSimWorker> {
  /** The renderer instance (typed as `any` — games cast to their renderer class). */
  renderer: any;
  /** The render surface the renderer is attached to (canvas on DOM hosts,
   *  NativeSurface on the native runtime). */
  surface: RenderSurface;
  /** The sim worker instance. Undefined for renderer-only games (no `sim` declared). */
  sim?: Sim;
  /** The sim SAB (entity/component data, zero-copy shared with the sim worker).
   *  Undefined for renderer-only games. */
  simSAB?: SharedArrayBuffer;
  /** The input SAB (renderer writes, sim worker reads).
   *  Undefined for renderer-only games. */
  inputSAB?: SharedArrayBuffer;
  /** Extra SABs from `sim.getExtraBuffers()` (e.g. water, custom-game-data).
   *  For renderer-only games, this contains only library-allocated SABs (if any). */
  extraBuffers: Record<string, SharedArrayBuffer>;
  /** The save store, if save config was provided and init succeeded. May be null. */
  saveStore: ISaveStore | null;
  /** The save mode that was actually selected (may differ from config in fallback). */
  saveMode: "inline" | "worker" | "host";
  /**
   * Mode-aware save: persists the current state to the selected backend
   * (inline OPFS / worker OPFS / host store disk). Games should call this for
   * manual saves instead of `sim.save()` directly — `sim.save()` only writes
   * in inline mode and silently drops the save in host mode.
   * Returns true if the save succeeded. Undefined when no save config was declared.
   */
  save?: (slotName: string) => Promise<boolean>;
  /**
   * Mode-aware load: restores state from the selected backend. Games should
   * call this for manual loads instead of `sim.load()` directly.
   * Returns the loaded state (shape depends on the save source), or null if
   * no save exists. Undefined when no save config was declared.
   */
  load?: (slotName: string) => Promise<unknown | null>;
  /** The renderer-side save source, if `module.saveSource` was declared.
   *  Used by the autosave wiring for renderer-only games. Undefined for
   *  sim-worker games (which use `sim.save()` instead). */
  saveSource?: GameSaveSource;
  /** The typed downdraft bridge (window.downdraft). */
  bridge: typeof downdraft;
  /** True if running in deterministic/test mode (DOWNDRAFT_DETERMINISTIC=1). */
  deterministic: boolean;
  /** True if running in dev mode (Vite dev or downdraft.isDev). */
  isDev: boolean;
  /** The library host (if engine libraries were declared). Games can access
   *  library-provided resources via DI tokens from onReady. */
  libraryHost?: LibraryHost;
  /** The plugin host (if `module.plugins` was declared). Games can access
   *  plugin diagnostics via `pluginHost.snapshot()` and trigger reloads. */
  pluginHost?: PluginHost;
  /** The UI handle created by `module.ui` (e.g. a PixiUiBridge). Set after
   *  renderer init, before `onReady` runs — hooks can `ctx.ui?.host` (cast to
   *  the concrete bridge type) to post events or wire subscriptions. */
  ui?: GameUiHandle;
}

/**
 * Plugin runtime configuration. Games opt into the user-authored plugin
 * (modding) system by declaring a `plugins` field on their `GameModule`.
 *
 * The host constructs a renderer-side `PluginHost` and (for sim-thread
 * plugins) forwards manifests to the sim worker. Games choose per-format
 * whether worker-js plugins run on the sim worker or in a dedicated plugin
 * worker; WASM is always forced to its own worker; QuickJS runs in-process on
 * the renderer; asset plugins are data-only.
 */
export interface PluginRuntimeConfig {
  /** Default thread for worker-js plugins: "sim" (inside the game's sim
   *  worker) or "own-worker" (dedicated sandboxed worker). Default: "own-worker". */
  workerJs?: "sim" | "own-worker";
  /** Discovery sources. Local plugin dirs + remote workshop stores. */
  sources?: PluginSource[];
  /** Game-defined permission allowlist (further restricts tier). */
  permissions?: ReadonlySet<PluginPermission>;
  /** Game-defined event catalog for the plugin event bus. */
  eventCatalog?: Record<string, unknown>;
  /** Pre-resolved manifests to load (in addition to discovered sources).
   *  Useful for tests and for bundling first-party plugins. */
  manifests?: PluginManifest[];
}

/**
 * A declarative game definition.
 *
 * Games create a `GameModule` and pass it to `startGame()`. The module
 * describes the renderer, sim worker (optional), UI, event routing, save
 * config, devtools, and game-specific hooks. `startGame()` orchestrates the
 * full bootstrap sequence.
 *
 * The `Sim` generic parameter lets games specify their concrete sim worker
 * type so `GameContext.sim` is typed correctly (no casting). For renderer-only
 * games, omit `sim` and `simConfig` — `Sim` defaults to `GameSimWorker` and
 * the sim-related hooks (`events`, `onSimStart`) are ignored.
 *
 * Two topologies:
 *   - **Sim-worker**: declare `sim` + `simConfig`. `startGame()` spawns the
 *     worker, captures SABs, wires event routing, and starts the sim.
 *   - **Renderer-only**: omit `sim` + `simConfig`. All logic runs on the
 *     renderer thread. Declare `saveSource` if you need autosave. Use
 *     engine libraries (e.g. `WeatherFxLib`, `ModelsLib`) for GPU-side work.
 */
export interface GameModule<Sim extends GameSimWorker = GameSimWorker> {
  // ── Required: renderer ──
  /** Factory that creates the renderer from a canvas. */
  renderer: RendererFactory;

  // ── Optional: sim worker (omit for renderer-only games) ──
  /** Factory that creates the sim worker. Omit for renderer-only games. */
  sim?: SimWorkerFactory<Sim>;
  /** Config passed to `sim.start()`. Required when `sim` is declared. */
  simConfig?: Record<string, unknown>;
  /**
   * Renderer-owned sim worker. For games where the renderer spawns and starts
   * its own worker internally during `renderer.init()` (e.g. falling-sand's
   * renderer creates its SandWorkerHost). Declare this INSTEAD of `sim` — it
   * is called after renderer init to retrieve the worker, which is then
   * exposed as `ctx.sim` and wired into `module.events` routing like a
   * factory-created worker. This removes the need for no-op GameSimWorker
   * adapter classes.
   *
   * The returned object must satisfy GameSimWorker (start + getSimBuffer +
   * getInputBuffer, plus onEvent or subscribeEvents for event routing).
   * `SimWorkerHost` subclasses satisfy this directly via `subscribeEvents`:
   *   `simFromRenderer: (r) => r.getWorkerHost() ?? undefined`
   */
  simFromRenderer?: (renderer: any, ctx: GameContext<Sim>) => Sim | undefined | Promise<Sim | undefined>;

  // ── UI ──
  /** Mount the UI framework (React: createRoot().render(), Solid: render(), etc).
   *  DOM hosts only — on the native runtime there is no DOM overlay tree, so
   *  a declared mountUI is skipped with an error logged (UI on native renders
   *  into the surface via imui/pixi-ui). */
  mountUI?: (overlay: HTMLElement, ctx: GameContext<Sim>) => Promise<void> | void;
  /** CSS imports / side-effect imports to run before UI mount. Optional. */
  imports?: () => void;
  /**
   * Declarative UI lifecycle. Called once with the game context; the returned
   * handle is started after renderer init (before `onReady`) and disposed on
   * hot-reload (before `onDispose`). The handle is exposed as `ctx.ui`.
   *
   * For PixiJS-worker UIs:
   *   `ui: () => createPixiUiBridge({ statsLayout, sceneModuleUrl, getStats, onAction })`
   *
   * This coexists with `mountUI` (DOM overlay) — games can use either or both.
   */
  ui?: (ctx: GameContext<Sim>) => GameUiHandle | Promise<GameUiHandle>;

  // ── Event routing (sim-worker games only) ──
  /** Declarative sim→renderer event handler map. Replaces the switch block.
   *  Ignored for renderer-only games (no sim worker to emit events). */
  events?: SimEventMap<GameContext<Sim>>;

  // ── Save ──
  /** Save configuration. If omitted, no autosave is wired. */
  save?: GameSaveConfig;
  /** Renderer-side save source for renderer-only games. When declared, the
   *  autosave wiring calls `saveSource.save()` instead of `sim.save()`.
   *  Ignored for sim-worker games (the sim worker's `save()` is used). */
  saveSource?: GameSaveSource;

  // ── Engine libraries ──
  /**
   * Engine libraries to auto-wire (water, physics, terrain, etc.).
   * Each entry is either a bare `EngineLibrary` (uses default config) or
   * a `[library, config]` tuple to override config.
   *
   * The host allocates SABs, instantiates sim-side systems + renderer-side
   * passes, and registers provided resources in the DI graph.
   *
   * Games can still import and wire library classes manually (escape hatch)
   * if they need more control than the descriptor provides.
   */
  libraries?: LibraryEntry[];

  // ── User-authored plugins (modding) ──
  /**
   * Plugin runtime configuration. When declared, `startGame()` constructs a
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
  mcp?: (ctx: GameContext<Sim>) => void | Promise<void>;

  // ── Hooks ──
  /**
   * Called after renderer creation, before init. Use to wire sim-ready
   * listeners, capture early state, etc. The renderer exists but is not
   * initialized yet.
   */
  onBeforeInit?: (ctx: GameContext<Sim>) => Promise<void> | void;
  /**
   * Called to initialize the renderer. Should return false on failure.
   * Default: calls `renderer.init()`. The sim worker is started in parallel
   * (see `onSimStart`). Override to add LUT waits, player spawn, etc.
   */
  onInit?: (ctx: GameContext<Sim>) => Promise<boolean> | boolean;
  /**
   * Called to start the sim worker (only when `sim` is declared and `onInit`
   * is NOT overridden). Default: calls `sim.start(simConfig)`. Override to
   * add player spawn after sim is ready. Ignored for renderer-only games.
   *
   * When `onInit` IS overridden, the game's `onInit` owns sim start — this
   * hook is not called. This lets games start the sim in parallel with
   * `renderer.init()` (e.g. to-the-ocean does `Promise.all([renderer.init(),
   * sim.start(config)])` in its `onInit`).
   */
  onSimStart?: (ctx: GameContext<Sim>) => Promise<void> | void;
  /**
   * Called after renderer init + sim start succeed, before render loop.
   * This is the main game-specific wiring hook: setBuffers, OSR, sim bridge,
   * DevTools, gizmo handlers, HUD polling, debug toggles, hot-reload.
   */
  onReady?: (ctx: GameContext<Sim>) => Promise<void> | void;
  /** Called on Vite hot-reload dispose to clean up resources. */
  onDispose?: (ctx: GameContext<Sim>) => Promise<void> | void;
  /** Called in deterministic mode to apply overrides (e.g. pause render loop). */
  onDeterministic?: (ctx: GameContext<Sim>) => void;
  /** Called periodically with the current render FPS. */
  onFpsUpdate?: (fps: number, ctx: GameContext<Sim>) => void;
  /** Called with the display refresh rate when available. */
  onDisplayInfo?: (refreshRate: number, ctx: GameContext<Sim>) => void;

  // ── Surface/overlay ──
  /** Surface/canvas layer index. Default: 0 — the only layer on native hosts. */
  canvasLayer?: number;
  /** Overlay layer index. Default: 0. DOM hosts only. */
  overlayLayer?: number;
  /** FPS polling interval in ms. Default: 500. */
  fpsPollIntervalMs?: number;

  // ── Feature log ──
  /** Optional getter for active plugin names (populates the `plug` field of the
   *  renderer feature log line). e.g. () => gameWorld.moduleHost.listModules() */
  getActiveModules?: () => string[];
}

// ── startGame() ──

/**
 * Start a game from a declarative `GameModule`.
 *
 * This is the high-level entry point. It wraps `bootstrapGame()` and adds:
 *   - Engine library auto-wiring (SAB allocation, sim systems, renderer passes)
 *   - Sim worker spawn + SAB capture (skipped for renderer-only games)
 *   - Declarative event routing (the `events` map — sim-worker games only)
 *   - Save store initialization (sim-worker or renderer-side save source)
 *   - Typed `GameContext` passed to all hooks
 *
 * Two topologies are supported:
 *   - **Sim-worker**: `module.sim` is declared → worker spawned, SABs captured,
 *     events routed, sim started after renderer init.
 *   - **Renderer-only**: `module.sim` is omitted → no worker, no SABs, no
 *     event routing. All logic runs on the renderer thread. Declare
 *     `module.saveSource` for autosave support.
 *
 * Games that need full control can call `bootstrapGame()` directly.
 */
export async function startGame<Sim extends GameSimWorker>(module: GameModule<Sim>): Promise<void> {
  const deterministic = !!(downdraft as any)?.deterministic;
  const isDev = !!(downdraft?.isDev) || isDevMode;
  const hasSim = !!module.sim;

  // 0. Resolve the render surface (canvas on DOM hosts, NativeSurface on native)
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
  //     games + the doctor panel can query snapshots.
  let pluginHost: PluginHost | null = null;
  if (module.plugins) {
    const pCfg = module.plugins;
    const hostOpts: PluginHostOptions = {
      gameId: (downdraft as any)?.appId ?? "unknown",
      engineVersion: ENGINE_VERSION,
      gameAllow: pCfg.permissions,
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

  // 1. Create sim worker + capture SABs (renderer-only games skip this).
  //    If libraries declared, pass the library-allocated SABs to the sim
  //    factory via a seed object so the sim can share them zero-copy.
  const simSeed = Object.keys(libBuffers).length > 0 ? { libraryBuffers: libBuffers } : undefined;
  const simWorker = hasSim ? module.sim!(simSeed as any) : null;
  const simSAB = simWorker?.getSimBuffer();
  const inputSAB = simWorker?.getInputBuffer();
  const extraBuffers = simWorker?.getExtraBuffers?.() ?? {};

  // 2. Create renderer
  const renderer = module.renderer(surface);

  // 3. Build the game context. Sim fields are undefined for renderer-only games.
  const ctx: GameContext<Sim> = {
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
      ctx.extraBuffers[name] = sab;
    }
    ctx.libraryHost = libHost;
  }

  // 3c. Expose the plugin host on ctx (if constructed).
  if (pluginHost) {
    ctx.pluginHost = pluginHost;
  }

  // Event kinds emitted by the engine itself (sim-worker-base lifecycle)
  // that games are not required to handle — suppress the dev warning for
  // these so autosave doesn't spam the console when no handler is wired.
  const ENGINE_EMITTED_EVENT_KINDS = new Set(["ready", "saved", "loaded", "error"]);

  // 4. Wire event routing from the declarative events map (sim-worker only).
  //    Supports both GameSimWorker.onEvent(cb) and SimWorkerHost's
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
          log.error("startGame", `Event handler error for "${msg.kind}": ${err}`);
        }
      } else if (isDev && !ENGINE_EMITTED_EVENT_KINDS.has(msg.kind)) {
        log.warn("startGame", `Unhandled sim event kind: "${msg.kind}"`);
      }
    });
  };
  if (simWorker) wireSimEvents(simWorker);

  // 5. Run onBeforeInit hook
  if (module.onBeforeInit) {
    await module.onBeforeInit(ctx);
  }

  // 6. Initialize save store (if configured) — for non-inline modes this
  //    runs before bootstrapGame so onReady can use it. For inline mode
  //    (sim-worker + OPFS), the store is initialized inside onRendererInit
  //    after the sim worker has started.
  if (module.save && !deterministic) {
    try {
      // Default to "host" (disk via the host's typed save store) when the
      // bridge exposes one — on native this is HostSaveStore over
      // HostServices. Fall back to "auto" (OPFS) only in a pure browser
      // where there is no host bridge.
      const saveMode = module.save.mode ?? (downdraft.saveStore ? "host" : "auto");
      if (saveMode === "auto" && simWorker?.initSaveStore && isOpfsAvailable() && !downdraft.saveStore) {
        // Inline mode — defer init to onRendererInit (after sim worker starts).
        ctx.saveMode = "inline";
        ctx.saveStore = null;
      } else {
        const { store, mode: resolvedMode } = await createSaveStore({
          mode: saveMode,
          opfsOptions: {
            engineVersion: module.save.engineVersion,
            maxGenerations: module.save.maxGenerations ?? 3,
          },
          bridge: downdraft,
        });
        ctx.saveStore = store;
        // resolvedMode is "worker" | "host" | "inline" (inline returns a
        // null store); narrow to the ctx.saveMode union accordingly.
        ctx.saveMode = resolvedMode === "inline" ? "inline"
          : resolvedMode === "worker" ? "worker" : "host";
      }
    } catch (e) {
      log.warn("startGame", `Save store init failed, falling back to host bridge: ${e}`);
      ctx.saveMode = "host";
    }
  }

  // 6b. Mode-aware save/load helpers — exposed on ctx so games can trigger manual
  //     saves/loads that work regardless of the selected backend. This is the
  //     same logic the autosave interval uses below. Games MUST use ctx.save /
  //     ctx.load instead of sim.save / sim.load directly: sim.save only writes
  //     in inline mode (it has its own OPFS store) and silently drops the save
  //     in host mode (it returns stateJson but nothing forwards it to disk).
  if (module.save && !deterministic) {
    ctx.save = async (slotName: string): Promise<boolean> => {
      try {
        // Renderer-side save source takes priority (renderer-only games);
        // otherwise fall back to the sim worker's save() (sim-worker games).
        // ctx.sim covers simFromRenderer games, resolved after renderer init.
        const sim = ctx.sim ?? simWorker;
        const result = ctx.saveSource
          ? await ctx.saveSource.save(slotName)
          : sim?.save
            ? await sim.save(slotName)
            : null;
        // In inline mode, the sim worker's save() already persisted to its own
        // OPFS store — nothing more to do. In host/worker mode the sim worker
        // only serialized — the renderer owns the store write.
        if (result?.stateJson && ctx.saveMode !== "inline" && ctx.saveStore) {
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
        log.error("startGame", `Manual save failed: ${e}`);
        return false;
      }
    };

    ctx.load = async (slotName: string): Promise<unknown | null> => {
      try {
        // Renderer-side save source load (renderer-only games)
        if (ctx.saveSource?.load) {
          const stateJson = await ctx.saveSource.load(slotName);
          return stateJson ? JSON.parse(stateJson) : null;
        }
        // ctx.sim covers simFromRenderer games (resolved post renderer-init).
        const sim = ctx.sim ?? simWorker;
        // Inline mode: sim worker loads directly from its own OPFS store.
        // The sim worker's load() restores state internally; we just need a
        // truthy return value so any onLoad hook fires.
        if (ctx.saveMode === "inline" && sim?.load) {
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
        if (downdraft?.loadGameState) {
          const stateJson = await downdraft.loadGameState(slotName);
          if (!stateJson) return null;
          // The host bridge returns JSON.stringify(result.state.components),
          // so the parsed result is the components map directly (not a
          // SaveState). Find the game component (e.g. "sandbox") and
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
        log.error("startGame", `Manual load failed: ${e}`);
        return null;
      }
    };
  }

  // 7. Delegate to bootstrapGame() for the standard sequence
  await bootstrapGame({
    canvasLayer: module.canvasLayer,
    overlayLayer: module.overlayLayer,
    fpsPollIntervalMs: module.fpsPollIntervalMs,
    getActiveModules: module.getActiveModules,

    mountUI: module.mountUI
      ? (overlayEl) => module.mountUI!(overlayEl, ctx)
      : undefined,

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
          libHost.setRendererBuffers(libBuffers);
        }
      }

      // ── Renderer-owned sim resolution ──
      // Games whose renderer spawns/starts the sim worker internally (declared
      // via `module.simFromRenderer` instead of `module.sim`) get the worker
      // resolved here — after renderer.init() has created it. ctx.sim is
      // populated and declarative `events` routing is wired, matching the
      // factory-created path. startGame() never calls start() on it — the
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
          log.warn("startGame", `simFromRenderer resolution failed: ${e}`);
        }
      }

      // ── Sim worker start ──
      // When `onInit` is NOT overridden, startGame owns sim start — it runs
      // here, after renderer.init() has succeeded. When `onInit` IS overridden,
      // the game's onInit owns sim start (e.g. to-the-ocean starts the sim in
      // parallel with renderer.init() inside its onInit). Renderer-only games
      // have no sim worker to start.
      if (simWorker && !module.onInit) {
        if (module.onSimStart) {
          await module.onSimStart(ctx);
        } else {
          await simWorker.start(module.simConfig ?? {});
        }
      }

      // ── Inline save store init (sim-worker + OPFS) ──
      // Now that the sim worker is started, initialize its inline OPFS store.
      // This must happen before the autosave load (which runs in bootstrapGame
      // after onRendererInit returns) so that the sim worker can load from OPFS.
      if (ctx.saveMode === "inline" && (ctx.sim ?? simWorker)?.initSaveStore && module.save) {
        try {
          await (ctx.sim ?? simWorker)!.initSaveStore!({
            engineVersion: module.save.engineVersion,
            maxGenerations: module.save.maxGenerations ?? 3,
          });
        } catch (e) {
          log.warn("startGame", `Inline save store init failed, falling back to host save store: ${e}`);
          ctx.saveMode = "host";
        }
      }

      // ── Plugin loading ──
      // Load all discovered plugins (renderer + own-worker threads). Sim-
      // thread plugins are forwarded to the sim worker by the game's sim
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
          log.warn("startGame", `Plugin loading error: ${e}`);
        }
      }

      // ── Declarative UI lifecycle ──
      // Create + start the UI handle (e.g. a PixiUiBridge) before onReady so
      // hooks can wire subscriptions against ctx.ui.
      if (module.ui) {
        try {
          ctx.ui = await module.ui(ctx);
          await ctx.ui.start();
        } catch (e) {
          // UI failure is non-fatal — the game canvas still runs.
          log.error("startGame", `UI start failed: ${e}`);
          ctx.ui = undefined;
        }
      }

      // ── Game-specific wiring ──
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
