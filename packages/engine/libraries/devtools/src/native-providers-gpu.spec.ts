import { describe, test, expect } from "bun:test";
import { registerEngineProviders } from "./native-providers";
import type { PanelSnapshot } from "./snapshot";

// The "gpu" provider feeds provider-driven frontends (devtools GPU surface,
// external viewers pulling snapshot("gpu") over the mirror) with the same
// data the docked gpu panel gets via the inspector's getGPUInfo RPC. It was
// missing from the registry — the devtools GPU tab rendered empty against
// targets whose mirror hello advertised sim/memory/render-graph only.

function stubTarget() {
  const providers = new Map<string | number, () => PanelSnapshot>();
  return {
    providers,
    registerProvider(panel: string | number, collect: () => PanelSnapshot) {
      providers.set(panel, collect);
    },
    registerCommandHandler() { /* not under test */ },
  };
}

function stubRenderer() {
  return {
    getAdapterInfo: () => ({ vendor: "test-vendor", architecture: "vulkan", device: "stub-gpu", description: "unit-test" }),
    getDevice: () => ({ limits: { maxBindGroups: 4, maxBufferSize: 1024 * 1024 } }),
    telemetryCollector: {
      getFrameTelemetry: () => ({ fps: 120, avgFrameTime: 8.3, p95: 9.1, p99: 10.2, gpuTimeMs: 4.2, drawCalls: 10, triangles: 5000 }),
      getFrameTimes: () => [8.1, 8.3, 8.2],
    },
    gpuResourceTracker: {
      getStats: () => ({ textureCount: 3, bufferCount: 5, textureBytes: 4096, bufferBytes: 2048, totalBytes: 6144, resources: [] }),
    },
  };
}

describe("gpu provider", () => {
  test("registerEngineProviders registers a gpu provider", () => {
    const target = stubTarget();
    registerEngineProviders(target as never, { renderer: stubRenderer() });
    expect(target.providers.has("gpu")).toBe(true);
  });

  test("gpu snapshot maps collectGpuInfo into named kv + series sections", () => {
    const target = stubTarget();
    registerEngineProviders(target as never, { renderer: stubRenderer() });
    const snap = target.providers.get("gpu")!();
    expect(snap.status).not.toBe("unsupported");

    const kvNames = snap.sections.filter((s) => s.kind === "kv").map((s) => s.name);
    expect(kvNames).toContain("GPU Adapter Info");
    expect(kvNames).toContain("Frame Performance");

    const adapter = snap.sections.find((s) => s.kind === "kv" && s.name === "GPU Adapter Info");
    const rows = adapter && adapter.kind === "kv" ? adapter.rows : [];
    expect(rows.some((r) => r.key === "Device" && r.value === "stub-gpu")).toBe(true);

    const series = snap.sections.find((s) => s.kind === "series");
    expect(series && series.kind === "series" ? series.series.length : 0).toBeGreaterThan(0);
  });

  test("renderer with no GPU surface returns unsupported, not a throw", () => {
    const target = stubTarget();
    registerEngineProviders(target as never, { renderer: null });
    const snap = target.providers.get("gpu")!();
    expect(snap.status).toBe("unsupported");
  });
});
