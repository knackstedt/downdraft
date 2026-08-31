import { TaskLatencyHistogram } from "./task-latency";

describe("TaskLatencyHistogram", () => {
  it("records samples and computes percentiles", () => {
    const h = new TaskLatencyHistogram();
    for (let i = 1; i <= 100; i++) {
      h.record(i * 1000); // 1ms to 100ms in us
    }
    const p = h.getPercentiles();
    expect(p.max).toBe(100_000);
    expect(p.p50).toBeGreaterThan(0);
    expect(p.p50).toBeLessThanOrEqual(p.p95);
    expect(p.p95).toBeLessThanOrEqual(p.p99);
    expect(p.p99).toBeLessThanOrEqual(p.max);
  });

  it("returns zeros for empty histogram", () => {
    const h = new TaskLatencyHistogram();
    const p = h.getPercentiles();
    expect(p.p50).toBe(0);
    expect(p.p95).toBe(0);
    expect(p.p99).toBe(0);
    expect(p.max).toBe(0);
  });

  it("stores samples for the flame graph", () => {
    const h = new TaskLatencyHistogram();
    h.record(1000, "tick", 0);
    h.record(2000, "eval", 1);
    h.record(3000, "on_event", 0);
    const samples = h.getSamples();
    expect(samples.length).toBe(3);
    // Most recent first
    expect(samples[0].name).toBe("on_event");
    expect(samples[0].durationUs).toBe(3000);
    expect(samples[0].depth).toBe(0);
    expect(samples[1].name).toBe("eval");
    expect(samples[2].name).toBe("tick");
  });

  it("caps the sample ring at MAX_SAMPLE_RING", () => {
    const h = new TaskLatencyHistogram();
    for (let i = 0; i < 200; i++) {
      h.record(i, `task-${i}`);
    }
    const samples = h.getSamples();
    expect(samples.length).toBe(128); // MAX_SAMPLE_RING
  });

  it("reset clears all data", () => {
    const h = new TaskLatencyHistogram();
    h.record(1000);
    h.record(2000);
    expect(h.getCount()).toBe(2);
    h.reset();
    expect(h.getCount()).toBe(0);
    expect(h.getPercentiles().max).toBe(0);
    expect(h.getSamples().length).toBe(0);
  });

  it("getCount returns total recorded count", () => {
    const h = new TaskLatencyHistogram();
    h.record(100);
    h.record(200);
    h.record(300);
    expect(h.getCount()).toBe(3);
  });
});
