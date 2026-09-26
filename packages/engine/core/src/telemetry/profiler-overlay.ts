import { UIButton, UILine, UIPanel, UIRoot, UIScrollPanel, UITabBar, UIText, type UIColor } from "../imui";
import type { SnapshotDiff } from "./collector";
import { TelemetryCollector } from "./collector";

export interface ProfilerOverlayConfig {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  updateIntervalMs: number;
  fontSize: number;
  panelWidth: number;
  panelHeight: number;
}

export const DEFAULT_PROFILER_CONFIG: ProfilerOverlayConfig = {
  position: "top-left",
  updateIntervalMs: 100,
  fontSize: 11,
  panelWidth: 440,
  panelHeight: 520,
};

const COLORS = {
  green: [0.3, 0.9, 0.3, 1] as UIColor,
  yellow: [1, 1, 0.3, 1] as UIColor,
  red: [1, 0.3, 0.3, 1] as UIColor,
  cyan: [0.3, 0.8, 1, 1] as UIColor,
  white: [1, 1, 1, 1] as UIColor,
  dim: [0.6, 0.6, 0.6, 1] as UIColor,
  orange: [1, 0.65, 0.3, 1] as UIColor,
  purple: [0.7, 0.4, 1, 1] as UIColor,
  bg: [0.05, 0.05, 0.08, 0.92] as UIColor,
  border: [0.3, 0.3, 0.35, 0.8] as UIColor,
  barBg: [0.15, 0.15, 0.18, 0.8] as UIColor,
  tabBg: [0.1, 0.1, 0.14, 0.95] as UIColor,
  contentBg: [0.06, 0.06, 0.1, 0.9] as UIColor,
};

const PASS_COLORS: UIColor[] = [
  [0.3, 0.8, 1, 1],
  [0.3, 0.9, 0.3, 1],
  [1, 1, 0.3, 1],
  [1, 0.65, 0.3, 1],
  [1, 0.3, 0.3, 1],
  [0.7, 0.4, 1, 1],
  [0.3, 1, 0.8, 1],
  [1, 0.5, 0.8, 1],
  [0.5, 0.8, 1, 1],
  [0.8, 0.8, 0.3, 1],
];

type TabId = "overview" | "passes" | "memory" | "render" | "graph" | "snapshots";

export class ProfilerOverlay {
  private telemetry: TelemetryCollector;
  private config: ProfilerOverlayConfig;
  private root: UIRoot;
  private mainPanel: UIPanel;
  private tabBar: UITabBar;
  private contentPanel: UIPanel;
  private scrollPanel: UIScrollPanel;
  private visible: boolean = false;
  private lastUpdate: number = 0;
  private screenWidth: number = 1920;
  private screenHeight: number = 1080;
  private activeTab: TabId = "overview";
  private graphLine: UILine;
  private graphHistory: number[] = [];
  private maxGraphPoints: number = 120;
  private selectedSnapshotA: number = -1;
  private selectedSnapshotB: number = -1;
  private snapshotDiffs: SnapshotDiff[] = [];
  private tabContent: UIPanel[] = [];
  private overviewTexts: UIText[] = [];
  private passTexts: UIText[] = [];
  private passBars: UIPanel[] = [];
  private memoryTexts: UIText[] = [];
  private renderTexts: UIText[] = [];
  private snapshotTexts: UIText[] = [];
  private snapshotButtons: UIButton[] = [];
  private graphRefTexts: UIText[] = [];

  constructor(telemetry: TelemetryCollector, config?: Partial<ProfilerOverlayConfig>) {
    this.telemetry = telemetry;
    this.config = { ...DEFAULT_PROFILER_CONFIG, ...config };
    this.root = new UIRoot(this.screenWidth, this.screenHeight);
    this.mainPanel = new UIPanel(this.config.panelWidth, this.config.panelHeight);
    this.mainPanel.style.backgroundColor = COLORS.bg;
    this.mainPanel.style.borderColor = COLORS.border;
    this.mainPanel.style.borderWidth = 1;
    this.mainPanel.style.borderRadius = 6;
    this.mainPanel.layoutMode = "absolute";
    this.root.addChild(this.mainPanel);
    this.root.visible = false;

    const tabHeight = 28;
    this.tabBar = new UITabBar(this.config.panelWidth);
    this.tabBar.setTabs([
      { id: "overview", label: "Overview" },
      { id: "passes", label: "Passes" },
      { id: "memory", label: "Memory" },
      { id: "render", label: "Render" },
      { id: "graph", label: "Graph" },
      { id: "snapshots", label: "Snapshots" },
    ]);
    this.tabBar.onTabChange = (id: string) => this.switchTab(id as TabId);
    this.tabBar.x = 0;
    this.tabBar.y = 0;
    this.mainPanel.addChild(this.tabBar);

    const contentY = tabHeight;
    const contentH = this.config.panelHeight - tabHeight;

    this.contentPanel = new UIPanel(this.config.panelWidth, contentH);
    this.contentPanel.x = 0;
    this.contentPanel.y = contentY;
    this.contentPanel.style.backgroundColor = COLORS.contentBg;
    this.contentPanel.layoutMode = "absolute";
    this.mainPanel.addChild(this.contentPanel);

    this.scrollPanel = new UIScrollPanel(this.config.panelWidth - 4, contentH - 4);
    this.scrollPanel.x = 2;
    this.scrollPanel.y = 2;
    this.scrollPanel.style.backgroundColor = [0, 0, 0, 0];
    this.contentPanel.addChild(this.scrollPanel);

    this.graphLine = new UILine();
    this.graphLine.lineWidth = 1.5;
    this.graphLine.lineColor = COLORS.cyan;

    this.buildAllTabs();
    this.layout();
  }

  private buildAllTabs(): void {
    for (let i = 0; i < 6; i++) {
      const panel = new UIPanel(this.config.panelWidth - 8, 0);
      panel.style.backgroundColor = [0, 0, 0, 0];
      panel.layoutMode = "absolute";
      this.tabContent[i] = panel;
      this.scrollPanel.addChild(panel);
    }
    this.buildOverviewTab();
    this.buildPassesTab();
    this.buildMemoryTab();
    this.buildRenderTab();
    this.buildGraphTab();
    this.buildSnapshotsTab();
  }

  private buildOverviewTab(): void {
    const p = this.tabContent[0];
    p.removeChildren();
    this.overviewTexts = [];
    const fs = this.config.fontSize;
    const lineH = fs + 4;
    const labels = [
      "FPS: --", "Frame: --ms", "p95: --ms  p99: --ms",
      "Draws: --", "Tris: --", "GPU: --ms",
      "Heap: --MB / --MB", "VRAM: --MB (tex:-- buf:--)",
      "Passes: --", "Snapshots: --",
    ];
    for (let i = 0; i < labels.length; i++) {
      const t = new UIText(labels[i], this.config.panelWidth - 20, lineH);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = COLORS.white;
      t.x = 8;
      t.y = 4 + i * lineH;
      p.addChild(t);
      this.overviewTexts.push(t);
    }
    p.height = labels.length * lineH + 8;
  }

  private buildPassesTab(): void {
    const p = this.tabContent[1];
    p.removeChildren();
    this.passTexts = [];
    this.passBars = [];
    const fs = this.config.fontSize;
    const lineH = fs + 6;
    const maxPasses = 16;
    for (let i = 0; i < maxPasses; i++) {
      const barBg = new UIPanel(this.config.panelWidth - 20, 3);
      barBg.x = 8;
      barBg.y = 4 + i * lineH + fs;
      barBg.style.backgroundColor = COLORS.barBg;
      barBg.style.borderRadius = 2;
      p.addChild(barBg);
      this.passBars.push(barBg);

      const bar = new UIPanel(0, 3);
      bar.x = 8;
      bar.y = 4 + i * lineH + fs;
      bar.style.backgroundColor = PASS_COLORS[i % PASS_COLORS.length];
      bar.style.borderRadius = 2;
      p.addChild(bar);
      this.passBars.push(bar);

      const t = new UIText("", this.config.panelWidth - 20, lineH);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = COLORS.white;
      t.x = 8;
      t.y = 4 + i * lineH;
      p.addChild(t);
      this.passTexts.push(t);
    }
    p.height = maxPasses * lineH + 8;
  }

  private buildMemoryTab(): void {
    const p = this.tabContent[2];
    p.removeChildren();
    this.memoryTexts = [];
    const fs = this.config.fontSize;
    const lineH = fs + 3;
    const maxRows = 40;
    for (let i = 0; i < maxRows; i++) {
      const t = new UIText("", this.config.panelWidth - 20, lineH);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = i === 0 ? COLORS.cyan : COLORS.white;
      t.x = 8;
      t.y = 4 + i * lineH;
      p.addChild(t);
      this.memoryTexts.push(t);
    }
    p.height = maxRows * lineH + 8;
  }

  private buildRenderTab(): void {
    const p = this.tabContent[3];
    p.removeChildren();
    this.renderTexts = [];
    const fs = this.config.fontSize;
    const lineH = fs + 3;
    const maxRows = 30;
    for (let i = 0; i < maxRows; i++) {
      const t = new UIText("", this.config.panelWidth - 20, lineH);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = i === 0 ? COLORS.cyan : COLORS.white;
      t.x = 8;
      t.y = 4 + i * lineH;
      p.addChild(t);
      this.renderTexts.push(t);
    }
    p.height = maxRows * lineH + 8;
  }

  private buildGraphTab(): void {
    const p = this.tabContent[4];
    p.removeChildren();
    this.graphRefTexts = [];
    const fs = this.config.fontSize;
    const graphH = 200;
    const graphW = this.config.panelWidth - 20;

    const titleText = new UIText("Frame Time Graph (ms)", graphW, fs + 2);
    titleText.style.fontSize = fs;
    titleText.style.fontFamily = "monospace";
    titleText.style.textColor = COLORS.cyan;
    titleText.x = 8;
    titleText.y = 4;
    p.addChild(titleText);

    const graphBg = new UIPanel(graphW, graphH);
    graphBg.x = 8;
    graphBg.y = 4 + fs + 4;
    graphBg.style.backgroundColor = [0.08, 0.08, 0.1, 0.8];
    graphBg.style.borderColor = COLORS.border;
    graphBg.style.borderWidth = 1;
    p.addChild(graphBg);

    this.graphLine.x = 8;
    this.graphLine.y = 4 + fs + 4;
    this.graphLine.width = graphW;
    this.graphLine.height = graphH;
    p.addChild(this.graphLine);

    const refLabels = ["16.7ms (60fps)", "33.3ms (30fps)", "Avg  p95  p99  Min  Max"];
    for (let i = 0; i < refLabels.length; i++) {
      const t = new UIText(refLabels[i], graphW, fs + 2);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = i < 2 ? COLORS.dim : COLORS.white;
      t.x = 8;
      t.y = 4 + fs + 4 + graphH + 4 + i * (fs + 3);
      p.addChild(t);
      this.graphRefTexts.push(t);
    }
    p.height = fs + 4 + graphH + 4 + refLabels.length * (fs + 3) + 8;
  }

  private buildSnapshotsTab(): void {
    const p = this.tabContent[5];
    p.removeChildren();
    this.snapshotTexts = [];
    this.snapshotButtons = [];
    const fs = this.config.fontSize;
    const lineH = fs + 4;

    const btnRow = new UIPanel(this.config.panelWidth - 16, 28);
    btnRow.x = 8;
    btnRow.y = 4;
    btnRow.style.backgroundColor = [0, 0, 0, 0];
    btnRow.layoutMode = "horizontal";
    p.addChild(btnRow);

    const snapBtn = new UIButton("Snapshot", 80, 24);
    snapBtn.style.fontSize = fs;
    snapBtn.callbacks.onClick = () => {
      this.telemetry.saveSnapshot(`Snap ${this.telemetry.getSnapshots().length + 1}`);
      this.updateSnapshotsTab();
    };
    btnRow.addChild(snapBtn);
    this.snapshotButtons.push(snapBtn);

    const clearBtn = new UIButton("Clear", 60, 24);
    clearBtn.style.fontSize = fs;
    clearBtn.callbacks.onClick = () => {
      this.telemetry.clearSnapshots();
      this.selectedSnapshotA = -1;
      this.selectedSnapshotB = -1;
      this.snapshotDiffs = [];
      this.updateSnapshotsTab();
    };
    btnRow.addChild(clearBtn);
    this.snapshotButtons.push(clearBtn);

    const diffBtn = new UIButton("Diff A→B", 70, 24);
    diffBtn.style.fontSize = fs;
    diffBtn.callbacks.onClick = () => {
      const snaps = this.telemetry.getSnapshots();
      if (this.selectedSnapshotA >= 0 && this.selectedSnapshotB >= 0 &&
          this.selectedSnapshotA < snaps.length && this.selectedSnapshotB < snaps.length) {
        this.snapshotDiffs = TelemetryCollector.diffSnapshots(
          snaps[this.selectedSnapshotA], snaps[this.selectedSnapshotB],
        );
        this.updateSnapshotsTab();
      }
    };
    btnRow.addChild(diffBtn);
    this.snapshotButtons.push(diffBtn);

    const maxRows = 35;
    for (let i = 0; i < maxRows; i++) {
      const t = new UIText("", this.config.panelWidth - 20, lineH);
      t.style.fontSize = fs;
      t.style.fontFamily = "monospace";
      t.style.textColor = COLORS.white;
      t.x = 8;
      t.y = 36 + i * lineH;
      p.addChild(t);
      this.snapshotTexts.push(t);
    }
    p.height = 36 + maxRows * lineH + 8;
  }

  private switchTab(tabId: TabId): void {
    this.activeTab = tabId;
    const tabOrder: TabId[] = ["overview", "passes", "memory", "render", "graph", "snapshots"];
    const idx = tabOrder.indexOf(tabId);
    for (let i = 0; i < this.tabContent.length; i++) {
      this.tabContent[i].visible = i === idx;
    }
    this.scrollPanel.scrollY = 0;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  getPanel(): UIPanel {
    return this.mainPanel;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    this.root.width = width;
    this.root.height = height;
    this.layout();
  }

  setCanvas(canvas: HTMLCanvasElement): void {
    this.scrollPanel.setCanvas(canvas);
  }

  private layout(): void {
    const pw = this.config.panelWidth;
    const ph = this.config.panelHeight;
    let x = 8;
    let y = 8;
    if (this.config.position === "top-right") {
      x = this.screenWidth - pw - 8;
    } else if (this.config.position === "bottom-left") {
      y = this.screenHeight - ph - 8;
    } else if (this.config.position === "bottom-right") {
      x = this.screenWidth - pw - 8;
      y = this.screenHeight - ph - 8;
    }
    this.mainPanel.x = x;
    this.mainPanel.y = y;
  }

  update(dt: number): void {
    if (!this.visible) return;

    this.graphHistory.push(dt * 1000);
    if (this.graphHistory.length > this.maxGraphPoints) {
      this.graphHistory.shift();
    }

    const now = performance.now();
    if (now - this.lastUpdate < this.config.updateIntervalMs) return;
    this.lastUpdate = now;

    switch (this.activeTab) {
      case "overview": this.updateOverview(); break;
      case "passes": this.updatePasses(); break;
      case "memory": this.updateMemory(); break;
      case "render": this.updateRender(); break;
      case "graph": this.updateGraph(); break;
      case "snapshots": this.updateSnapshotsTab(); break;
    }
  }

  private updateOverview(): void {
    const fps = this.telemetry.getFPS();
    const avgFrame = this.telemetry.getAverageFrameTime();
    const p95 = this.telemetry.getFrameTimePercentile(0.95);
    const p99 = this.telemetry.getFrameTimePercentile(0.99);
    const drawStats = this.telemetry.getDrawStats();
    const gpuTime = this.telemetry.getGpuTime();
    const mem = this.telemetry.getMemoryUsage();
    const res = this.telemetry.getResourceStats();
    const passes = this.telemetry.getPassTimings();
    const snaps = this.telemetry.getSnapshots();

    let idx = 0;
    const set = (text: string, color?: UIColor) => {
      if (idx < this.overviewTexts.length) {
        this.overviewTexts[idx].setText(text);
        if (color) this.overviewTexts[idx].style.textColor = color;
        idx++;
      }
    };

    set(`FPS: ${fps}`, fps >= 55 ? COLORS.green : fps >= 30 ? COLORS.yellow : COLORS.red);
    set(`Frame: ${avgFrame.toFixed(2)}ms`);
    set(`p95: ${p95.toFixed(2)}ms  p99: ${p99.toFixed(2)}ms`, COLORS.yellow);
    set(`Draws: ${drawStats.drawCalls}`, COLORS.cyan);
    set(`Tris: ${(drawStats.triangles / 1000).toFixed(1)}K`, COLORS.cyan);
    set(`GPU: ${gpuTime.toFixed(2)}ms`, COLORS.cyan);
    set(`Heap: ${(mem.heapUsed / 1048576).toFixed(1)}MB / ${(mem.heapTotal / 1048576).toFixed(1)}MB`, COLORS.dim);
    if (res) {
      set(`VRAM: ${(res.totalBytes / 1048576).toFixed(1)}MB (tex:${res.textureCount} buf:${res.bufferCount})`, COLORS.purple);
    } else {
      set(`VRAM: --`, COLORS.dim);
    }
    set(`Passes: ${passes.length}`, COLORS.dim);
    set(`Snapshots: ${snaps.length}`, COLORS.dim);
  }

  private updatePasses(): void {
    const timings = this.telemetry.getPassTimings();
    const totalCpu = timings.reduce((s, p) => s + p.cpuMs, 0);
    const maxMs = Math.max(0.1, ...timings.map((t) => t.cpuMs));
    const maxBarW = this.config.panelWidth - 60;

    for (let i = 0; i < this.passTexts.length && i < 16; i++) {
      if (i < timings.length) {
        const t = timings[i];
        const pct = totalCpu > 0 ? (t.cpuMs / totalCpu * 100).toFixed(0) : "0";
        const color = t.cpuMs > 10 ? COLORS.red : t.cpuMs > 3 ? COLORS.yellow : COLORS.green;
        this.passTexts[i].setText(`${t.name.padEnd(14)} ${t.cpuMs.toFixed(2).padStart(6)}ms ${pct.padStart(3)}%  d:${t.drawCalls} t:${t.triangles}`);
        this.passTexts[i].style.textColor = color;
        this.passTexts[i].visible = true;

        const barIdx = i * 2 + 1;
        if (barIdx < this.passBars.length) {
          const barW = Math.max(1, (t.cpuMs / maxMs) * maxBarW);
          this.passBars[barIdx].width = barW;
          this.passBars[barIdx].style.backgroundColor = PASS_COLORS[i % PASS_COLORS.length];
          this.passBars[barIdx].visible = true;
        }
        if (i * 2 < this.passBars.length) {
          this.passBars[i * 2].visible = true;
        }
      } else {
        this.passTexts[i].visible = false;
        if (i * 2 < this.passBars.length) this.passBars[i * 2].visible = false;
        if (i * 2 + 1 < this.passBars.length) this.passBars[i * 2 + 1].visible = false;
      }
    }
  }

  private updateMemory(): void {
    const res = this.telemetry.getResourceStats();
    if (!res) {
      this.memoryTexts[0].setText("GPUResourceTracker not connected");
      for (let i = 1; i < this.memoryTexts.length; i++) this.memoryTexts[i].visible = false;
      return;
    }

    let idx = 0;
    const set = (text: string, color?: UIColor) => {
      if (idx < this.memoryTexts.length) {
        this.memoryTexts[idx].setText(text);
        if (color) this.memoryTexts[idx].style.textColor = color;
        this.memoryTexts[idx].visible = true;
        idx++;
      }
    };

    set(`VRAM: ${(res.totalBytes / 1048576).toFixed(2)}MB`, COLORS.cyan);
    set(`Textures: ${res.textureCount}  (${(res.textureBytes / 1048576).toFixed(2)}MB)`, COLORS.purple);
    set(`Buffers:  ${res.bufferCount}  (${(res.bufferBytes / 1048576).toFixed(2)}MB)`, COLORS.orange);
    set(`${"Label".padEnd(24)} ${"Type".padEnd(8)} ${"Size".padStart(10)}`, COLORS.dim);

    const sorted = res.resources.sort((a, b) => b.size - a.size);
    for (let i = 0; i < sorted.length && idx < this.memoryTexts.length; i++) {
      const r = sorted[i];
      const sizeStr = r.size >= 1048576
        ? (r.size / 1048576).toFixed(2) + "MB"
        : (r.size / 1024).toFixed(1) + "KB";
      const label = (r.callsite || r.label).slice(0, 24);
      const color = r.size > 10 * 1048576 ? COLORS.red : r.size > 1048576 ? COLORS.yellow : COLORS.white;
      set(`${label.padEnd(24)} ${r.type.padEnd(8)} ${sizeStr.padStart(10)}`, color);
    }
    for (; idx < this.memoryTexts.length; idx++) {
      this.memoryTexts[idx].visible = false;
    }
  }

  private updateRender(): void {
    const timings = this.telemetry.getPassTimings();
    let idx = 0;
    const set = (text: string, color?: UIColor) => {
      if (idx < this.renderTexts.length) {
        this.renderTexts[idx].setText(text);
        if (color) this.renderTexts[idx].style.textColor = color;
        this.renderTexts[idx].visible = true;
        idx++;
      }
    };

    set(`${"Pass".padEnd(14)} ${"Draws".padStart(6)} ${"Tris".padStart(8)} ${"Pipe".padStart(5)} ${"Bind".padStart(5)} ${"Rebind".padStart(6)}`, COLORS.cyan);
    set("");

    const totalDraws = timings.reduce((s, p) => s + p.drawCalls, 0);
    const totalTris = timings.reduce((s, p) => s + p.triangles, 0);
    const totalPipe = timings.reduce((s, p) => s + p.pipelineSwitches, 0);
    const totalBind = timings.reduce((s, p) => s + p.bindGroupChanges, 0);
    const totalRebind = timings.reduce((s, p) => s + p.bufferRebinds, 0);

    for (let _i = 0, _it = timings, _n = _it.length; _i < _n; _i++) { const t = _it[_i];
      if (idx >= this.renderTexts.length) break;
      const color = t.pipelineSwitches > 5 ? COLORS.red : t.bindGroupChanges > 10 ? COLORS.yellow : COLORS.white;
      set(
        `${t.name.padEnd(14)} ${String(t.drawCalls).padStart(6)} ${(t.triangles / 1000).toFixed(1).padStart(7)}K ${String(t.pipelineSwitches).padStart(5)} ${String(t.bindGroupChanges).padStart(5)} ${String(t.bufferRebinds).padStart(6)}`,
        color,
      );
    }

    set("");
    set(`TOTAL          ${String(totalDraws).padStart(6)} ${(totalTris / 1000).toFixed(1).padStart(7)}K ${String(totalPipe).padStart(5)} ${String(totalBind).padStart(5)} ${String(totalRebind).padStart(6)}`, COLORS.green);

    for (; idx < this.renderTexts.length; idx++) {
      this.renderTexts[idx].visible = false;
    }
  }

  private updateGraph(): void {
    const history = this.graphHistory.length > 0 ? this.graphHistory : this.telemetry.getGraphHistory();
    if (history.length < 2) {
      this.graphLine.setSegments([]);
      return;
    }

    const graphW = this.config.panelWidth - 20;
    const graphH = 200;
    const maxMs = Math.max(33.33, ...history);
    const yScale = (graphH - 20) / maxMs;
    const xStep = graphW / this.maxGraphPoints;

    const segments: number[] = [];
    for (let i = 1; i < history.length; i++) {
      const x1 = (i - 1) * xStep;
      const y1 = graphH - 10 - history[i - 1] * yScale;
      const x2 = i * xStep;
      const y2 = graphH - 10 - history[i] * yScale;
      segments.push(x1, y1, x2, y2);
    }
    this.graphLine.setSegments(segments);

    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const sorted = [...history].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const min = sorted[0] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;

    if (this.graphRefTexts.length >= 3) {
      this.graphRefTexts[0].setText(`16.7ms (60fps)  ${maxMs > 16.7 ? "⚠ above" : "✓ ok"}`);
      this.graphRefTexts[1].setText(`33.3ms (30fps)  ${maxMs > 33.3 ? "⚠ above" : "✓ ok"}`);
      this.graphRefTexts[2].setText(
        `Avg ${avg.toFixed(2)}  p95 ${p95.toFixed(2)}  p99 ${p99.toFixed(2)}  Min ${min.toFixed(2)}  Max ${max.toFixed(2)}`,
      );
    }
  }

  private updateSnapshotsTab(): void {
    const snaps = this.telemetry.getSnapshots();
    let idx = 0;
    const set = (text: string, color?: UIColor) => {
      if (idx < this.snapshotTexts.length) {
        this.snapshotTexts[idx].setText(text);
        if (color) this.snapshotTexts[idx].style.textColor = color;
        this.snapshotTexts[idx].visible = true;
        idx++;
      }
    };

    set(`Snapshots: ${snaps.length}  (A: ${this.selectedSnapshotA >= 0 ? snaps[this.selectedSnapshotA]?.label : "—"}  B: ${this.selectedSnapshotB >= 0 ? snaps[this.selectedSnapshotB]?.label : "—"})`, COLORS.cyan);
    set("");

    for (let i = 0; i < snaps.length && idx < this.snapshotTexts.length - 10; i++) {
      const s = snaps[i];
      const markerA = i === this.selectedSnapshotA ? "[A]" : "   ";
      const markerB = i === this.selectedSnapshotB ? "[B]" : "   ";
      set(
        `${markerA}${markerB} ${s.label.padEnd(12)} ${s.fps}fps  ${s.avgFrame.toFixed(2)}ms  draws:${s.drawCalls}  VRAM:${s.resourceStats ? (s.resourceStats.totalBytes / 1048576).toFixed(1) + "MB" : "—"}`,
        i === this.selectedSnapshotA || i === this.selectedSnapshotB ? COLORS.yellow : COLORS.white,
      );
    }

    if (this.snapshotDiffs.length > 0) {
      set("");
      set("── Diff A → B ──", COLORS.cyan);
      for (let _i = 0, _it = this.snapshotDiffs, _n = _it.length; _i < _n; _i++) { const d = _it[_i];
        if (idx >= this.snapshotTexts.length) break;
        const sign = d.delta > 0 ? "+" : "";
        const color = Math.abs(d.deltaPct) < 5 ? COLORS.white : d.delta > 0 ? COLORS.red : COLORS.green;
        set(
          `${d.metric.padEnd(24)} ${d.a.toFixed(2).padStart(8)} → ${d.b.toFixed(2).padStart(8)}  ${sign}${d.delta.toFixed(2).padStart(8)} (${sign}${d.deltaPct.toFixed(1)}%)`,
          color,
        );
      }
    }

    for (; idx < this.snapshotTexts.length; idx++) {
      this.snapshotTexts[idx].visible = false;
    }
  }

  selectSnapshotA(index: number): void {
    this.selectedSnapshotA = index;
  }

  selectSnapshotB(index: number): void {
    this.selectedSnapshotB = index;
  }

  cycleSnapshotA(): void {
    const snaps = this.telemetry.getSnapshots();
    if (snaps.length === 0) return;
    this.selectedSnapshotA = (this.selectedSnapshotA + 1) % snaps.length;
  }

  cycleSnapshotB(): void {
    const snaps = this.telemetry.getSnapshots();
    if (snaps.length === 0) return;
    this.selectedSnapshotB = (this.selectedSnapshotB + 1) % snaps.length;
  }

  getRoot(): UIRoot {
    return this.root;
  }

  destroy(): void {
    this.scrollPanel.destroy();
    this.mainPanel.removeChildren();
    this.root.removeChild(this.mainPanel);
    this.tabContent = [];
    this.overviewTexts = [];
    this.passTexts = [];
    this.passBars = [];
    this.memoryTexts = [];
    this.renderTexts = [];
    this.snapshotTexts = [];
    this.snapshotButtons = [];
  }
}
