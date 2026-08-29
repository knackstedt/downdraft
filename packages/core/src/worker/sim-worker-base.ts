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
//     Android WebView — see sab-polyfill.ts + buffer-sync.ts)
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
// references SharedArrayBuffer. On desktop/Electron this is a no-op.
import "../sab/sab-polyfill";
import { usingRealSAB } from "../sab/sab-polyfill";
import type { BufferSyncConfig, BufferSyncWorker } from "./buffer-sync";

import { expose, exposeEvents, type WorkerApi } from "./rpc";

export interface SimWorkerStats {
  fps: number;
  tick: number;
  frame: number;
}

export interface SimTickContext {
  /** Current tick count (incremented before each onTick call). */
  tickCount: number;
  /** Current frame count (incremented after each tick batch). */
  frameCount: number;
  /** Current FPS (updated once per second). */
  fps: number;
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
  /** Get the events emitter for sending events to the host. */
  events: { emit: (kind: string, data?: any) => void };
}

export interface CreateSimWorkerOptions {
  /** Fixed simulation timestep in seconds (e.g., 1/30 for 30Hz, 1/60 for 60Hz). */
  fixedDt: number;
  /** Maximum ticks per loop iteration (prevents death spiral). Default: 5. */
  maxStepsPerFrame?: number;

  /**
   * If true, the worker starts in paused mode. The renderer must call
   * resume() to begin simulation. Useful when save data must be loaded
   * before the sim starts (e.g. mining-rpg). Default: false.
   */
  startPaused?: boolean;

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
   * unavailable (Android WebView), a BufferSyncWorker is created that syncs
   * the declared write regions to the main thread after each tick batch.
   * The regions should declare which regions the WORKER writes (sim data,
   * stats, board) vs which it reads (input). See buffer-sync.ts.
   */
  onSyncConfig?: (sab: SharedArrayBuffer) => BufferSyncConfig;

  /**
   * Additional API methods to expose beyond the standard set.
   * e.g. { clear: () => { ... }, loadGrid: (grid, fields, w, h) => { ... } }
   */
  extraApi?: Record<string, (...args: any[]) => any>;
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
 *   ...extraApi — any additional methods
 */
export function createSimWorker(opts: CreateSimWorkerOptions): SimWorkerControl {
  const tickMs = opts.fixedDt * 1000;
  const maxStepsPerFrame = opts.maxStepsPerFrame ?? 5;

  let running = false;
  let loopActive = false;
  let stepInProgress = false;
  let paused = false;
  let stepOnce = false;
  let speedMultiplier = 1;
  let lastTick = 0;
  let tickAccumulator = 0;
  let tickCount = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let fps = 0;

  // SAB polyfill: buffer sync worker (only created when SAB is unavailable).
  let syncWorker: BufferSyncWorker | null = null;
  // setTimeout truncates fractional milliseconds (e.g. 32.333 → 32), losing
  // ~frac(tickMs) ms per iteration. For tickMs = 33.333 (30Hz), that's 0.333ms
  // per iteration — after ~100 iterations (~3.3s) the deficit reaches one full
  // tick, causing the accumulator to burst a 2-tick frame. This produces a
  // slow, periodic oscillation in the effective tick rate (and thus in
  // everything driven by dt: movement speed, drop spin, animation timing).
  // We accumulate the sub-ms remainder and add it back when it exceeds 1ms,
  // so the average setTimeout delay matches the desired interval exactly.
  let timerRemainder = 0;

  const events = exposeEvents();

  const control: SimWorkerControl = {
    pause: () => { paused = true; },
    resume: () => {
      paused = false;
      lastTick = performance.now();
      tickAccumulator = 0;
    },
    async withLoopStopped<T>(fn: () => Promise<T> | T): Promise<T> {
      // Stop the loop from scheduling another iteration.
      loopActive = false;
      // Wait for any in-flight onTick() to complete (max ~50ms).
      for (let i = 0; i < 50 && stepInProgress; i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      stepInProgress = false;
      try {
        return await fn();
      } finally {
        // Restart the loop.
        loopActive = true;
        lastTick = performance.now();
        tickAccumulator = 0;
        loop();
      }
    },
    events,
  };

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
          tickAccumulator += (elapsed / tickMs) * speedMultiplier;

          let steps = 0;
          const maxSteps = stepOnce ? 1 : maxStepsPerFrame;

          while (tickAccumulator >= 1 && steps < maxSteps) {
            tickCount++;
            stepInProgress = true;
            await opts.onTick(opts.fixedDt, { tickCount, frameCount, fps });
            stepInProgress = false;
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
            syncWorker?.syncToMain();
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
      // Compensate for setTimeout's integer truncation: accumulate the sub-ms
      // fractional part and add 1ms when it exceeds 1ms, so the average delay
      // matches the desired interval exactly. Without this, a fractional tickMs
      // (e.g. 33.333 for 30Hz) loses ~0.333ms per iteration to truncation,
      // causing a ~3.3s periodic oscillation in the effective tick rate.
      const remaining = tickMs - (performance.now() - now);
      const intRemaining = Math.max(0, Math.floor(remaining));
      timerRemainder += remaining - intRemaining;
      let delay = intRemaining;
      if (timerRemainder >= 1) {
        delay += 1;
        timerRemainder -= 1;
      }
      if (loopActive) setTimeout(loop, delay);
    } catch (e) {
      const err = e as Error;
      console.error(`[createSimWorker] Loop error: ${err.message}\n${err.stack}`);
      opts.onError?.(err);
      if (loopActive) setTimeout(loop, 100);
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
      events.emit("ready", {});
      loop();
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
      syncWorker = null; // release sync worker reference
      await opts.onShutdown?.();
    },

    async setSpeed(speed: number): Promise<void> {
      speedMultiplier = Math.max(0, speed);
    },

    async step(): Promise<void> {
      stepOnce = true;
      paused = false;
      lastTick = performance.now();
      tickAccumulator = 0;
    },

    getStats(): SimWorkerStats {
      return { fps, tick: tickCount, frame: frameCount };
    },
  };

  const api: WorkerApi = { ...standardApi, ...(opts.extraApi ?? {}) };
  expose(api);

  return control;
}
