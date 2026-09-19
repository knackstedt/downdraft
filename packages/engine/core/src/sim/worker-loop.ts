// ============================================================================
// SimWorkerLoop — reusable setTimeout-based simulation loop for Web Workers.
//
// Supports dynamic sim speed via a hybrid approach:
//   speed > 1x: tick multiplier (N ticks per iteration, dt stays fixed)
//   speed < 1x: variable dt (1 tick per iteration with scaled dt)
//   speed = 0:  paused (no ticks)
//
// Games provide an async tick callback and an optional event-drain callback.
// The loop handles speed control, tick counting, and error recovery.
// ============================================================================

import type { GCController } from "../telemetry/gc-controller";

export interface SimWorkerLoopConfig {
  /** Fixed simulation timestep in seconds (e.g., 1/60 for 60Hz). */
  fixedDt: number;
  /** Maximum sim speed multiplier (tick multiplier cap). */
  maxSpeed: number;
  /** Minimum sim speed (0 = paused). */
  minSpeed: number;
  /**
   * Async tick callback. Receives the dt for this tick.
   * For speed-up, called N times per loop iteration with dt=fixedDt.
   * For slow-down, called once per loop iteration with dt=fixedDt*speed.
   */
  tick: (dt: number) => Promise<void>;
  /**
   * Called after each tick in slow-down mode, or once after all ticks
   * in speed-up mode. Use this to drain and forward events.
   * Receives the number of ticks executed in this iteration.
   */
  onAfterTicks?: (tickCount: number) => void;
  /** Called when the loop crashes with an unrecoverable error. */
  onError?: (err: Error) => void;
  /** Optional GC controller for proactive GC during post-tick headroom. */
  gcController?: GCController;
}

export interface SimWorkerLoopStats {
  tickCount: number;
  tickTimeAccum: number;
  speed: number;
  paused: boolean;
  running: boolean;
}

export class SimWorkerLoop {
  private fixedDt: number;
  private maxSpeed: number;
  private minSpeed: number;
  private tickCb: (dt: number) => Promise<void>;
  private onAfterTicksCb: ((tickCount: number) => void) | null;
  private onErrorCb: ((err: Error) => void) | null;
  private gcController: GCController | null;

  private running = false;
  private paused = false;
  private speed = 1.0;
  private tickAccumulator = 0;
  private tickCount = 0;
  private tickTimeAccum = 0;
  private lastTick = 0;
  private readonly tickMs: number;
  // Maximum ticks per loop iteration when speed > 1x. Prevents sim-death-spiral
  // when the sim falls behind real-time (each tick takes longer than tickMs).
  private maxStepsPerFrame = 5;
  /** Last time the clamp warning was emitted (rate-limited to 1 per 5s). */
  private lastClampWarn = -Infinity;

  constructor(config: SimWorkerLoopConfig) {
    this.fixedDt = config.fixedDt;
    this.maxSpeed = config.maxSpeed;
    this.minSpeed = config.minSpeed;
    this.tickCb = config.tick;
    this.onAfterTicksCb = config.onAfterTicks ?? null;
    this.onErrorCb = config.onError ?? null;
    this.gcController = config.gcController ?? null;
    this.tickMs = config.fixedDt * 1000; // ms per tick at 1x (e.g. 1/60 * 1000 = 16.67ms)
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
  }

  pause(): void {
    this.paused = true;
    this.gcController?.collectMajor();
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSpeed(): number {
    return this.speed;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(this.minSpeed, Math.min(this.maxSpeed, speed));
    this.tickAccumulator = 0;
  }

  setMaxStepsPerFrame(max: number): void {
    this.maxStepsPerFrame = Math.max(1, Math.floor(max));
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getTickTimeAccum(): number {
    return this.tickTimeAccum;
  }

  resetTickTimeAccum(): void {
    this.tickTimeAccum = 0;
  }

  /** Attach or detach a GC controller at runtime. */
  setGCController(ctrl: GCController | null): void {
    this.gcController = ctrl;
  }

  getStats(): SimWorkerLoopStats {
    return {
      tickCount: this.tickCount,
      tickTimeAccum: this.tickTimeAccum,
      speed: this.speed,
      paused: this.paused,
      running: this.running,
    };
  }

  private loop = async (): Promise<void> => {
    if (!this.running) return;

    const now = performance.now();
    if (now - this.lastTick >= this.tickMs) {
      this.lastTick = now - ((now - this.lastTick) % this.tickMs);

      if (!this.paused && this.speed > 0) {
        try {
          if (this.speed < 1.0) {
            // Variable dt: 1 tick per iteration with scaled dt (slow-motion)
            const dt = this.fixedDt * this.speed;
            const tickStart = performance.now();
            await this.tickCb(dt);
            this.tickTimeAccum += performance.now() - tickStart;
            this.tickCount++;
            this.onAfterTicksCb?.(1);
          } else {
            // Tick multiplier: N ticks per iteration with dt=fixedDt (speed-up)
            this.tickAccumulator += this.speed;
            let ticksThisIteration = 0;
            while (this.tickAccumulator >= 1 && ticksThisIteration < this.maxStepsPerFrame) {
              const tickStart = performance.now();
              await this.tickCb(this.fixedDt);
              this.tickTimeAccum += performance.now() - tickStart;
              this.tickCount++;
              this.tickAccumulator--;
              ticksThisIteration++;
            }
            // If we hit the cap, the sim is falling behind — clamp the accumulator
            // to prevent a death spiral where each frame tries to catch up more.
            if (this.tickAccumulator >= 1) {
              // Rate-limit: under sustained overload this would otherwise warn
              // every iteration, and console I/O makes the overload worse.
              const nowMs = performance.now();
              if (nowMs - this.lastClampWarn > 5000) {
                this.lastClampWarn = nowMs;
                console.warn(`[SimWorkerLoop] Clamped to ${this.maxStepsPerFrame} ticks this frame (sim falling behind, accumulator=${this.tickAccumulator.toFixed(1)})`);
              }
              this.tickAccumulator = 0;
            }
            this.onAfterTicksCb?.(ticksThisIteration);
          }
        } catch (err) {
          const error = err as Error;
          console.error(`[SimWorkerLoop] Tick crashed at tick ${this.tickCount}: ${error.message}\n${error.stack}`);
          this.onErrorCb?.(error);
          this.running = false;
          return;
        }
      }
    }

    // Offer post-tick headroom to the GC controller for proactive collection
    if (this.gcController) {
      const tickEnd = performance.now();
      const tickDuration = tickEnd - now;
      const headroom = this.tickMs - tickDuration;
      if (headroom > 0) {
        this.gcController.maybeCollect(headroom, this.tickMs);
      }
    }

    setTimeout(this.loop, Math.max(1, this.tickMs - (performance.now() - now)));
  };
}
