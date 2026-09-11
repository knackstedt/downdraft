// ============================================================================
// perf-metrics.ts — Comprehensive performance metrics panel.
//
// Charts (top to bottom):
// - Thread CPU Utilization % (one line per thread, from ProfilingSAB)
// - Thread Memory / Heap (one line per thread, from ProfilingSAB)
// - GPU Frame Time (CPU vs GPU, from GPUProfiler)
// - GPU Memory (texture + buffer bytes, from GPUResourceTracker)
// - Current values table (per-thread + GPU + process)
// ============================================================================

import { Container } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_BLUE, COLOR_GREEN, COLOR_ORANGE, COLOR_TEXT_DIM, THREAD_COLORS } from "../shared/colors";
import { formatBytes, formatMs, makeKeyValueGrid, makeLabel, makeLineChart, type LineSeries } from "../shared/widgets";

const CHART_H = 110;
const CHART_GAP = 8;
const TABLE_H = 140;

export function renderPerfMetricsPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();

  // ── Collect current metrics ──
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  // ── Read ProfilingSAB slots ──
  let slots: { slotIndex: number; name: string; metrics: any; eventLoop: any }[] = [];
  if (ctx.profilingSAB) {
    try {
      // Use the ProfilingSABReader from @downdraft/core/profiling
      const { ProfilingSABReader, computeProfilingSABLayout } = require("@downdraft/core/profiling");
      const layout = computeProfilingSABLayout();
      const reader = new ProfilingSABReader(ctx.profilingSAB, layout);
      const snapshot = reader.readSnapshot();
      slots = snapshot.slots.map((s: any) => ({
        slotIndex: s.slotIndex,
        name: s.name,
        metrics: s.metrics,
        eventLoop: s.eventLoop,
      }));
    } catch {
      // Fallback: try raw SAB read (simplified)
      try {
        const sab = ctx.profilingSAB;
        const u32 = new Uint32Array(sab);
        const maxSlots = 32;
        for (let i = 0; i < maxSlots; i++) {
          const slotBase = 16 + i * 16;
          const alive = Atomics.load(u32, slotBase);
          if (alive !== 1) continue;
          slots.push({
            slotIndex: i,
            name: `worker-${i}`,
            metrics: { cpuPercent: 0, heapUsed: 0, heapTotal: 0, gcPauseMaxUs: 0, taskLatencyP95Us: 0 },
            eventLoop: {},
          });
        }
      } catch { /* ignore */ }
    }
  }

  // Sample thread metrics (every 500ms)
  scene.sampleThreadMetrics(slots);

  // ── GPU metrics ──
  const renderer = ctx.renderer;
  const profiler = renderer?.gpuProfiler;
  const tracker = renderer?.gpuResourceTracker;
  let gpuFrameMs = 0;
  let cpuFrameMs = 0;
  let gpuTotalBytes = 0;
  if (profiler) {
    const timings = profiler.getPassTimings?.() ?? [];
    gpuFrameMs = timings.reduce((sum: number, t: any) => sum + (t.gpuMs ?? 0), 0);
    cpuFrameMs = timings.reduce((sum: number, t: any) => sum + (t.cpuMs ?? 0), 0);
  }
  if (tracker) {
    const stats = tracker.getStats?.() ?? {};
    gpuTotalBytes = stats.totalBytes ?? 0;
  }
  scene.sampleGpuMetrics(gpuTotalBytes, cpuFrameMs, gpuFrameMs);

  let ry = 4;

  // ── Chart 1: Thread CPU Utilization % ──
  c.addChild(makeLabel("Thread CPU Utilization (%)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const threadHistory = scene.getThreadMetricsHistory();
  const cpuSeries: LineSeries[] = [];
  for (const [slotIdx, hist] of threadHistory) {
    if (hist.cpuPercent.length < 2) continue;
    const color = THREAD_COLORS[slotIdx % THREAD_COLORS.length];
    const slot = slots.find((s) => s.slotIndex === slotIdx);
    const name = slot?.name ?? `slot-${slotIdx}`;
    cpuSeries.push({ data: hist.cpuPercent, color, label: name.slice(0, 12) });
  }
  if (cpuSeries.length > 0) {
    c.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: cpuSeries, yLabel: "%", yMax: 100,
    }));
  } else {
    c.addChild(makeLabel("No thread data (ProfilingSAB not available)", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 2: Thread Memory (Heap) ──
  c.addChild(makeLabel("Thread Memory (Heap, MB)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const memSeries: LineSeries[] = [];
  for (const [slotIdx, hist] of threadHistory) {
    if (hist.heapUsed.length < 2) continue;
    const color = THREAD_COLORS[slotIdx % THREAD_COLORS.length];
    const slot = slots.find((s) => s.slotIndex === slotIdx);
    const name = slot?.name ?? `slot-${slotIdx}`;
    const dataMb = hist.heapUsed.map((b) => b / 1024 / 1024);
    memSeries.push({ data: dataMb, color, label: name.slice(0, 12) });
  }
  if (memSeries.length > 0) {
    c.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: memSeries, yLabel: "MB",
    }));
  } else {
    c.addChild(makeLabel("No thread data", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 3: GPU Frame Time ──
  c.addChild(makeLabel("GPU Frame Time (ms)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const gpuFrameHistory = scene.getGpuFrameTimeHistory();
  if (gpuFrameHistory.cpu.length > 1) {
    const frameSeries: LineSeries[] = [
      { data: gpuFrameHistory.cpu, color: COLOR_BLUE, label: "CPU" },
      { data: gpuFrameHistory.gpu, color: COLOR_ORANGE, label: "GPU" },
    ];
    c.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: frameSeries, yLabel: "ms",
    }));
  } else {
    c.addChild(makeLabel("Collecting GPU data...", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 4: GPU Memory ──
  c.addChild(makeLabel("GPU Memory (MB)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const gpuMemHistory = scene.getGpuMemHistory();
  if (gpuMemHistory.length > 1) {
    const dataMb = gpuMemHistory.map((b) => b / 1024 / 1024);
    const memChartSeries: LineSeries[] = [
      { data: dataMb, color: COLOR_GREEN, label: "GPU Total" },
    ];
    c.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: memChartSeries, yLabel: "MB",
    }));
  } else {
    c.addChild(makeLabel("Collecting GPU memory data...", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Current values table ──
  c.addChild(makeLabel("Current Values", 8, ry, COLOR_GREEN, 11));
  ry += 16;

  const entries: { key: string; value: string }[] = [];

  // Per-thread metrics
  entries.push({ key: "— Threads —", value: "" });
  for (const slot of slots) {
    const m = slot.metrics;
    entries.push({
      key: `${slot.name}.cpu`,
      value: `${(m.cpuPercent ?? 0).toFixed(1)}%`,
    });
    entries.push({
      key: `${slot.name}.heap`,
      value: formatBytes(m.heapUsed ?? 0),
    });
    entries.push({
      key: `${slot.name}.gcMax`,
      value: formatMs((m.gcPauseMaxUs ?? 0) / 1000),
    });
    entries.push({
      key: `${slot.name}.latencyP95`,
      value: formatMs((m.taskLatencyP95Us ?? 0) / 1000),
    });
  }

  // GPU metrics
  entries.push({ key: "— GPU —", value: "" });
  if (tracker) {
    const stats = tracker.getStats?.() ?? {};
    entries.push({ key: "GPU.textures", value: String(stats.textureCount ?? "?") });
    entries.push({ key: "GPU.buffers", value: String(stats.bufferCount ?? "?") });
    entries.push({ key: "GPU.mem", value: formatBytes(stats.totalBytes ?? 0) });
  }
  if (profiler) {
    entries.push({ key: "GPU.frameMs", value: formatMs(gpuFrameMs) });
    entries.push({ key: "CPU.frameMs", value: formatMs(cpuFrameMs) });
  }

  // Process metrics
  entries.push({ key: "— Process —", value: "" });
  entries.push({ key: "RSS", value: formatBytes(mem.rss) });
  entries.push({ key: "Heap", value: formatBytes(mem.heapUsed) });
  entries.push({ key: "HeapTotal", value: formatBytes(mem.heapTotal) });
  entries.push({ key: "External", value: formatBytes(mem.external ?? 0) });
  entries.push({ key: "CPU.user", value: `${(cpu.user / 1000).toFixed(0)}ms` });
  entries.push({ key: "CPU.sys", value: `${(cpu.system / 1000).toFixed(0)}ms` });

  c.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 9, rowHeight: 13 }));

  return c;
}
