// ============================================================================
// perf-metrics.ts — Comprehensive performance metrics panel.
//
// Charts (top to bottom, in a scrollable container):
// - Thread CPU Utilization % (one line per thread, from ProfilingSAB)
// - Thread Memory / Heap (one line per thread, from ProfilingSAB)
// - GPU Frame Time (CPU vs GPU, from GPUProfiler)
// - GPU Memory (texture + buffer bytes, from GPUResourceTracker)
// - Current values table (per-thread + GPU + process)
//
// Each chart legend shows the actual current value of each series.
// ============================================================================

import { Container } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_BLUE, COLOR_GREEN, COLOR_ORANGE, COLOR_TEXT_DIM, THREAD_COLORS } from "../shared/colors";
import { formatBytes, formatMs, makeKeyValueGrid, makeLabel, makeLineChart, makeScrollPanel, type LineSeries } from "../shared/widgets";

const CHART_H = 110;
const CHART_GAP = 8;

export function renderPerfMetricsPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();

  // ── Collect current process metrics ──
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  // ── Read ProfilingSAB slots using the real reader ──
  let slots: { slotIndex: number; name: string; metrics: any; eventLoop: any }[] = [];
  if (ctx.profilingSAB) {
    try {
      // Use the ProfilingSABReader from @downdraft/core/profiling.
      // The layout is deterministic given the default capacity parameters,
      // which is what allocateProfilingSAB() uses in native-entry.ts.
      const { ProfilingSABReader, computeProfilingSABLayout } = require("@downdraft/core/profiling");
      const layout = computeProfilingSABLayout();
      // Verify the SAB is large enough for the default layout (sanity check)
      if (ctx.profilingSAB.byteLength >= layout.byteLength) {
        const reader = new ProfilingSABReader(ctx.profilingSAB, layout);
        const snapshot = reader.readSnapshot();
        slots = snapshot.slots.map((s: any) => ({
          slotIndex: s.slotIndex,
          name: s.name || `slot-${s.slotIndex}`,
          metrics: s.metrics,
          eventLoop: s.eventLoop,
        }));
      }
    } catch (e) {
      console.warn("[perf-metrics] ProfilingSAB read failed:", e);
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

  // ── Build all content into a scroll panel ──
  // Estimate content height: 4 charts * (CHART_H + 16 label) + table + gaps
  const threadCount = Math.max(slots.length, 1);
  const tableH = 16 + (threadCount * 4 + 8) * 13 + 16;
  const contentHeight = 4 * (CHART_H + 16 + CHART_GAP) + tableH + 20;
  const scrollY = scene.getScrollY("perf-metrics");
  const scroll = makeScrollPanel({ x: 0, y: 0, width: w, height: h, contentHeight, scrollY, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  let ry = 4;

  // ── Chart 1: Thread CPU Utilization % ──
  content.addChild(makeLabel("Thread CPU Utilization (%)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const threadHistory = scene.getThreadMetricsHistory();
  const cpuSeries: LineSeries[] = [];
  for (const [slotIdx, hist] of threadHistory) {
    if (hist.cpuPercent.length < 2) continue;
    const color = THREAD_COLORS[slotIdx % THREAD_COLORS.length];
    const slot = slots.find((s) => s.slotIndex === slotIdx);
    const name = slot?.name ?? `slot-${slotIdx}`;
    // Show current value in the legend
    const currentVal = hist.cpuPercent[hist.cpuPercent.length - 1] ?? 0;
    cpuSeries.push({ data: hist.cpuPercent, color, label: `${name.slice(0, 10)}: ${currentVal.toFixed(1)}%` });
  }
  if (cpuSeries.length > 0) {
    content.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: cpuSeries, yLabel: "%", yMax: 100,
    }));
  } else {
    content.addChild(makeLabel(slots.length === 0
      ? "No thread data (ProfilingSAB not attached)"
      : "Collecting thread data...",
      12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 2: Thread Memory (Heap) ──
  content.addChild(makeLabel("Thread Memory (Heap, MB)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const memSeries: LineSeries[] = [];
  for (const [slotIdx, hist] of threadHistory) {
    if (hist.heapUsed.length < 2) continue;
    const color = THREAD_COLORS[slotIdx % THREAD_COLORS.length];
    const slot = slots.find((s) => s.slotIndex === slotIdx);
    const name = slot?.name ?? `slot-${slotIdx}`;
    const dataMb = hist.heapUsed.map((b) => b / 1024 / 1024);
    const currentVal = dataMb[dataMb.length - 1] ?? 0;
    memSeries.push({ data: dataMb, color, label: `${name.slice(0, 10)}: ${currentVal.toFixed(1)}MB` });
  }
  if (memSeries.length > 0) {
    content.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: memSeries, yLabel: "MB",
    }));
  } else {
    content.addChild(makeLabel("No thread memory data", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 3: GPU Frame Time ──
  content.addChild(makeLabel("GPU Frame Time (ms)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const gpuFrameHistory = scene.getGpuFrameTimeHistory();
  if (gpuFrameHistory.cpu.length > 1) {
    const curCpu = gpuFrameHistory.cpu[gpuFrameHistory.cpu.length - 1] ?? 0;
    const curGpu = gpuFrameHistory.gpu[gpuFrameHistory.gpu.length - 1] ?? 0;
    const frameSeries: LineSeries[] = [
      { data: gpuFrameHistory.cpu, color: COLOR_BLUE, label: `CPU: ${curCpu.toFixed(1)}ms` },
      { data: gpuFrameHistory.gpu, color: COLOR_ORANGE, label: `GPU: ${curGpu.toFixed(1)}ms` },
    ];
    content.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: frameSeries, yLabel: "ms",
    }));
  } else {
    content.addChild(makeLabel("Collecting GPU data...", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Chart 4: GPU Memory ──
  content.addChild(makeLabel("GPU Memory (MB)", 8, ry, COLOR_GREEN, 11));
  ry += 16;
  const gpuMemHistory = scene.getGpuMemHistory();
  if (gpuMemHistory.length > 1) {
    const dataMb = gpuMemHistory.map((b) => b / 1024 / 1024);
    const curVal = dataMb[dataMb.length - 1] ?? 0;
    const memChartSeries: LineSeries[] = [
      { data: dataMb, color: COLOR_GREEN, label: `GPU Total: ${curVal.toFixed(1)}MB` },
    ];
    content.addChild(makeLineChart({
      x: 8, y: ry, width: w - 16, height: CHART_H,
      series: memChartSeries, yLabel: "MB",
    }));
  } else {
    content.addChild(makeLabel("Collecting GPU memory data...", 12, ry + 20, COLOR_TEXT_DIM, 10));
  }
  ry += CHART_H + CHART_GAP;

  // ── Current values table ──
  content.addChild(makeLabel("Current Values", 8, ry, COLOR_GREEN, 11));
  ry += 16;

  const entries: { key: string; value: string }[] = [];

  // Per-thread metrics
  if (slots.length > 0) {
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
  }

  // GPU metrics
  entries.push({ key: "— GPU —", value: "" });
  if (tracker) {
    const stats = tracker.getStats?.() ?? {};
    entries.push({ key: "GPU.textures", value: String(stats.textureCount ?? "?") });
    entries.push({ key: "GPU.buffers", value: String(stats.bufferCount ?? "?") });
    entries.push({ key: "GPU.mem", value: formatBytes(stats.totalBytes ?? 0) });
  } else {
    entries.push({ key: "GPU.tracker", value: "unavailable" });
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

  content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 9, rowHeight: 13 }));

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  return c;
}
