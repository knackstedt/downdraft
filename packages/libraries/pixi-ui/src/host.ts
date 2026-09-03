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

import { usingRealSAB } from "@downdraft/core/sab/sab-polyfill";
import {
    DEFAULT_STATS_LAYOUT,
    serializeConfig,
    type MainToWorkerMessage,
    type PixiUiAction,
    type PixiUiEvent,
    type PointerMessage,
    type PointerMissedMessage,
    type Rect,
    type SceneStateMessage,
    type WorkerToMainMessage
} from "./bridge-protocol";
import { detectSystemFontScale } from "./font-scale";
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
  /**
   * Render resolution (backing-store pixels per CSS pixel). Default:
   * `window.devicePixelRatio` (or 1 in non-browser contexts). Set to 1 to
   * force 1× rendering (blurry on HiDPI but cheaper). The canvas backing
   * store is sized to `width * resolution`; PixiJS rasterizes at that
   * resolution so text is crisp on Retina/HiDPI displays.
   */
  resolution?: number;
  /**
   * Font scale multiplier for all text in the overlay. Default:
   * `max(1, detectSystemFontScale())`. Use `host.setFontScale()` to update
   * at runtime (notifies the worker which re-renders with the new scale).
   */
  fontScale?: number;
  /**
   * Pass-through mode: the overlay canvas is always pointer-events: auto.
   * Pointer events inside interactive regions (reported by the scene via
   * getInteractiveRegions) are forwarded to the worker for PixiJS hit-testing;
   * events outside all regions are dispatched as synthetic PointerEvents on
   * the game canvas (layer 0) so the game keeps receiving mouse input.
   *
   * Use this for games where interactive UI elements coexist with game-canvas
   * mouse input (e.g. a material toolbar + canvas painting). When false
   * (default), the overlay is pointer-events: none unless the scene calls
   * setInteractive(true) — the original modal-UI model.
   */
  passThrough?: boolean;
  /**
   * Additional SharedArrayBuffers to share into the worker. The worker's
   * scene context will have these available as `ctx.extraSharedBuffers[name]`.
   * Used by the profiler overlay to share the ProfilingSAB with the pixi-ui
   * worker so the profiler scene can read profiling data directly.
   */
  extraSharedBuffers?: Record<string, SharedArrayBuffer>;
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
  /** Render resolution (backing-store px per CSS px). Tracks devicePixelRatio. */
  private resolution: number;
  /** Font scale multiplier (system-detected default, user-increasable). */
  private fontScale: number;
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
  private transferred = false; // true after transferControlToOffscreen()
  private passThrough: boolean;
  private interactiveRegions: Rect[] = [];
  private opaqueRegions: Rect[] = [];
  private gameCanvas: HTMLCanvasElement | null = null;
  private extraSharedBuffers: Record<string, SharedArrayBuffer> | null = null;

  /** Called when the worker requests a game action (pause, resume, save, ...). */
  onAction: ((action: PixiUiAction) => void) | null = null;

  /** Called when the worker signals interactive mode changed. */
  onInteractiveChange: ((interactive: boolean) => void) | null = null;

  /** Called when the worker reports opaque UI panel regions changed. The game
   *  uses these to skip rendering the 3D scene + postfx under opaque panels. */
  onOpaqueChange: ((regions: Rect[]) => void) | null = null;

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
    // Render at the display's physical pixel density so PixiJS text is crisp
    // on HiDPI/Retina displays. The host sizes the canvas backing store to
    // `width * resolution`; the worker passes this to PIXI.Application.init
    // as `resolution` (with autoDensity: false, since the host owns the DOM
    // canvas CSS size via style.width/height = 100vw/100vh).
    this.resolution = config.resolution
      ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    // Default to the system-detected font scale (accessibility). Games can
    // override with a user preference loaded from localStorage.
    this.fontScale = config.fontScale ?? detectSystemFontScale();
    this.passThrough = config.passThrough ?? false;
    this.extraSharedBuffers = config.extraSharedBuffers ?? null;
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
    // Ensure the overlay canvas is always positioned correctly, even if the
    // game doesn't import downdraft-base.css. Without position:fixed, z-index
    // has no effect and the canvas gets pushed below the viewport by the game
    // canvas in normal flow.
    this.canvas.style.position = "fixed";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100vw";
    this.canvas.style.height = "100vh";
    this.canvas.style.display = "block";
    // In pass-through mode the overlay is always interactive (pointer-events:
    // auto); the host dispatches non-hit events to the game canvas. Otherwise
    // default to pass-through (pointer-events: none) until the scene calls
    // setInteractive(true).
    this.canvas.style.pointerEvents = this.passThrough ? "auto" : "none";
    if (this.passThrough) this.interactive = true;
    // Layer 1 (game UI) sits below the DOM overlay (z-index 100).
    // Layer 2+ (debug overlays like the profiler) sit above the DOM overlay
    // so they're not obscured by the game's React UI.
    this.canvas.style.zIndex = this.canvasLayer >= 2
      ? String(100 + this.canvasLayer * 10) // layer 2 → 120, layer 3 → 130, etc.
      : String(40 + this.canvasLayer * 10); // layer 1 → 50
    // Size the backing store to physical pixels (CSS size × resolution) so
    // PixiJS renders at full DPI. The CSS size stays 100vw/100vh (set above),
    // so the browser scales the backing store down to the display — crisp on
    // HiDPI. PixiJS's autoDensity is off (we own the DOM canvas style).
    this.canvas.width = Math.round(this.width * this.resolution);
    this.canvas.height = Math.round(this.height * this.resolution);

    // Ensure the game canvas (layer 0) is below the overlay. If the game
    // doesn't import downdraft-base.css, the game canvas may lack
    // position:fixed + z-index:0, causing stacking issues.
    const gameCanvas = document.querySelector('canvas[data-dd-layer="0"]') as HTMLCanvasElement | null;
    if (gameCanvas) {
      gameCanvas.style.position = "fixed";
      gameCanvas.style.top = "0";
      gameCanvas.style.left = "0";
      gameCanvas.style.width = "100vw";
      gameCanvas.style.height = "100vh";
      gameCanvas.style.zIndex = "0";
    }

    // 2. Allocate the UiStatsSAB.
    this.uiStatsSab = allocateUiStatsSab(this.config.statsLayout!);

    // 3. Transfer canvas control to an OffscreenCanvas.
    let offscreen: OffscreenCanvas;
    try {
      offscreen = this.canvas.transferControlToOffscreen();
      this.transferred = true;
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
      extraSharedBuffers: this.extraSharedBuffers ?? undefined,
      config: serializeConfig(this.config),
      width: this.width,
      height: this.height,
      resolution: this.resolution,
      fontScale: this.fontScale,
    };
    this.worker.postMessage(initMsg, [offscreen]);

    // 6. Wire pointer event forwarding (only active when interactive).
    this.wirePointerEvents();

    // 6b. Wire keyboard event forwarding. Keyboard events are forwarded to
    //     the worker as PixiUiEvents ({ kind: "keydown"/"keyup", key, code, ... })
    //     so scenes can handle menu shortcuts (ESC, I, P, ...). The host does
    //     NOT consume the events — the game's own keydown listeners still fire.
    this.wireKeyEvents();

    // In pass-through mode, find the game canvas (layer 0) for forwarding
    // non-hit pointer events. Look up after a microtask so the framework's
    // canvas creation has settled.
    if (this.passThrough) {
      queueMicrotask(() => {
        this.gameCanvas = document.querySelector('canvas[data-dd-layer="0"]');
      });
    }

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
    // SAB polyfill: the worker's UiStatsSAB is a separate ArrayBuffer (not
    // shared memory), so writes here don't reach it. Post the raw bytes so
    // the worker can copy them into its local SAB. On real SAB, the worker
    // reads shared memory directly and this message is never sent.
    if (!usingRealSAB && this.worker && !this.disposed) {
      // Copy the SAB bytes into a standalone ArrayBuffer for transfer.
      // (this.uiStatsSab is a polyfilled ArrayBuffer at runtime, but typed
      // as SharedArrayBuffer — slice() returns SharedArrayBuffer which isn't
      // assignable to ArrayBuffer, so we copy via Uint8Array.)
      const bytes = new Uint8Array(this.uiStatsSab.byteLength);
      bytes.set(new Uint8Array(this.uiStatsSab));
      const msg: MainToWorkerMessage = { kind: "statsSync", data: bytes.buffer };
      this.worker.postMessage(msg, [bytes.buffer]);
    }
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

  /** Get the latest opaque panel regions reported by the worker (canvas px). */
  getOpaqueRegions(): Rect[] {
    return this.opaqueRegions;
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
    this.unwireKeyEvents();
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
      case "sceneState": {
        const pending = this.pendingQueries.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingQueries.delete(msg.requestId);
          pending.resolve(msg.state);
        }
        break;
      }
      case "captureResult": {
        const pending = this.pendingQueries.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingQueries.delete(msg.requestId);
          pending.resolve({ png: msg.png, width: msg.width, height: msg.height });
        }
        break;
      }
      case "error":
        console.error(`[PixiUI worker] ${msg.message}`, msg.stack ?? "");
        if (!this.ready) this.readyReject(new Error(msg.message));
        break;
      case "interactiveRegions":
        this.interactiveRegions = msg.regions;
        break;
      case "opaqueRegions":
        this.opaqueRegions = msg.regions;
        this.onOpaqueChange?.(msg.regions);
        break;
      case "pointerMissed":
        // The worker hit-tested a pointerdown and it didn't hit any
        // interactive PixiJS element. Dispatch a synthetic PointerEvent on
        // the element beneath the overlay so the game canvas receives it.
        this.dispatchPointerMissed(msg);
        break;
    }
  }

  private applyInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    // In pass-through mode, the overlay is always interactive (pointer-events:
    // auto) — the host filters by interactive region before forwarding. Ignore
    // setInteractive requests from the worker so the overlay stays clickable
    // (e.g. a pause button during gameplay) and forwardPointer keeps working.
    if (this.passThrough) return;
    this.interactive = interactive;
    if (this.canvas) {
      this.canvas.style.pointerEvents = interactive ? "auto" : "none";
    }
    this.onInteractiveChange?.(interactive);
  }

  // ── Font scale ──

  /** The current font scale multiplier (>= 1.0). */
  get fontScaleValue(): number {
    return this.fontScale;
  }

  /**
   * Update the font scale at runtime. Notifies the worker, which updates the
   * scene context and re-renders text at the new scale. Use
   * `saveUserFontScale()` from `font-scale.ts` to persist the preference.
   */
  setFontScale(scale: number): void {
    const clamped = Math.max(1, scale);
    if (clamped === this.fontScale) return;
    this.fontScale = clamped;
    if (this.worker) {
      const msg: MainToWorkerMessage = { kind: "setFontScale", fontScale: clamped };
      this.worker.postMessage(msg);
    }
  }

  private handleResize = (): void => {
    if (!this.worker || !this.canvas) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // Re-read devicePixelRatio — it can change when the window is dragged
    // between monitors with different pixel densities.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const dprChanged = dpr !== this.resolution;
    if (w === this.width && h === this.height && !dprChanged) return;
    this.width = w;
    this.height = h;
    if (dprChanged) this.resolution = dpr;
    // Keep the backing store in sync with the new CSS size × resolution.
    // After transferControlToOffscreen(), the canvas backing store is owned
    // by the worker — we can't set width/height from the main thread. The
    // worker handles the OffscreenCanvas resize via the resize message below.
    if (!this.transferred) {
      this.canvas.width = Math.round(w * this.resolution);
      this.canvas.height = Math.round(h * this.resolution);
    }
    const msg: MainToWorkerMessage = {
      kind: "resize",
      width: w,
      height: h,
      ...(dprChanged ? { resolution: this.resolution } : {}),
    };
    this.worker.postMessage(msg);
  };

  // ── Pointer event forwarding (active only when interactive) ──

  private onPointerDown = (e: PointerEvent): void => this.forwardPointer("pointerdown", e);
  private onPointerMove = (e: PointerEvent): void => this.forwardPointer("pointermove", e);
  private onPointerUp = (e: PointerEvent): void => this.forwardPointer("pointerup", e);
  private onPointerLeave = (e: PointerEvent): void => this.forwardPointer("pointerleave", e);

  // ── Keyboard event forwarding ──
  //
  // Forward keydown/keyup to the worker as PixiUiEvents so scenes can handle
  // menu shortcuts (ESC, I, P, ...). The host does NOT preventDefault or
  // stopPropagation — the game's own keyboard listeners still receive the
  // events. Auto-repeat keydowns are skipped to reduce postMessage traffic.

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.postEvent({
      kind: "keydown",
      key: e.key,
      code: e.code,
      modifiers: (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0),
    });
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.postEvent({
      kind: "keyup",
      key: e.key,
      code: e.code,
      modifiers: (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0),
    });
  };

  private wireKeyEvents(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private unwireKeyEvents(): void {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

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
    // In pass-through mode the overlay captures right-clicks that would
    // otherwise reach the game canvas beneath. Suppress the browser context
    // menu for clicks outside interactive regions so games that use
    // right-drag for input (e.g. sandjongg panning) keep working. Clicks
    // inside interactive regions (UI elements) keep the default menu.
    if (this.passThrough) {
      c.addEventListener("contextmenu", this.onContextMenu);
      // Forward wheel events to the element beneath the overlay so games
      // that listen for wheel on their canvas (e.g. overburden zoom) keep
      // working. Without this, the overlay (pointer-events: auto) captures
      // the wheel event and the game canvas beneath never sees it.
      c.addEventListener("wheel", this.onWheel, { passive: false });
    }
  }

  private unwirePointerEvents(): void {
    const c = this.canvas;
    if (!c) return;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("contextmenu", this.onContextMenu);
    c.removeEventListener("wheel", this.onWheel);
  }

  private onContextMenu = (e: MouseEvent): void => {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inRegion = this.interactiveRegions.some(
      (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
    );
    if (!inRegion) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.canvas) return;
    // Always forward wheel events to the element beneath the overlay in
    // pass-through mode. Unlike pointer events (where PixiJS does its own
    // hit-testing on forwarded events), wheel events have no PixiJS
    // hit-testing — without forwarding, the overlay (pointer-events: auto)
    // swallows them and the game canvas never sees zoom input. Some scenes
    // (e.g. overburden's @pixi/react scene) return a full-screen interactive
    // region, so gating on inRegion would block all wheel forwarding.
    e.preventDefault();
    // Find the element beneath the overlay (same logic as dispatchOnGameCanvas).
    let target: Element | null = null;
    if (typeof document !== "undefined" && typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      // Skip ALL pixi-ui overlay canvases (data-dd-layer >= 1) to prevent
      // infinite recursion when multiple overlays are stacked.
      for (const el of stack) {
        if (this.isOverlayCanvas(el)) continue;
        target = el;
        break;
      }
    }
    if (!target) target = this.gameCanvas;
    if (!target) return;
    (target as EventTarget).dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    }));
  };

  private forwardPointer(type: PointerMessage["type"], e: PointerEvent): void {
    if (!this.interactive || !this.worker) return;
    const rect = this.canvas!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // In pass-through mode, check if the event is inside an interactive
    // region. If yes, forward to the worker for PixiJS hit-testing. If no,
    // dispatch a synthetic PointerEvent on the game canvas so the game keeps
    // receiving mouse input (e.g. painting on the game canvas).
    if (this.passThrough) {
      const inRegion = this.interactiveRegions.some(
        (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
      );
      if (!inRegion) {
        this.dispatchOnGameCanvas(type, e);
        return;
      }
    }

    const msg: MainToWorkerMessage = {
      kind: "pointer",
      type,
      x,
      y,
      button: e.button,
      modifiers: (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0),
    };
    this.worker.postMessage(msg);
  }

  /**
   * Dispatch a synthetic PointerEvent on the element beneath the overlay
   * canvas so the game receives mouse input that didn't hit a PixiUI
   * interactive region. Used in pass-through mode.
   *
   * Games may stack multiple canvases below the overlay (e.g. sandjongg has
   * a Canvas2D tile-selection canvas at z-index 10 above the WebGPU sand
   * canvas at z-index 0). Rather than hardcoding a specific canvas, we use
   * document.elementsFromPoint() to find the topmost element at the event
   * coordinates that is NOT the overlay canvas — i.e. what would have
   * received the event if the overlay had pointer-events: none. This handles
   * any number of stacked canvases correctly.
   */
  private dispatchOnGameCanvas(type: PointerMessage["type"], e: PointerEvent): void {
    let target: Element | null = null;
    if (typeof document !== "undefined" && typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      // Skip ALL pixi-ui overlay canvases (data-dd-layer >= 1) — when multiple
      // PixiUiHost instances are stacked (e.g. game UI + profiler overlay),
      // each canvas has its own pointer listener. Dispatching a synthetic event
      // on another overlay canvas would re-trigger its forwardPointer →
      // dispatchOnGameCanvas → infinite recursion.
      for (const el of stack) {
        if (this.isOverlayCanvas(el)) continue;
        target = el;
        break;
      }
    }
    // Fallback to the cached game canvas (layer 0) if elementsFromPoint
    // didn't yield a target (e.g. the event is off-screen).
    if (!target) target = this.gameCanvas;
    if (!target) return;
    const rect = (target as HTMLElement).getBoundingClientRect();
    // Only dispatch if the event is within the target's bounds.
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return;
    }
    this.dispatchSyntheticOnTarget(target, type, e.clientX, e.clientY, e.button, e.buttons, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey);
  }

  /**
   * Handle a pointerMissed message from the worker: a forwarded pointerdown
   * didn't hit any interactive PixiJS element. Dispatch a synthetic
   * PointerEvent on the element beneath the overlay so the game canvas
   * receives the click (e.g. for task queueing, mining, tile selection).
   *
   * The worker reports canvas-pixel coordinates; we convert to client
   * coordinates using the overlay's bounding rect.
   */
  private dispatchPointerMissed(msg: PointerMissedMessage): void {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const clientX = rect.left + msg.x;
    const clientY = rect.top + msg.y;
    let target: Element | null = null;
    if (typeof document !== "undefined" && typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(clientX, clientY);
      // Skip ALL pixi-ui overlay canvases (see dispatchOnGameCanvas for rationale).
      for (const el of stack) {
        if (this.isOverlayCanvas(el)) continue;
        target = el;
        break;
      }
    }
    if (!target) target = this.gameCanvas;
    if (!target) return;
    const targetRect = (target as HTMLElement).getBoundingClientRect();
    if (clientX < targetRect.left || clientX > targetRect.right || clientY < targetRect.top || clientY > targetRect.bottom) {
      return;
    }
    const shift = (msg.modifiers & 1) !== 0;
    const ctrl = (msg.modifiers & 2) !== 0;
    const alt = (msg.modifiers & 4) !== 0;
    const meta = (msg.modifiers & 8) !== 0;
    const buttons = msg.type === "pointerdown" ? (msg.button === 0 ? 1 : msg.button === 2 ? 2 : 4) : 0;
    this.dispatchSyntheticOnTarget(target, msg.type, clientX, clientY, msg.button, buttons, shift, ctrl, alt, meta);
  }

  /**
   * Dispatch synthetic pointer + mouse events on a target element. A real
   * browser click generates both pointer and mouse events; game canvases may
   * listen for either. Dispatching only a PointerEvent would miss listeners
   * registered for "mousedown"/"mouseup"/"mousemove" (e.g. overburden's
   * input handler), and dispatching only a MouseEvent would miss listeners
   * for "pointerdown" (e.g. sandjongg's input handler). Dispatching both
   * ensures all game canvas input handlers fire.
   */
  private dispatchSyntheticOnTarget(
    target: Element,
    pointerType: PointerMessage["type"],
    clientX: number,
    clientY: number,
    button: number,
    buttons: number,
    shiftKey: boolean,
    ctrlKey: boolean,
    altKey: boolean,
    metaKey: boolean,
  ): void {
    const common = { bubbles: true, cancelable: true, clientX, clientY, button, buttons, shiftKey, ctrlKey, altKey, metaKey };
    // Pointer event (for games that listen for pointerdown/pointerup/pointermove)
    (target as EventTarget).dispatchEvent(new PointerEvent(pointerType, { ...common, pointerId: 1, pointerType: "mouse" }));
    // Corresponding mouse event (for games that listen for mousedown/mouseup/mousemove)
    const mouseType: string = pointerType === "pointerdown" ? "mousedown"
      : pointerType === "pointerup" ? "mouseup"
      : pointerType === "pointermove" ? "mousemove"
      : "mouseleave";
    (target as EventTarget).dispatchEvent(new MouseEvent(mouseType, common));
  }

  /**
   * Check if an element is a pixi-ui overlay canvas (data-dd-layer >= 1).
   * Used to skip overlay canvases when dispatching synthetic pointer events
   * on the game canvas beneath — prevents infinite recursion when multiple
   * PixiUiHost instances are stacked (e.g. game UI + profiler overlay).
   */
  private isOverlayCanvas(el: Element): boolean {
    const layer = el.getAttribute?.("data-dd-layer");
    if (layer === null || layer === undefined) return false;
    const n = Number(layer);
    return n >= 1;
  }
}
