import { TraceEventWriter } from "./trace-event-writer";
import {
  allocateProfilingSAB,
  claimSlot,
  ProfilingSABWriter,
  ProfilingSABReader,
  fnv1a32,
  STORE_OPFS,
  STORE_IDB,
  RUNTIME_JS,
  SEVERITY_WARN,
  METRIC_TICK_LATENCY,
} from "./profiling-sab";

describe("TraceEventWriter", () => {
  it("produces valid Chrome Trace Event JSON", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    const tagHash = writer.internTag("save.dat");
    writer.writeThreadMetrics({
      heapUsed: 1000, heapTotal: 2000, rss: 3000,
      cpuTimeMs: 10, cpuPercent: 50,
      gcPauseTotalUs: 100, gcPauseCount: 2, gcPauseMaxUs: 60,
      tick: 1, taskCount: 5,
      taskLatencyP50Us: 100, taskLatencyP95Us: 200, taskLatencyP99Us: 300, taskLatencyMaxUs: 400,
    });
    writer.pushIopsRecord({
      opKind: 1, store: STORE_OPFS, tagHash, bytes: 1024,
      latencyUs: 500, ts: performance.now(), workerTag: fnv1a32("test"),
    });
    writer.pushWarningRecord({
      ruleIdHash: fnv1a32("dd:tick-slow"),
      severity: SEVERITY_WARN,
      metricKind: METRIC_TICK_LATENCY,
      value: 60000, threshold: 50000,
      workerTag: fnv1a32("test"),
      ts: performance.now(),
      autoTraceFired: false,
    });

    const reader = new ProfilingSABReader(sab, layout);
    const tw = new TraceEventWriter();
    tw.startRecording();
    tw.ingestSnapshot(reader.readSnapshot());
    const result = tw.stopRecording();

    expect(result.eventCount).toBeGreaterThan(0);
    const parsed = JSON.parse(result.json);
    expect(parsed.traceEvents).toBeDefined();
    expect(Array.isArray(parsed.traceEvents)).toBe(true);
    // Should have task, gc, iops, and warning events
    const cats = parsed.traceEvents.map((e: any) => e.cat);
    expect(cats.some((c: string) => c.includes("task"))).toBe(true);
    expect(cats.some((c: string) => c.includes("iops"))).toBe(true);
    expect(cats.some((c: string) => c.includes("warning"))).toBe(true);
  });

  it("isRecording reflects state", () => {
    const tw = new TraceEventWriter();
    expect(tw.isRecording()).toBe(false);
    tw.startRecording();
    expect(tw.isRecording()).toBe(true);
    tw.stopRecording();
    expect(tw.isRecording()).toBe(false);
  });

  it("startRecording clears previous events", () => {
    const tw = new TraceEventWriter();
    tw.startRecording();
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    writer.writeThreadMetrics({
      heapUsed: 0, heapTotal: 0, rss: 0, cpuTimeMs: 0, cpuPercent: 0,
      gcPauseTotalUs: 0, gcPauseCount: 0, gcPauseMaxUs: 0,
      tick: 1, taskCount: 1, taskLatencyP50Us: 100, taskLatencyP95Us: 200, taskLatencyP99Us: 300, taskLatencyMaxUs: 400,
    });
    const reader = new ProfilingSABReader(sab, layout);
    tw.ingestSnapshot(reader.readSnapshot());
    let result = tw.stopRecording();
    expect(result.eventCount).toBeGreaterThan(0);

    tw.startRecording();
    result = tw.stopRecording();
    expect(result.eventCount).toBe(0); // cleared
  });
});
