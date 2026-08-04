import { UIPanel, UIRoot, UIText, type UIColor } from "../ui/element";
import type { TelemetryCollector } from "./collector";

export interface DebugOverlayConfig {
  showFPS: boolean;
  showFrameTime: boolean;
  showDrawCalls: boolean;
  showGpuTime: boolean;
  showMemory: boolean;
  showSystemTimings: boolean;
  showPercentiles: boolean;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  fontSize: number;
  backgroundOpacity: number;
  updateIntervalMs: number;
}

export const DEFAULT_DEBUG_OVERLAY_CONFIG: DebugOverlayConfig = {
  showFPS: true,
  showFrameTime: true,
  showDrawCalls: true,
  showGpuTime: true,
  showMemory: true,
  showSystemTimings: false,
  showPercentiles: true,
  position: "top-left",
  fontSize: 11,
  backgroundOpacity: 0.75,
  updateIntervalMs: 100,
};

const COLOR_GREEN: UIColor = [0.3, 0.9, 0.3, 1];
const COLOR_YELLOW: UIColor = [1, 1, 0.3, 1];
const COLOR_RED: UIColor = [1, 0.3, 0.3, 1];
const COLOR_CYAN: UIColor = [0.3, 0.8, 1, 1];
const COLOR_WHITE: UIColor = [1, 1, 1, 1];
const COLOR_DIM: UIColor = [0.6, 0.6, 0.6, 1];

/**
 * In-game debug/profiling overlay rendered via the engine's GPU UI system.
 *
 * Works in packaged builds without React or DevTools. Builds a UIRoot
 * with text elements showing FPS, frame times, draw calls, GPU time,
 * memory usage, and system timings from the TelemetryCollector.
 *
 * Usage:
 *   const overlay = new DebugOverlay(telemetry);
 *   overlay.setScreenSize(1920, 1080);
 *   // each frame:
 *   overlay.update(dt);
 *   const root = overlay.getRoot(); // pass to UICompositePass.setRoot()
 */
export class DebugOverlay {
  private telemetry: TelemetryCollector;
  private config: DebugOverlayConfig;
  private root: UIRoot;
  private panel: UIPanel;
  private texts: UIText[] = [];
  private lastUpdate: number = 0;
  private screenWidth: number = 1920;
  private screenHeight: number = 1080;
  private visible: boolean = false;
  private frameTimeHistory: number[] = [];
  private maxHistory: number = 120;

  constructor(telemetry: TelemetryCollector, config?: Partial<DebugOverlayConfig>) {
    this.telemetry = telemetry;
    this.config = { ...DEFAULT_DEBUG_OVERLAY_CONFIG, ...config };
    this.root = new UIRoot(this.screenWidth, this.screenHeight);
    this.panel = new UIPanel(220, 0);
    this.panel.style.backgroundColor = [0, 0, 0, this.config.backgroundOpacity];
    this.panel.style.borderColor = [0.3, 0.3, 0.35, 0.8];
    this.panel.style.borderWidth = 1;
    this.panel.style.borderRadius = 4;
    this.panel.style.padding = [6, 8, 6, 8];
    this.panel.layoutMode = "absolute";
    this.root.addChild(this.panel);
    this.root.visible = false;
    this.buildTexts();
    this.layout();
  }

  private buildTexts(): void {
    this.panel.removeChildren();
    this.texts = [];

    const scale = this.config.fontSize / 11;
    const addText = (text: string, color: UIColor = COLOR_WHITE): UIText => {
      const el = new UIText(text, Math.round(200 * scale), this.config.fontSize + 2);
      el.style.fontSize = this.config.fontSize;
      el.style.fontFamily = "monospace";
      el.style.textColor = color;
      this.panel.addChild(el);
      this.texts.push(el);
      return el;
    };

    if (this.config.showFPS) addText("FPS: --", COLOR_GREEN);
    if (this.config.showFrameTime) addText("Frame: --ms", COLOR_WHITE);
    if (this.config.showPercentiles) addText("p95: --ms  p99: --ms", COLOR_YELLOW);
    if (this.config.showDrawCalls) addText("Draws: --", COLOR_CYAN);
    if (this.config.showGpuTime) addText("GPU: --ms", COLOR_CYAN);
    if (this.config.showMemory) addText("Heap: --MB / --MB", COLOR_DIM);
    if (this.config.showSystemTimings) addText("Systems: --", COLOR_DIM);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  getPanel(): UIPanel {
    return this.panel;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setConfig(config: Partial<DebugOverlayConfig>): void {
    this.config = { ...this.config, ...config };
    this.buildTexts();
    this.layout();
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    this.root.width = width;
    this.root.height = height;
    this.layout();
  }

  private layout(): void {
    const scale = this.config.fontSize / 11;
    const panelWidth = Math.round(220 * scale);
    const lineH = Math.round(this.config.fontSize * 1.5);
    const panelHeight = this.texts.length * lineH + 12;

    let x = 8;
    let y = 8;
    if (this.config.position === "top-right") {
      x = this.screenWidth - panelWidth - 8;
    } else if (this.config.position === "bottom-left") {
      y = this.screenHeight - panelHeight - 8;
    } else if (this.config.position === "bottom-right") {
      x = this.screenWidth - panelWidth - 8;
      y = this.screenHeight - panelHeight - 8;
    }

    this.panel.x = x;
    this.panel.y = y;
    this.panel.width = panelWidth;
    this.panel.height = panelHeight;

    // Position text elements at absolute screen coordinates within the panel
    const [pt, , , pl] = this.panel.style.padding;
    for (let i = 0; i < this.texts.length; i++) {
      this.texts[i].x = x + pl;
      this.texts[i].y = y + pt + i * lineH;
    }
  }

  update(dt: number): void {
    if (!this.visible) return;

    this.frameTimeHistory.push(dt * 1000);
    if (this.frameTimeHistory.length > this.maxHistory) {
      this.frameTimeHistory.shift();
    }

    const now = performance.now();
    if (now - this.lastUpdate < this.config.updateIntervalMs) return;
    this.lastUpdate = now;

    let idx = 0;
    const fps = this.telemetry.getFPS();
    const avgFrame = this.telemetry.getAverageFrameTime();
    const p95 = this.telemetry.getFrameTimePercentile(0.95);
    const p99 = this.telemetry.getFrameTimePercentile(0.99);
    const drawStats = this.telemetry.getDrawStats();
    const gpuTime = this.telemetry.getGpuTime();
    const mem = this.telemetry.getMemoryUsage();

    if (this.config.showFPS && idx < this.texts.length) {
      const color = fps >= 55 ? COLOR_GREEN : fps >= 30 ? COLOR_YELLOW : COLOR_RED;
      this.texts[idx].setText(`FPS: ${fps}`);
      this.texts[idx].style.textColor = color;
      idx++;
    }
    if (this.config.showFrameTime && idx < this.texts.length) {
      this.texts[idx].setText(`Frame: ${avgFrame.toFixed(2)}ms`);
      idx++;
    }
    if (this.config.showPercentiles && idx < this.texts.length) {
      this.texts[idx].setText(`p95: ${p95.toFixed(2)}ms  p99: ${p99.toFixed(2)}ms`);
      idx++;
    }
    if (this.config.showDrawCalls && idx < this.texts.length) {
      this.texts[idx].setText(`Draws: ${drawStats.drawCalls}`);
      idx++;
    }
    if (this.config.showGpuTime && idx < this.texts.length) {
      this.texts[idx].setText(`GPU: ${gpuTime.toFixed(2)}ms`);
      idx++;
    }
    if (this.config.showMemory && idx < this.texts.length) {
      const heapMB = (mem.heapUsed / 1048576).toFixed(1);
      const totalMB = (mem.heapTotal / 1048576).toFixed(1);
      this.texts[idx].setText(`Heap: ${heapMB}MB / ${totalMB}MB`);
      idx++;
    }
    if (this.config.showSystemTimings && idx < this.texts.length) {
      const timings = this.telemetry.getSystemTimings();
      const recent = timings.slice(-5);
      const summary = recent.length > 0
        ? recent.map((t) => `${t.name}:${t.durationMs.toFixed(1)}`).join(" ")
        : "—";
      this.texts[idx].setText(`Systems: ${summary}`);
      idx++;
    }
  }

  getRoot(): UIRoot {
    return this.root;
  }

  destroy(): void {
    this.panel.removeChildren();
    this.root.removeChild(this.panel);
    this.texts = [];
  }
}
