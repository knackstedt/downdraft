import { TelemetryCollector } from "./collector";

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

  it("should clamp percentile index for out-of-range p values", () => {
    const t = new TelemetryCollector(true);
    for (let i = 0; i < 10; i++) {
      t.recordFrame(i);
    }
    expect(t.getFrameTimePercentile(-0.5)).toBe(0);
    expect(t.getFrameTimePercentile(1.5)).toBe(9);
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

  it("should record draw stats when enabled", () => {
    const t = new TelemetryCollector(true);
    t.recordDrawStats(5, 1200);
    const stats = t.getDrawStats();
    expect(stats.drawCalls).toBe(5);
    expect(stats.triangles).toBe(1200);
  });

  it("should not record draw stats when disabled", () => {
    const t = new TelemetryCollector(false);
    t.recordDrawStats(5, 1200);
    const stats = t.getDrawStats();
    expect(stats.drawCalls).toBe(0);
    expect(stats.triangles).toBe(0);
  });

  it("should record GPU time when enabled", () => {
    const t = new TelemetryCollector(true);
    t.recordGpuTime(8.5);
    expect(t.getGpuTime()).toBe(8.5);
  });

  it("should not record GPU time when disabled", () => {
    const t = new TelemetryCollector(false);
    t.recordGpuTime(8.5);
    expect(t.getGpuTime()).toBe(0);
  });

  it("should compute FPS from average frame time", () => {
    const t = new TelemetryCollector(true);
    t.recordFrame(16.67);
    t.recordFrame(16.67);
    expect(t.getFPS()).toBeCloseTo(60, 0);
  });

  it("should return 0 FPS with no frame data", () => {
    const t = new TelemetryCollector(true);
    expect(t.getFPS()).toBe(0);
  });

  it("should get memory usage from thread metrics", () => {
    const t = new TelemetryCollector(true);
    t.updateThreadMetrics("main", { heapUsed: 1048576, heapTotal: 2097152, rss: 4194304 });
    const mem = t.getMemoryUsage();
    expect(mem.heapUsed).toBe(1048576);
    expect(mem.heapTotal).toBe(2097152);
    expect(mem.rss).toBe(4194304);
  });

  it("should reset draw stats and GPU time", () => {
    const t = new TelemetryCollector(true);
    t.recordDrawStats(5, 1200);
    t.recordGpuTime(8.5);

    t.reset();

    expect(t.getDrawStats().drawCalls).toBe(0);
    expect(t.getDrawStats().triangles).toBe(0);
    expect(t.getGpuTime()).toBe(0);
  });
});
