// ============================================================================
// createSimWorker — helper for game sim worker entries.
//
// Handles the standard sim worker API: init, pause, resume, shutdown, setSpeed,
// step, getStats, resize. Games provide only onInit, onTick, and optional
// onResize/onAfterTicks/onShutdown.
//
// This enforces the standard API shape — consumers can't deviate. The helper
// handles:
//   - Tick loop with fixed-step accumulator + speed multiplier
//   - FPS tracking (per-second frame counter)
//   - frameCount + tickCount
//   - stepOnce (single-step mode: step once then pause)
//   - startPaused option (for workers that need to wait for save data before simulating)
//   - getStats() returning { fps, tick, frame }
//   - expose() wiring with the standard API
//   - "ready" event emission after onInit
//   - Error recovery (logs error, retries after 100ms)
//   - SAB polyfill buffer sync (when SharedArrayBuffer is unavailable, e.g.
//     polyfilled — see sab-polyfill.ts + buffer-sync.ts)
//
// Usage in a game worker entry:
//   createSimWorker({
//     fixedDt: 1/30,
//     onInit(sab, gridW, gridH) { ... },
//     onTick(dt, ctx) { ... },
//     onAfterTicks(ctx) { ... },  // once-per-frame writes (e.g. SAB upload)
//     onResize(gridW, gridH) { ... },
//     startPaused: true,          // start paused (e.g. wait for save data)
//     onSyncConfig(sab) { ... },  // buffer sync regions (SAB polyfill)
//     extraApi: { clear: () => { ... }, loadGrid: (...) => { ... } },
//   });
// ============================================================================

// Import the SAB polyfill FIRST — it must execute before any code that
// references SharedArrayBuffer. On hosts with real SABs this is a no-op.
import { flushProfilingTick, getWarningEngine, METRIC_TICK_LATENCY, recordTaskLatency } from "../profiling/worker-prelude";
import "../sab/sab-polyfill";
import { usingRealSAB } from "../sab/sab-polyfill";
import type { BufferSyncConfig, BufferSyncWorker } from "./buffer-sync";

import { mulberry32, type RngFn } from "../math/rng";
import type {
    ComponentSection,
    ISaveStore,
    LoadOptions,
    SaveMeta,
    SaveOptions,
    SaveState
} from "../save/persist-types";
import type {
    GCController
} from "../telemetry/gc-controller";
import { createLogger, setThreadTag } from "../util/logger";
import { expose, exposeEvents, type WorkerApi } from "./rpc";

const log = createLogger();

export interface SimWorkerStats {
  fps: number;
  tick: number;
  frame: number;
  /** Cumulative onTick wall time in ms — diff with tick to get avg tick cost. */
  tickMs: number;
}

/**
 * Detect deterministic/test mode inside a worker. `DOWNDRAFT_DETERMINISTIC`
 * reaches workers via `globalThis.__DOWNDRAFT_DETERMINISTIC__` (set by the
 * host before worker creation) or `process.env` (Bun/Node workers).
 */
function detectDeterministic(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.__DOWNDRAFT_DETERMINISTIC__) return true;
  try {
    return (g.process as { env?: Record<string, string> } | undefined)?.env
      ?.DOWNDRAFT_DETERMINISTIC === "1";
  } catch {
    return false;
  }
}

/**
 * Replace `Math.random` with a seeded-RNG-backed function that warns once per
 * callsite. In deterministic mode this makes stray `Math.random()` calls in
 * sim code deterministic (they draw from the same stream as `ctx.rng`) while
 * surfacing migration targets. Only installed when deterministic mode is on.
 */
function installDeterministicMathGuard(rng: RngFn): void {
  const warned = new Set<string>();
  const original = Math.random;
  Math.random = () => {
    const stack = new Error().stack ?? "";
    if (!warned.has(stack)) {
      warned.add(stack);
      const line = stack.split("\n")[1]?.trim() ?? "unknown callsite";
      log.warn(
        "createSimWorker",
        `Math.random() called in deterministic sim — use ctx.rng (from ${line})`,
      );
    }
    return rng();
  };
  // Restore path for tests / unusual host reuse.
  (Math.random as { __downdraftRestore?: () => void }).__downdraftRestore = () => {
    Math.random = original;
  };
}

export interface SimTickContext {
  /** Current tick count (incremented before each onTick call). */
  tickCount: number;
  /** Current frame count (incremented after each tick batch). */
  frameCount: number;
  /** Current FPS (updated once per second). */
  fps: number;
  /**
   * Seeded RNG (mulberry32) for deterministic randomness in sim code.
   * Seeded by `CreateSimWorkerOptions.seed` or `control.setSeed()` — prefer
   * this over `Math.random`, which is not deterministic across runs.
   */
  rng: RngFn;
}

export interface SimAfterTicksContext {
  /** Number of ticks executed in this frame iteration. */
  ticksThisFrame: number;
  /** Current tick count after all ticks this frame. */
  tickCount: number;
  /** Current frame count (incremented after this callback). */
  frameCount: number;
  /** Current FPS (updated once per second). */
  fps: number;
}

export interface SimWorkerControl {
  /** Pause the sim loop (internal use, e.g. from extraApi methods). */
  pause(): void;
  /** Resume the sim loop (resets accumulator to prevent catch-up spike). */
  resume(): void;
  /**
   * Stop the loop, wait for any in-flight onTick() to finish, then call the
   * callback. After the callback resolves, restart the loop. Use this from
   * onResize or extraApi methods that need to safely tear down + recreate
   * resources (e.g. SandStepPool) without racing with the tick loop.
   */
  withLoopStopped<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Current speed multiplier (after min/max clamping). */
  getSpeed(): number;
  /** Set the speed multiplier (clamped to minSpeed/maxSpeed). */
  setSpeed(speed: number): void;
  /**
   * Accumulated wall-clock ms spent inside onTick() since the last
   * resetTickTimeAccum(). Use for sim-CPU% diagnostics.
   */
  getTickTimeAccum(): number;
  /** Reset the tick-time accumulator (see getTickTimeAccum). */
  resetTickTimeAccum(): void;
  /** Current tick count. */
  getTickCount(): number;
  /**
   * Attach a GCController to the loop — it is offered post-tick headroom
   * for proactive collection each frame (same contract as
   * SimWorkerLoop.setGCController).
   */
  setGCController(ctrl: GCController | null): void;
  /**
   * Stop the loop permanently (e.g. from an uncaught-error handler).
   * After stop() the worker only responds to RPC — no more ticks.
   */
  stop(): void;
  /** Get the events emitter for sending events to the host. */
  events: { emit: (kind: string, data?: any) => void };
  /**
   * Reseed the deterministic RNG exposed as `ctx.rng`. Call from `onInit`
   * once the game's seed is known (e.g. `control.setSeed(simConfig.seed)`).
   * If `Math.random` was trapped (deterministic mode), the trap draws from
   * the reseeded stream too.
   */
  setSeed(seed: number): void;
}

export interface CreateSimWorkerOptions {
  /** Fixed simulation timestep in seconds (e.g., 1/30 for 30Hz, 1/60 for 60Hz). */
  fixedDt: number;
  /** Maximum ticks per loop iteration (prevents death spiral). Default: 5. */
  maxStepsPerFrame?: number;

  /** Minimum speed multiplier for setSpeed(). Default: 0. */
  minSpeed?: number;
  /** Maximum speed multiplier for setSpeed(). Default: unbounded. */
  maxSpeed?: number;

  /**
   * If true, the worker starts in paused mode. The renderer must call
   * resume() to begin simulation. Useful when save data must be loaded
   * before the sim starts (e.g. mining-rpg). Default: false.
   */
  startPaused?: boolean;

  /**
   * Seed for the deterministic RNG exposed as `ctx.rng` in `onTick`.
   * If the real seed only becomes known inside `onInit` (e.g. from
   * simConfig args), call `control.setSeed(seed)` there instead.
   */
  seed?: number;

  /**
   * Deterministic/test mode. When true, `Math.random` is replaced by a
   * seeded-RNG-backed shim that warns once per callsite — stray entropy in
   * sim code becomes deterministic AND visible. Default: auto-detected via
   * `__DOWNDRAFT_DETERMINISTIC__` / `process.env.DOWNDRAFT_DETERMINISTIC`.
   * Set explicitly to force on/off.
   */
  deterministic?: boolean;

  /**
   * Called once at init time. Receives the SharedArrayBuffer and any
   * additional args passed to the init() RPC. Set up the world, writer,
   * input views, etc. here. Throw to signal init failure.
   */
  onInit: (sab: SharedArrayBuffer, control: SimWorkerControl, ...args: any[]) => Promise<void> | void;

  /**
   * Called once per simulation tick. Receives the fixed dt (in seconds) and a
   * context object with current tickCount, frameCount, and fps.
   * Perform the sim step here. Throw to signal a tick error (the loop will
   * log it and retry after 100ms).
   */
  onTick: (dt: number, ctx: SimTickContext) => Promise<void> | void;

  /**
   * Called when the worker receives a resize() RPC. Optional.
   * Receives the args passed to resize().
   */
  onResize?: (...args: any[]) => Promise<void> | void;

  /**
   * Called when the worker receives a shutdown() RPC. Optional.
   * Clean up resources here.
   */
  onShutdown?: () => Promise<void> | void;

  /**
   * Called after each tick batch (all ticks for one frame iteration).
   * Use for once-per-frame writes (e.g. uploading the full SAB after all
   * catch-up ticks, rather than per-tick). Receives a context with
   * ticksThisFrame, tickCount, frameCount, and fps.
   *
   * Note: frameCount is incremented AFTER this callback, so the value
   * passed here is the count before this frame's increment.
   */
  onAfterTicks?: (ctx: SimAfterTicksContext) => void;

  /**
   * Called when the loop crashes with an unrecoverable error.
   */
  onError?: (err: Error) => void;

  /**
   * Returns the buffer sync config for the SAB polyfill (worker side).
   * Called after onInit with the SAB. If provided and SharedArrayBuffer is
   * unavailable, a BufferSyncWorker is created that syncs
   * the declared write regions to the main thread after each tick batch.
   * The regions should declare which regions the WORKER writes (sim data,
   * stats, board) vs which it reads (input). See buffer-sync.ts.
   */
  onSyncConfig?: (sab: SharedArrayBuffer) => BufferSyncConfig;

  /**
   * SAB polyfill throttled sync: names of "fast" write regions that should be
   * synced to the main thread EVERY tick batch (e.g. header, entities, drops).
   * Large "slow" regions (e.g. grid data) are only synced every
   * `onSyncSlowInterval` tick batches. This dramatically reduces per-tick copy
   * overhead on mobile (e.g. 18KB/tick instead of 1.78MB/tick).
   *
   * If omitted, ALL write regions are synced every tick batch (original behavior).
   */
  onSyncFastRegions?: string[];

  /**
   * How often (in tick batches) to sync ALL write regions (including slow
   * regions not listed in `onSyncFastRegions`). Default: 10. Only effective
   * when `onSyncFastRegions` is provided.
   */
  onSyncSlowInterval?: number;

  /**
   * Additional API methods to expose beyond the standard set.
   * e.g. { clear: () => { ... }, loadGrid: (grid, fields, w, h) => { ... } }
   */
  extraApi?: Record<string, (...args: any[]) => any>;

  /**
   * Save/load plumbing. When provided, the standard API gains the game
   * persistence contract shared by the worker-host save flow:
   *
   *   save(slotName, opts?)           → { slotName, stateJson, success, gen?, meta? }
   *   load(slotName, stateJson?, opts?) → boolean
   *   initSaveStore(storeOpts)        → creates + initializes the inline store
   *   restoreFromState(stateJson)     → applies a serialized payload directly
   *
   * `capture()` returns the component's data payload; it is wrapped in the
   * standard SaveState shape (components[componentName] = { v, data }) so
   * all save backends store the same format. The computed
   * SaveMeta (defaults merged with the `meta()` hook's extras) is returned
   * as `meta` so the renderer-side store can persist real metadata.
   * The emitted "saved" event carries `origin: "renderer"` — sim-initiated
   * saves (Simulation.save) emit without an origin so game handlers can
   * distinguish who must persist the payload.
   */
  save?: {
    /**
     * Serialize the sim's current state. When `componentName` is set this
     * returns that component's data payload (wrapped as `{ v, data }` under
     * `components[componentName]`); when omitted it returns the full
     * components map directly (multi-component games).
     *
     * Optional — omit for push-model games where the renderer captures state
     * itself (e.g. reads the SAB) and only pushes data in on load. When
     * omitted, save()/captureState() are not exposed.
     */
    capture?: () => unknown | Promise<unknown>;
    /**
     * Binary payloads that accompany the JSON capture (typed-array state like
     * grids/chunks that isn't JSON-expressible). Called immediately after
     * capture() — with no sim tick able to interleave — so the two can share
     * a captured snapshot via a worker-local variable. The blobs flow to
     * ISaveStore.save() via SaveOptions.blobs (worker-owned stores) and are
     * returned from captureState() (renderer-owned stores).
     */
    captureBlobs?: () => Record<string, ArrayBuffer> | Promise<Record<string, ArrayBuffer>>;
    /**
     * Apply a previously captured payload. Called with the loop stopped
     * (withLoopStopped) so the sim can't tick mid-restore. Receives the
     * component data (componentName set) or the full parsed payload, plus
     * any binary blobs from the SaveState (grid/chunk payloads that aren't
     * JSON-expressible).
     */
    restore?: (data: unknown, blobs?: Record<string, ArrayBuffer>) => void | Promise<void>;
    /**
     * Component key under SaveState.components (e.g. "sandbox"). Omit when
     * capture() returns the whole components map.
     */
    componentName?: string;
    /** Schema version stamped on the component section. Default: 1. */
    version?: number;
    /**
     * Factory for an inline save store (e.g. `(o) => new OpfsSaveStore(o)`).
     * Injectable because OpfsSaveStore lives in libraries/persistence —
     * core must not import it. When omitted, save() still returns the
     * stateJson for the caller's own store path.
     */
    createStore?: (opts: unknown) => ISaveStore & { init?: () => Promise<void> };
    /**
     * Extra SaveState.meta fields. Receives the captured payload and the
     * caller's SaveOptions (e.g. to forward engineVersion from
     * saveOpts.properties).
     */
    meta?: (data: unknown, saveOpts?: SaveOptions) => Partial<SaveMeta>;
  };

  /**
   * Command dispatch. When provided, the standard API gains
   * sendCommand(cmd) which forwards to this handler.
   */
  onCommand?: (cmd: unknown) => void | Promise<void>;

  /**
   * Wrap the exposed API with devtools + profiling RPC methods
   * (__devtoolsGetManifest, __profilingAttach, etc.). When provided, the
   * function is called with the assembled API and its return value is passed
   * to expose(). Use this to add devtools + profiling RPC methods:
   *
   *   wrapExpose: (api) => exposeDevToolsApi(api)
   *
   * Default: undefined (expose(api) is called directly).
   */
  wrapExpose?: (api: WorkerApi) => WorkerApi;
}

/**
 * Creates and starts a sim worker with the standard API.
 * Call this at the top level of a game's worker entry file.
 *
 * The exposed API is:
 *   init(sab, ...args) — calls onInit, starts the loop, emits "ready"
 *   resize(...args) — calls onResize
 *   pause() — pauses the loop
 *   resume() — resumes the loop (resets accumulator to prevent catch-up spike)
 *   shutdown() — stops the loop, calls onShutdown
 *   setSpeed(speed) — sets the speed multiplier (0 = paused)
 *   step() — single-steps (runs 1 tick then pauses)
 *   getStats() — returns { fps, tick, frame }
 *   save/load/initSaveStore/restoreFromState — when opts.save is provided
 *   sendCommand(cmd) — when opts.onCommand is provided
 *   ...extraApi — any additional methods
 */
export function createSimWorker(opts: CreateSimWorkerOptions): SimWorkerControl {
  // Thread tag for log prefixes — this file runs in the sim worker realm.
  // Games that run multiple sims (e.g. falling-sand's per-layer workers)
  // set their own tag (S0/S1/...) after this default.
  if (!(globalThis as any).__ddThreadTag) setThreadTag("S0");

  const tickMs = opts.fixedDt * 1000;
  const maxStepsPerFrame = opts.maxStepsPerFrame ?? 5;

  let running = false;
  let loopActive = false;
  let paused = false;
  let stepOnce = false;
  let speedMultiplier = 1;
  let lastTick = 0;
  let tickAccumulator = 0;
  let tickCount = 0;
  let tickTimeAccum = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let fps = 0;

  // SAB polyfill: buffer sync worker (only created when SAB is unavailable).
  let syncWorker: BufferSyncWorker | null = null;
  // SAB polyfill: throttled sync counter. When onSyncFastRegions is provided,
  // fast regions are synced every tick batch, and ALL regions (including slow
  // ones) are synced every onSyncSlowInterval tick batches.
  let syncSlowCounter = 0;
  const syncSlowInterval = opts.onSyncSlowInterval ?? 10;

  // Inline save store (created by initSaveStore() via opts.save.createStore).
  let saveStore: (ISaveStore & { init?: () => Promise<void> }) | null = null;

  // Optional GC controller — offered post-tick headroom each frame.
  let gcController: GCController | null = null;

  /**
   * Extract the restore payload from a serialized state. Handles all three
   * wire forms: raw data, a components map (`{ name: { v, data } }`), and a
   * full SaveState (`{ components: { name: { v, data } } }`). When
   * componentName is omitted the components map / raw payload is returned
   * as-is for multi-component games.
   */
  const extractRestoreData = (parsed: any): unknown => {
    const name = opts.save!.componentName;
    if (!name) return parsed?.components ?? parsed;
    return (
      parsed?.components?.[name]?.data ??
      (parsed?.[name]?.data !== undefined ? parsed[name].data : parsed)
    );
  };
  const syncFastRegions = opts.onSyncFastRegions;
  // setTimeout truncates fractional milliseconds (e.g. 32.333 → 32), losing
  // ~frac(tickMs) ms per iteration. For tickMs = 33.333 (30Hz), that's 0.333ms
  // per iteration — after ~100 iterations (~3.3s) the deficit reaches one full
  // tick, causing the accumulator to burst a 2-tick frame. This produces a
  // slow, periodic oscillation in the effective tick rate (and thus in
  // everything driven by dt: movement speed, drop spin, animation timing).
  // We accumulate the sub-ms remainder and add it back when it exceeds 1ms,
  // so the average setTimeout delay matches the desired interval exactly.
  let timerRemainder = 0;

  // The single armed loop timer — loop() schedules through scheduleLoop so
  // withLoopStopped/stop/shutdown can disarm it. Without this, stopping the
  // loop left a pending setTimeout that fired after the stop and spawned a
  // second parallel loop chain.
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  // Promise for the in-flight onTick() call — the real barrier
  // withLoopStopped waits on (the old code polled a flag for ~50ms then
  // proceeded anyway, letting a suspended tick race the critical section).
  let tickInFlight: Promise<void> | null = null;
  // Serializes withLoopStopped critical sections.
  let stopChain: Promise<unknown> = Promise.resolve();

  const events = exposeEvents();

  // Deterministic RNG — reseedable via control.setSeed(); the stable `rng`
  // closure is what ctx.rng and the Math.random shim draw from.
  let rngImpl = mulberry32(opts.seed ?? 0x9e3779b9);
  const rng: RngFn = () => rngImpl();
  const deterministic = opts.deterministic ?? detectDeterministic();
  if (deterministic) {
    installDeterministicMathGuard(rng);
  }

  const control: SimWorkerControl = {
    pause: () => { paused = true; },
    setSeed: (seed: number) => { rngImpl = mulberry32(seed); },
    resume: () => {
      paused = false;
      lastTick = performance.now();
      tickAccumulator = 0;
    },
    async withLoopStopped<T>(fn: () => Promise<T> | T): Promise<T> {
      // Serialize concurrent callers — a second caller queues behind the
      // first's stop → critical section → restart cycle.
      const run = stopChain.then(async (): Promise<T> => {
        // Stop the loop from scheduling another iteration AND disarm the
        // pending one — an armed setTimeout that fires while loopActive was
        // already restored used to spawn a second parallel loop chain.
        loopActive = false;
        clearLoopTimer();
        // Hard barrier: if onTick is mid-flight, wait for it to actually
        // return. Its continuation observes loopActive === false and exits
        // before touching the accumulator or rescheduling. No timeout —
        // running fn() while a tick still mutates state is exactly the
        // race this exists to prevent.
        if (tickInFlight) await tickInFlight.catch(() => {});
        try {
          return await fn();
        } finally {
          // Restart the loop — unless shutdown landed while we held the
          // barrier (running === false is the permanent stop signal).
          if (running) {
            loopActive = true;
            lastTick = performance.now();
            tickAccumulator = 0;
            void loop();
          }
        }
      });
      // Keep the chain alive across failures in fn().
      stopChain = run.then(() => undefined, () => undefined);
      return run;
    },
    getSpeed: () => speedMultiplier,
    setSpeed: (speed: number) => {
      speedMultiplier = Math.min(
        opts.maxSpeed ?? Infinity,
        Math.max(opts.minSpeed ?? 0, speed),
      );
    },
    getTickTimeAccum: () => tickTimeAccum,
    resetTickTimeAccum: () => { tickTimeAccum = 0; },
    getTickCount: () => tickCount,
    setGCController: (ctrl: GCController | null) => { gcController = ctrl; },
    stop: () => { running = false; loopActive = false; clearLoopTimer(); },
    events,
  };

  /** Arm the next loop iteration — the ONLY place a loop timer is created. */
  function scheduleLoop(delay: number): void {
    if (!loopActive) return;
    if (loopTimer !== null) clearTimeout(loopTimer); // never stack timers
    loopTimer = setTimeout(() => {
      loopTimer = null;
      void loop();
    }, delay);
  }

  function clearLoopTimer(): void {
    if (loopTimer !== null) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
  }

  async function loop(): Promise<void> {
    if (!running || !loopActive) return;

    try {
      const now = performance.now();
      const elapsed = now - lastTick;

      if (elapsed >= tickMs) {
        lastTick = now - (elapsed % tickMs);

        if (!paused || stepOnce) {
          // Only accumulate sim time when actually stepping. While paused,
          // lastTick still advances (above) so we don't get a huge elapsed
          // spike on resume, but we must NOT let tickAccumulator build up.
          //
          // Credit only WHOLE tick periods: the fractional remainder stays
          // owed in lastTick's phase (the snap above) and is re-measured as
          // part of the next elapsed. Crediting elapsed/tickMs fractionally
          // here AND keeping the remainder in lastTick counts it twice —
          // every late-timer remainder leaks ~its size in extra sim time,
          // so the sim ran measurably fast under timer jitter.
          tickAccumulator += Math.floor(elapsed / tickMs) * speedMultiplier;

          let steps = 0;
          const maxSteps = stepOnce ? 1 : maxStepsPerFrame;

          while (tickAccumulator >= 1 && steps < maxSteps) {
            tickCount++;
            const tickStart = performance.now();
            const tick = Promise.resolve(
              opts.onTick(opts.fixedDt, { tickCount, frameCount, fps, rng }),
            );
            tickInFlight = tick;
            try {
              await tick;
            } finally {
              tickInFlight = null;
            }
            const tickDurationUs = (performance.now() - tickStart) * 1000;
            tickTimeAccum += tickDurationUs / 1000;
            // Record task latency for the flame graph + histogram
            recordTaskLatency("js", tickDurationUs, "tick");
            // Fire instantaneous tick-latency warning (if configured)
            getWarningEngine()?.checkInstant(METRIC_TICK_LATENCY, tickDurationUs);
            if (!loopActive) return; // resize/withLoopStopped interrupted
            tickAccumulator -= 1;
            steps++;
          }

          // Clamp accumulator if we hit the step cap (death spiral prevention)
          if (tickAccumulator > maxStepsPerFrame) {
            tickAccumulator = 0;
          }

          if (stepOnce) {
            stepOnce = false;
            paused = true;
            tickAccumulator = 0;
          }

          // Once-per-frame callback (after all ticks this frame)
          if (steps > 0) {
            opts.onAfterTicks?.({
              ticksThisFrame: steps,
              tickCount,
              frameCount,
              fps,
            });

            // SAB polyfill: sync written regions to the main thread after
            // each tick batch. No-op when real SAB is available (desktop).
            // When onSyncFastRegions is provided, use throttled sync:
            //   - Every tick batch: sync only fast regions (header, entities)
            //   - Every N tick batches: sync ALL regions (including grids)
            if (syncWorker) {
              if (syncFastRegions) {
                syncWorker.syncToMain(syncFastRegions);
                syncSlowCounter++;
                if (syncSlowCounter >= syncSlowInterval) {
                  syncWorker.syncToMain();
                  syncSlowCounter = 0;
                }
              } else {
                syncWorker.syncToMain();
              }
            }

            // Flush profiling data (ThreadMetrics + EventLoop + instant warnings)
            flushProfilingTick();
          }
        }

        // Offer post-tick headroom to the GC controller for proactive
        // collection (same contract as SimWorkerLoop).
        if (gcController) {
          const headroom = tickMs - (performance.now() - now);
          if (headroom > 0) {
            gcController.maybeCollect(headroom, tickMs);
          }
        }
      }

      frameCount++;
      fpsTimer += elapsed;
      if (fpsTimer >= 1000) {
        fps = Math.round((frameCount * 1000) / fpsTimer);
        frameCount = 0;
        fpsTimer = 0;
      }

      // Sleep until the next tick is due instead of spinning with setTimeout(0).
      // The deadline is phase-aligned: lastTick holds the fractional
      // `elapsed % tickMs` remainder from the snap above, so the next tick is
      // due at lastTick + tickMs — NOT a fresh tickMs from now. Sleeping a
      // whole tickMs per iteration discards that remainder: whenever the
      // remainder + timer jitter was smaller than this iteration's work, the
      // loop woke before the deadline, did nothing, and slept another full
      // tickMs — producing alternating normal/doubled tick intervals.
      // If the accumulator still holds owed ticks (step cap was hit), they're
      // spent on the next due iteration — the backlog is clamped to
      // maxStepsPerFrame so a deadline wait is never more than ~tickMs.
      const remaining = lastTick + tickMs - performance.now();
      // Compensate for setTimeout's integer truncation: accumulate the sub-ms
      // fractional part and add 1ms when it exceeds 1ms, so the average delay
      // matches the desired interval exactly. Without this, a fractional tickMs
      // (e.g. 33.333 for 30Hz) loses ~0.333ms per iteration to truncation,
      // causing a ~3.3s periodic oscillation in the effective tick rate.
      const intRemaining = Math.max(0, Math.floor(remaining));
      timerRemainder += remaining - intRemaining;
      let delay = intRemaining;
      if (timerRemainder >= 1) {
        delay += 1;
        timerRemainder -= 1;
      }
      scheduleLoop(delay);
    } catch (e) {
      const err = e as Error;
      log.error("createSimWorker", `Loop error: ${err.message}\n${err.stack}`);
      opts.onError?.(err);
      scheduleLoop(100);
    }
  }

  const standardApi: WorkerApi = {
    async init(sab: SharedArrayBuffer, ...args: any[]): Promise<void> {
      await opts.onInit(sab, control, ...args);

      // SAB polyfill: set up buffer sync if SAB is unavailable and the game
      // provided a sync config. The BufferSyncWorker posts written regions
      // to the main thread after each tick batch (see syncToMain() above).
      if (!usingRealSAB && opts.onSyncConfig) {
        const { BufferSyncWorker: BSW } = await import("./buffer-sync");
        syncWorker = new BSW(opts.onSyncConfig(sab));
        syncWorker.start();
        // Sync initial state (e.g. board data written during onInit) to the
        // main thread immediately — the sim may be paused at startup and
        // syncToMain() won't be called until the first tick batch.
        syncWorker.syncToMain();
      }

      running = true;
      loopActive = true;
      paused = opts.startPaused ?? false;
      stepOnce = false;
      speedMultiplier = 1;
      lastTick = performance.now();
      tickAccumulator = 0;
      tickCount = 0;
      frameCount = 0;
      fpsTimer = 0;
      fps = 0;
      timerRemainder = 0;
      clearLoopTimer();
      events.emit("ready", {});
      void loop();
    },

    async resize(...args: any[]): Promise<void> {
      if (!opts.onResize) return;
      // Use withLoopStopped to safely pause the loop during resize.
      // This prevents races between onTick() and onResize() when both
      // access shared resources (e.g. SandStepPool).
      await control.withLoopStopped(() => opts.onResize!(...args));
    },

    async pause(): Promise<void> {
      paused = true;
    },

    async resume(): Promise<void> {
      paused = false;
      lastTick = performance.now();
      tickAccumulator = 0; // prevent catch-up spike after resume
    },

    async shutdown(): Promise<void> {
      running = false;
      loopActive = false;
      clearLoopTimer();
      syncWorker = null; // release sync worker reference
      saveStore = null;
      await opts.onShutdown?.();
    },

    async setSpeed(speed: number): Promise<void> {
      speedMultiplier = Math.min(
        opts.maxSpeed ?? Infinity,
        Math.max(opts.minSpeed ?? 0, speed),
      );
    },

    async step(): Promise<void> {
      stepOnce = true;
      paused = false;
      lastTick = performance.now();
      tickAccumulator = 0;
    },

    getStats(): SimWorkerStats {
      return { fps, tick: tickCount, frame: frameCount, tickMs: tickTimeAccum };
    },

    ...(opts.save?.capture
      ? {
          async save(
            slotName: string,
            saveOpts?: SaveOptions,
          ): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number; meta?: SaveMeta }> {
            const data = await opts.save!.capture!();
            const capturedBlobs = await opts.save!.captureBlobs?.();
            // Always wrap in SaveState.components format so every backend
            // stores the state in the expected component format —
            // FileSaveStore.load() expects each component to have a
            // { v, data } structure.
            const name = opts.save!.componentName;
            const components: Record<string, ComponentSection> = name
              ? { [name]: { v: opts.save!.version ?? 1, data } }
              : (data as Record<string, ComponentSection>);
            const metaExtra = opts.save!.meta?.(data, saveOpts);
            const saveStateObj: SaveState = {
              components,
              meta: {
                engineVersion: "0.0.0",
                timestamp: Date.now() / 1000,
                entityCount: 0,
                playerCount: 0,
                ...metaExtra,
              },
            };
            const stateJson = JSON.stringify(saveStateObj.components);
            let gen: number | undefined;
            let success = true;
            if (saveStore) {
              const result = await saveStore.save(slotName, saveStateObj, {
                ...saveOpts,
                blobs: capturedBlobs ?? saveOpts?.blobs,
              });
              success = result.success;
              gen = result.gen;
            }
            events.emit("saved", { slotName, stateJson, success, gen, meta: saveStateObj.meta, origin: "renderer" });
            return { slotName, stateJson, success, gen, meta: saveStateObj.meta };
          },

          /**
           * Raw capture payload — no store interaction. Lets a
           * renderer-owned save system (createGameSaveSystem) pull the
           * worker's state and embed it in its own SaveState. Binary
           * payloads (typed arrays) come back in `blobs`, transferred via
           * structured clone.
           */
          async captureState(): Promise<{ stateJson: string; blobs?: Record<string, ArrayBuffer> }> {
            const data = await opts.save!.capture!();
            const blobs = await opts.save!.captureBlobs?.();
            return { stateJson: JSON.stringify(data), blobs };
          },
        }
      : {}),

    ...(opts.save?.restore
      ? {
          async load(
            slotName: string,
            stateJson?: string,
            loadOpts?: LoadOptions,
          ): Promise<boolean> {
            let json = stateJson;
            let blobs: Record<string, ArrayBuffer> | undefined;
            let gen: number | undefined;
            if (!json && saveStore) {
              const result = await saveStore.load(slotName, loadOpts);
              const payload = opts.save!.componentName
                ? result.state?.components?.[opts.save!.componentName]?.data
                : result.state?.components;
              if (payload !== undefined && payload !== null) {
                json = JSON.stringify(payload);
                blobs = result.blobs;
                gen = result.gen;
              }
            }
            if (!json) {
              events.emit("loaded", { slotName, success: false });
              return false;
            }
            let data: unknown = json;
            try {
              data = extractRestoreData(JSON.parse(json));
            } catch {
              // not JSON — pass through as-is
            }
            // Stop the loop during restore — mutating sim state while a tick
            // is in flight is a data race.
            await control.withLoopStopped(() => opts.save!.restore!(data, blobs));
            events.emit("loaded", { slotName, success: true, gen });
            return true;
          },

          async restoreFromState(
            stateJson: string,
            blobs?: Record<string, ArrayBuffer>,
          ): Promise<void> {
            let data: unknown = stateJson;
            try {
              data = extractRestoreData(JSON.parse(stateJson));
            } catch {
              // not JSON — pass through as-is
            }
            await control.withLoopStopped(() => opts.save!.restore!(data, blobs));
          },
        }
      : {}),

    ...(opts.save?.createStore
      ? {
          async initSaveStore(storeOpts: unknown): Promise<void> {
            saveStore = opts.save!.createStore!(storeOpts);
            await saveStore.init?.();
          },
        }
      : {}),

    ...(opts.onCommand
      ? {
          async sendCommand(cmd: unknown): Promise<void> {
            await opts.onCommand!(cmd);
          },
        }
      : {}),
  };

  const api: WorkerApi = { ...standardApi, ...(opts.extraApi ?? {}) };

  // Optionally wrap the API before exposing (e.g. with exposeDevToolsApi
  // to add devtools + profiling RPC methods).
  expose(opts.wrapExpose ? opts.wrapExpose(api) : api);

  return control;
}
