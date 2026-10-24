import { describe, test, expect } from "bun:test";
import { collectMetrics } from "./collectors";
import {
  allocateProfilingSAB,
  claimSlot,
  ProfilingSABWriter,
  fnv1a32,
  RUNTIME_JS,
  RUNTIME_WASM,
} from "@downdraft/engine/profiling";

// The ProfilingBridge claims an in-process SAB slot named "renderer" on the
// main thread and fills it from the same performance.memory source that the
// synthetic "main" slot reads — before the dedupe fix, the metrics feed
// reported the same isolate heap twice as two separate "threads".

function writeSlot(sab: SharedArrayBuffer, layout: any, slotIndex: number, heapUsed: number, cpuPercent: number) {
  new ProfilingSABWriter(sab, layout, slotIndex).writeThreadMetrics({
    heapUsed,
    heapTotal: heapUsed,
    rss: heapUsed,
    cpuTimeMs: 0,
    cpuPercent,
    gcPauseTotalUs: 0,
    gcPauseCount: 0,
    gcPauseMaxUs: 0,
    tick: 1,
    taskCount: 1,
    taskLatencyP50Us: 0,
    taskLatencyP95Us: 1234,
    taskLatencyP99Us: 0,
    taskLatencyMaxUs: 0,
  });
}

describe("collectMetrics", () => {
  test("in-process renderer slot merges into main instead of duplicating the heap", async () => {
    const { sab, layout } = allocateProfilingSAB();
    const rendererIdx = claimSlot(sab, layout, fnv1a32("renderer"), RUNTIME_JS, "renderer");
    const simIdx = claimSlot(sab, layout, fnv1a32("sim"), RUNTIME_JS, "sim");
    writeSlot(sab, layout, rendererIdx, 500 * 1024 * 1024, 12.5);
    writeSlot(sab, layout, simIdx, 64 * 1024 * 1024, 33);

    const slots = await collectMetrics({ renderer: null, profilingSAB: sab });
    const names = slots.map((s) => s.name);
    expect(names).toEqual(["main", "sim"]);
    // The merged "main" keeps the renderer slot's richer fields.
    const main = slots[0];
    expect(main.slotIndex).toBe(rendererIdx);
    expect(main.history[0].cpuPercent).toBeCloseTo(12.5, 1);
    expect(main.history[0].taskLatencyP95Us).toBeCloseTo(1234, 0);
    expect(main.history[0].heapUsed).toBe(500 * 1024 * 1024);
    const sim = slots[1];
    expect(sim.history[0].heapUsed).toBe(64 * 1024 * 1024);
  });

  test("non-JS worker named 'renderer' is not merged", async () => {
    const { sab, layout } = allocateProfilingSAB();
    const idx = claimSlot(sab, layout, fnv1a32("renderer"), RUNTIME_WASM, "renderer");
    writeSlot(sab, layout, idx, 8 * 1024 * 1024, 50);

    const slots = await collectMetrics({ renderer: null, profilingSAB: sab });
    expect(slots.map((s) => s.name)).toEqual(["main", "renderer"]);
  });

  test("no SAB — main only", async () => {
    const slots = await collectMetrics({ renderer: null, profilingSAB: null });
    expect(slots.map((s) => s.name)).toEqual(["main"]);
  });
});
