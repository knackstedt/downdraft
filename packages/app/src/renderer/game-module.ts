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
    type ISaveStore,
    type LibraryEntry,
    type LibraryHost,
    type PluginHostOptions,
    type PluginManifest,
    type PluginPermission,
    type PluginSource,
} from "@downdraft/core";
import { bootstrapGame, type BootstrapDevToolsOptions } from "./bootstrap";
import { downdraft, getCanvas, getOverlay } from "./index";
import { createSaveStore, isOpfsAvailable, type SaveStoreMode } from "./save-store-factory";

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
  /** Start the sim worker. Config is opaque to the framework (game-specific). */
  start(config: unknown): Promise<void>;
  /** Register an event callback for sim→renderer messages. */
  onEvent(cb: (msg: any) => void): void;
  getSimBuffer(): SharedArrayBuffer;
  getInputBuffer(): SharedArrayBuffer;
  /** Optional additional SABs the game wants exposed via GameContext. */
  getExtraBuffers?(): Record<string, SharedArrayBuffer>;
  addPlayer?(playerId: number, name: string): Promise<void> | void;
  save?(slotName: string, opts?: unknown): Promise<{ stateJson: string; success: boolean } | null>;
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

/** Factory that creates the renderer from a canvas element. */
export type RendererFactory = (canvas: HTMLCanvasElement) => any;

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
  /** Serialize current state and return it as a JSON string. */
  save(slotName: string): Promise<{ stateJson: string; success: boolean } | null>;
  /** Optional: load a previously saved state. If omitted, the save store's
   *  own load path is used (OPFS / IPC). */
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
  /** Save mode. Default: "auto" (OPFS worker → IPC fallback). */
  mode?: SaveStoreMode;
  /** Engine version string for save slots. */
  engineVersion: string;
  /** Max save generations to keep. Default: 3. */
  maxGenerations?: number;
  /** Autosave interval in ms. Default: 3000. */
  intervalMs?: number;
  /** Slot name for autosave. Default: "autosave". */
  slotName?: string;
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
  /** The canvas element the renderer is attached to. */
  canvas: HTMLCanvasElement;
  /** The DOM overlay element (for UI mounting). */
  overlay: HTMLElement;
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
  saveMode: "inline" | "worker" | "ipc";
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

  // ── UI ──
  /** Mount the UI framework (React: createRoot().render(), Solid: render(), etc). */
  mountUI?: (overlay: HTMLElement, ctx: GameContext<Sim>) => Promise<void> | void;
  /** CSS imports / side-effect imports to run before UI mount. Optional. */
  imports?: () => void;

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

  // ── Canvas/overlay ──
  /** Canvas layer index. Default: 0. */
  canvasLayer?: number;
  /** Overlay layer index. Default: 0. */
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
  const isDev = !!(downdraft?.isDev) || import.meta.env.DEV === true;
  const hasSim = !!module.sim;

  // 0. Resolve canvas + overlay
  const canvas = getCanvas(module.canvasLayer ?? 0);
  const overlay = getOverlay(module.overlayLayer ?? 0);

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
    for (const m of pCfg.manifests ?? []) {
      pluginHost.discover(m, "inline");
    }
    // Local-dir discovery is performed by the game's vite config / preload;
    // manifests are discovered via the plugin host's discover() API. Here we
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
  const renderer = module.renderer(canvas);

  // 3. Build the game context. Sim fields are undefined for renderer-only games.
  const ctx: GameContext<Sim> = {
    renderer,
    canvas,
    overlay,
    sim: simWorker as Sim | undefined,
    simSAB,
    inputSAB,
    extraBuffers,
    saveStore: null,
    saveMode: "ipc",
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

  // 4. Wire event routing from the declarative events map (sim-worker only).
  if (module.events && simWorker) {
    const events = module.events;
    simWorker.onEvent((msg) => {
      const handler = events[msg.kind];
      if (handler) {
        try {
          handler(msg.data, ctx);
        } catch (err) {
          console.error(`[startGame] Event handler error for "${msg.kind}":`, err);
        }
      } else if (isDev && msg.kind !== "ready" && msg.kind !== "error") {
        console.warn(`[startGame] Unhandled sim event kind: "${msg.kind}"`);
      }
    });
  }

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
      const saveMode = module.save.mode ?? "auto";
      if (saveMode === "auto" && simWorker?.initSaveStore && isOpfsAvailable()) {
        // Inline mode — defer init to onRendererInit (after sim worker starts).
        ctx.saveMode = "inline";
        ctx.saveStore = null;
      } else {
        const store = await createSaveStore({
          mode: saveMode,
          opfsOptions: {
            engineVersion: module.save.engineVersion,
            maxGenerations: module.save.maxGenerations ?? 3,
          },
          bridge: downdraft,
        });
        ctx.saveStore = store;
        ctx.saveMode = store ? (saveMode === "auto" ? "worker" : saveMode) : "ipc";
      }
    } catch (e) {
      console.warn("[startGame] Save store init failed, falling back to IPC:", e);
      ctx.saveMode = "ipc";
    }
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
      // Runs before the GPU device is available so libraries like
      // @downdraft/library-pixi-ui can construct their host + provide DI tokens.
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
      if (ctx.saveMode === "inline" && simWorker?.initSaveStore && module.save) {
        try {
          await simWorker.initSaveStore({
            engineVersion: module.save.engineVersion,
            maxGenerations: module.save.maxGenerations ?? 3,
          });
        } catch (e) {
          console.warn("[startGame] Inline save store init failed, falling back to IPC:", e);
          ctx.saveMode = "ipc";
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
          await pluginHost.loadAll();
        } catch (e) {
          console.warn("[startGame] Plugin loading error:", e);
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
          load: async () => {
            const slotName = module.save!.slotName ?? "autosave";
            // Renderer-side save source load (renderer-only games)
            if (ctx.saveSource?.load) {
              const stateJson = await ctx.saveSource.load(slotName);
              return stateJson ? JSON.parse(stateJson) : null;
            }
            // Inline mode: sim worker loads directly from its own OPFS store.
            // The sim worker's load() restores state internally; we just need
            // a truthy return value so onLoad (if any) fires.
            if (ctx.saveMode === "inline" && simWorker?.load) {
              const success = await simWorker.load(slotName);
              return success ? { restored: true } : null;
            }
            if (ctx.saveStore) {
              const result = await ctx.saveStore.load(slotName);
              return result?.state ?? null;
            }
            if (downdraft?.loadGameState) {
              const stateJson = await downdraft.loadGameState(slotName);
              return stateJson ? JSON.parse(stateJson) : null;
            }
            return null;
          },
          save: async () => {
            const slotName = module.save!.slotName ?? "autosave";
            // Renderer-side save source takes priority (renderer-only games);
            // otherwise fall back to the sim worker's save() (sim-worker games).
            const result = ctx.saveSource
              ? await ctx.saveSource.save(slotName)
              : simWorker?.save
                ? await simWorker.save(slotName)
                : null;
            // In inline mode, the sim worker's save() already persisted to
            // its own OPFS store — nothing more to do here.
            // In IPC mode, forward the state JSON to the main process.
            if (result?.stateJson && ctx.saveMode === "ipc" && downdraft?.saveGameState) {
              await downdraft.saveGameState(slotName, result.stateJson);
            }
          },
          intervalMs: module.save?.intervalMs,
        }
      : undefined,

    mcp: module.mcp ? () => module.mcp!(ctx) : undefined,

    onDisplayInfo: module.onDisplayInfo
      ? (rate) => module.onDisplayInfo!(rate, ctx)
      : undefined,

    onHotReloadDispose: () => {
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
