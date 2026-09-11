// ============================================================================
// perf-metrics.ts — Performance Metrics panel.
//
// Shows real-time CPU usage (process.cpuUsage), memory usage
// (process.memoryUsage), and per-worker profiling data from the
// ProfilingSAB. Renders line charts for memory and CPU over time.
// ============================================================================

import { Container } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_GREEN, COLOR_RED, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { formatBytes, makeKeyValueGrid, makeLabel, makeLineChart, type LineSeries } from "../shared/widgets";

const MAX_HISTORY = 120; // ~2 minutes at 1s update

export function renderPerfMetricsPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const history = scene.getPerfMetricsHistory();

  // ── Collect current metrics ──
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  // Use the history arrays directly (not copies) so data persists.
  const memSeries = history.mem;
  const cpuSeries = history.cpu;

  // Only add a new sample if the last one is > 500ms old
  const now = Date.now();
  const lastEntry = memSeries[memSeries.length - 1];
  if (!lastEntry || now - lastEntry[2] > 500) {
    memSeries.push([mem.rss, mem.heapUsed, now]);
    cpuSeries.push([cpu.user, cpu.system, now]);
    if (memSeries.length > MAX_HISTORY) memSeries.shift();
    if (cpuSeries.length > MAX_HISTORY) cpuSeries.shift();
  }

  // ── CPU chart (top half) ──
  const chartH = Math.floor(h * 0.35);
  c.addChild(makeLabel("CPU Usage (ms/s)", 8, 4, COLOR_GREEN, 12));

  if (cpuSeries.length > 1) {
    // Compute CPU delta between samples (ms) — LineSeries.data is number[]
    const userDelta: number[] = [];
    const sysDelta: number[] = [];
    for (let i = 1; i < cpuSeries.length; i++) {
      const dt = (cpuSeries[i][2] - cpuSeries[i - 1][2]) / 1000; // seconds
      if (dt <= 0) continue;
      const userMs = (cpuSeries[i][0] - cpuSeries[i - 1][0]) / 1000; // μs→ms
      const sysMs = (cpuSeries[i][1] - cpuSeries[i - 1][1]) / 1000;
      userDelta.push(userMs / dt); // ms/s = % of one core
      sysDelta.push(sysMs / dt);
    }
    const series: LineSeries[] = [
      { data: userDelta, color: COLOR_GREEN, label: "User" },
      { data: sysDelta, color: COLOR_RED, label: "System" },
    ];
    c.addChild(makeLineChart({
      x: 8, y: 22, width: w - 16, height: chartH - 22,
      series, yLabel: "ms/s",
    }));
  } else {
    c.addChild(makeLabel("Collecting data...", 8, 22, COLOR_TEXT_DIM, 10));
  }

  // ── Memory chart (bottom half) ──
  const memY = chartH + 8;
  const memChartH = Math.floor(h * 0.35);
  c.addChild(makeLabel("Memory Usage (MB)", 8, memY, COLOR_GREEN, 12));

  if (memSeries.length > 1) {
    // Convert to MB and build series data (LineSeries.data is number[])
    const rssData = memSeries.map((e: number[]) => e[0] / 1024 / 1024);
    const heapData = memSeries.map((e: number[]) => e[1] / 1024 / 1024);
    const series: LineSeries[] = [
      { data: rssData, color: COLOR_GREEN, label: "RSS" },
      { data: heapData, color: COLOR_YELLOW, label: "Heap" },
    ];
    c.addChild(makeLineChart({
      x: 8, y: memY + 22, width: w - 16, height: memChartH - 22,
      series, yLabel: "MB",
    }));
  } else {
    c.addChild(makeLabel("Collecting data...", 8, memY + 22, COLOR_TEXT_DIM, 10));
  }

  // ── Current values table (bottom) ──
  const tableY = memY + memChartH + 8;
  c.addChild(makeLabel("Current Values", 8, tableY, COLOR_GREEN, 12));
  const entries: { key: string; value: string }[] = [
    { key: "RSS", value: formatBytes(mem.rss) },
    { key: "Heap Used", value: formatBytes(mem.heapUsed) },
    { key: "Heap Total", value: formatBytes(mem.heapTotal) },
    { key: "External", value: formatBytes(mem.external ?? 0) },
    { key: "CPU User", value: `${(cpu.user / 1000).toFixed(0)} ms` },
    { key: "CPU System", value: `${(cpu.system / 1000).toFixed(0)} ms` },
  ];

  // ── ProfilingSAB data (if available) ──
  if (ctx.profilingSAB) {
    const sab = ctx.profilingSAB;
    const view = new Int32Array(sab);
    // Read worker thread timing data from the SAB (layout depends on the engine)
    // The first few ints are typically: [0]=workerCount, [1..N]=per-worker frame time
    const workerCount = Atomics.load(view, 0);
    if (workerCount > 0 && workerCount < 32) {
      entries.push({ key: "Workers", value: String(workerCount) });
      for (let i = 0; i < Math.min(workerCount, 4); i++) {
        const frameTime = Atomics.load(view, 1 + i);
        entries.push({ key: `Worker ${i} frame`, value: `${frameTime} μs` });
      }
    }
  }

  c.addChild(makeKeyValueGrid({ x: 8, y: tableY + 18, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));

  return c;
}
