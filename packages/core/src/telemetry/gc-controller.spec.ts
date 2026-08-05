import { GCController, DEFAULT_GC_CONTROLLER_CONFIG } from "./gc-controller";

describe("GCController", () => {
  afterEach(() => {
    // Clean up any globalThis.gc we set in tests
    delete (globalThis as any).gc;
  });

  it("should be disabled by default", () => {
    const c = new GCController("test");
    expect(c.getConfig().enabled).toBe(false);
    expect(c.isGcAvailable()).toBe(false);
  });

  it("should have default config values", () => {
    const c = new GCController("test");
    const cfg = c.getConfig();
    expect(cfg.minorIntervalMs).toBe(DEFAULT_GC_CONTROLLER_CONFIG.minorIntervalMs);
    expect(cfg.headroomThreshold).toBe(DEFAULT_GC_CONTROLLER_CONFIG.headroomThreshold);
    expect(cfg.pressureThresholdBytes).toBe(DEFAULT_GC_CONTROLLER_CONFIG.pressureThresholdBytes);
    expect(cfg.majorOnTransitions).toBe(true);
    expect(cfg.gcDurationWarnMs).toBe(DEFAULT_GC_CONTROLLER_CONFIG.gcDurationWarnMs);
  });

  it("should accept partial config overrides", () => {
    const c = new GCController("test", { enabled: true, minorIntervalMs: 50 });
    const cfg = c.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.minorIntervalMs).toBe(50);
    // Other values should be defaults
    expect(cfg.headroomThreshold).toBe(DEFAULT_GC_CONTROLLER_CONFIG.headroomThreshold);
  });

  it("should not call gc when disabled", () => {
    let called = false;
    (globalThis as any).gc = () => { called = true; };
    const c = new GCController("test", { enabled: false });
    c.maybeCollect(100, 16.67);
    expect(called).toBe(false);
  });

  it("should not crash when globalThis.gc is undefined", () => {
    delete (globalThis as any).gc;
    const c = new GCController("test", { enabled: true });
    expect(c.isGcAvailable()).toBe(false);
    // Should be a no-op, not throw
    c.maybeCollect(100, 16.67);
    c.collectMajor();
    c.forceMajor();
    const stats = c.getStats();
    expect(stats.gcAvailable).toBe(false);
    expect(stats.interval.autoMinorCount).toBe(0);
  });

  it("should skip when headroom is below threshold", () => {
    let called = false;
    (globalThis as any).gc = () => { called = true; };
    const c = new GCController("test", { enabled: true, headroomThreshold: 0.5 });
    // headroom 5ms / interval 16.67ms = 0.30 < 0.5 → skip
    c.maybeCollect(5, 16.67);
    expect(called).toBe(false);
    const stats = c.getStats();
    expect(stats.interval.skippedNoHeadroom).toBe(1);
  });

  it("should trigger minor GC when headroom is sufficient and enabled", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.2,
      minorIntervalMs: 0, // no throttle for test
      pressureThresholdBytes: 0, // no pressure gate for test
    });
    // headroom 10ms / interval 16.67ms = 0.60 >= 0.2 → trigger
    c.maybeCollect(10, 16.67);
    expect(callCount).toBe(1);
    const stats = c.getStats();
    expect(stats.interval.autoMinorCount).toBe(1);
  });

  it("should throttle minor GC calls within minorIntervalMs", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 1000, // 1s throttle
      pressureThresholdBytes: 0,
    });
    c.maybeCollect(50, 16.67);
    c.maybeCollect(50, 16.67); // should be throttled
    expect(callCount).toBe(1);
  });

  it("should detect slow GC and increment slowGcCount", () => {
    (globalThis as any).gc = () => {
      // Simulate a slow GC by sleeping
      const start = performance.now();
      while (performance.now() - start < 10) { /* busy wait */ }
    };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 0,
      pressureThresholdBytes: 0,
      gcDurationWarnMs: 5,
    });
    c.maybeCollect(50, 16.67);
    const stats = c.getStats();
    expect(stats.interval.autoMinorCount).toBe(1);
    expect(stats.interval.slowGcCount).toBe(1);
    expect(stats.interval.autoGcMaxMs).toBeGreaterThan(5);
  });

  it("should reset interval counters on getStats but preserve overall", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 0,
      pressureThresholdBytes: 0,
    });
    c.maybeCollect(50, 16.67);
    const s1 = c.getStats();
    expect(s1.interval.autoMinorCount).toBe(1);
    expect(s1.overall.autoMinorCount).toBe(1);
    // Second getStats — interval should be reset
    const s2 = c.getStats();
    expect(s2.interval.autoMinorCount).toBe(0);
    expect(s2.overall.autoMinorCount).toBe(1); // preserved
  });

  it("should merge config via setConfig", () => {
    const c = new GCController("test");
    c.setConfig({ enabled: true, minorIntervalMs: 32 });
    const cfg = c.getConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.minorIntervalMs).toBe(32);
  });

  it("should record headroom samples even when disabled", () => {
    const c = new GCController("test", { enabled: false });
    c.maybeCollect(10, 16.67);
    c.maybeCollect(5, 16.67);
    const stats = c.getStats();
    expect(stats.headroomSamples.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle gc() throwing an error gracefully", () => {
    (globalThis as any).gc = () => { throw new Error("GC failed"); };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 0,
      pressureThresholdBytes: 0,
    });
    c.maybeCollect(50, 16.67);
    const stats = c.getStats();
    expect(stats.interval.failedCount).toBe(1);
    expect(stats.interval.autoMinorCount).toBe(0);
  });

  it("should call collectMajor when majorOnTransitions is enabled", () => {
    let callCount = 0;
    let lastCallArg: any = null;
    (globalThis as any).gc = (arg: any) => { callCount++; lastCallArg = arg; };
    const c = new GCController("test", { enabled: true, majorOnTransitions: true });
    c.collectMajor();
    expect(callCount).toBe(1);
  });

  it("should not call collectMajor when majorOnTransitions is disabled", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", { enabled: true, majorOnTransitions: false });
    c.collectMajor();
    expect(callCount).toBe(0);
  });

  it("should always call forceMajor regardless of majorOnTransitions", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", { majorOnTransitions: false });
    c.forceMajor();
    expect(callCount).toBe(1);
  });

  it("should reset all counters via reset()", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 0,
      pressureThresholdBytes: 0,
    });
    c.maybeCollect(50, 16.67);
    c.reset();
    const stats = c.getStats();
    expect(stats.overall.autoMinorCount).toBe(0);
    expect(stats.interval.autoMinorCount).toBe(0);
    expect(stats.headroomSamples.length).toBe(0);
  });

  it("should track recent invocations", () => {
    let callCount = 0;
    (globalThis as any).gc = () => { callCount++; };
    const c = new GCController("test", {
      enabled: true,
      headroomThreshold: 0.1,
      minorIntervalMs: 0,
      pressureThresholdBytes: 0,
    });
    c.maybeCollect(10, 16.67);
    c.maybeCollect(20, 16.67);
    const stats = c.getStats();
    expect(stats.recentInvocations.length).toBe(2);
    expect(stats.recentInvocations[0].type).toBe("minor");
    expect(stats.recentInvocations[1].type).toBe("minor");
  });
});
