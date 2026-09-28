// DORMANT — no live consumers; frame timing is owned by GameRenderer and
// the native host's rAF driver. Retained only for the core/index.ts
// re-export until deletion (Phase 7 of
// docs/refactor/native-rearchitecture-plan.md).
export class HighResTimer {
  private lastTime: number = 0;
  private frameCount: number = 0;
  private fps: number = 0;
  private fpsAccum: number = 0;
  private fpsTimer: number = 0;

  constructor() {
    this.lastTime = performance.now();
  }

  reset(): void {
    this.lastTime = performance.now();
  }

  delta(): number {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    return dt;
  }

  tick(dt: number): void {
    this.frameCount++;
    this.fpsTimer += dt;
    this.fpsAccum++;
    if (this.fpsTimer >= 1.0) {
      this.fps = this.fpsAccum / this.fpsTimer;
      this.fpsTimer = 0;
      this.fpsAccum = 0;
    }
  }

  getFPS(): number {
    return this.fps;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  static now(): number {
    return performance.now();
  }

  static nowNs(): bigint {
    if (typeof process !== "undefined" && process.hrtime) {
      return process.hrtime.bigint();
    }
    return BigInt(Math.floor(performance.now() * 1_000_000));
  }
}
