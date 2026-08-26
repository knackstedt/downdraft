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
export interface LibrarySimSetup<C = unknown> {
  /**
   * Called once during sim worker init to create the sim-side system.
   * Receives the library config + the sim context (SABs, world, inject).
   * Returns the system instance (stored and passed to `tick()`).
   */
  create(config: C, ctx: LibrarySimContext): unknown;
  /**
   * Called each sim tick at the declared `tickPhase`.
   * Receives the system instance + tick context (dt, entities, etc.).
   */
  tick?(system: unknown, ctx: LibrarySimTickContext): void;
  /**
   * Called on sim shutdown / hot-reload dispose.
   */
  dispose?(system: unknown): void;
}

/** Context passed to `LibrarySimSetup.create()`. */
export interface LibrarySimContext {
  /** The SABs allocated for this library (keyed by channel name). */
  buffers: Record<string, SharedArrayBuffer>;
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
 * Renderer-side library wiring. Called from the renderer during `init()`
 * and `setBuffers()`.
 */
export interface LibraryRendererSetup<C = unknown> {
  /**
   * Called once during renderer init (after WebGPU device is ready).
   * Receives the GPU device, format, and library config.
   * Returns a renderer-side instance (stored and passed to `draw()`).
   */
  init?(config: C, ctx: LibraryRendererInitContext): unknown;
  /**
   * Called when SABs are set on the renderer (`setBuffers()`).
   * Receives the renderer instance from `init()` + the SABs.
   */
  setBuffers?(instance: unknown, buffers: Record<string, SharedArrayBuffer>): void;
  /**
   * Called per frame during the render pass.
   * Receives the renderer instance + frame context.
   */
  draw?(instance: unknown, ctx: LibraryRendererDrawContext): void;
  /**
   * Called on renderer dispose.
   */
  dispose?(instance: unknown): void;
}

/** Context for `LibraryRendererSetup.init()`. */
export interface LibraryRendererInitContext {
  device: GPUDevice;
  format: GPUTextureFormat;
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
 * export const WaterLib: EngineLibrary<WaterConfig> = {
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
 *     setBuffers(pass, buffers) { (pass as any).setReader(new WaterBufferReader(buffers.water)); },
 *     draw(pass, dctx) { (pass as any).execute(dctx.passEncoder); },
 *   },
 * };
 * ```
 */
export interface EngineLibrary<C = unknown> {
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
  sim?: LibrarySimSetup<C>;
  /** When in the sim tick to call `sim.tick()`. Default: "post-physics". */
  tickPhase?: LibraryTickPhase;

  // ── Renderer-side ──
  /** Renderer-side setup (pass creation + per-frame draw). Omit for sim-only. */
  renderer?: LibraryRendererSetup<C>;

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
  /** Run all library tick functions for a given phase. */
  tickPhase(phase: LibraryTickPhase, tickCtx: LibrarySimTickContext): void;
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
}
