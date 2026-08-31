// ============================================================================
// ProfilerScene — the pixi-ui scene that renders the in-game profiler overlay.
//
// Runs inside the pixi-ui worker (OffscreenCanvas). Reads the ProfilingSAB
// (shared via ctx.extraSharedBuffers["profiling"]) each frame and renders:
//   - A view selector (10 built-in views)
//   - The active view's content (line charts, bar charts, flame graph, etc.)
//   - A warning toast stack (auto-expiring)
//   - A record/export bar (start/stop trace recording, download JSON)
//
// This is a pure pixi-ui implementation — no DOM, no React, no Electron deps.
// ============================================================================

import {
  ProfilingSABReader,
  computeProfilingSABLayout,
  type ProfilingSnapshot
} from "@downdraft/core/profiling";
import type { PixiUiScene, PixiUiSceneContext, PixiUiUpdateData } from "@downdraft/library-pixi-ui/scene";
import type { DebugViewDescriptor } from "@downdraft/module-devtools";
import { Container, Graphics, Text, type Application } from "pixi.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHART_BG = 0x111122;
const CHART_GRID = 0x222244;
const CHART_AXIS = 0x444466;
const COLOR_GREEN = 0x00ff88;
const COLOR_YELLOW = 0xffaa00;
const COLOR_RED = 0xff4444;
const COLOR_BLUE = 0x4488ff;
const COLOR_PURPLE = 0xff00ff;
const COLOR_CYAN = 0x00ffff;
const COLOR_TEXT = 0xcccccc;
const COLOR_TEXT_DIM = 0x888888;
const COLOR_HEADER = 0x00ff88;
const FONT = "sans-serif";

const HISTORY_LEN = 120; // 120 samples
const SAMPLE_INTERVAL_MS = 50; // record a sample every 50ms → 6s window
const CHART_HEIGHT = 120;
const CHART_PADDING = 40; // left padding for labels
const CHART_TOP = 30; // top padding inside chart area
const CHART_BOTTOM = 20; // bottom padding for x-axis labels

// Colors for per-worker lines (cycled)
const WORKER_COLORS = [COLOR_GREEN, COLOR_BLUE, COLOR_YELLOW, COLOR_CYAN, COLOR_PURPLE, COLOR_RED];

// ─── View renderer types ────────────────────────────────────────────────────

interface ViewRendererContext {
  app: Application;
  width: number;
  height: number;
  snapshot: ProfilingSnapshot | null;
  activeView: string;
  history: MetricsHistory;
  scrollOffset: number;
}

type ViewRenderer = (ctx: ViewRendererContext) => Container;

// ─── Time-series history ────────────────────────────────────────────────────

interface SlotHistory {
  slotIndex: number;
  name: string;
  heapUsed: number[];
  heapTotal: number[];
  cpuPercent: number[];
  taskLatencyP50: number[];
  taskLatencyP95: number[];
  taskLatencyMax: number[];
  gcPauseMax: number[];
  rafJitterP50: number[];
  rafJitterP95: number[];
  rafJitterMax: number[];
  idleHeadroom: number[];
  tick: number[];
}

class MetricsHistory {
  private slots: Map<number, SlotHistory> = new Map();
  private maxLen: number;

  constructor(maxLen: number = HISTORY_LEN) {
    this.maxLen = maxLen;
  }

  /** Record a snapshot's per-slot metrics into the history. */
  record(snapshot: ProfilingSnapshot): void {
    const seenSlots = new Set<number>();
    for (const slot of snapshot.slots) {
      seenSlots.add(slot.slotIndex);
      let h = this.slots.get(slot.slotIndex);
      if (!h) {
        h = {
          slotIndex: slot.slotIndex,
          name: slot.name,
          heapUsed: [],
          heapTotal: [],
          cpuPercent: [],
          taskLatencyP50: [],
          taskLatencyP95: [],
          taskLatencyMax: [],
          gcPauseMax: [],
          rafJitterP50: [],
          rafJitterP95: [],
          rafJitterMax: [],
          idleHeadroom: [],
          tick: [],
        };
        this.slots.set(slot.slotIndex, h);
      }
      h.name = slot.name;
      const m = slot.metrics;
      const el = slot.eventLoop;
      this.push(h.heapUsed, m.heapUsed);
      this.push(h.heapTotal, m.heapTotal);
      this.push(h.cpuPercent, m.cpuPercent);
      this.push(h.taskLatencyP50, m.taskLatencyP50Us);
      this.push(h.taskLatencyP95, m.taskLatencyP95Us);
      this.push(h.taskLatencyMax, m.taskLatencyMaxUs);
      this.push(h.gcPauseMax, m.gcPauseMaxUs);
      this.push(h.rafJitterP50, el.rafJitterP50Us);
      this.push(h.rafJitterP95, el.rafJitterP95Us);
      this.push(h.rafJitterMax, el.rafJitterMaxUs);
      this.push(h.idleHeadroom, el.idleHeadroomMs);
      this.push(h.tick, m.tick);
    }
    // Remove slots that are no longer alive
    for (const [idx, h] of this.slots) {
      if (!seenSlots.has(idx)) {
        this.slots.delete(idx);
      }
    }
  }

  private push(arr: number[], val: number): void {
    arr.push(val);
    if (arr.length > this.maxLen) arr.shift();
  }

  getSlots(): SlotHistory[] {
    return Array.from(this.slots.values()).sort((a, b) => a.slotIndex - b.slotIndex);
  }

  getSlot(slotIndex: number): SlotHistory | undefined {
    return this.slots.get(slotIndex);
  }
}

// ─── Toast system ───────────────────────────────────────────────────────────

interface Toast {
  text: string;
  severity: number;
  createdAt: number;
  duration: number;
}

const TOAST_DURATION_MS = 5000;
const MAX_TOASTS = 5;

// ─── Record/Export bar state ────────────────────────────────────────────────

interface RecordBarState {
  recording: boolean;
  source: "contentTracing" | "in-engine";
  startTime: number;
}

// ─── ProfilerScene ──────────────────────────────────────────────────────────

export class ProfilerScene implements PixiUiScene {
  root: Container;
  private ctx: PixiUiSceneContext;
  private reader: ProfilingSABReader | null = null;
  private views: DebugViewDescriptor[] = [];
  private activeViewIdx: number = 0;
  private contentContainer: Container;
  private viewSelectorContainer: Container;
  private toastContainer: Container;
  private recordBarContainer: Container;
  private toasts: Toast[] = [];
  private recordBar: RecordBarState = { recording: false, source: "in-engine", startTime: 0 };
  private lastWarningsCount: number = 0;
  private viewRenderers: Map<string, ViewRenderer> = new Map();
  private history: MetricsHistory = new MetricsHistory(HISTORY_LEN);
  private lastSampleMs: number = 0;
  private scrollOffset: number = 0;

  constructor(ctx: PixiUiSceneContext) {
    this.ctx = ctx;
    this.root = new Container();
    this.contentContainer = new Container();
    this.viewSelectorContainer = new Container();
    this.toastContainer = new Container();
    this.recordBarContainer = new Container();
    this.root.addChild(this.viewSelectorContainer);
    this.root.addChild(this.contentContainer);
    this.root.addChild(this.recordBarContainer);
    this.root.addChild(this.toastContainer);

    // Initialize the SAB reader if the profiling SAB was shared
    const sab = ctx.extraSharedBuffers?.["profiling"];
    if (sab) {
      const config = ctx.sceneConfig as any;
      const layoutOpts = config?.layout ?? {};
      const layout = computeProfilingSABLayout(
        layoutOpts.maxSlots,
        layoutOpts.iopsRingCap,
        layoutOpts.warningRingCap,
        layoutOpts.stringTableCap,
      );
      this.reader = new ProfilingSABReader(sab, layout);
    }

    this.registerViewRenderers();

    const config = ctx.sceneConfig as any;
    if (config?.views) {
      this.views = config.views;
    } else {
      this.views = this.getDefaultViews();
    }
  }

  update(data: PixiUiUpdateData): void {
    const snapshot = this.reader?.readSnapshot() ?? null;

    // Record metrics into history at a throttled rate so charts don't scroll
    // too fast. Sample every SAMPLE_INTERVAL_MS of wall-clock time.
    const now = performance.now();
    if (snapshot && now - this.lastSampleMs >= SAMPLE_INTERVAL_MS) {
      this.lastSampleMs = now;
      this.scrollOffset = 0; // reset at new sample
      this.history.record(snapshot);

      // Check for new warnings -> add toasts
      const newWarnings = snapshot.warnings.length - this.lastWarningsCount;
      if (newWarnings > 0) {
        for (let i = this.lastWarningsCount; i < snapshot.warnings.length; i++) {
          const w = snapshot.warnings[i];
          this.addToast(this.formatWarning(w), w.severity);
        }
      }
      this.lastWarningsCount = snapshot.warnings.length;
    } else if (snapshot) {
      // Interpolate scrollOffset from 0→1 across the sample interval so the
      // chart scrolls smoothly between discrete samples.
      const elapsed = now - this.lastSampleMs;
      this.scrollOffset = Math.min(1, elapsed / SAMPLE_INTERVAL_MS);
    }

    // Handle pointer events (tab clicks, record bar)
    for (const ev of data.events) {
      if (ev.kind === "pointerdown" && (ev as any).button === 0) {
        const x = (ev as any).x as number;
        const y = (ev as any).y as number;
        if (y >= 0 && y < 36) {
          const tabIdx = Math.floor(x / 80);
          if (tabIdx >= 0 && tabIdx < this.views.length) {
            this.activeViewIdx = tabIdx;
          }
        }
        if (y >= 36 && y < 66) {
          if (x < 120) {
            this.recordBar.recording = !this.recordBar.recording;
            this.recordBar.startTime = performance.now();
          }
        }
      }
    }

    // Clear + redraw
    this.contentContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.viewSelectorContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.toastContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.recordBarContainer.removeChildren().forEach((c) => c.destroy({ children: true }));

    this.drawViewSelector();

    const activeView = this.views[this.activeViewIdx];
    if (activeView) {
      const renderer = this.viewRenderers.get(activeView.kind);
      if (renderer) {
        const viewContent = renderer({
          app: this.ctx.app,
          width: this.ctx.width,
          height: this.ctx.height,
          snapshot,
          activeView: activeView.id,
          history: this.history,
          scrollOffset: this.scrollOffset,
        });
        viewContent.y = 70;
        this.contentContainer.addChild(viewContent);
      }
    }

    this.drawToasts();
    this.drawRecordBar();
  }

  resize(_width: number, _height: number): void {}

  getInteractiveRegions() {
    const regions: { x: number; y: number; width: number; height: number }[] = [];
    for (let i = 0; i < this.views.length; i++) {
      regions.push({ x: i * 80, y: 0, width: 80, height: 36 });
    }
    regions.push({ x: 0, y: 36, width: this.ctx.width, height: 30 });
    return regions;
  }

  dispose(): void {
    this.root.destroy({ children: true });
  }

  // ─── Private methods ──────────────────────────────────────────────────────

  private addToast(text: string, severity: number): void {
    this.toasts.push({ text, severity, createdAt: performance.now(), duration: TOAST_DURATION_MS });
    if (this.toasts.length > MAX_TOASTS) this.toasts.shift();
  }

  private formatWarning(w: any): string {
    const sevNames = ["INFO", "WARN", "ERROR", "CRITICAL"];
    const sev = sevNames[w.severity] ?? "UNKNOWN";
    return `[${sev}] ${w.ruleIdHash} = ${w.value} (threshold ${w.threshold})`;
  }

  private drawViewSelector(): void {
    const bg = new Graphics();
    bg.rect(0, 0, this.ctx.width, 36);
    bg.fill({ color: 0x1a1a2e, alpha: 0.9 });
    this.viewSelectorContainer.addChild(bg);

    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i];
      const isActive = i === this.activeViewIdx;
      const tab = new Text({
        text: view.label,
        style: { fontSize: 12, fill: isActive ? COLOR_GREEN : COLOR_TEXT_DIM, fontFamily: FONT },
      });
      tab.x = i * 80 + 5;
      tab.y = 14;
      this.viewSelectorContainer.addChild(tab);
    }
  }

  private drawToasts(): void {
    const now = performance.now();
    this.toasts = this.toasts.filter((t) => now - t.createdAt < t.duration);
    let y = this.ctx.height - 30;
    for (const toast of this.toasts) {
      const colors = [COLOR_BLUE, COLOR_YELLOW, COLOR_RED, COLOR_PURPLE];
      const color = colors[toast.severity] ?? COLOR_TEXT_DIM;
      const bg = new Graphics();
      const text = new Text({
        text: toast.text,
        style: { fontSize: 10, fill: 0xffffff, fontFamily: FONT },
      });
      const w = Math.min(text.width + 20, this.ctx.width - 20);
      bg.roundRect(10, y - 25, w, 25, 4);
      bg.fill({ color, alpha: 0.8 });
      text.x = 15;
      text.y = y - 22;
      this.toastContainer.addChild(bg);
      this.toastContainer.addChild(text);
      y -= 30;
    }
  }

  private drawRecordBar(): void {
    const bg = new Graphics();
    bg.rect(0, 36, this.ctx.width, 30);
    bg.fill({ color: 0x0a0a1a, alpha: 0.9 });
    this.recordBarContainer.addChild(bg);

    const recordText = this.recordBar.recording ? "[REC] (stop)" : "[ ] Record";
    const recordColor = this.recordBar.recording ? COLOR_RED : COLOR_GREEN;
    const recLabel = new Text({
      text: recordText,
      style: { fontSize: 12, fill: recordColor, fontFamily: FONT },
    });
    recLabel.x = 10;
    recLabel.y = 44;
    this.recordBarContainer.addChild(recLabel);

    const srcLabel = new Text({
      text: `Source: ${this.recordBar.source}`,
      style: { fontSize: 12, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    srcLabel.x = 120;
    srcLabel.y = 44;
    this.recordBarContainer.addChild(srcLabel);

    if (this.recordBar.recording) {
      const elapsed = ((performance.now() - this.recordBar.startTime) / 1000).toFixed(1);
      const timeLabel = new Text({
        text: `${elapsed}s`,
        style: { fontSize: 12, fill: COLOR_RED, fontFamily: FONT },
      });
      timeLabel.x = 250;
      timeLabel.y = 44;
      this.recordBarContainer.addChild(timeLabel);
    }
  }

  private getDefaultViews(): DebugViewDescriptor[] {
    return [
      { id: "memory", label: "Memory", kind: "memory", order: 0 },
      { id: "cpu", label: "CPU", kind: "cpu", order: 1 },
      { id: "task-latency", label: "Task Latency", kind: "task-latency", order: 2 },
      { id: "iops-opfs", label: "IOPS: OPFS", kind: "iops-opfs", order: 3 },
      { id: "iops-idb", label: "IOPS: IDB", kind: "iops-idb", order: 4 },
      { id: "event-loop", label: "Event Loop", kind: "event-loop", order: 5 },
      { id: "gc-heap", label: "GC & Heap", kind: "gc-heap", order: 6 },
      { id: "flame-graph", label: "Flame Graph", kind: "flame-graph", order: 7 },
      { id: "gpu-passes", label: "GPU Passes", kind: "gpu-passes", order: 8 },
      { id: "warnings", label: "Warnings", kind: "warnings", order: 9 },
    ];
  }

  private registerViewRenderers(): void {
    this.viewRenderers.set("memory", renderMemoryView);
    this.viewRenderers.set("cpu", renderCpuView);
    this.viewRenderers.set("task-latency", renderTaskLatencyView);
    this.viewRenderers.set("iops-opfs", renderIopsView.bind(null, 0));
    this.viewRenderers.set("iops-idb", renderIopsView.bind(null, 1));
    this.viewRenderers.set("event-loop", renderEventLoopView);
    this.viewRenderers.set("gc-heap", renderGcHeapView);
    this.viewRenderers.set("flame-graph", renderFlameGraphView);
    this.viewRenderers.set("gpu-passes", renderGpuPassesView);
    this.viewRenderers.set("warnings", renderWarningsView);
  }
}

// ─── Chart helpers ──────────────────────────────────────────────────────────

function makeBaseContainer(width: number, height: number): Container {
  const c = new Container();
  const bg = new Graphics();
  bg.rect(0, 0, width, height);
  bg.fill({ color: CHART_BG, alpha: 0.85 });
  c.addChild(bg);
  return c;
}

function makeLabel(text: string, x: number, y: number, color: number, fontSize: number = 10): Text {
  return new Text({
    text,
    style: { fontSize, fill: color, fontFamily: FONT },
    x, y,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}us`;
  return `${(us / 1000).toFixed(2)}ms`;
}

function slotDisplayName(slot: { name: string; slotIndex: number }): string {
  const n = slot.name;
  if (!n || n.length === 0) return `slot-${slot.slotIndex}`;
  // Filter non-printable characters (garbage from SAB mismatch)
  for (let i = 0; i < n.length && i < 64; i++) {
    const c = n.charCodeAt(i);
    if (c < 32 || c > 126) return `slot-${slot.slotIndex}`;
  }
  return n;
}

/**
 * Draw a line chart for a time-series of values.
 * @param container The container to draw into
 * @param series Array of { label, data, color } entries
 * @param x Left x position
 * @param y Top y position
 * @param width Chart width
 * @param height Chart height
 * @param yMax Max Y value (auto-scale if 0)
 * @param yLabel Label for Y axis
 */
function drawLineChart(
  container: Container,
  series: { label: string; data: number[]; color: number }[],
  x: number,
  y: number,
  width: number,
  height: number,
  yMax: number = 0,
  yLabel: string = "",
  scrollOffset: number = 0,
): void {
  const chartW = width - CHART_PADDING - 10;
  const chartH = height - CHART_TOP - CHART_BOTTOM;
  const chartX = x + CHART_PADDING;
  const chartY = y + CHART_TOP;

  // Auto-scale Y
  let maxVal = yMax;
  if (maxVal <= 0) {
    for (const s of series) {
      for (const v of s.data) {
        if (v > maxVal) maxVal = v;
      }
    }
  }
  if (maxVal <= 0) maxVal = 1;

  // Background
  const bg = new Graphics();
  bg.rect(chartX, chartY, chartW, chartH);
  bg.fill({ color: 0x0a0a16, alpha: 0.6 });
  container.addChild(bg);

  // Grid lines (4 horizontal)
  const grid = new Graphics();
  for (let i = 0; i <= 4; i++) {
    const gy = chartY + (chartH * i) / 4;
    grid.moveTo(chartX, gy);
    grid.lineTo(chartX + chartW, gy);
    grid.stroke({ color: CHART_GRID, width: 1, alpha: 0.5 });
    // Y-axis label
    const val = maxVal * (1 - i / 4);
    const lbl = new Text({
      text: val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0),
      style: { fontSize: 10, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    lbl.x = chartX - 30;
    lbl.y = gy - 5;
    container.addChild(lbl);
  }
  // Vertical grid lines (6)
  for (let i = 0; i <= 6; i++) {
    const gx = chartX + (chartW * i) / 6;
    grid.moveTo(gx, chartY);
    grid.lineTo(gx, chartY + chartH);
    grid.stroke({ color: CHART_GRID, width: 1, alpha: 0.3 });
  }
  container.addChild(grid);

  // Axes
  const axes = new Graphics();
  axes.moveTo(chartX, chartY);
  axes.lineTo(chartX, chartY + chartH);
  axes.lineTo(chartX + chartW, chartY + chartH);
  axes.stroke({ color: CHART_AXIS, width: 1 });
  container.addChild(axes);

  // Y-axis label
  if (yLabel) {
    const yLbl = new Text({
      text: yLabel,
      style: { fontSize: 10, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    yLbl.x = x;
    yLbl.y = y + 5;
    container.addChild(yLbl);
  }

  // Draw each series as a line.
  // scrollOffset interpolates x positions so the chart scrolls smoothly
  // between samples instead of jumping one column per tick.
  for (const s of series) {
    if (s.data.length < 2) continue;
    const line = new Graphics();
    const n = s.data.length;
    // The newest sample is anchored at the right edge; older samples flow
    // leftward. scrollOffset ∈ [0,1) shifts everything left by a fraction
    // of one sample width, producing sub-pixel smooth motion.
    const sampleW = chartW / (HISTORY_LEN - 1);
    for (let i = 0; i < n; i++) {
      // i = n-1 is the newest sample → rightmost. Older samples are to its left.
      const ageFromRight = n - 1 - i;
      const px = chartX + chartW - ageFromRight * sampleW - scrollOffset * sampleW;
      const py = chartY + chartH - (s.data[i] / maxVal) * chartH;
      if (i === 0) line.moveTo(px, py);
      else line.lineTo(px, py);
    }
    line.stroke({ color: s.color, width: 1.5, alpha: 0.9 });
    container.addChild(line);
  }

  // Legend
  let legendX = chartX + 5;
  const legendY = chartY + 3;
  for (const s of series) {
    const dot = new Graphics();
    dot.circle(legendX, legendY + 5, 4);
    dot.fill({ color: s.color });
    container.addChild(dot);
    const lbl = new Text({
      text: s.label,
      style: { fontSize: 10, fill: s.color, fontFamily: FONT },
    });
    lbl.x = legendX + 8;
    lbl.y = legendY;
    container.addChild(lbl);
    legendX += lbl.width + 20;
  }
}

/**
 * Draw a bar chart for current values across slots.
 */
function drawBarChart(
  container: Container,
  bars: { label: string; value: number; color: number }[],
  x: number,
  y: number,
  width: number,
  height: number,
  yMax: number = 0,
  yLabel: string = "",
): void {
  const chartW = width - CHART_PADDING - 10;
  const chartH = height - CHART_TOP - CHART_BOTTOM;
  const chartX = x + CHART_PADDING;
  const chartY = y + CHART_TOP;

  let maxVal = yMax;
  if (maxVal <= 0) {
    for (const b of bars) {
      if (b.value > maxVal) maxVal = b.value;
    }
  }
  if (maxVal <= 0) maxVal = 1;

  // Background
  const bg = new Graphics();
  bg.rect(chartX, chartY, chartW, chartH);
  bg.fill({ color: 0x0a0a16, alpha: 0.6 });
  container.addChild(bg);

  // Grid lines
  const grid = new Graphics();
  for (let i = 0; i <= 4; i++) {
    const gy = chartY + (chartH * i) / 4;
    grid.moveTo(chartX, gy);
    grid.lineTo(chartX + chartW, gy);
    grid.stroke({ color: CHART_GRID, width: 1, alpha: 0.5 });
    const val = maxVal * (1 - i / 4);
    const lbl = new Text({
      text: val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0),
      style: { fontSize: 10, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    lbl.x = chartX - 30;
    lbl.y = gy - 5;
    container.addChild(lbl);
  }
  container.addChild(grid);

  // Axes
  const axes = new Graphics();
  axes.moveTo(chartX, chartY);
  axes.lineTo(chartX, chartY + chartH);
  axes.lineTo(chartX + chartW, chartY + chartH);
  axes.stroke({ color: CHART_AXIS, width: 1 });
  container.addChild(axes);

  if (yLabel) {
    const yLbl = new Text({
      text: yLabel,
      style: { fontSize: 10, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    yLbl.x = x;
    yLbl.y = y + 5;
    container.addChild(yLbl);
  }

  // Bars
  const barWidth = bars.length > 0 ? chartW / bars.length : chartW;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const bx = chartX + i * barWidth + 4;
    const bh = (b.value / maxVal) * chartH;
    const by = chartY + chartH - bh;
    const bar = new Graphics();
    bar.rect(bx, by, barWidth - 8, bh);
    bar.fill({ color: b.color, alpha: 0.8 });
    container.addChild(bar);
    // Label
    const lbl = new Text({
      text: b.label,
      style: { fontSize: 10, fill: COLOR_TEXT_DIM, fontFamily: FONT },
    });
    lbl.x = bx;
    lbl.y = chartY + chartH + 3;
    container.addChild(lbl);
  }
}

function formatAxisValue(val: number): string {
  if (val >= 1024 * 1024) return `${(val / (1024 * 1024)).toFixed(1)}M`;
  if (val >= 1024) return `${(val / 1024).toFixed(1)}K`;
  if (val >= 100) return val.toFixed(0);
  return val.toFixed(1);
}

// ─── View renderers ─────────────────────────────────────────────────────────
// Each view shows ONE chart with ONE line per worker (using WORKER_COLORS).
// This makes it easy to compare workers side by side.

function getWorkerSeries(
  slots: SlotHistory[],
  extractor: (sh: SlotHistory) => number[],
): { label: string; data: number[]; color: number }[] {
  return slots.map((sh, i) => ({
    label: slotDisplayName(sh),
    data: extractor(sh),
    color: WORKER_COLORS[i % WORKER_COLORS.length],
  }));
}

function renderMemoryView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 400);
  c.addChild(makeLabel("Memory — Heap Used (one line per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No profiling data (waiting for workers to claim slots...)", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  // Chart 1: Heap Used (one line per worker)
  c.addChild(makeLabel("Heap Used", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.heapUsed), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "bytes", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  // Chart 2: Heap Total (one line per worker)
  c.addChild(makeLabel("Heap Total", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.heapTotal), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "bytes", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  // Current values summary
  for (const sh of slots) {
    const name = slotDisplayName(sh);
    const lastUsed = sh.heapUsed.length > 0 ? sh.heapUsed[sh.heapUsed.length - 1] : 0;
    const lastTotal = sh.heapTotal.length > 0 ? sh.heapTotal[sh.heapTotal.length - 1] : 0;
    const pct = lastTotal > 0 ? (lastUsed / lastTotal) * 100 : 0;
    c.addChild(makeLabel(`${name}: ${formatBytes(lastUsed)} / ${formatBytes(lastTotal)} (${pct.toFixed(0)}%)`, 10, y, COLOR_TEXT_DIM, 10));
    y += 14;
  }

  return c;
}

function renderCpuView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 400);
  c.addChild(makeLabel("CPU — % over time (one line per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  drawLineChart(c, getWorkerSeries(slots, s => s.cpuPercent), 10, y, ctx.width - 20, CHART_HEIGHT, 100, "%", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  for (const sh of slots) {
    const name = slotDisplayName(sh);
    const lastCpu = sh.cpuPercent.length > 0 ? sh.cpuPercent[sh.cpuPercent.length - 1] : 0;
    const lastTick = sh.tick.length > 0 ? sh.tick[sh.tick.length - 1] : 0;
    c.addChild(makeLabel(`${name}: ${lastCpu.toFixed(1)}%  tick: ${lastTick}`, 10, y, COLOR_TEXT_DIM, 10));
    y += 14;
  }

  return c;
}

function renderTaskLatencyView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 500);
  c.addChild(makeLabel("Task Latency (one line per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  c.addChild(makeLabel("p50", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.taskLatencyP50), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "us", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  c.addChild(makeLabel("p95", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.taskLatencyP95), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "us", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  c.addChild(makeLabel("max", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.taskLatencyMax), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "us", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  for (const sh of slots) {
    const name = slotDisplayName(sh);
    const p50 = sh.taskLatencyP50.length > 0 ? sh.taskLatencyP50[sh.taskLatencyP50.length - 1] : 0;
    const p95 = sh.taskLatencyP95.length > 0 ? sh.taskLatencyP95[sh.taskLatencyP95.length - 1] : 0;
    const max = sh.taskLatencyMax.length > 0 ? sh.taskLatencyMax[sh.taskLatencyMax.length - 1] : 0;
    c.addChild(makeLabel(`${name}: p50=${formatUs(p50)}  p95=${formatUs(p95)}  max=${formatUs(max)}`, 10, y, COLOR_TEXT_DIM, 10));
    y += 14;
  }

  return c;
}

function renderIopsView(store: number, ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 400);
  const storeName = store === 0 ? "OPFS" : "IDB";
  c.addChild(makeLabel(`IOPS: ${storeName}`, 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  let y = 25;
  let totalOps = 0;
  const slotBars: { label: string; value: number; color: number }[] = [];

  for (let i = 0; i < ctx.snapshot.slots.length; i++) {
    const slot = ctx.snapshot.slots[i];
    const records = slot.iopsRecords.filter((r) => r.store === store);
    if (records.length === 0) continue;
    const name = slotDisplayName(slot);
    totalOps += records.length;
    slotBars.push({ label: name.slice(0, 8), value: records.length, color: WORKER_COLORS[i % WORKER_COLORS.length] });

    c.addChild(makeLabel(`${name}: ${records.length} ops`, 10, y, COLOR_TEXT, 11));
    y += 15;

    for (const r of records.slice(0, 8)) {
      const tag = slot.tagTable.get(r.tagHash) ?? `hash:${r.tagHash}`;
      c.addChild(makeLabel(`  op=${r.opKind} tag=${tag} bytes=${formatBytes(r.bytes)} latency=${formatUs(r.latencyUs)}`, 20, y, COLOR_TEXT_DIM, 10));
      y += 12;
    }
    y += 5;
  }

  if (totalOps === 0) {
    c.addChild(makeLabel(`No ${storeName} IOPS recorded (no operations or patches not active)`, 10, y, COLOR_TEXT_DIM));
    return c;
  }

  if (slotBars.length > 0) {
    y += 10;
    c.addChild(makeLabel("Ops by worker", 10, y, COLOR_TEXT, 11));
    y += 15;
    drawBarChart(c, slotBars, 10, y, ctx.width - 20, 100, 0, "ops");
  }

  return c;
}

function renderEventLoopView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 500);
  c.addChild(makeLabel("Event Loop (one line per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  c.addChild(makeLabel("rAF Jitter p95", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.rafJitterP95), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "us", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  c.addChild(makeLabel("Idle Headroom", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.idleHeadroom), 10, y, ctx.width - 20, CHART_HEIGHT, 16.67, "ms", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  for (const sh of slots) {
    const name = slotDisplayName(sh);
    const j95 = sh.rafJitterP95.length > 0 ? sh.rafJitterP95[sh.rafJitterP95.length - 1] : 0;
    const idle = sh.idleHeadroom.length > 0 ? sh.idleHeadroom[sh.idleHeadroom.length - 1] : 0;
    c.addChild(makeLabel(`${name}: jitter p95=${formatUs(j95)} | idle=${idle.toFixed(1)}ms`, 10, y, COLOR_TEXT_DIM, 10));
    y += 14;
  }

  return c;
}

function renderGcHeapView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 500);
  c.addChild(makeLabel("GC & Heap (one line per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  c.addChild(makeLabel("GC Max Pause", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.gcPauseMax), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "us", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  c.addChild(makeLabel("Heap Used", 10, y, COLOR_TEXT, 11));
  y += 15;
  drawLineChart(c, getWorkerSeries(slots, s => s.heapUsed), 10, y, ctx.width - 20, CHART_HEIGHT, 0, "bytes", ctx.scrollOffset);
  y += CHART_HEIGHT + 10;

  for (const sh of slots) {
    const name = slotDisplayName(sh);
    const gcMax = sh.gcPauseMax.length > 0 ? sh.gcPauseMax[sh.gcPauseMax.length - 1] : 0;
    const used = sh.heapUsed.length > 0 ? sh.heapUsed[sh.heapUsed.length - 1] : 0;
    c.addChild(makeLabel(`${name}: gc max=${formatUs(gcMax)} | heap ${formatBytes(used)}`, 10, y, COLOR_TEXT_DIM, 10));
    y += 14;
  }

  return c;
}

function renderFlameGraphView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 400);
  c.addChild(makeLabel("Flame Graph — Task Latency Timeline (one row per worker)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.slots.length === 0) {
    c.addChild(makeLabel("No data", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const slots = ctx.history.getSlots();
  let y = 25;

  for (let si = 0; si < slots.length; si++) {
    const sh = slots[si];
    const name = slotDisplayName(sh);
    const color = WORKER_COLORS[si % WORKER_COLORS.length];
    c.addChild(makeLabel(name, 10, y, color, 11));
    y += 15;

    // Latency timeline: each sample is a vertical bar colored by magnitude
    const chartW = ctx.width - 40;
    const chartH = 60;
    const chartX = 30;
    const chartY = y;
    const sampleW = chartW / HISTORY_LEN;

    // Background
    const bg = new Graphics();
    bg.rect(chartX, chartY, chartW, chartH);
    bg.fill({ color: 0x0a0a16, alpha: 0.6 });
    c.addChild(bg);

    // Find max for scaling
    let maxLat = 1;
    for (const v of sh.taskLatencyMax) {
      if (v > maxLat) maxLat = v;
    }

    // Draw bars with smooth scroll offset
    const data = sh.taskLatencyMax;
    const bars = new Graphics();
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const bh = (v / maxLat) * chartH;
      const px = chartX + chartW - (data.length - 1 - i) * sampleW - ctx.scrollOffset * sampleW;
      const by = chartY + chartH - bh;
      const barColor = v > maxLat * 0.8 ? COLOR_RED : v > maxLat * 0.5 ? COLOR_YELLOW : COLOR_GREEN;
      bars.rect(px, by, Math.max(1, sampleW - 0.5), bh);
      bars.fill({ color: barColor, alpha: 0.85 });
    }
    c.addChild(bars);

    // Axis
    const axes = new Graphics();
    axes.moveTo(chartX, chartY);
    axes.lineTo(chartX, chartY + chartH);
    axes.lineTo(chartX + chartW, chartY + chartH);
    axes.stroke({ color: CHART_AXIS, width: 1 });
    c.addChild(axes);

    c.addChild(makeLabel(formatAxisValue(maxLat), chartX - 35, chartY - 5, COLOR_TEXT_DIM, 10));
    c.addChild(makeLabel("0", chartX - 15, chartY + chartH - 6, COLOR_TEXT_DIM, 10));

    y += chartH + 15;

    const p50 = sh.taskLatencyP50.length > 0 ? sh.taskLatencyP50[sh.taskLatencyP50.length - 1] : 0;
    const max = sh.taskLatencyMax.length > 0 ? sh.taskLatencyMax[sh.taskLatencyMax.length - 1] : 0;
    c.addChild(makeLabel(`p50=${formatUs(p50)}  max=${formatUs(max)}`, 10, y, COLOR_TEXT_DIM, 10));
    y += 18;
  }

  return c;
}

function renderGpuPassesView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 200);
  c.addChild(makeLabel("GPU Passes (render/compute/blit timings)", 10, 5, COLOR_HEADER, 12));
  const gpuPasses = (ctx.snapshot as any)?.gpuPasses ?? [];
  if (gpuPasses.length === 0) {
    c.addChild(makeLabel("No GPU pass data (requires TelemetryCollector wiring)", 10, 30, COLOR_TEXT_DIM));
    return c;
  }
  let y = 30;
  let totalGpuMs = 0;
  for (const p of gpuPasses) {
    c.addChild(makeLabel(`${p.name}: ${p.ms.toFixed(2)}ms (${p.type})`, 10, y, COLOR_TEXT));
    totalGpuMs += p.ms;
    y += 14;
  }
  c.addChild(makeLabel(`Total GPU: ${totalGpuMs.toFixed(2)}ms`, 10, y + 5, COLOR_GREEN, 11));
  return c;
}

function renderWarningsView(ctx: ViewRendererContext): Container {
  const c = makeBaseContainer(ctx.width, 400);
  c.addChild(makeLabel("Warnings (recent)", 10, 5, COLOR_HEADER, 12));

  if (!ctx.snapshot || ctx.snapshot.warnings.length === 0) {
    c.addChild(makeLabel("No warnings", 10, 30, COLOR_TEXT_DIM));
    return c;
  }

  const sevColors = [COLOR_BLUE, COLOR_YELLOW, COLOR_RED, COLOR_PURPLE];
  const sevNames = ["INFO", "WARN", "ERROR", "CRITICAL"];
  let y = 25;
  for (const w of ctx.snapshot.warnings.slice(-20)) {
    const sev = sevNames[w.severity] ?? "UNKNOWN";
    const color = sevColors[w.severity] ?? COLOR_TEXT_DIM;
    c.addChild(makeLabel(`[${sev}] metric=${w.metricKind} val=${w.value} threshold=${w.threshold}`, 10, y, color, 10));
    y += 14;
  }
  return c;
}
