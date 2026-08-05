import { PhysicsAccumulator } from "./physics-accumulator";

describe("PhysicsAccumulator", () => {
  it("should produce one step when accumulator >= fixedDt", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60 });
    acc.accumulate(1 / 60);
    const steps = acc.consumeSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBeCloseTo(1 / 60, 10);
  });

  it("should produce multiple steps for large dt", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60 });
    acc.accumulate(3 / 60);
    const steps = acc.consumeSteps();
    expect(steps).toHaveLength(3);
  });

  it("should cap catch-up steps at maxCatchUpSteps", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60, maxCatchUpSteps: 3 });
    acc.accumulate(10 / 60); // 10 steps worth
    const steps = acc.consumeSteps();
    expect(steps).toHaveLength(3);
    expect(acc.isOverBudget()).toBe(true);
    expect(acc.getSlipAmount()).toBeGreaterThan(0);
  });

  it("should clear over-budget when keeping up", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60, maxCatchUpSteps: 3 });
    acc.accumulate(10 / 60);
    acc.consumeSteps();
    expect(acc.isOverBudget()).toBe(true);
    // Now accumulate exactly one step and consume
    acc.accumulate(1 / 60);
    acc.consumeSteps();
    expect(acc.isOverBudget()).toBe(false);
  });

  it("should ignore invalid dt values", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60 });
    acc.accumulate(NaN);
    acc.accumulate(Infinity);
    acc.accumulate(-1);
    expect(acc.getAccumulator()).toBe(0);
    expect(acc.consumeSteps()).toHaveLength(0);
  });

  it("should record step wall time and set over-budget", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60, stepBudgetMs: 10 });
    acc.recordStepWallTime(15); // > budget
    expect(acc.isOverBudget()).toBe(true);
    acc.recordStepWallTime(5); // < budget
    // overBudget only clears on consumeSteps when keeping up
    acc.accumulate(1 / 60);
    acc.consumeSteps();
    expect(acc.isOverBudget()).toBe(false);
  });

  it("should reset state", () => {
    const acc = new PhysicsAccumulator({ fixedDt: 1 / 60 });
    acc.accumulate(10 / 60);
    acc.consumeSteps();
    acc.reset();
    expect(acc.getAccumulator()).toBe(0);
    expect(acc.isOverBudget()).toBe(false);
    expect(acc.getSlipAmount()).toBe(0);
  });
});
