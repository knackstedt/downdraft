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

  private running = false;
  private paused = false;
  private speed = 1.0;
  private tickAccumulator = 0;
  private tickCount = 0;
  private tickTimeAccum = 0;
  private lastTick = 0;
  private readonly tickMs: number;

  constructor(config: SimWorkerLoopConfig) {
    this.fixedDt = config.fixedDt;
    this.maxSpeed = config.maxSpeed;
    this.minSpeed = config.minSpeed;
    this.tickCb = config.tick;
    this.onAfterTicksCb = config.onAfterTicks ?? null;
    this.onErrorCb = config.onError ?? null;
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

  getTickCount(): number {
    return this.tickCount;
  }

  getTickTimeAccum(): number {
    return this.tickTimeAccum;
  }

  resetTickTimeAccum(): void {
    this.tickTimeAccum = 0;
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
            while (this.tickAccumulator >= 1) {
              const tickStart = performance.now();
              await this.tickCb(this.fixedDt);
              this.tickTimeAccum += performance.now() - tickStart;
              this.tickCount++;
              this.tickAccumulator--;
              ticksThisIteration++;
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

    setTimeout(this.loop, Math.max(1, this.tickMs - (performance.now() - now)));
  };
}
