// ============================================================================
// debugger-scene.ts — the pixi scene for the native debugger overlay.
//
// Renders a tab bar (6 panels) + the active panel's content. Each frame it
// clears + rebuilds the view (following the ProfilerScene pattern). Click
// handling uses a HitCollector: panels register hit regions during build,
// and getInteractiveRegions() exposes them for the host's SDL hit-testing.
//
// The scene owns a CdpBridge (console + profiling) and references to the
// renderer + game pixi host (for scene/GPU/DOM-tree data).
// ============================================================================

import type { Application } from "pixi.js";
import { Container, Graphics, Text } from "pixi.js";

import { CdpBridge, type CdpProfile } from "./cdp-bridge";
import { renderConsolePanel } from "./panels/console-panel";
import { renderDomTreePanel } from "./panels/dom-tree-panel";
import { renderGpuPanel } from "./panels/gpu-panel";
import { renderPerfMetricsPanel } from "./panels/perf-metrics";
import { renderPerfRecorderPanel } from "./panels/perf-recorder";
import { renderScenePanel } from "./panels/scene-panel";
import {
    BG_DARK, COLOR_GREEN, COLOR_TEXT_DIM,
    FONT,
    fs,
    setFontScale,
} from "./shared/colors";
import { HitCollector, makeLabel, makeTabBar, type TabDef } from "./shared/widgets";

// ── Panel IDs ──

export const PANEL_IDS = ["console", "scene", "gpu", "perf-recorder", "perf-metrics", "dom-tree"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_TABS: TabDef[] = [
  { id: "console", label: "Console" },
  { id: "scene", label: "Scene" },
  { id: "gpu", label: "GPU" },
  { id: "perf-recorder", label: "Perf Rec" },
  { id: "perf-metrics", label: "Perf Metrics" },
  { id: "dom-tree", label: "DOM Tree" },
];

// ── Scene context (passed to panels each frame) ──

export interface DebuggerSceneContext {
  app: Application;
  width: number;
  height: number;
  /** The game renderer (WebGPURenderer) — for GPU/scene data. */
  renderer: any;
  /** The game's NativePixiUiHost — for the PIXI scene graph tree. */
  gamePixiUi: any;
  /** The CdpBridge (console + profiling). */
  cdp: CdpBridge;
  /** Optional ProfilingSAB for per-worker metrics. */
  profilingSAB: SharedArrayBuffer | null;
}

// ── DebuggerScene ──

export class DebuggerScene {
  root: Container;
  private ctx: DebuggerSceneContext;
  private activePanel: PanelId = "console";
  private tabBarContainer: Container;
  private contentContainer: Container;
  private statusContainer: Container;
  private hits: HitCollector = new HitCollector();
  private scrollY: Record<string, number> = {};
  // Panel-specific state (persisted across frames):
  private consoleFilter: string = "all"; // "all" | "error" | "warn" | "info"
  private sceneExpanded: Set<string> = new Set();
  private sceneSelected: string | null = null;
  private gpuExpanded: Set<string> = new Set();
  private domExpanded: Set<string> = new Set();
  private domSelected: string | null = null;
  private domTreeMode: "pixi" | "ecs" = "pixi";
  private perfRecording: boolean = false;
  private lastProfile: CdpProfile | null = null;
  private perfMetricsHistory: { mem: number[][]; cpu: number[][] } = { mem: [], cpu: [] };

  constructor(ctx: DebuggerSceneContext) {
    this.ctx = ctx;
    setFontScale(1);
    this.root = new Container();
    this.tabBarContainer = new Container();
    this.contentContainer = new Container();
    this.statusContainer = new Container();
    this.root.addChild(this.tabBarContainer);
    this.root.addChild(this.contentContainer);
    this.root.addChild(this.statusContainer);
  }

  /** The active panel id. */
  getActivePanel(): PanelId { return this.activePanel; }

  /** Per-panel scroll offset (for scroll panels). */
  getScrollY(panel: string): number { return this.scrollY[panel] ?? 0; }
  setScrollY(panel: string, y: number): void { this.scrollY[panel] = y; }

  // ── Panel state accessors (used by panels) ──
  getConsoleFilter(): string { return this.consoleFilter; }
  setConsoleFilter(f: string): void { this.consoleFilter = f; }
  getSceneExpanded(): Set<string> { return this.sceneExpanded; }
  getSceneSelected(): string | null { return this.sceneSelected; }
  setSceneSelected(id: string | null): void { this.sceneSelected = id; }
  getGpuExpanded(): Set<string> { return this.gpuExpanded; }
  getDomExpanded(): Set<string> { return this.domExpanded; }
  getDomSelected(): string | null { return this.domSelected; }
  setDomSelected(id: string | null): void { this.domSelected = id; }
  getDomTreeMode(): "pixi" | "ecs" { return this.domTreeMode; }
  setDomTreeMode(m: "pixi" | "ecs"): void { this.domTreeMode = m; }
  isPerfRecording(): boolean { return this.perfRecording; }
  setPerfRecording(r: boolean): void { this.perfRecording = r; }
  getLastProfile(): CdpProfile | null { return this.lastProfile; }
  setLastProfile(p: CdpProfile | null): void { this.lastProfile = p; }
  getPerfMetricsHistory(): { mem: number[][]; cpu: number[][] } { return this.perfMetricsHistory; }

  /** The scene context (passed to panels). */
  getContext(): DebuggerSceneContext { return this.ctx; }
  /** The hit collector (panels register clicks here during build). */
  getHits(): HitCollector { return this.hits; }

  /** Update — called each frame by the host. Rebuilds the view. */
  update(): void {
    // Clear previous frame's children + hits
    this.tabBarContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.contentContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.statusContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.hits.regions = [];

    const w = this.ctx.width;
    const h = this.ctx.height;

    // Tab bar at top
    const tabBar = makeTabBar(PANEL_TABS, this.activePanel, w, this.hits, (id) => {
      this.activePanel = id as PanelId;
    });
    this.tabBarContainer.addChild(tabBar.container);

    // Content area below tab bar
    const contentY = 32;
    const contentH = h - contentY - 20;

    // Render the active panel
    let content: Container;
    switch (this.activePanel) {
      case "console":
        content = renderConsolePanel(this, 0, contentY, w, contentH);
        break;
      case "scene":
        content = renderScenePanel(this, 0, contentY, w, contentH);
        break;
      case "gpu":
        content = renderGpuPanel(this, 0, contentY, w, contentH);
        break;
      case "perf-recorder":
        content = renderPerfRecorderPanel(this, 0, contentY, w, contentH);
        break;
      case "perf-metrics":
        content = renderPerfMetricsPanel(this, 0, contentY, w, contentH);
        break;
      case "dom-tree":
        content = renderDomTreePanel(this, 0, contentY, w, contentH);
        break;
      default:
        content = new Container();
    }
    this.contentContainer.addChild(content);

    // Status bar at bottom
    this.drawStatusBar(w, h);
  }

  /** Interactive regions for the host's SDL hit-testing. */
  getInteractiveRegions(): { x: number; y: number; width: number; height: number }[] {
    return this.hits.regions.map((r) => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    }));
  }

  /** Dispatch a pointerdown to the matching hit region. Returns true if consumed. */
  handlePointerDown(x: number, y: number): boolean {
    for (const r of this.hits.regions) {
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        try { r.onClick(); } catch (err) { console.error("[DebuggerScene] click handler error:", err); }
        return true;
      }
    }
    return false;
  }

  resize(width: number, height: number): void {
    this.ctx.width = width;
    this.ctx.height = height;
  }

  dispose(): void {
    this.root.destroy({ children: true });
  }

  // ── Private ──

  private drawStatusBar(w: number, h: number): void {
    const bg = new Graphics();
    bg.rect(0, h - 20, w, 20);
    bg.fill({ color: BG_DARK, alpha: 0.95 });
    this.statusContainer.addChild(bg);
    const status = `Panel: ${this.activePanel} | CDP: ${this.ctx.cdp.isAvailable ? "on" : "off"} | Click regions: ${this.hits.regions.length}`;
    this.statusContainer.addChild(makeLabel(status, 8, h - 16, COLOR_TEXT_DIM, 11));
    // FPS-ish indicator on the right
    const rightLabel = new Text({
      text: "F12 toggle | F11 screenshot",
      style: { fontSize: fs(11), fill: COLOR_GREEN, fontFamily: FONT },
    });
    rightLabel.anchor.set(1, 0);
    rightLabel.x = w - 8;
    rightLabel.y = h - 16;
    this.statusContainer.addChild(rightLabel);
  }
}
