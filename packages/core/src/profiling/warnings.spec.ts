import {
  WarningEngine,
  DEFAULT_WORKER_WARNING_RULES,
  DEFAULT_RENDERER_WARNING_RULES,
  type WarningRule,
  type WarningRecordData,
  type WarningContext,
} from "./warnings";
import {
  METRIC_TICK_LATENCY,
  METRIC_HEAP_PERCENT,
  METRIC_IOPS_LATENCY,
  SEVERITY_WARN,
  SEVERITY_ERROR,
  SEVERITY_CRITICAL,
} from "./profiling-sab";

describe("WarningEngine", () => {
  it("fires an instantaneous rule when threshold is crossed", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:tick-slow",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50_000,
      cooldownMs: 1000,
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));

    engine.checkInstant(METRIC_TICK_LATENCY, 30_000); // below threshold
    expect(fired.length).toBe(0);

    engine.checkInstant(METRIC_TICK_LATENCY, 60_000); // above threshold
    expect(fired.length).toBe(1);
    expect(fired[0].value).toBe(60_000);
    expect(fired[0].severity).toBe(SEVERITY_WARN);
  });

  it("respects cooldown — does not re-fire within cooldownMs", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:cooldown",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50,
      cooldownMs: 100000, // very long cooldown
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));

    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(fired.length).toBe(1); // only fired once
  });

  it("fires again after cooldown expires", async () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:cooldown-expire",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50,
      cooldownMs: 50, // short cooldown
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));

    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(fired.length).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(fired.length).toBe(2);
  });

  it("supports multiple callbacks", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:multi-cb",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50,
      cooldownMs: 0,
    });
    let calls1 = 0, calls2 = 0;
    engine.onWarning(() => calls1++);
    engine.onWarning(() => calls2++);
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(calls1).toBe(1);
    expect(calls2).toBe(1);
  });

  it("unsubscribe stops the callback", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:unsub",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50,
      cooldownMs: 0,
    });
    let calls = 0;
    const unsub = engine.onWarning(() => calls++);
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(calls).toBe(1);
    unsub();
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(calls).toBe(1); // not called again
  });

  it("windowed rule fires only after sustained threshold", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:windowed",
      severity: SEVERITY_CRITICAL,
      metric: METRIC_HEAP_PERCENT,
      compare: ">",
      threshold: 80,
      sustained: true,
      windowMs: 100,
      cooldownMs: 0,
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));

    // Below threshold — should not fire, window resets
    engine.checkWindow(() => 50);
    expect(fired.length).toBe(0);

    // Above threshold but not yet sustained
    engine.checkWindow(() => 90);
    expect(fired.length).toBe(0);

    // Wait for window to elapse
    // We can't easily wait 100ms in a fast test, so we use a mock approach:
    // The window logic checks elapsed >= windowMs. We'll just wait.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        engine.checkWindow(() => 90);
        expect(fired.length).toBe(1);
        resolve();
      }, 120);
    });
  });

  it("windowed rule resets when condition becomes false", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:windowed-reset",
      severity: SEVERITY_WARN,
      metric: METRIC_HEAP_PERCENT,
      compare: ">",
      threshold: 80,
      sustained: true,
      windowMs: 1000,
      cooldownMs: 0,
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));

    engine.checkWindow(() => 90); // start window
    engine.checkWindow(() => 50); // condition false — reset
    engine.checkWindow(() => 90); // start window again
    // Should not have fired (window not elapsed)
    expect(fired.length).toBe(0);
  });

  it("removeRule stops evaluation", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:remove",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 50,
      cooldownMs: 0,
    });
    const fired: WarningRecordData[] = [];
    engine.onWarning((rec) => fired.push(rec));
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(fired.length).toBe(1);
    engine.removeRule("test:remove");
    engine.checkInstant(METRIC_TICK_LATENCY, 100);
    expect(fired.length).toBe(1); // not fired again
  });

  it("default worker rules include tick-slow and iops-slow", () => {
    const tickRule = DEFAULT_WORKER_WARNING_RULES.find((r) => r.id === "dd:tick-slow");
    expect(tickRule).toBeDefined();
    expect(tickRule!.severity).toBe(SEVERITY_WARN);
    expect(tickRule!.metric).toBe(METRIC_TICK_LATENCY);

    const iopsRule = DEFAULT_WORKER_WARNING_RULES.find((r) => r.id === "dd:iops-slow");
    expect(iopsRule).toBeDefined();
    expect(iopsRule!.metric).toBe(METRIC_IOPS_LATENCY);
  });

  it("default renderer rules include heap-critical with autoTrace", () => {
    const heapCritical = DEFAULT_RENDERER_WARNING_RULES.find((r) => r.id === "dd:heap-critical");
    expect(heapCritical).toBeDefined();
    expect(heapCritical!.severity).toBe(SEVERITY_CRITICAL);
    expect(heapCritical!.autoTrace).toBeDefined();
    expect(heapCritical!.sustained).toBe(true);
  });

  it("compare operators work correctly", () => {
    const engine = new WarningEngine(null);
    engine.addRule({
      id: "test:gt",
      severity: SEVERITY_WARN,
      metric: METRIC_TICK_LATENCY,
      compare: ">",
      threshold: 100,
      cooldownMs: 0,
    });
    engine.addRule({
      id: "test:gte",
      severity: SEVERITY_WARN,
      metric: METRIC_IOPS_LATENCY,
      compare: ">=",
      threshold: 100,
      cooldownMs: 0,
    });
    const fired: string[] = [];
    engine.onWarning((rec) => fired.push(rec.ruleId));

    engine.checkInstant(METRIC_TICK_LATENCY, 100); // not > 100
    expect(fired).not.toContain("test:gt");
    engine.checkInstant(METRIC_TICK_LATENCY, 101); // > 100
    expect(fired).toContain("test:gt");

    engine.checkInstant(METRIC_IOPS_LATENCY, 100); // >= 100
    expect(fired).toContain("test:gte");
  });
});
