import type { GameWorld } from "./world";

export type RenderCallback = (alpha: number) => void;

export interface GameLoopConfig {
  /** Fixed simulation timestep in seconds (e.g., 1/60 for 60Hz). */
  fixedDt: number;
  /** Maximum simulation steps per frame to prevent the spiral of death. */
  maxStepsPerFrame: number;
  /** Optional render callback invoked once per frame with interpolation alpha. */
  onRender?: RenderCallback;
}

export interface GameLoopStats {
  fps: number;
  simSteps: number;
  alpha: number;
  accumulator: number;
}

/**
 * Unified game loop that coordinates fixed-timestep simulation with rendering.
 *
 * Uses an accumulator pattern:
 * 1. Each frame, measure wall-clock delta time.
 * 2. Accumulate delta into the accumulator.
 * 3. While the accumulator >= fixedDt, run a simulation step.
 * 4. Cap steps at maxStepsPerFrame to prevent the spiral of death.
 * 5. Compute interpolation alpha = accumulator / fixedDt.
 * 6. Render once per frame, passing alpha for interpolation.
 *
 * The render callback (if provided) is invoked once per frame after
 * simulation steps, receiving the interpolation alpha.
 */
export class GameLoop {
  private gameWorld: GameWorld;
  private renderCb: RenderCallback | null;
  private fixedDt: number;
  private maxSteps: number;
  private running: boolean = false;
  private rafId: number = 0;
  private accumulator: number = 0;
  private alpha: number = 0;
  private lastTime: number = 0;
  private frameCount: number = 0;
  private fpsTimer: number = 0;
  private fps: number = 0;
  private lastSimSteps: number = 0;

  constructor(gameWorld: GameWorld, config: GameLoopConfig) {
    this.gameWorld = gameWorld;
    this.renderCb = config.onRender ?? null;
    this.fixedDt = config.fixedDt;
    this.maxSteps = config.maxStepsPerFrame;
  }

  /** Start the unified game loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.accumulator = 0;
    this.lastTime = performance.now();

    // Only start the RAF loop if requestAnimationFrame is available
    // (not in test environments like bun test).
    if (typeof requestAnimationFrame !== "undefined") {
      this.loop();
    }
  }

  /** Stop the unified game loop. */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Interpolation alpha for the current frame (0.0 to 1.0). */
  getAlpha(): number {
    return this.alpha;
  }

  /** Current FPS estimate. */
  getFPS(): number {
    return this.fps;
  }

  /** Number of simulation steps executed in the last frame. */
  getLastSimSteps(): number {
    return this.lastSimSteps;
  }

  /** Current accumulator value (remaining un-simulated time). */
  getAccumulator(): number {
    return this.accumulator;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get the fixed simulation timestep. */
  getFixedDt(): number {
    return this.fixedDt;
  }

  /** Update the fixed simulation timestep. */
  setFixedDt(dt: number): void {
    this.fixedDt = dt;
    this.accumulator = 0;
  }

  /** Update the max steps per frame. */
  setMaxStepsPerFrame(max: number): void {
    this.maxSteps = max;
  }

  /** Get the max steps per frame. */
  getMaxStepsPerFrame(): number {
    return this.maxSteps;
  }

  /** Attach or detach a render callback at runtime. */
  setRenderCallback(cb: RenderCallback | null): void {
    this.renderCb = cb;
  }

  getStats(): GameLoopStats {
    return {
      fps: this.fps,
      simSteps: this.lastSimSteps,
      alpha: this.alpha,
      accumulator: this.accumulator,
    };
  }

  /**
   * Run one frame of simulation + rendering with a given delta time (seconds).
   * Returns the number of simulation steps executed.
   *
   * Can be called directly for testing or external loop driving (no RAF).
   */
  runFrame(frameDt: number): number {
    // Cap frame delta at 250ms to avoid huge jumps after tab switches.
    const dt = Math.min(frameDt, 0.25);

    // FPS counter
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // Fixed-timestep simulation with catch-up
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSteps) {
      this.gameWorld.step(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }

    // Spiral-of-death protection: if we still have too much accumulated time,
    // drop it to prevent unbounded catch-up.
    if (this.accumulator > this.fixedDt * this.maxSteps) {
      this.accumulator = 0;
    }

    this.lastSimSteps = steps;

    // Interpolation alpha: how far between sim steps we are (0.0 to ~1.0)
    this.alpha = this.fixedDt > 0 ? this.accumulator / this.fixedDt : 0;
    this.gameWorld.resources.alpha = this.alpha;

    // Render once per frame
    if (this.renderCb) {
      this.renderCb(this.alpha);
    }

    return steps;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    this.runFrame(frameDt);
  };
}
