// ============================================================================
// pixi-ui-worker — the UI worker's main module.
//
// Runs inside a Web Worker spawned by PixiUiHost. It:
//   1. Receives the init message (OffscreenCanvas + UiStatsSAB + config).
//   2. Creates a PIXI.Application on the OffscreenCanvas with the chosen backend.
//   3. Dynamically imports the game's scene module (or uses a default scene).
//   4. Runs a ticker loop that reads the UiStatsSAB + drains postMessage events.
//   5. Handles pointer events forwarded from the main thread (PixiJS hit-testing).
//   6. Responds to queryScene / captureOverlay requests from MCP tools.
//
// IMPORTANT: `new URL("./pixi-ui-worker.ts", import.meta.url)` must appear
// literally in host.ts for Vite to bundle this worker (workerUrlGuardPlugin).
// ============================================================================

// ── Minimal document polyfill for PixiJS v8 in a Web Worker ──
// PixiJS v8's shader precision tester (getTestContext → createCanvas) calls
// document.createElement('canvas') during renderer init, and the Text renderer
// creates canvases for text rasterization. In a worker there's no document,
// so we shim createElement('canvas') to return a new OffscreenCanvas.
//
// PixiJS may set canvas.width/height to 0 or float values, but OffscreenCanvas
// requires unsigned long. We monkey-patch the prototype setters to coerce
// (this is safe in a worker — all OffscreenCanvas instances are ours).
// We can't use a Proxy because WebGL's texImage2D/texSubImage2D won't
// recognize a Proxy as a valid TexImageSource.
if (typeof document === "undefined") {
  // Monkey-patch OffscreenCanvas width/height to coerce to positive integers.
  const proto = OffscreenCanvas.prototype as any;
  const origWidth = Object.getOwnPropertyDescriptor(proto, "width");
  const origHeight = Object.getOwnPropertyDescriptor(proto, "height");
  if (origWidth?.set) {
    const origWidthSet = origWidth.set;
    Object.defineProperty(proto, "width", {
      get: origWidth.get,
      set(v: any) { origWidthSet.call(this, Math.max(1, Math.floor(Number(v) || 1))); },
      configurable: true,
    });
  }
  if (origHeight?.set) {
    const origHeightSet = origHeight.set;
    Object.defineProperty(proto, "height", {
      get: origHeight.get,
      set(v: any) { origHeightSet.call(this, Math.max(1, Math.floor(Number(v) || 1))); },
      configurable: true,
    });
  }
  (self as any).document = {
    createElement(tag: string): any {
      if (tag === "canvas") return new OffscreenCanvas(1, 1);
      return {};
    },
    createElementNS(_ns: string, tag: string): any {
      if (tag === "canvas") return new OffscreenCanvas(1, 1);
      return {};
    },
  };
}
// PixiJS v8 references these globals as type guards / fallback detection.
// They don't exist in a worker; stub them so the WebGL/WebGPU path is taken.
if (typeof (self as any).CanvasRenderingContext2D === "undefined") {
  (self as any).CanvasRenderingContext2D = class CanvasRenderingContext2D {};
}
if (typeof (self as any).HTMLCanvasElement === "undefined") {
  (self as any).HTMLCanvasElement = class HTMLCanvasElement {};
}

import { Application, Container, Text, type Ticker } from "pixi.js";
import {
    type InitMessage,
    type MainToWorkerMessage,
    type PixiUiAction,
    type PixiUiEvent,
    type SceneNodeSummary,
    type SerializedPixiUiConfig,
    type WorkerToMainMessage,
} from "./bridge-protocol";
import type { PixiUiScene, PixiUiSceneContext, PixiUiSceneFactory } from "./scene";
import { readUiStats, validateUiStatsSab } from "./ui-stats-sab";

let app: Application | null = null;
let scene: PixiUiScene | null = null;
let config: SerializedPixiUiConfig | null = null;
let uiStatsSab: SharedArrayBuffer | null = null;
let eventQueue: PixiUiEvent[] = [];
let startTime = 0;
let lastTime = 0;
let interactive = false;

// ── Helpers: post messages to main thread ──

function postToMain(msg: WorkerToMainMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

function postReady(backend: string): void {
  postToMain({ kind: "ready", backend });
}

function postError(message: string, stack?: string): void {
  postToMain({ kind: "error", message, stack });
}

function postAction(action: PixiUiAction): void {
  postToMain({ kind: "action", action });
}

function postSetInteractive(value: boolean): void {
  interactive = value;
  postToMain({ kind: "setInteractive", interactive: value });
}

// ── Error handling ──

self.onerror = (e: any) => {
  postError(`Unhandled error: ${e?.message ?? e}`, e?.stack);
};

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  postError(`Unhandled rejection: ${e.reason}`, e.reason?.stack);
});

// ── Message handler ──

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  try {
    switch (msg.kind) {
      case "init":
        await handleInit(msg);
        break;
      case "event":
        eventQueue.push(msg.event);
        break;
      case "pointer":
        handlePointer(msg);
        break;
      case "resize":
        handleResize(msg.width, msg.height);
        break;
      case "queryScene":
        handleQueryScene(msg.requestId);
        break;
      case "captureOverlay":
        await handleCaptureOverlay(msg.requestId);
        break;
      case "dispose":
        handleDispose();
        break;
    }
  } catch (err) {
    postError(`Message handler error for "${msg.kind}": ${(err as Error).message}`, (err as Error).stack);
  }
};

// ── Init ──

async function handleInit(msg: InitMessage): Promise<void> {
  config = msg.config;
  uiStatsSab = msg.uiStatsSab;

  // Validate the SAB layout matches the config.
  validateUiStatsSab(msg.uiStatsSab, msg.config.statsLayout);

  // Create the PIXI.Application on the transferred OffscreenCanvas.
  // PixiJS v8 Application.init() is async; we use the static async factory.
  const preference = msg.config.backend === "webgpu" ? "webgpu" : msg.config.backend === "auto" ? undefined : "webgl";
  try {
    app = new Application();
    await app.init({
      canvas: msg.offscreenCanvas,
      width: msg.width,
      height: msg.height,
      backgroundAlpha: 0, // transparent overlay
      preference, // "webgl" | "webgpu" | undefined (auto)
      antialias: true,
      resolution: 1, // the host sets canvas width/height; we render 1:1
      autoDensity: false,
    });
  } catch (err) {
    postError(`PIXI.Application init failed: ${(err as Error).message}`, (err as Error).stack);
    return;
  }

  const backend = (app.renderer as any).name ?? msg.config.backend ?? "unknown";
  if (config?.debug) postError(`[PixiUI] Backend: ${backend}`); // reuse error channel for debug logs

  // Build the scene.
  const sceneCtx: PixiUiSceneContext = {
    app,
    width: msg.width,
    height: msg.height,
    sceneConfig: msg.config.sceneConfig,
    setInteractive: postSetInteractive,
    postAction,
    log: (level: "info" | "warn" | "error", text: string) => {
      // Forward logs via the error channel with a [debug] prefix (the host
      // routes "error" kind to console.error; for dev logs we use console too).
      if (level === "error") postError(text);
      else if (level === "warn") console.warn(`[PixiUI scene] ${text}`);
      else console.info(`[PixiUI scene] ${text}`);
    },
  };

  try {
    if (msg.config.sceneModuleUrl) {
      const mod = await import(msg.config.sceneModuleUrl);
      const exportName = msg.config.sceneExportName ?? "default";
      const factory = mod[exportName] as PixiUiSceneFactory | undefined;
      if (typeof factory !== "function") {
        throw new Error(`Scene module "${msg.config.sceneModuleUrl}" export "${exportName}" is not a function`);
      }
      scene = factory(sceneCtx);
    } else {
      scene = createDefaultScene(sceneCtx);
    }
  } catch (err) {
    postError(`Scene init failed: ${(err as Error).message}`, (err as Error).stack);
    // Still report ready so the host doesn't hang — the overlay will be blank
    // with an error logged. The game can detect the error via onAction/error.
  }

  // Start the ticker loop.
  startTime = performance.now();
  lastTime = startTime;
  if (app.ticker) {
    app.ticker.add((_ticker: Ticker) => tick());
  } else {
    // Fallback: manual rAF loop (shouldn't be needed in v8, but defensive).
    const rafLoop = () => {
      tick();
      if (!disposed) requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);
  }

  postReady(backend);
}

let disposed = false;

// ── Per-frame tick ──

function tick(): void {
  if (!scene || !config || !uiStatsSab) return;
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  const elapsedTime = (now - startTime) / 1000;

  // Read per-frame scalars from the SAB.
  const stats = readUiStats(uiStatsSab, config.statsLayout);

  // Drain queued events.
  const events = eventQueue;
  eventQueue = [];

  try {
    scene.update({ stats, events, dt, elapsedTime });
  } catch (err) {
    postError(`Scene update error: ${(err as Error).message}`, (err as Error).stack);
  }
}

// ── Pointer handling ──

function handlePointer(msg: { type: string; x: number; y: number; button: number; modifiers: number }): void {
  if (!app || !interactive) return;
  // PixiJS v8 event system: synthesize a pointer event on the renderer's canvas.
  // The EventSystem is automatically created by Application.init() when a canvas
  // is provided. We use the renderer's eventSystem to dispatch.
  const renderer = app.renderer as any;
  const eventSystem = renderer?.events;
  if (!eventSystem) return;

  // Build a minimal PointerEvent-like object for PixiJS's EventSystem.
  // PixiJS v8's EventSystem.onPointerDown etc. expect a native PointerEvent.
  // Since we're in a worker, we construct a synthetic event and call the
  // appropriate handler directly.
  const syntheticEvent = {
    pointerId: 1,
    pointerType: "mouse",
    clientX: msg.x,
    clientY: msg.y,
    button: msg.button,
    buttons: msg.type === "pointerdown" ? (msg.button === 0 ? 1 : msg.button === 2 ? 2 : 4) : 0,
    shiftKey: (msg.modifiers & 1) !== 0,
    ctrlKey: (msg.modifiers & 2) !== 0,
    altKey: (msg.modifiers & 4) !== 0,
    metaKey: (msg.modifiers & 8) !== 0,
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: null,
    isTrusted: true,
    // PixiJS reads offsetX/offsetY from the canvas; we pass clientX/Y as both.
    offsetX: msg.x,
    offsetY: msg.y,
    pageX: msg.x,
    pageY: msg.y,
  };

  try {
    if (msg.type === "pointerdown") eventSystem.onPointerDown(syntheticEvent as any);
    else if (msg.type === "pointermove") eventSystem.onPointerMove(syntheticEvent as any);
    else if (msg.type === "pointerup") eventSystem.onPointerUp(syntheticEvent as any);
    else if (msg.type === "pointerleave") eventSystem.onPointerOut(syntheticEvent as any);
  } catch (err) {
    // PixiJS event system can throw if the synthetic event shape is slightly off.
    // Log but don't crash the worker.
    if (config?.debug) postError(`Pointer dispatch error: ${(err as Error).message}`);
  }
}

// ── Resize ──

function handleResize(width: number, height: number): void {
  if (!app?.renderer) return;
  app.renderer.resize(width, height);
  scene?.resize?.(width, height);
}

// ── Scene state query (for MCP) ──

function handleQueryScene(requestId: number): void {
  const nodes = scene?.summarize?.() ?? summarizeScene(scene?.root ?? null);
  postToMain({
    kind: "sceneState",
    requestId,
    state: { nodes, interactive, backend: (app?.renderer as any)?.name ?? config?.backend ?? "unknown" },
  });
}

function summarizeScene(root: Container | null): SceneNodeSummary[] {
  if (!root) return [];
  const out: SceneNodeSummary[] = [];
  for (const child of root.children) {
    out.push(summarizeNode(child));
  }
  return out;
}

function summarizeNode(obj: any): SceneNodeSummary {
  const summary: SceneNodeSummary = {
    name: obj.name ?? "",
    type: obj.constructor?.name ?? "unknown",
    visible: obj.visible ?? true,
    x: obj.x ?? 0,
    y: obj.y ?? 0,
    width: obj.width ?? 0,
    height: obj.height ?? 0,
  };
  if (obj.text !== undefined) summary.text = String(obj.text);
  if (obj.children?.length) {
    summary.children = obj.children.slice(0, 20).map(summarizeNode);
  }
  return summary;
}

// ── Capture overlay (for MCP) ──

async function handleCaptureOverlay(requestId: number): Promise<void> {
  if (!app) {
    postToMain({ kind: "captureResult", requestId, png: null, width: 0, height: 0 });
    return;
  }
  try {
    // Render a frame, then extract the canvas content as PNG.
    app.render();
    const canvas = app.canvas as unknown as OffscreenCanvas;
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = await blob.arrayBuffer();
    postToMain({
      kind: "captureResult",
      requestId,
      png: buf,
      width: canvas.width,
      height: canvas.height,
    });
  } catch (err) {
    postError(`Capture failed: ${(err as Error).message}`);
    postToMain({ kind: "captureResult", requestId, png: null, width: 0, height: 0 });
  }
}

// ── Dispose ──

function handleDispose(): void {
  disposed = true;
  try { scene?.dispose(); } catch { /* ignore */ }
  scene = null;
  try { app?.destroy(); } catch { /* ignore */ }
  app = null;
  uiStatsSab = null;
  config = null;
}

// ── Default scene (when no sceneModuleUrl configured) ──

function createDefaultScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = new Container();
  root.name = "default-root";

  const label = new Text({
    text: "PixiUI ready",
    style: { fill: 0x00ffaa, fontSize: 24, fontFamily: "monospace" },
  });
  label.name = "ready-label";
  label.x = 16;
  label.y = 16;
  root.addChild(label);

  const fpsLabel = new Text({
    text: "FPS: --",
    style: { fill: 0xffffff, fontSize: 16, fontFamily: "monospace" },
  });
  fpsLabel.name = "fps-label";
  fpsLabel.x = 16;
  fpsLabel.y = 48;
  root.addChild(fpsLabel);

  ctx.app.stage.addChild(root);

  return {
    root,
    update({ stats }) {
      if (stats.fps !== undefined) {
        fpsLabel.text = `FPS: ${Math.floor(stats.fps)}`;
      }
    },
    summarize() {
      return summarizeScene(root);
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
