import { TelemetryCollector } from "./collector.ts";

describe("TelemetryCollector", () => {
  it("should be disabled by default", () => {
    const t = new TelemetryCollector();
    expect(t.isEnabled()).toBe(false);
  });

  it("should not record when disabled", () => {
    const t = new TelemetryCollector(false);
    t.recordFrame(16.6);
    t.recordSystemTiming("test", 5);
    t.updateThreadMetrics("main", { heapUsed: 100 });

    expect(t.getFrameTimes().length).toBe(0);
    expect(t.getSystemTimings().length).toBe(0);
    expect(t.getThreadMetrics().length).toBe(0);
  });

  it("should record frame times when enabled", () => {
    const t = new TelemetryCollector(true);
    t.recordFrame(16.6);
    t.recordFrame(33.3);
    t.recordFrame(16.6);

    expect(t.getFrameTimes().length).toBe(3);
    expect(t.getAverageFrameTime()).toBeCloseTo(22.17, 1);
  });

  it("should cap frame history at maxFrameHistory", () => {
    const t = new TelemetryCollector(true);
    for (let i = 0; i < 400; i++) {
      t.recordFrame(i);
    }
    expect(t.getFrameTimes().length).toBe(300);
  });

  it("should compute percentiles", () => {
    const t = new TelemetryCollector(true);
    for (let i = 0; i < 100; i++) {
      t.recordFrame(i);
    }
    // p50 should be around 50
    expect(t.getFrameTimePercentile(0.5)).toBe(50);
    // p95 should be around 95
    expect(t.getFrameTimePercentile(0.95)).toBe(95);
  });

  it("should return 0 for empty frame times", () => {
    const t = new TelemetryCollector(true);
    expect(t.getAverageFrameTime()).toBe(0);
    expect(t.getFrameTimePercentile(0.5)).toBe(0);
  });

  it("should record system timings", () => {
    const t = new TelemetryCollector(true);
    t.recordSystemTiming("physics", 2.5);
    t.recordSystemTiming("render", 8.3);

    const timings = t.getSystemTimings();
    expect(timings.length).toBe(2);
    expect(timings[0].name).toBe("physics");
    expect(timings[1].name).toBe("render");
  });

  it("should update thread metrics", () => {
    const t = new TelemetryCollector(true);
    t.updateThreadMetrics("main", { heapUsed: 1024, rss: 2048 });
    t.updateThreadMetrics("worker-0", { heapUsed: 512 });

    const metrics = t.getThreadMetrics();
    expect(metrics.length).toBe(2);

    const main = metrics.find((m) => m.threadName === "main");
    expect(main).toBeDefined();
    expect(main!.heapUsed).toBe(1024);
    expect(main!.rss).toBe(2048);
  });

  it("should merge thread metrics on update", () => {
    const t = new TelemetryCollector(true);
    t.updateThreadMetrics("main", { heapUsed: 100, rss: 200 });
    t.updateThreadMetrics("main", { heapUsed: 300 });

    const metrics = t.getThreadMetrics();
    expect(metrics.length).toBe(1);
    expect(metrics[0].heapUsed).toBe(300);
    expect(metrics[0].rss).toBe(200); // preserved from first update
  });

  it("should reset all data", () => {
    const t = new TelemetryCollector(true);
    t.recordFrame(16);
    t.recordSystemTiming("test", 1);
    t.updateThreadMetrics("main", { heapUsed: 100 });

    t.reset();

    expect(t.getFrameTimes().length).toBe(0);
    expect(t.getSystemTimings().length).toBe(0);
    expect(t.getThreadMetrics().length).toBe(0);
  });

  it("should toggle enabled state", () => {
    const t = new TelemetryCollector(false);
    expect(t.isEnabled()).toBe(false);

    t.setEnabled(true);
    expect(t.isEnabled()).toBe(true);

    t.setEnabled(false);
    expect(t.isEnabled()).toBe(false);
  });
});
