// ============================================================================
// debugger-scene.ts — the pixi scene for the native debugger overlay.
//
// Docked on the RIGHT side of the screen (Chrome DevTools style). The dock
// width is adjustable by dragging the left edge. Content (tab bar, active
// panel, status bar) is rendered within the dock area. The area to the left
// of the dock is a semi-transparent backdrop so the game shows through but
// the dock stands out.
//
// Click handling uses a HitCollector: panels register hit regions during
// build, and getInteractiveRegions() exposes them for the host's SDL
// hit-testing. The scene owns a CdpBridge (console + profiling) and
// references to the renderer + game pixi host (for scene/GPU/DOM-tree data).
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
    BG_DARK,
    COLOR_BORDER, COLOR_GREEN, COLOR_TEXT_DIM,
    FONT,
    fs,
    setFontScale
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

// ── Dock constants ──

const DOCK_DEFAULT_WIDTH = 520;
const DOCK_MIN_WIDTH = 320;
const DOCK_HANDLE_WIDTH = 6;
const TAB_BAR_HEIGHT = 32;
const STATUS_BAR_HEIGHT = 22;
const BACKDROP_ALPHA = 0.15;

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

// ── Thread info (for console REPL + log filtering) ──

export interface ThreadInfo {
  /** Unique id (e.g. "main", "slot-0", "slot-1"). */
  id: string;
  /** Display name (e.g. "main", "sim", "pixi-ui"). */
  name: string;
  /** Thread kind. */
  kind: "main" | "worker";
  /** Runtime kind (from ProfilingSAB, if available). */
  runtime?: string;
  /** Evaluate an expression in this thread. */
  eval?: (expr: string) => Promise<{ result?: any; error?: string }>;
}

// ── DebuggerScene ──

export class DebuggerScene {
  root: Container;
  private ctx: DebuggerSceneContext;
  private activePanel: PanelId = "console";
  private backdropContainer: Container;
  private dockContainer: Container;
  private tabBarContainer: Container;
  private contentContainer: Container;
  private statusContainer: Container;
  private handleContainer: Container;
  private hits: HitCollector = new HitCollector();
  private scrollY: Record<string, number> = {};

  // ── Dock state ──
  private dockWidth: number = DOCK_DEFAULT_WIDTH;
  private isDragging: boolean = false;

  // ── Keyboard focus + text input state ──
  private focusedWidget: string | null = null;
  private textInputActive: boolean = false;
  private textInputHandlers: { onText: (text: string) => void; onKey: (key: string, keyCode: number) => void; } | null = null;

  // ── Panel-specific state (persisted across frames) ──
  private consoleFilter: string = "all"; // "all" | "error" | "warn" | "info"
  private consoleThreadFilter: string = "all"; // "all" | thread id
  private consoleSelectedThread: string = "main";
  private consoleReplInput: string = "";
  private consoleReplHistory: string[] = [];
  private consoleReplHistoryIdx: number = -1;
  private consoleReplResults: { text: string; isError: boolean; timestamp: number }[] = [];
  private workerEvalFns: Map<string, (expr: string) => Promise<{ result?: any; error?: string }>> = new Map();
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
    setFontScale(1.5);
    this.root = new Container();
    this.backdropContainer = new Container();
    this.dockContainer = new Container();
    this.tabBarContainer = new Container();
    this.contentContainer = new Container();
    this.statusContainer = new Container();
    this.handleContainer = new Container();
    this.root.addChild(this.backdropContainer);
    this.root.addChild(this.dockContainer);
    this.dockContainer.addChild(this.handleContainer);
    this.dockContainer.addChild(this.tabBarContainer);
    this.dockContainer.addChild(this.contentContainer);
    this.dockContainer.addChild(this.statusContainer);
  }

  /** The active panel id. */
  getActivePanel(): PanelId { return this.activePanel; }

  /** Per-panel scroll offset (for scroll panels). */
  getScrollY(panel: string): number { return this.scrollY[panel] ?? 0; }
  setScrollY(panel: string, y: number): void { this.scrollY[panel] = y; }

  // ── Dock state accessors ──
  getDockWidth(): number { return this.dockWidth; }
  setDockWidth(w: number): void { this.dockWidth = w; }
  isDockDragging(): boolean { return this.isDragging; }

  /** The dock's x position (left edge). */
  getDockX(): number { return Math.max(0, this.ctx.width - this.dockWidth); }

  // ── Panel state accessors (used by panels) ──
  getConsoleFilter(): string { return this.consoleFilter; }
  setConsoleFilter(f: string): void { this.consoleFilter = f; }
  getConsoleThreadFilter(): string { return this.consoleThreadFilter; }
  setConsoleThreadFilter(t: string): void { this.consoleThreadFilter = t; }
  getConsoleSelectedThread(): string { return this.consoleSelectedThread; }
  setConsoleSelectedThread(t: string): void { this.consoleSelectedThread = t; }
  getConsoleReplInput(): string { return this.consoleReplInput; }
  setConsoleReplInput(s: string): void { this.consoleReplInput = s; }
  getConsoleReplHistory(): string[] { return this.consoleReplHistory; }
  getConsoleReplHistoryIdx(): number { return this.consoleReplHistoryIdx; }
  setConsoleReplHistoryIdx(i: number): void { this.consoleReplHistoryIdx = i; }
  getConsoleReplResults(): { text: string; isError: boolean; timestamp: number }[] { return this.consoleReplResults; }
  addConsoleReplResult(text: string, isError: boolean): void {
    this.consoleReplResults.push({ text, isError, timestamp: performance.now() });
    if (this.consoleReplResults.length > 100) this.consoleReplResults.shift();
  }
  clearConsoleReplResults(): void { this.consoleReplResults = []; }

  /** Register an eval function for a worker thread (by name). */
  registerThreadEval(threadName: string, evalFn: (expr: string) => Promise<{ result?: any; error?: string }>): void {
    this.workerEvalFns.set(threadName, evalFn);
  }

  /** Discover all available threads (main + workers from ProfilingSAB + registered). */
  getThreads(): ThreadInfo[] {
    const threads: ThreadInfo[] = [];
    // Main thread (always available, uses CDP)
    threads.push({
      id: "main",
      name: "main",
      kind: "main",
      runtime: "js",
      eval: (expr: string) => this.ctx.cdp.evaluate(expr),
    });
    // Worker threads from ProfilingSAB
    if (this.ctx.profilingSAB) {
      try {
        const sab = this.ctx.profilingSAB;
        const u32 = new Uint32Array(sab);
        const u16 = new Uint16Array(sab);
        // Read maxSlots from header (or use a fixed default)
        // The layout's maxSlots is at a known offset — but we don't have the layout
        // object here. Use a simple scan: check the first 32 slots for alive flags.
        const maxSlots = 32;
        for (let i = 0; i < maxSlots; i++) {
          // Slot header: ALIVE at offset 0 (relative to slot start)
          // The slot table starts after the header (HEADER_SIZE = 64 bytes = 16 u32s)
          // Each slot header is SLOT_HEADER_SIZE bytes
          // We need the layout to compute offsets precisely. For now, use a
          // simplified approach: the slot table offset is 64 bytes, each slot
          // header is 64 bytes (16 u32s). ALIVE is the first u32 in each slot.
          const slotBase = 16 + i * 16; // 64/4=16 u32s per slot header
          const alive = Atomics.load(u32, slotBase);
          if (alive !== 1) continue;
          // Read name from the slot's string table
          // Name length is at slot header offset SH.NAME_LEN (index 14 in u32)
          const nameLen = u32[slotBase + 14];
          if (nameLen === 0) continue;
          // The string data is in the slot's region, not the header.
          // Without the exact layout, we can't read the name precisely.
          // Fall back to a generic name.
          const name = `worker-${i}`;
          const threadId = `slot-${i}`;
          if (threads.find((t) => t.id === threadId)) continue;
          threads.push({
            id: threadId,
            name,
            kind: "worker",
            runtime: "js",
            eval: this.workerEvalFns.get(name),
          });
        }
      } catch {
        // SAB read failed — skip
      }
    }
    // Registered worker eval fns (that aren't already in the list)
    for (const [name, evalFn] of this.workerEvalFns) {
      if (threads.find((t) => t.name === name)) continue;
      threads.push({
        id: `worker:${name}`,
        name,
        kind: "worker",
        runtime: "js",
        eval: evalFn,
      });
    }
    return threads;
  }

  /** Get the eval function for the selected thread. */
  getSelectedThreadEval(): ((expr: string) => Promise<{ result?: any; error?: string }>) | null {
    const threads = this.getThreads();
    const selected = threads.find((t) => t.id === this.consoleSelectedThread);
    return selected?.eval ?? null;
  }

  /** Execute a REPL expression in the selected thread. */
  async executeRepl(expr: string): Promise<void> {
    if (!expr.trim()) return;
    // Add to history
    this.consoleReplHistory.push(expr);
    if (this.consoleReplHistory.length > 100) this.consoleReplHistory.shift();
    this.consoleReplHistoryIdx = -1;
    // Show the input
    this.addConsoleReplResult(`> ${expr}`, false);
    // Evaluate
    const evalFn = this.getSelectedThreadEval();
    if (!evalFn) {
      this.addConsoleReplResult(`< no eval available for thread "${this.consoleSelectedThread}" >`, true);
      return;
    }
    try {
      const result = await evalFn(expr);
      if (result.error) {
        this.addConsoleReplResult(`< ${result.error} >`, true);
      } else {
        const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
        this.addConsoleReplResult(text, false);
      }
    } catch (err) {
      this.addConsoleReplResult(`< ${String(err)} >`, true);
    }
  }

  getSceneExpanded(): Set<string> { return this.sceneExpanded; }
  getSceneSelected(): string | null { return this.sceneSelected; }
  setSceneSelected(id: string | null): void { this.sceneSelected = id; }
  toggleSceneExpanded(id: string): void {
    if (this.sceneExpanded.has(id)) this.sceneExpanded.delete(id);
    else this.sceneExpanded.add(id);
  }
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

  // ── Keyboard focus + text input ──

  /** Get the currently focused widget id (e.g. "console-repl"). */
  getFocusedWidget(): string | null { return this.focusedWidget; }

  /** Set keyboard focus to a widget. Pass null to clear focus. */
  setFocus(widgetId: string | null): void {
    this.focusedWidget = widgetId;
    // The host polls isTextInputActive() to call SDL_StartTextInput/StopTextInput
    if (widgetId && !this.textInputActive) {
      this.textInputActive = true;
    } else if (!widgetId && this.textInputActive) {
      this.textInputActive = false;
    }
  }

  /** Whether text input is currently active (the host calls SDL_StartTextInput/StopTextInput). */
  isTextInputActive(): boolean { return this.textInputActive; }

  /** Register a text input handler for the focused widget. */
  setTextInputHandler(handler: { onText: (text: string) => void; onKey: (key: string, keyCode: number) => void; } | null): void {
    this.textInputHandler = handler;
  }

  /** Handle a text input event (from SDL_TEXTINPUT). Called by the host. */
  handleTextInput(text: string): void {
    if (this.textInputHandler) {
      try { this.textInputHandler.onText(text); } catch (err) { console.error("[DebuggerScene] text input error:", err); }
    }
  }

  /** Handle a keydown event for the focused widget (control keys only). */
  handleKeyDown(key: string, keyCode: number): void {
    if (this.textInputHandler) {
      try { this.textInputHandler.onKey(key, keyCode); } catch (err) { console.error("[DebuggerScene] key down error:", err); }
    }
  }

  /** Update — called each frame by the host. Rebuilds the view. */
  update(): void {
    // Clear previous frame's children + hits
    this.backdropContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.handleContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.tabBarContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.contentContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.statusContainer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.hits.regions = [];

    const surfW = this.ctx.width;
    const surfH = this.ctx.height;

    // Clamp dock width to surface
    const maxDockW = Math.max(DOCK_MIN_WIDTH, surfW - 100);
    if (this.dockWidth > maxDockW) this.dockWidth = maxDockW;
    if (this.dockWidth < DOCK_MIN_WIDTH) this.dockWidth = DOCK_MIN_WIDTH;

    const dockX = this.getDockX();
    const dockW = this.dockWidth;

    // ── Backdrop (dim the game area left of the dock) ──
    if (dockX > 0) {
      const backdrop = new Graphics();
      backdrop.rect(0, 0, dockX, surfH);
      backdrop.fill({ color: 0x000000, alpha: BACKDROP_ALPHA });
      this.backdropContainer.addChild(backdrop);
    }

    // ── Dock container position ──
    this.dockContainer.x = dockX;
    this.dockContainer.y = 0;

    // ── Drag handle (left edge of dock) ──
    this.drawDragHandle(dockW, surfH);

    // ── Tab bar at top of dock ──
    const tabBar = makeTabBar(PANEL_TABS, this.activePanel, dockW, this.hits, (id) => {
      this.activePanel = id as PanelId;
    });
    this.tabBarContainer.addChild(tabBar.container);

    // ── Content area below tab bar ──
    const contentY = TAB_BAR_HEIGHT;
    const contentH = surfH - contentY - STATUS_BAR_HEIGHT;

    // Push the dock offset + content area offset so panel-registered hit
    // regions are in absolute (surface) coordinates. Pop after the panel
    // is built.
    this.hits.pushOffset(dockX, contentY);

    // Render the active panel
    let content: Container;
    switch (this.activePanel) {
      case "console":
        content = renderConsolePanel(this, 0, contentY, dockW, contentH);
        break;
      case "scene":
        content = renderScenePanel(this, 0, contentY, dockW, contentH);
        break;
      case "gpu":
        content = renderGpuPanel(this, 0, contentY, dockW, contentH);
        break;
      case "perf-recorder":
        content = renderPerfRecorderPanel(this, 0, contentY, dockW, contentH);
        break;
      case "perf-metrics":
        content = renderPerfMetricsPanel(this, 0, contentY, dockW, contentH);
        break;
      case "dom-tree":
        content = renderDomTreePanel(this, 0, contentY, dockW, contentH);
        break;
      default:
        content = new Container();
    }
    this.contentContainer.addChild(content);

    // Pop the content area offset.
    this.hits.popOffset();

    // ── Status bar at bottom of dock ──
    this.drawStatusBar(dockW, surfH);
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
    // Check drag handle first (highest priority)
    if (this.isDragging) return true;
    const dockX = this.getDockX();
    if (x >= dockX - DOCK_HANDLE_WIDTH && x < dockX + DOCK_HANDLE_WIDTH && y >= 0 && y < this.ctx.height) {
      this.isDragging = true;
      return true;
    }

    // Only process clicks within the dock area
    if (x < dockX) return false;

    for (const r of this.hits.regions) {
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        try { r.onClick(); } catch (err) { console.error("[DebuggerScene] click handler error:", err); }
        return true;
      }
    }
    return false;
  }

  /** Handle a pointer move event during a drag. Returns true if consumed. */
  handlePointerMove(x: number, _y: number): boolean {
    if (!this.isDragging) return false;
    const maxDockW = Math.max(DOCK_MIN_WIDTH, this.ctx.width - 100);
    this.dockWidth = Math.max(DOCK_MIN_WIDTH, Math.min(maxDockW, this.ctx.width - x));
    return true;
  }

  /** Handle a pointer up event (ends drag). Returns true if consumed. */
  handlePointerUp(_x: number, _y: number): boolean {
    if (this.isDragging) {
      this.isDragging = false;
      return true;
    }
    return false;
  }

  resize(width: number, height: number): void {
    this.ctx.width = width;
    this.ctx.height = height;
    // Clamp dock width to new surface
    const maxDockW = Math.max(DOCK_MIN_WIDTH, width - 100);
    if (this.dockWidth > maxDockW) this.dockWidth = maxDockW;
  }

  dispose(): void {
    this.root.destroy({ children: true });
  }

  // ── Private ──

  private drawDragHandle(dockW: number, surfH: number): void {
    // The drag handle is on the LEFT edge of the dock (at x = -DOCK_HANDLE_WIDTH/2
    // relative to the dock container, which is at dockX). The hit region is
    // registered in absolute coordinates.
    const dockX = this.getDockX();
    const handle = new Graphics();
    // Handle bar
    handle.rect(-DOCK_HANDLE_WIDTH, 0, DOCK_HANDLE_WIDTH, surfH);
    handle.fill({ color: this.isDragging ? COLOR_GREEN : COLOR_BORDER, alpha: 0.6 });
    // Grip lines (3 horizontal lines centered on the handle)
    const gripColor = this.isDragging ? 0xffffff : COLOR_TEXT_DIM;
    for (let i = -1; i <= 1; i++) {
      const cy = surfH / 2 + i * 8;
      handle.moveTo(-DOCK_HANDLE_WIDTH + 1, cy - 3);
      handle.lineTo(-1, cy - 3);
      handle.stroke({ color: gripColor, width: 1, alpha: 0.5 });
      handle.moveTo(-DOCK_HANDLE_WIDTH + 1, cy + 3);
      handle.lineTo(-1, cy + 3);
      handle.stroke({ color: gripColor, width: 1, alpha: 0.5 });
    }
    this.handleContainer.addChild(handle);

    // Register the drag handle hit region (wider than visual for easier grabbing)
    this.hits.add(dockX - DOCK_HANDLE_WIDTH, 0, DOCK_HANDLE_WIDTH * 2, surfH, () => {
      this.isDragging = true;
    });
  }

  private drawStatusBar(dockW: number, surfH: number): void {
    const bg = new Graphics();
    bg.rect(0, surfH - STATUS_BAR_HEIGHT, dockW, STATUS_BAR_HEIGHT);
    bg.fill({ color: BG_DARK, alpha: 0.95 });
    this.statusContainer.addChild(bg);

    const status = `${this.activePanel} | CDP: ${this.ctx.cdp.isAvailable ? "on" : "off"} | ${this.hits.regions.length} regions`;
    this.statusContainer.addChild(makeLabel(status, 8, surfH - STATUS_BAR_HEIGHT + 4, COLOR_TEXT_DIM, 11));

    const rightLabel = new Text({
      text: "F12 toggle | F11 screenshot",
      style: { fontSize: fs(11), fill: COLOR_GREEN, fontFamily: FONT },
    });
    rightLabel.anchor.set(1, 0);
    rightLabel.x = dockW - 8;
    rightLabel.y = surfH - STATUS_BAR_HEIGHT + 4;
    this.statusContainer.addChild(rightLabel);
  }
}
