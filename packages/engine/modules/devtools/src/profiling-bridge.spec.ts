import { devtools, _devtoolsImpl } from "./api";
import { BUILTIN_VIEW_DESCRIPTORS, type DebugViewDescriptor } from "./debug-view-descriptors";
import { ProfilingBridge } from "./profiling-bridge";

describe("Debug view descriptors", () => {
  it("has 10 built-in views", () => {
    expect(BUILTIN_VIEW_DESCRIPTORS.length).toBe(10);
    const kinds = BUILTIN_VIEW_DESCRIPTORS.map((v) => v.kind);
    expect(kinds).toContain("memory");
    expect(kinds).toContain("cpu");
    expect(kinds).toContain("task-latency");
    expect(kinds).toContain("iops-opfs");
    expect(kinds).toContain("iops-idb");
    expect(kinds).toContain("event-loop");
    expect(kinds).toContain("gc-heap");
    expect(kinds).toContain("flame-graph");
    expect(kinds).toContain("gpu-passes");
    expect(kinds).toContain("warnings");
  });
});

describe("DevToolsAPI view registration", () => {
  beforeEach(() => {
    _devtoolsImpl.clear();
  });

  it("getViews returns the 10 built-in views by default", () => {
    const views = devtools.getViews();
    expect(views.length).toBe(10);
  });

  it("registerView adds a custom view", () => {
    const customView: DebugViewDescriptor = {
      id: "custom:foo",
      label: "Foo",
      kind: "custom",
      order: 50,
    };
    devtools.registerView(customView);
    const views = devtools.getViews();
    expect(views.length).toBe(11);
    expect(views.find((v) => v.id === "custom:foo")).toBeDefined();
  });

  it("registerView overrides a built-in view with the same id", () => {
    devtools.registerView({ id: "memory", label: "Custom Memory", kind: "memory", order: 0 });
    const views = devtools.getViews();
    const memView = views.find((v) => v.id === "memory");
    expect(memView).toBeDefined();
    expect(memView!.label).toBe("Custom Memory");
    // Still 10 views (overrode, not added)
    expect(views.length).toBe(10);
  });

  it("views are sorted by order", () => {
    devtools.registerView({ id: "custom:z", label: "Z", kind: "custom", order: 200 });
    devtools.registerView({ id: "custom:a", label: "A", kind: "custom", order: 1 });
    const views = devtools.getViews();
    // First view should be order 0 (memory), then custom:a (order 1), etc.
    expect(views[0].order).toBe(0);
    expect(views[1].order).toBe(1);
  });
});

describe("DevToolsAPI profiling SAB", () => {
  beforeEach(() => {
    _devtoolsImpl.clear();
  });

  it("attachProfilingSAB + getProfilingSAB round-trip", () => {
    const sab = new SharedArrayBuffer(64);
    devtools.attachProfilingSAB(sab);
    expect(devtools.getProfilingSAB()).toBe(sab);
  });

  it("getProfilingSAB returns null before attach", () => {
    expect(devtools.getProfilingSAB()).toBeNull();
  });
});

describe("ProfilingBridge", () => {
  it("creates a ProfilingSAB and attaches it to devtools", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    const sab = bridge.getProfilingSAB();
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    expect(devtools.getProfilingSAB()).toBe(sab);
    bridge.dispose();
  });

  it("registers the 10 built-in view descriptors", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    const views = devtools.getViews();
    expect(views.length).toBe(10);
    bridge.dispose();
  });

  it("creates a warning engine + event loop monitor", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    expect(bridge.getWarningEngine()).toBeDefined();
    expect(bridge.getEventLoopMonitor()).toBeDefined();
    bridge.dispose();
  });

  it("creates a trace event writer", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    expect(bridge.getTraceEventWriter()).toBeDefined();
    expect(bridge.isRecording()).toBe(false);
    bridge.dispose();
  });

  it("onWarning subscribes to warnings", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    let fired = 0;
    const unsub = bridge.onWarning(() => fired++);
    // Simulate a renderer-side warning
    bridge.getWarningEngine().addRule({
      id: "test:bridge",
      severity: 1,
      metric: 1,
      compare: ">",
      threshold: 50,
      cooldownMs: 0,
    });
    // tick() drains the SAB warning ring (empty initially)
    bridge.tick();
    bridge.endFrame();
    unsub();
    bridge.dispose();
    // No warnings fired (SAB is empty, no instant check)
    expect(fired).toBe(0);
  });

  it("startRecording/stopRecording with in-engine source", async () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge({ traceSource: "in-engine" });
    bridge.startRecording();
    expect(bridge.isRecording()).toBe(true);
    bridge.tick(); // ingest snapshot while recording
    const result = await bridge.stopRecording();
    expect(result.source).toBe("in-engine");
    expect(result.json).toBeDefined();
    expect(bridge.isRecording()).toBe(false);
    bridge.dispose();
  });

  it("getSnapshot returns the latest profiling snapshot", () => {
    _devtoolsImpl.clear();
    const bridge = new ProfilingBridge();
    bridge.tick();
    const snap = bridge.getSnapshot();
    expect(snap).toBeDefined();
    expect(snap!.slots).toBeDefined();
    bridge.dispose();
  });
});
