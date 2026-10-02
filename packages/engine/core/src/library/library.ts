// ============================================================================
// Library descriptor — declarative engine library wiring
//
// An `EngineLibrary` descriptor lets games declare which engine libraries they
// use (water, physics, terrain, etc.) in their `GameModule.libraries[]` array.
// The `LibraryHost` auto-wires each library: allocates SAB channels,
// instantiates sim-side systems + renderer-side readers/passes, and exposes
// them via typed tokens in the DI graph.
//
// Libraries keep their bare class exports as an escape hatch — games that
// need full control can still import and wire classes manually.
//
// Design:
//   - Progressive: simple libraries (just SAB) get a 5-line descriptor;
//     complex ones (terrain with worker pools) add more fields.
//   - Typed: each descriptor is generic in its config type.
//   - DI-integrated: libraries `provides` typed tokens that plugins/hooks
//     can `inject` from the GameContext.
// ============================================================================

import type { ResourceToken } from "../ecs/resource";

// ── Tick phases (where in the sim tick the library's system runs) ──

export type LibraryTickPhase =
  | "pre-physics"    // before physics step (e.g. water heightfield update)
  | "physics"        // the physics step itself
  | "post-physics"   // after physics (e.g. buoyancy sampling)
  | "terrain"        // terrain LOD/deformation/generation
  | "buffer-write";  // final SAB buffer write (before renderer reads)

// ── Sim-side descriptor ──

/**
 * Sim-side library wiring. Called from the sim worker during initialization.
 *
 * The `sim` context provides access to the SABs allocated by the library
 * descriptor, the world, and other libraries' provided resources.
 */
export interface LibrarySimSetup<C = unknown, S = unknown> {
  /**
   * Called once during sim worker init to create the sim-side system.
   * Receives the library config + the sim context (SABs, world, inject).
   * Returns the system instance (stored and passed to `tick()`).
   * May be async (e.g. WASM init) — the host resolves the promise before
   * the instance is passed to `tick()`/`dispose()`. NOTE: an async create
   * resolves after `initSim()` returns, so resources it `provide()`s are
   * not visible to other libraries' `create()` calls in the same init pass —
   * provide shared resources synchronously or defer injection to `tick()`.
   */
  create(config: C, ctx: LibrarySimContext): S | Promise<S>;
  /**
   * Called each sim tick at the declared `tickPhase`.
   * Receives the system instance + tick context (dt, entities, etc.).
   */
  tick?(system: S, ctx: LibrarySimTickContext): void;
  /**
   * Called on sim shutdown / hot-reload dispose.
   */
  dispose?(system: S): void;
}

/** Context passed to `LibrarySimSetup.create()`. */
export interface LibrarySimContext {
  /** The SABs allocated for this library (keyed by channel name). */
  buffers: Record<string, SharedArrayBuffer>;
  /** Provide a typed resource to the sim DI graph (other libraries/plugins can inject it). */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /** Inject a resource from the DI graph (e.g. another library's output). */
  inject<T>(token: ResourceToken<T>): T;
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
}

/** Context passed to `LibrarySimSetup.tick()`. */
export interface LibrarySimTickContext {
  dt: number;
  tick: number;
  /** Entity data (same as sim tick systems receive). */
  entities: unknown;
  entityCount: number;
  players: unknown;
  playerCount: number;
}

// ── Renderer-side descriptor ──

/**
 * Context for `LibraryRendererSetup.create()` — the early renderer-side hook.
 *
 * Unlike `LibraryRendererInitContext`, this does NOT receive a GPU device —
 * it runs before the WebGPU device is acquired. Use it for renderer-only
 * libraries that need to construct a host, spawn a worker, or register a
 * DI token without depending on the GPU (e.g. a UI overlay worker
 * that renders to its own OffscreenCanvas).
 */
export interface LibraryRendererCreateContext {
  /** Provide a typed resource to the renderer DI graph (other libraries/plugins can inject it). */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /** Inject a resource from the renderer DI graph. */
  inject<T>(token: ResourceToken<T>): T;
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
}

/**
 * Renderer-side library wiring. Called from the renderer during `init()`
 * and `setBuffers()`.
 */
export interface LibraryRendererSetup<C = unknown, R = unknown> {
  /**
   * Called once early during renderer setup, BEFORE the WebGPU device is
   * acquired and before `init()`. Use for renderer-only libraries that
   * don't need the GPU (e.g. a UI overlay worker host). The returned
   * instance is stored and passed to `init()`/`setBuffers()`/`draw()`/`dispose()`
   * if those are also defined. Omit for GPU-pass libraries that only need `init()`.
   * May return null to indicate the library is unavailable (e.g. a required
   * DI token is missing).
   */
  create?(config: C, ctx: LibraryRendererCreateContext): R | null;
  /**
   * Called once during renderer init (after WebGPU device is ready).
   * Receives the GPU device, format, and library config.
   * Returns a renderer-side instance (stored and passed to `draw()`).
   * If `create()` returned an instance, it is kept unless `init()` returns
   * a new one.
   */
  init?(config: C, ctx: LibraryRendererInitContext): R | null | undefined;
  /**
   * Called when SABs are set on the renderer (`setBuffers()`).
   * Receives the renderer instance from `init()` + the SABs.
   * The optional context provides `provide()` for registering resources
   * into the DI graph (e.g. a buffer reader created during setBuffers).
   */
  setBuffers?(instance: R, buffers: Record<string, SharedArrayBuffer>, ctx?: { provide<T>(token: ResourceToken<T>, value: T): void }): void;
  /**
   * Called per frame during the render pass.
   * Receives the renderer instance + frame context.
   */
  draw?(instance: R, ctx: LibraryRendererDrawContext): void;
  /**
   * Called on renderer dispose.
   */
  dispose?(instance: R): void;
}

/** Context for `LibraryRendererSetup.init()`. */
export interface LibraryRendererInitContext {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** Provide a typed resource to the renderer DI graph (other libraries/plugins can inject it). */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /** Inject a resource from the renderer DI graph. */
  inject<T>(token: ResourceToken<T>): T;
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
}

/** Context for `LibraryRendererSetup.draw()`. */
export interface LibraryRendererDrawContext {
  passEncoder: GPURenderPassEncoder;
  dt: number;
  elapsedTime: number;
}

// ── SAB channel declaration ──

/**
 * Declares a SAB channel that the library needs allocated.
 * The host allocates the SAB and passes it to both sim and renderer setup.
 */
export interface LibrarySABChannel {
  /** Channel name (keyed in the `buffers` record passed to setup functions). */
  name: string;
  /** SAB size in bytes. */
  size: number;
}

// ── The descriptor ──

/**
 * A declarative engine library descriptor.
 *
 * Games declare libraries in their `GameModule.libraries[]` array. The
 * `LibraryHost` auto-wires each library: allocates SABs, calls sim-side
 * and renderer-side setup, and registers provided resources in the DI graph.
 *
 * Example (water library):
 * ```ts
 * export const WaterLib: EngineLibrary<WaterConfig, WaterBufferWriter, WaterPass> = {
 *   name: "water",
 *   version: "1.0.0",
 *   sabChannels: [{ name: "water", size: WaterChannel.BUFFER_SIZE }],
 *   provides: [WaterWriterTok, WaterReaderTok],
 *   sim: {
 *     create(config, ctx) {
 *       const writer = new WaterBufferWriter(ctx.buffers.water);
 *       writer.init(config.patchSize);
 *       return writer;
 *     },
 *     tick(writer, tickCtx) { updateWaterBuffer(writer, tickCtx.dt); },
 *   },
 *   tickPhase: "pre-physics",
 *   renderer: {
 *     init(config, rctx) { return new WaterPass(rctx.device, rctx.format); },
 *     setBuffers(pass, buffers) { pass.setReader(new WaterBufferReader(buffers.water)); },
 *     draw(pass, dctx) { pass.execute(dctx.passEncoder); },
 *   },
 * };
 * ```
 */
export interface EngineLibrary<C = unknown, S = unknown, R = unknown> {
  /** Library name (unique among the game's libraries[]). */
  name: string;
  /** Library version (semver). */
  version: string;

  // ── SAB channels ──
  /** SAB channels to allocate for this library. Empty if no SABs needed. */
  sabChannels?: LibrarySABChannel[];

  // ── DI ──
  /** Typed tokens this library provides to the DI graph. */
  provides?: ResourceToken<unknown>[];
  /** Typed tokens this library requires from the DI graph. */
  requires?: ResourceToken<unknown>[];

  // ── Sim-side ──
  /** Sim-side setup (system creation + tick). Omit for renderer-only libraries. */
  sim?: LibrarySimSetup<C, S>;
  /** When in the sim tick to call `sim.tick()`. Default: "post-physics". */
  tickPhase?: LibraryTickPhase;

  // ── Renderer-side ──
  /** Renderer-side setup (early host creation + pass creation + per-frame draw).
   *  Omit for sim-only libraries. `create` runs before the GPU device is ready
   *  (renderer-only host/worker libraries); `init`/`setBuffers`/`draw`/`dispose`
   *  run with the GPU device available. */
  renderer?: LibraryRendererSetup<C, R>;

  // ── Config ──
  /** Default config. Overridden by the game's `libraries[]` entry config. */
  defaultConfig?: C;
}

// ── Game-facing library entry (in GameModule.libraries[]) ──

/**
 * An entry in `GameModule.libraries[]`. Either a bare `EngineLibrary` (uses
 * default config) or a tuple `[library, config]` to override config.
 */
export type LibraryEntry<C = unknown> =
  | EngineLibrary<C>
  | [EngineLibrary<C>, C];

// ── LibraryHost (internal — wires libraries) ──

/**
 * Internal host that manages library lifecycle. Created by `startGame()`
 * and the sim worker. Not exported — games interact with libraries via
 * the DI graph (`ctx.inject(WaterWriterTok)` etc.).
 */
export interface LibraryHost {
  /** Allocate SABs for all libraries. Called early (before sim/renderer init). */
  allocateBuffers(): Record<string, SharedArrayBuffer>;
  /** Initialize sim-side systems. Called during sim worker init. */
  initSim(ctx: LibrarySimContext): void;
  /**
   * Initialize sim-side systems reusing pre-allocated SABs (e.g. allocated
   * on the renderer side and transferred to the sim worker via the seed).
   * Use this in the sim worker instead of `allocateBuffers()` + `initSim()`.
   */
  initSimWithExistingBuffers(buffers: Record<string, SharedArrayBuffer>, ctx: Omit<LibrarySimContext, "buffers">): void;
  /** Run all library tick functions for a given phase. */
  tickPhase(phase: LibraryTickPhase, tickCtx: LibrarySimTickContext): void;
  /**
   * Call `renderer.create` for all libraries that define it. Runs early,
   * before the WebGPU device is acquired. Use for renderer-only libraries
   * (host/worker setup that doesn't need the GPU). Optional — libraries
   * without `renderer.create` are skipped.
   */
  createRenderer(ctx: LibraryRendererCreateContext): void;
  /** Initialize renderer-side passes. Called during renderer init. */
  initRenderer(ctx: LibraryRendererInitContext): void;
  /** Set buffers on renderer-side passes. Called during renderer setBuffers. */
  setRendererBuffers(buffers: Record<string, SharedArrayBuffer>): void;
  /** Draw all renderer-side passes. Called per frame. */
  drawRenderer(ctx: LibraryRendererDrawContext): void;
  /** Dispose all sim-side systems. */
  disposeSim(): void;
  /** Dispose all renderer-side passes. */
  disposeRenderer(): void;
  /** Validate the library dependency graph (provides/requires). Called automatically in STRICT mode during initSim/initRenderer. */
  validateGraph(): void;
}
