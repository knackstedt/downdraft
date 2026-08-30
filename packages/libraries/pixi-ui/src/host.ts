// ============================================================================
// PixiUiHost — main-thread host for the PixiJS-in-worker UI overlay.
//
// Spawns the UI worker, acquires/creates the overlay canvas, transfers it
// to the worker via transferControlToOffscreen(), allocates the UiStatsSAB,
// and bridges data + pointer events between the game and the worker.
//
// Created by the PixiUiLib descriptor (renderer.create) or directly by games
// using the escape hatch.
// ============================================================================

import {
    DEFAULT_STATS_LAYOUT,
    serializeConfig,
    type MainToWorkerMessage,
    type PixiUiAction,
    type PixiUiEvent,
    type PointerMessage,
    type SceneStateMessage,
    type WorkerToMainMessage
} from "./bridge-protocol";
import type { PixiUiLibConfig } from "./library";
import { allocateUiStatsSab, writeUiStats } from "./ui-stats-sab";

export interface PixiUiHostOptions {
  /** Canvas layer index for the overlay. Default: 1 (above the game canvas at 0). */
  canvasLayer?: number;
  /** DOM id for the overlay canvas. Default: "pixi-ui-canvas". */
  canvasId?: string;
  /** CSS width/height in pixels. Default: window.innerWidth/innerHeight. */
  width?: number;
  height?: number;
}

interface PendingQuery {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PixiUiHost {
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private uiStatsSab: SharedArrayBuffer | null = null;
  private config: PixiUiLibConfig;
  private canvasLayer: number;
  private canvasId: string;
  private width: number;
  private height: number;
  private interactive = false;
  private disposed = false;
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private pendingQueries = new Map<number, PendingQuery>();
  private queryCounter = 0;
  private resizeObserver: ResizeObserver | null = null;
  private canvasCreated = false;

  /** Called when the worker requests a game action (pause, resume, save, ...). */
  onAction: ((action: PixiUiAction) => void) | null = null;

  /** Called when the worker signals interactive mode changed. */
  onInteractiveChange: ((interactive: boolean) => void) | null = null;

  /** Called when the worker reports it's ready (PIXI.Application created). */
  onReady: (() => void) | null = null;

  constructor(config: PixiUiLibConfig) {
    // Apply defaults for config fields that may be omitted (escape hatch).
    this.config = {
      backend: "webgl2",
      statsLayout: DEFAULT_STATS_LAYOUT,
      debug: false,
      ...config,
    };
    this.canvasLayer = config.canvasLayer ?? 1;
    this.canvasId = config.canvasId ?? "pixi-ui-canvas";
    this.width = config.width ?? (typeof window !== "undefined" ? window.innerWidth : 1280);
    this.height = config.height ?? (typeof window !== "undefined" ? window.innerHeight : 720);
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /** The overlay canvas element (null until start()). */
  get overlayCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Whether the worker has reported ready. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Promise that resolves when the worker reports ready. */
  get whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Whether the overlay is currently in interactive (pointer-events: auto) mode. */
  get isInteractive(): boolean {
    return this.interactive;
  }

  /** The UiStatsSAB (for direct reads by MCP tools / debug). */
  get statsBuffer(): SharedArrayBuffer | null {
    return this.uiStatsSab;
  }

  /**
   * Start the host: acquire/create the overlay canvas, allocate the SAB,
   * spawn the worker, and send the init message.
   */
  async start(): Promise<void> {
    if (this.worker) return; // already started

    // 1. Acquire or create the overlay canvas.
    this.canvas = this.acquireCanvas();
    this.canvas.style.pointerEvents = "none"; // default: pass-through to game
    this.canvas.style.zIndex = "50"; // above game canvas (z 0), below DOM overlay (z 100)
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    // 2. Allocate the UiStatsSAB.
    this.uiStatsSab = allocateUiStatsSab(this.config.statsLayout!);

    // 3. Transfer canvas control to an OffscreenCanvas.
    let offscreen: OffscreenCanvas;
    try {
      offscreen = this.canvas.transferControlToOffscreen();
    } catch (err) {
      const e = err as Error & { name?: string };
      throw new Error(`PixiUiHost: transferControlToOffscreen failed — ${e.name ?? "Error"}: ${e.message ?? e}. Ensure the canvas hasn't already been used with getContext().`);
    }

    // 4. Spawn the worker. The inline `new URL(...)` pattern is required by
    //    Vite for worker bundling (enforced by workerUrlGuardPlugin).
    this.worker = new Worker(
      new URL("./pixi-ui-worker.ts", import.meta.url),
      { type: "module" },
    );

    this.worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      this.handleWorkerMessage(e.data);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      const msg = `PixiUI worker error: ${e.message ?? "unknown"} (${e.filename}:${e.lineno})`;
      console.error(msg);
      if (!this.ready) this.readyReject(new Error(msg));
    };

    // 5. Send init message. Only the OffscreenCanvas is transferable —
    //    SharedArrayBuffer is shared memory (not transferred, just passed).
    const initMsg: MainToWorkerMessage = {
      kind: "init",
      offscreenCanvas: offscreen,
      uiStatsSab: this.uiStatsSab,
      config: serializeConfig(this.config),
      width: this.width,
      height: this.height,
    };
    this.worker.postMessage(initMsg, [offscreen]);

    // 6. Wire pointer event forwarding (only active when interactive).
    this.wirePointerEvents();

    // 7. Observe canvas size changes → forward resize to worker.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvas);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.handleResize);
    }

    // Wait for the worker's ready message (or timeout).
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("PixiUI worker init timeout (10s)")), 10000),
      ),
    ]);
  }

  /** Write per-frame scalar values to the UiStatsSAB (called from the game loop). */
  writeStats(values: Record<string, number>): void {
    if (!this.uiStatsSab) return;
    writeUiStats(this.uiStatsSab, this.config.statsLayout!, values);
  }

  /** Post a game event to the worker (structured-clone postMessage). */
  postEvent(event: PixiUiEvent): void {
    if (!this.worker || this.disposed) return;
    const msg: MainToWorkerMessage = { kind: "event", event };
    this.worker.postMessage(msg);
  }

  /** Query the worker for a scene-graph summary (used by MCP tools). */
  queryScene(timeoutMs = 5000): Promise<SceneStateMessage["state"]> {
    if (!this.worker) return Promise.reject(new Error("PixiUI worker not started"));
    const requestId = ++this.queryCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(requestId);
        reject(new Error(`queryScene timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingQueries.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: MainToWorkerMessage = { kind: "queryScene", requestId };
      this.worker!.postMessage(msg);
    });
  }

  /** Request the worker to capture the overlay as a PNG ArrayBuffer. */
  captureOverlay(timeoutMs = 5000): Promise<{ png: ArrayBuffer | null; width: number; height: number }> {
    if (!this.worker) return Promise.reject(new Error("PixiUI worker not started"));
    const requestId = ++this.queryCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(requestId);
        reject(new Error(`captureOverlay timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingQueries.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const msg: MainToWorkerMessage = { kind: "captureOverlay", requestId };
      this.worker!.postMessage(msg);
    });
  }

  /** Force-toggle interactive mode (for MCP testing). */
  setInteractive(interactive: boolean): void {
    this.applyInteractive(interactive);
  }

  /**
   * Dispatch a synthetic pointer event to the worker (for MCP testing).
   * Temporarily enables interactive mode if needed. Coordinates are in
   * canvas pixels (top-left origin).
   */
  dispatchPointer(
    type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave",
    x: number,
    y: number,
    button = 0,
  ): void {
    if (!this.worker) return;
    if (!this.interactive) this.applyInteractive(true);
    const msg: MainToWorkerMessage = {
      kind: "pointer",
      type,
      x,
      y,
      button,
      modifiers: 0,
    };
    this.worker.postMessage(msg);
  }

  /** Dispose: terminate worker, remove canvas (if created), free SAB. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) {
      try { this.worker.postMessage({ kind: "dispose" } as MainToWorkerMessage); } catch { /* ignore */ }
      this.worker.terminate();
      this.worker = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.handleResize);
    }
    this.unwirePointerEvents();
    if (this.canvasCreated && this.canvas?.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.canvas = null;
    this.uiStatsSab = null;
    // Reject any pending queries.
    for (const q of this.pendingQueries.values()) {
      clearTimeout(q.timer);
      q.reject(new Error("PixiUI host disposed"));
    }
    this.pendingQueries.clear();
  }

  // ── Internal ──

  private acquireCanvas(): HTMLCanvasElement {
    // Try to find an existing canvas for the configured layer.
    const existing = document.querySelector(
      `canvas[data-dd-layer="${this.canvasLayer}"]`,
    ) as HTMLCanvasElement | null;
    if (existing) return existing;

    // Create one and insert it above the game canvas (layer 0).
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-dd-layer", String(this.canvasLayer));
    canvas.id = this.canvasId;
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.display = "block";
    canvas.style.pointerEvents = "none";
    // Insert after the game canvas (so it stacks above in DOM order).
    const gameCanvas = document.querySelector('canvas[data-dd-layer="0"]');
    if (gameCanvas?.parentNode) {
      gameCanvas.parentNode.insertBefore(canvas, gameCanvas.nextSibling);
    } else {
      document.body.appendChild(canvas);
    }
    this.canvasCreated = true;
    return canvas;
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.kind) {
      case "ready":
        this.ready = true;
        this.onReady?.();
        this.readyResolve();
        break;
      case "setInteractive":
        this.applyInteractive(msg.interactive);
        break;
      case "action":
        this.onAction?.(msg.action);
        break;
      case "sceneState":
      case "captureResult": {
        const pending = this.pendingQueries.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingQueries.delete(msg.requestId);
          pending.resolve(msg);
        }
        break;
      }
      case "error":
        console.error(`[PixiUI worker] ${msg.message}`, msg.stack ?? "");
        if (!this.ready) this.readyReject(new Error(msg.message));
        break;
    }
  }

  private applyInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    this.interactive = interactive;
    if (this.canvas) {
      this.canvas.style.pointerEvents = interactive ? "auto" : "none";
    }
    this.onInteractiveChange?.(interactive);
  }

  private handleResize = (): void => {
    if (!this.worker || !this.canvas) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const msg: MainToWorkerMessage = { kind: "resize", width: w, height: h };
    this.worker.postMessage(msg);
  };

  // ── Pointer event forwarding (active only when interactive) ──

  private onPointerDown = (e: PointerEvent): void => this.forwardPointer("pointerdown", e);
  private onPointerMove = (e: PointerEvent): void => this.forwardPointer("pointermove", e);
  private onPointerUp = (e: PointerEvent): void => this.forwardPointer("pointerup", e);
  private onPointerLeave = (e: PointerEvent): void => this.forwardPointer("pointerleave", e);

  private wirePointerEvents(): void {
    // Always attached to the canvas; forwardPointer() checks interactive.
    // We attach to canvas (not window) so events only fire when the canvas
    // has pointer-events: auto (i.e. interactive mode).
    const c = this.canvas;
    if (!c) return;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
  }

  private unwirePointerEvents(): void {
    const c = this.canvas;
    if (!c) return;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
  }

  private forwardPointer(type: PointerMessage["type"], e: PointerEvent): void {
    if (!this.interactive || !this.worker) return;
    const rect = this.canvas!.getBoundingClientRect();
    const msg: MainToWorkerMessage = {
      kind: "pointer",
      type,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      button: e.button,
      modifiers: (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0),
    };
    this.worker.postMessage(msg);
  }
}
