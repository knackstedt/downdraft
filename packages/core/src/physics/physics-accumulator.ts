/**
 * Fixed-timestep accumulator for deterministic physics stepping.
 *
 * Accumulates real-time frame deltas and produces a list of fixed-dt steps
 * to run each frame. Caps catch-up steps to avoid spiral-of-death; if the
 * cap is hit, the remainder is dropped and `overBudget` is set (panic-freeze
 * trigger for the LoadShedder).
 */
export class PhysicsAccumulator {
  /** Fixed simulation timestep in seconds (default 1/60). */
  readonly fixedDt: number;
  /** Max number of catch-up steps per frame (default 5). */
  readonly maxCatchUpSteps: number;
  /** Per-step wall-time budget in ms before declaring over-budget (default 12). */
  readonly stepBudgetMs: number;

  private accumulator: number = 0;
  private overBudget: boolean = false;
  private slipAmount: number = 0;
  private lastStepWallMs: number = 0;

  constructor(opts: { fixedDt?: number; maxCatchUpSteps?: number; stepBudgetMs?: number } = {}) {
    const fixedDt = opts.fixedDt ?? 1 / 60;
    if (fixedDt <= 0 || !Number.isFinite(fixedDt)) throw new Error(`Invalid fixedDt: ${fixedDt}`);
    this.fixedDt = fixedDt;
    this.maxCatchUpSteps = opts.maxCatchUpSteps ?? 5;
    this.stepBudgetMs = opts.stepBudgetMs ?? 12;
  }

  /**
   * Add real-time delta to the accumulator.
   * Validates `realDt` is finite and non-negative; ignores invalid values.
   */
  accumulate(realDt: number): void {
    if (!Number.isFinite(realDt) || realDt < 0) return;
    this.accumulator += realDt;
  }

  /**
   * Returns the list of fixed-dt steps to run this frame, capped at
   * `maxCatchUpSteps`. If the accumulator still has leftover after the cap,
   * the remainder is dropped, `slipAmount` is recorded, and `overBudget`
   * is set.
   */
  consumeSteps(): number[] {
    const steps: number[] = [];
    let count = 0;
    while (this.accumulator >= this.fixedDt && count < this.maxCatchUpSteps) {
      steps.push(this.fixedDt);
      this.accumulator -= this.fixedDt;
      count++;
    }

    // If there's still time left after capping, we're slipping
    if (this.accumulator >= this.fixedDt) {
      this.slipAmount = this.accumulator;
      this.overBudget = true;
      // Drop the remainder to avoid unbounded growth
      this.accumulator = 0;
    } else {
      // Only clear over-budget if we're keeping up AND step wall time is OK
      if (!this.overBudget || this.lastStepWallMs <= this.stepBudgetMs) {
        this.overBudget = false;
      }
      this.slipAmount = 0;
    }

    return steps;
  }

  /**
   * Record the wall-clock time of the last step batch. If it exceeds
   * `stepBudgetMs`, set `overBudget`.
   */
  recordStepWallTime(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastStepWallMs = ms;
    if (ms > this.stepBudgetMs) {
      this.overBudget = true;
    }
  }

  isOverBudget(): boolean {
    return this.overBudget;
  }

  getSlipAmount(): number {
    return this.slipAmount;
  }

  getAccumulator(): number {
    return this.accumulator;
  }

  reset(): void {
    this.accumulator = 0;
    this.overBudget = false;
    this.slipAmount = 0;
    this.lastStepWallMs = 0;
  }
}
