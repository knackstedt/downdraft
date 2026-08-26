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

import type { ISaveStore, LibraryEntry } from "@downdraft/core";
import { bootstrapGame, type BootstrapDevToolsOptions } from "./bootstrap";
import { downdraft, getCanvas, getOverlay } from "./index";
import { createSaveStore, type SaveStoreMode } from "./save-store-factory";

// ── Types ──

/**
 * The sim worker abstraction. Games provide a factory that creates a sim
 * worker; `startGame()` calls `start()`, captures SABs, wires event routing,
 * and exposes the worker via `GameContext.sim`.
 *
 * This is intentionally minimal — games implement this interface on top of
 * their own sim worker class (e.g. `SimWebWorker` in to-the-ocean).
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
 * so `ctx.sim` is typed correctly (no casting).
 */
export interface GameContext<Sim extends GameSimWorker = GameSimWorker> {
  /** The renderer instance (typed as `any` — games cast to their renderer class). */
  renderer: any;
  /** The canvas element the renderer is attached to. */
  canvas: HTMLCanvasElement;
  /** The DOM overlay element (for UI mounting). */
  overlay: HTMLElement;
  /** The sim worker instance. */
  sim: Sim;
  /** The sim SAB (entity/component data, zero-copy shared with the sim worker). */
  simSAB: SharedArrayBuffer;
  /** The input SAB (renderer writes, sim worker reads). */
  inputSAB: SharedArrayBuffer;
  /** Extra SABs from `sim.getExtraBuffers()` (e.g. water, boat). */
  extraBuffers: Record<string, SharedArrayBuffer>;
  /** The save store, if save config was provided and init succeeded. May be null. */
  saveStore: ISaveStore | null;
  /** The save mode that was actually selected (may differ from config in fallback). */
  saveMode: "inline" | "worker" | "ipc";
  /** The typed downdraft bridge (window.downdraft). */
  bridge: typeof downdraft;
  /** True if running in deterministic/test mode (DOWNDRAFT_DETERMINISTIC=1). */
  deterministic: boolean;
  /** True if running in dev mode (Vite dev or downdraft.isDev). */
  isDev: boolean;
}

/**
 * A declarative game definition.
 *
 * Games create a `GameModule` and pass it to `startGame()`. The module
 * describes the renderer, sim worker, UI, event routing, save config,
 * devtools, and game-specific hooks. `startGame()` orchestrates the full
 * bootstrap sequence.
 *
 * The `Sim` generic parameter lets games specify their concrete sim worker
 * type so `GameContext.sim` is typed correctly (no casting).
 */
export interface GameModule<Sim extends GameSimWorker = GameSimWorker> {
  // ── Required: renderer + sim ──
  /** Factory that creates the renderer from a canvas. */
  renderer: RendererFactory;
  /** Factory that creates the sim worker. */
  sim: SimWorkerFactory<Sim>;
  /** Config passed to `sim.start()`. Typed as the game's sim config. */
  simConfig: Record<string, unknown>;

  // ── UI ──
  /** Mount the UI framework (React: createRoot().render(), Solid: render(), etc). */
  mountUI?: (overlay: HTMLElement, ctx: GameContext<Sim>) => Promise<void> | void;
  /** CSS imports / side-effect imports to run before UI mount. Optional. */
  imports?: () => void;

  // ── Event routing ──
  /** Declarative sim→renderer event handler map. Replaces the switch block. */
  events?: SimEventMap<GameContext<Sim>>;

  // ── Save ──
  /** Save configuration. If omitted, no autosave is wired. */
  save?: GameSaveConfig;

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
   * Called after the sim worker is started (in parallel with renderer init).
   * Default: calls `sim.start(simConfig)`. Override to add player spawn
   * after sim is ready.
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
   *  renderer feature log line). e.g. () => gameWorld.pluginHost.listPlugins() */
  getActivePlugins?: () => string[];
}

// ── startGame() ──

/**
 * Start a game from a declarative `GameModule`.
 *
 * This is the high-level entry point. It wraps `bootstrapGame()` and adds:
 *   - Engine library auto-wiring (SAB allocation, sim systems, renderer passes)
 *   - Sim worker spawn + SAB capture
 *   - Declarative event routing (the `events` map)
 *   - Save store initialization
 *   - Typed `GameContext` passed to all hooks
 *
 * Games that need full control can call `bootstrapGame()` directly.
 */
export async function startGame<Sim extends GameSimWorker>(module: GameModule<Sim>): Promise<void> {
  const deterministic = !!(downdraft as any)?.deterministic;
  const isDev = !!(downdraft?.isDev) || import.meta.env.DEV === true;

  // 0. Resolve canvas + overlay
  const canvas = getCanvas(module.canvasLayer ?? 0);
  const overlay = getOverlay(module.overlayLayer ?? 0);

  // 0b. Allocate library SABs (if any libraries declared) — before sim worker
  //     creation so the sim factory can receive externally-allocated SABs.
  let libHost: any = null;
  let libBuffers: Record<string, SharedArrayBuffer> = {};
  if (module.libraries && module.libraries.length > 0) {
    const { LibraryHostImpl } = await import("@downdraft/core");
    libHost = new LibraryHostImpl(module.libraries);
    libBuffers = libHost.allocateBuffers();
  }

  // 1. Create sim worker + capture SABs. If libraries declared, pass the
  //    library-allocated SABs to the sim factory via a seed object.
  const simSeed = Object.keys(libBuffers).length > 0 ? { libraryBuffers: libBuffers } : undefined;
  const simWorker = module.sim(simSeed as any);
  const simSAB = simWorker.getSimBuffer();
  const inputSAB = simWorker.getInputBuffer();
  const extraBuffers = simWorker.getExtraBuffers?.() ?? {};

  // 2. Create renderer
  const renderer = module.renderer(canvas);

  // 3. Build the partial context (saveStore filled in later)
  const ctx: GameContext<Sim> = {
    renderer,
    canvas,
    overlay,
    sim: simWorker,
    simSAB,
    inputSAB,
    extraBuffers,
    saveStore: null,
    saveMode: "ipc",
    bridge: downdraft,
    deterministic,
    isDev,
  };

  // 3b. Merge library SABs into extraBuffers + store host on ctx
  if (libHost) {
    for (const [name, sab] of Object.entries(libBuffers)) {
      ctx.extraBuffers[name] = sab;
    }
    (ctx as any).libraryHost = libHost;
  }

  // 4. Wire event routing from the declarative events map
  if (module.events) {
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

  // 6. Initialize save store (if configured) — before bootstrapGame so
  //    onReady can use it. Non-blocking: failures fall back to IPC.
  if (module.save && !deterministic) {
    try {
      const saveMode = module.save.mode ?? "auto";
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
    getActivePlugins: module.getActivePlugins,

    mountUI: module.mountUI
      ? (overlayEl) => module.mountUI!(overlayEl, ctx)
      : undefined,

    createRenderer: () => renderer,

    initRenderer: module.onInit
      ? () => module.onInit!(ctx)
      : (r) => r.init(),

    onRendererInit: async (r) => {
      // Start sim worker in parallel with renderer init was handled by
      // onInit/onSimStart. If the game didn't override onInit, start the
      // sim worker here (after renderer.init() succeeds).
      if (!module.onInit && module.onSimStart) {
        await module.onSimStart(ctx);
      } else if (!module.onInit) {
        await simWorker.start(module.simConfig);
      }
      // Run the game's onReady hook
      if (module.onReady) {
        await module.onReady(ctx);
      }
    },

    devtools: module.devtools,

    autosave: module.save && !deterministic
      ? {
          load: async () => {
            const slotName = module.save!.slotName ?? "autosave";
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
            if (simWorker.save) {
              const result = await simWorker.save(slotName);
              if (result?.stateJson && ctx.saveMode === "ipc" && downdraft?.saveGameState) {
                await downdraft.saveGameState(slotName, result.stateJson);
              }
            }
          },
          intervalMs: module.save?.intervalMs,
        }
      : undefined,

    mcp: module.mcp ? () => module.mcp!(ctx) : undefined,

    onDisplayInfo: module.onDisplayInfo
      ? (rate) => module.onDisplayInfo!(rate, ctx)
      : undefined,

    onHotReloadDispose: module.onDispose
      ? () => module.onDispose!(ctx)
      : undefined,

    onDeterministic: module.onDeterministic
      ? () => module.onDeterministic!(ctx)
      : undefined,

    onFpsUpdate: module.onFpsUpdate
      ? (fps) => module.onFpsUpdate!(fps, ctx)
      : undefined,
  });
}
