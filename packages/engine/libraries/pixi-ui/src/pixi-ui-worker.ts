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
  // Helper: create a stub DOM element that supports the methods PixiJS's
  // AccessibilitySystem and other DOM-dependent code call on elements
  // (addEventListener, removeEventListener, appendChild, etc.). In a worker
  // there's no real DOM, so these are all no-ops.
  function createStubElement(): any {
    return {
      style: {},
      appendChild(_node: any): any { return _node; },
      removeChild(_node: any): any { return _node; },
      addEventListener(_type: string, _listener: any, _opts?: any): void {},
      removeEventListener(_type: string, _listener: any, _opts?: any): void {},
      dispatchEvent(_event: any): boolean { return true; },
      setAttribute(_key: string, _value: string): void {},
      getAttribute(_key: string): any { return null; },
      contains(_node: any): boolean { return false; },
      focus(): void {},
      blur(): void {},
      click(): void {},
      remove(): void {},
      getBoundingClientRect(): any { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    };
  }
  (self as any).document = {
    createElement(tag: string): any {
      if (tag === "canvas") return new OffscreenCanvas(1, 1);
      return createStubElement();
    },
    createElementNS(_ns: string, tag: string): any {
      if (tag === "canvas") return new OffscreenCanvas(1, 1);
      return createStubElement();
    },
    // PixiJS v8's worker environment adapter checks for
    // document.addEventListener and overwrites document if it's missing.
    // Include addEventListener/removeEventListener/dispatchEvent so our stub
    // (with getElementsByTagName, querySelector, head, etc.) is preserved.
    addEventListener(_type: string, _listener: any, _opts?: any): void {},
    removeEventListener(_type: string, _listener: any, _opts?: any): void {},
    dispatchEvent(_event: any): boolean { return true; },
    // PixiJS's isRenderingToScreen() calls document.body.contains(resource).
    // In a worker, there's no DOM body — stub contains() to return false so
    // PixiJS treats OffscreenCanvas renders as off-screen (which is correct).
    body: createStubElement(),
    // Some libraries check document.documentElement for viewport sizing.
    documentElement: { clientWidth: 1280, clientHeight: 720, ...createStubElement() },
    // React 19 / @pixi/react / Vite's __vitePreload helper call these during
    // init. In a worker there are no DOM elements — return empty/null.
    getElementsByTagName(_name: string): any[] { return []; },
    getElementsByClassName(_name: string): any[] { return []; },
    getElementById(_id: string): any { return null; },
    querySelector(_selector: string): any { return null; },
    querySelectorAll(_selector: string): any[] { return []; },
    head: createStubElement(),
    // PixiJS's DOM adapter checks document.style for CSS property access.
    style: {},
    // Some libraries check document.readyState.
    readyState: "complete",
  };
}
// React 19 references `window` during module init + useSyncExternalStore.
// In a worker, `window` doesn't exist — alias it to `self`.
if (typeof (self as any).window === "undefined") {
  (self as any).window = self;
}
// @vitejs/plugin-react injects $RefreshReg$ / $RefreshSig$ calls for Fast
// Refresh (HMR). These globals don't exist in a worker — stub them as no-ops.
if (typeof (self as any).$RefreshReg$ === "undefined") {
  (self as any).$RefreshReg$ = () => {};
  (self as any).$RefreshSig$ = () => (fn: any) => fn;
}
// PixiJS v8 references these globals as type guards / fallback detection.
// They don't exist in a worker; stub them so the WebGL/WebGPU path is taken.
if (typeof (self as any).CanvasRenderingContext2D === "undefined") {
  (self as any).CanvasRenderingContext2D = class CanvasRenderingContext2D {};
}
if (typeof (self as any).HTMLCanvasElement === "undefined") {
  (self as any).HTMLCanvasElement = class HTMLCanvasElement {};
}

// ── Register PixiJS v8 WebWorkerAdapter ──
//
// PixiJS v8 defaults to BrowserAdapter, which uses document.createElement
// and CanvasRenderingContext2D. In a worker, we need the WebWorkerAdapter
// which uses OffscreenCanvas and OffscreenCanvasRenderingContext2D.
// Without this, the text renderer patches the wrong prototype
// (CanvasRenderingContext2D instead of OffscreenCanvasRenderingContext2D),
// producing invalid texture resources that cause createPattern to fail.
//
// The import must come AFTER the document/window stubs above (so the
// adapter's createCanvas fallback works during module init) but BEFORE
// the main pixi.js import below (so DOMAdapter is set before any PixiJS
// code runs). ES module imports are hoisted, but side-effect imports
// from the same module are evaluated in source order.
import { AccessibilitySystem, DOMAdapter, WebWorkerAdapter, extensions } from "pixi.js";
DOMAdapter.set(WebWorkerAdapter);

// Disable the AccessibilitySystem in the worker — it requires a real DOM
// (creates button elements, calls focus/remove, etc.) which doesn't exist
// in a Web Worker. Without this, every render frame throws errors when the
// accessibility system's postrender hook tries to manipulate DOM elements.
extensions.remove(AccessibilitySystem);

import { Application, Container, Text, WebGLRenderer, type Ticker } from "pixi.js";
// Side-effect import: registers the EventSystem as a renderer extension so
// that `app.renderer.events` is available. Without this, PixiJS v8's
// tree-shaking omits the EventSystem and pointer hit-testing doesn't work.
import "pixi.js/events";
import {
    type InitMessage,
    type MainToWorkerMessage,
    type PixiUiAction,
    type PixiUiEvent,
    type PointerMissedMessage,
    type Rect,
    type SceneNodeSummary,
    type SerializedPixiUiConfig,
    type StatsSyncMessage,
    type WorkerToMainMessage,
} from "./bridge-protocol";
import type { PixiUiScene, PixiUiSceneContext, PixiUiSceneFactory } from "./scene";
import { readUiStats, validateUiStatsSab } from "./ui-stats-sab";

// ── Bypass autoDetectRenderer's dynamic import in the worker ──
//
// PixiJS v8's autoDetectRenderer() uses `await import('./gl/WebGLRenderer.mjs')`
// to lazily load the WebGL renderer. When bundled by Vite (esbuild pre-bundling
// in dev, Rollup in prod), this dynamic import is split into a separate chunk
// (e.g. WebGLRenderer-XXXXX.js). In a Web Worker — especially in Electron with
// file:// protocol or when the worker's import.meta.url doesn't resolve chunk
// paths correctly — this chunk cannot be fetched, causing:
//   "Failed to fetch dynamically imported module: WebGLRenderer-XXXXX.js"
//
// We statically import WebGLRenderer and patch Application.init() to create the
// renderer directly, avoiding the dynamic import entirely for the WebGL backend
// (the default and the only backend that reliably works in a worker). For
// "webgpu" we fall back to the original init (which does the dynamic import —
// WebGPU in a worker is rare and would need its own static import if used).
const _originalAppInit = Application.prototype.init;
Application.prototype.init = async function(this: Application, options: any) {
  const preference = options?.preference;
  if (preference === "webgl" || preference === undefined || preference === "webgl2") {
    const opts = { ...options };
    // Create the renderer directly from the statically imported class.
    const renderer = new WebGLRenderer();
    await renderer.init(opts);
    (this as any).renderer = renderer;
    // Run Application plugins (TickerPlugin, etc.) — same as the original init.
    (Application as any)._plugins.forEach((plugin: any) => {
      plugin.init.call(this, opts);
    });
  } else {
    // WebGPU or other backends: fall back to original init (dynamic import).
    return _originalAppInit.call(this, options);
  }
};

// ── Worker environment stubs ──
//
// PixiJS's EventSystem._addEvents() registers DOM event listeners on
// globalThis.document and globalThis — neither exists in a Web Worker.
// We stub them with no-op addEventListener/removeEventListener so the
// EventSystem is created (giving us `renderer.events` for hit-testing)
// without crashing. We dispatch pointer events manually via _onPointerDown
// etc., so the DOM listeners are unnecessary.
//
// These MUST be set at module level (before handleInit runs) so they're
// in place when Application.init() triggers EventSystem.init().

if (typeof (globalThis as any).document === "undefined" || typeof (globalThis as any).document?.addEventListener !== "function") {
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    // PixiJS text rendering calls document.createElement('canvas') to get a
    // 2D canvas for rasterizing text. In a worker, we return an OffscreenCanvas
    // which supports getContext('2d') with the needed APIs (resetTransform, etc).
    createElement: (tag: string) => {
      if (tag.toLowerCase() === "canvas") return new OffscreenCanvas(1, 1);
      return { style: {}, getContext: () => null };
    },
    // PixiJS's isRenderingToScreen() checks document.body.contains(canvas).
    // In a worker, we're always rendering to the OffscreenCanvas (the "screen"),
    // so return true from contains().
    body: { contains: () => true },
    style: {},
  };
}
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = globalThis;
}

let app: Application | null = null;
let scene: PixiUiScene | null = null;
let sceneCtx: PixiUiSceneContext | null = null;
let config: SerializedPixiUiConfig | null = null;
let uiStatsSab: SharedArrayBuffer | null = null;
let extraSharedBuffers: Record<string, SharedArrayBuffer> | null = null;
let eventQueue: PixiUiEvent[] = [];
let startTime = 0;
let lastTime = 0;
let interactive = false;
// Font scale multiplier (>= 1.0). Set from the init message, updated via
// setFontScale messages. Exposed to scenes via PixiUiSceneContext.fontScale.
let fontScale = 1;
// In pass-through mode, tracks whether the current pointer drag started as
// a "miss" (no interactive PixiJS element was hit on pointerdown). While
// true, pointermove/pointerup are reported as misses too so the host
// dispatches them on the game canvas beneath the overlay — without this,
// the game canvas receives pointerdown (via pointerMissed) but never
// pointermove/pointerup, so click+drag (e.g. camera panning) doesn't work.
let dragMissed = false;

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
  // Skip if unchanged — scenes may call setInteractive() every frame in
  // their sync/update loop, and posting an identical message each frame is
  // wasteful (the host's applyInteractive also short-circuits, but the
  // postMessage boundary crossing itself is the cost we avoid here).
  if (interactive === value) return;
  interactive = value;
  postToMain({ kind: "setInteractive", interactive: value });
}

// ── Interactive regions reporting (for pass-through hit-testing) ──

let lastRegionsKey = "";

function postInteractiveRegionsIfChanged(): void {
  if (!scene?.getInteractiveRegions) return;
  let regions: Rect[];
  try {
    regions = scene.getInteractiveRegions();
  } catch {
    return;
  }
  // Serialize to a compact key for change detection (avoid posting every frame
  // when regions are static). Rounding to integers keeps the key stable across
  // sub-pixel layout jitter.
  const key = regions.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`).join("|");
  if (key === lastRegionsKey) return;
  lastRegionsKey = key;
  postToMain({ kind: "interactiveRegions", regions });
}

// ── Opaque regions reporting (for game-side occlusion culling) ──

let lastOpaqueKey = "";

function postOpaqueRegionsIfChanged(): void {
  if (!scene?.getOpaqueRegions) return;
  let regions: Rect[];
  try {
    regions = scene.getOpaqueRegions();
  } catch {
    return;
  }
  const key = regions.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`).join("|");
  if (key === lastOpaqueKey) return;
  lastOpaqueKey = key;
  postToMain({ kind: "opaqueRegions", regions });
}

// ── Error handling ──

self.onerror = (e: any) => {
  postError(`Unhandled error: ${e?.message ?? e}`, e?.stack);
};

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  postError(`Unhandled rejection: ${e.reason}`, e.reason?.stack);
});

// ── Message handler ──
//
// IMPORTANT: We use self.addEventListener("message", ...) instead of
// self.onmessage = ... because PixiJS's internal worker code (e.g.
// loadImageBitmap worker) overwrites self.onmessage during Application.init().
// addEventListener handlers cannot be overwritten by assignment, so our
// message handler survives the PixiJS init.

const messageHandler = async (e: MessageEvent<MainToWorkerMessage>) => {
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
        handleResize(msg.width, msg.height, msg.resolution);
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
      case "setFontScale":
        handleSetFontScale(msg.fontScale);
        break;
      case "statsSync":
        handleStatsSync(msg);
        break;
    }
  } catch (err) {
    postError(`Message handler error for "${msg.kind}": ${(err as Error).message}`, (err as Error).stack);
  }
};

self.addEventListener("message", messageHandler as (e: MessageEvent) => void);

// ── Init ──

async function handleInit(msg: InitMessage): Promise<void> {
  config = msg.config;
  uiStatsSab = msg.uiStatsSab;
  extraSharedBuffers = msg.extraSharedBuffers ?? null;

  // Validate the SAB layout matches the config.
  validateUiStatsSab(msg.uiStatsSab, msg.config.statsLayout);

  // Create the PIXI.Application on the transferred OffscreenCanvas.
  // PixiJS v8 Application.init() is async; we use the static async factory.
  const preference = msg.config.backend === "webgpu" ? "webgpu" : msg.config.backend === "auto" ? undefined : "webgl";

  try {
    app = new Application();
    // Render at the host-supplied resolution (typically devicePixelRatio) so
    // text is crisp on HiDPI/Retina displays. autoDensity is false because the
    // host owns the DOM canvas CSS size (style.width/height = 100vw/100vh);
    // PixiJS only manages the backing store (canvas.width/height = CSS × res).
    const resolution = msg.resolution ?? 1;
    await app.init({
      canvas: msg.offscreenCanvas,
      width: msg.width,
      height: msg.height,
      backgroundAlpha: 0, // transparent overlay
      preference, // "webgl" | "webgpu" | undefined (auto)
      antialias: true,
      resolution,
      autoDensity: false,
    });
  } catch (err) {
    postError(`PIXI.Application init failed: ${(err as Error).message}`, (err as Error).stack);
    return;
  }

  const backend = (app.renderer as any).name ?? msg.config.backend ?? "unknown";
  if (config?.debug) postError(`[PixiUI] Backend: ${backend}`); // reuse error channel for debug logs

  // In pass-through mode, the overlay is always interactive (the host sets
  // pointer-events: auto). Set the worker's interactive flag to match so
  // handlePointer doesn't return early. The scene can still toggle this off
  // via ctx.setInteractive(false) if needed.
  if (msg.config.passThrough) {
    interactive = true;
  }

  // Build the scene.
  fontScale = msg.fontScale ?? 1;
  sceneCtx = {
    app,
    width: msg.width,
    height: msg.height,
    fontScale,
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
    extraSharedBuffers: extraSharedBuffers ?? undefined,
  };

  try {
    if (msg.config.sceneModuleUrl) {
      // Expose the worker's pixi.js instance on self.__pixi before importing
      // the scene module. The sceneModuleUrlPlugin rewrites the scene's
      // `import { Container, Graphics, Text } from "pixi.js"` to
      // `const { ... } = self.__pixi;` so the scene uses THIS worker's pixi.js
      // instance (not the renderer's). This prevents dual-instance bugs where
      // PIXI v8 singleton comparisons (e.g. `fillStyle.texture === Texture.WHITE`
      // in getCanvasFillStyle) fail because the scene's Texture.WHITE is a
      // different object than the worker's.
      //
      // Use a dynamic import() to get the full pixi.js module namespace (all
      // exports). A static `import * as PIXI` would be tree-shaken by Rollup
      // because the only usage is this assignment. The dynamic import returns
      // the already-loaded module (pixi.js is bundled into the worker), so
      // there's no additional chunk or network request.
      try {
        (self as any).__pixi = await import("pixi.js");
      } catch (err) {
        throw new Error(
          `Failed to load pixi.js module for self.__pixi: ${(err as Error).message}. ` +
            `The scene module needs self.__pixi to use the worker's pixi.js instance.`,
        );
      }

      // Also expose @pixi/react and react on self so the scene module can use
      // the worker's instances instead of importing from the main bundle.
      // The sceneModuleUrlPlugin rewrites `import("@pixi/react")` and
      // `import("react")` (both static and dynamic) to use self.__pixiReact
      // and self.__react respectively. This prevents dual-instance bugs:
      // - @pixi/react from the main bundle would bring the main bundle's pixi.js
      //   into the worker, creating duplicate Texture.WHITE.
      // - React from the main bundle would have a different dispatcher than the
      //   worker's React, causing hooks to fail with null dispatcher errors.
      try {
        (self as any).__pixiReact = await import("@pixi/react");
      } catch { /* @pixi/react may not be installed */ }
      try {
        (self as any).__react = await import("react");
      } catch { /* react may not be installed */ }

      // The scene module URL is a runtime value passed from the host via
      // postMessage (the game's scene module), so Vite cannot analyze it at
      // build time. Suppress the dynamic-import warning intentionally.
      const mod = await import(/* @vite-ignore */ msg.config.sceneModuleUrl);
      const exportName = msg.config.sceneExportName ?? "default";
      const factory = mod[exportName] as PixiUiSceneFactory | undefined;
      if (typeof factory !== "function") {
        throw new Error(`Scene module "${msg.config.sceneModuleUrl}" export "${exportName}" is not a function`);
      }
      scene = await factory(sceneCtx);
    } else {
      scene = createDefaultScene(sceneCtx);
    }
    // Add the scene's root to the stage so it's visible. The default scene
    // does this itself, but custom scenes may not — do it here for all scenes
    // so factories don't need to know about the app stage.
    //
    // Guard against the scene root BEING the stage (or an ancestor/descendant
    // of it): adding a container to itself creates a parent/child + render-group
    // cycle, which makes PixiJS's GCSystem._updateInstructionGCTick recurse
    // infinitely (Maximum call stack size exceeded) on the first render.
    // Some scenes (e.g. the @pixi/react adapter scene) intentionally return
    // `root: ctx.app.stage` because they render directly into the stage.
    if (scene?.root && app?.stage && scene.root !== app.stage && !app.stage.children.includes(scene.root)) {
      app.stage.addChild(scene.root);
    }

    // Fix: PixiJS v8's EventSystem._addEvents() sets rootBoundary.rootTarget
    // to the renderer's root container. In a Web Worker, _addEvents() may not
    // be called (or may fail silently) because the DOM event listeners it
    // registers are no-ops on the stubbed document/window. Without rootTarget,
    // the EventSystem's hitTest() returns null for all pointer events, so
    // interactive UI elements (buttons, etc.) never receive clicks.
    // Manually set rootTarget to the app's stage so hit-testing works.
    const eventSystem = (app?.renderer as any)?.events;
    if (eventSystem?.rootBoundary && !eventSystem.rootBoundary.rootTarget) {
      eventSystem.rootBoundary.rootTarget = app?.stage ?? null;
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
    // Remove the Application's automatic render callback from the ticker.
    // If app.render() throws (e.g., WebGL context issues on OffscreenCanvas),
    // the uncaught error would stop the ticker. We handle rendering ourselves
    // in tick() with proper error handling.
    app.ticker.remove(app.render, app);
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
  try {
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

    // Render the PIXI stage to the OffscreenCanvas. We handle this here
    // (instead of letting the Application's TickerPlugin do it) so that
    // render errors are caught and don't stop the ticker.
    try {
      app?.render();
    } catch (err) {
      postError(`Render error: ${(err as Error).message}`, (err as Error).stack);
    }

    // After each update, report interactive regions to the host (for
    // pass-through hit-testing). Only post if the regions changed since the
    // last frame to avoid flooding the message channel.
    postInteractiveRegionsIfChanged();
    // Report opaque panel regions to the host (for game-side occlusion
    // culling — skipping 3D + postfx under opaque UI panels).
    postOpaqueRegionsIfChanged();
  } catch (err) {
    // Catch ALL errors in tick to prevent the PixiJS ticker from stopping.
    // If an uncaught error reaches the ticker's rAF callback, the ticker
    // stops requesting new frames and the worker becomes unresponsive.
    postError(`Tick error: ${(err as Error).message}`, (err as Error).stack);
  }
}

// ── Pointer handling ──

function handlePointer(msg: { type: string; x: number; y: number; button: number; modifiers: number }): void {
  if (!app) return;
  // In pass-through mode, the host already filters events by interactive
  // region before forwarding — always process forwarded events. In
  // non-pass-through mode, gate on the interactive flag (the host only
  // forwards when the canvas has pointer-events: auto, but this is a safety
  // check for the worker's own setInteractive state).
  if (!interactive && !config?.passThrough) return;

  // Queue pointer events as PixiUiEvents so scenes that recreate their
  // display objects every frame (e.g. the ProfilerScene) can handle clicks
  // in update() without relying on PixiJS hit-testing (which fails because
  // the display objects are destroyed before clicks register).
  eventQueue.push({
    kind: msg.type,
    x: msg.x,
    y: msg.y,
    button: msg.button,
    modifiers: msg.modifiers,
  } as PixiUiEvent);
  // PixiJS v8 event system: synthesize a pointer event on the renderer's canvas.
  // The EventSystem is automatically created by Application.init() when a canvas
  // is provided. We use the renderer's eventSystem to dispatch.
  const renderer = app.renderer as any;
  const eventSystem = renderer?.events;
  if (!eventSystem) return;

  // PixiJS v8's EventSystem handler methods are underscore-prefixed:
  //   _onPointerDown, _onPointerMove, _onPointerUp, _onPointerOverOut
  // They are bound in the constructor and registered as DOM event listeners.
  // We call them directly with a synthetic event.

  // Build a minimal PointerEvent-like object for PixiJS's EventSystem.
  // The synthetic event must include `target` and `composedPath` because
  // _onPointerUp checks `nativeEvent.target !== this.domElement` to decide
  // whether the pointerup is "outside" (which prevents click registration).
  const domElement = eventSystem.domElement;
  // PixiJS's mapPositionToPoint() uses domElement.getBoundingClientRect() to
  // map clientX/Y to scene coordinates. OffscreenCanvas (in a worker) has no
  // getBoundingClientRect(), so PixiJS falls back to a rect with
  // width=domElement.width (backing-store px, e.g. 2801) instead of CSS px
  // (e.g. 1318). This makes the mapping: point = clientX * (1/resolution),
  // which scales coordinates to ~47% of their correct value on HiDPI displays.
  // To compensate, multiply the host's CSS-pixel coordinates by the renderer's
  // resolution before passing them to PixiJS. The (1/resolution) in
  // mapPositionToPoint then cancels out, yielding the correct CSS-pixel scene
  // coordinates.
  const resolution = (app.renderer as any).resolution ?? 1;
  const px = msg.x * resolution;
  const py = msg.y * resolution;
  const syntheticEvent = {
    // `type` is read by _bootstrapEvent: it checks event.type.startsWith("mouse")
    // and replaces "mouse" with "pointer". We pass "pointerdown" etc. directly
    // since supportsPointerEvents may be false (no globalThis.PointerEvent in
    // a worker), which would route through the MouseEvent normalization path.
    type: msg.type,
    pointerId: 1,
    pointerType: "mouse",
    clientX: px,
    clientY: py,
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
    // These are in backing-store px (CSS × resolution) to match the clientX/Y
    // above — see the resolution comment for why this is necessary.
    offsetX: px,
    offsetY: py,
    pageX: px,
    pageY: py,
    // _onPointerUp checks target === domElement to determine if the pointerup
    // is "inside" (enabling click). Without these, pointerup becomes
    // "pointerupoutside" and clicks never fire.
    target: domElement,
    composedPath: () => [domElement],
    cancelable: true,
    isPrimary: true,
    width: 1,
    height: 1,
    tiltX: 0,
    tiltY: 0,
    pressure: 0.5,
    twist: 0,
    tangentialPressure: 0,
  };

  // In pass-through mode, hit-test before dispatching. If the pointerdown
  // doesn't hit any interactive PixiJS element, report a miss so the host
  // can dispatch the event on the game canvas beneath the overlay. This is
  // needed for scenes that report a full-screen interactive region (e.g.
  // @pixi/react scenes) — the host can't distinguish UI hits from empty
  // space, so the worker does the hit-test and reports misses.
  //
  // Once a pointerdown misses, all subsequent pointermove/pointerup in that
  // drag gesture are also reported as misses — otherwise the game canvas
  // receives pointerdown (via pointerMissed) but never pointermove, so
  // click+drag (e.g. camera panning) doesn't work.
  if (config?.passThrough) {
    if (msg.type === "pointerdown") {
      const rootBoundary = eventSystem.rootBoundary;
      // rootTarget is normally populated inside _onPointer* handlers from
      // renderer.lastObjectRendered — but that creates a chicken-and-egg
      // deadlock here: a pointerdown before any event ran has no rootTarget,
      // so it misses, and every subsequent event stays a miss forever. Seed
      // it from the rendered stage so the first click can hit-test.
      if (rootBoundary && !rootBoundary.rootTarget) {
        rootBoundary.rootTarget = (((app.renderer as any)?.lastObjectRendered) ?? app?.stage) as any;
      }
      if (rootBoundary && typeof rootBoundary.hitTest === "function" && rootBoundary.rootTarget) {
        let hit: unknown = null;
        try {
          hit = rootBoundary.hitTest(msg.x, msg.y);
        } catch { /* hit-test can throw on edge cases — treat as miss */ }
        if (!hit) {
          dragMissed = true;
          postToMain({ kind: "pointerMissed", type: msg.type, x: msg.x, y: msg.y, button: msg.button, modifiers: msg.modifiers });
          return;
        }
      } else {
        // Scene not ready yet (rootTarget is null during initialization).
        // Report a miss so the host dispatches on the game canvas.
        dragMissed = true;
        postToMain({ kind: "pointerMissed", type: msg.type, x: msg.x, y: msg.y, button: msg.button, modifiers: msg.modifiers });
        return;
      }
    } else if (dragMissed) {
      // pointermove or pointerup during a drag that started as a miss.
      // Forward to the game canvas so drag gestures (panning) work.
      postToMain({ kind: "pointerMissed", type: msg.type as PointerMissedMessage["type"], x: msg.x, y: msg.y, button: msg.button, modifiers: msg.modifiers });
      if (msg.type === "pointerup") dragMissed = false;
      return;
    }
  }

  try {
    if (msg.type === "pointerdown") {
      // PixiJS v8 _onPointerDown sets rootBoundary.rootTarget = renderer.lastObjectRendered.
      // In a worker, lastObjectRendered may be null/stale — ensure it's the stage.
      const renderer = app.renderer as any;
      if (renderer?.lastObjectRendered !== app?.stage) {
        renderer.lastObjectRendered = app?.stage;
      }
      eventSystem._onPointerDown(syntheticEvent as any);
    }
    else if (msg.type === "pointermove") eventSystem._onPointerMove(syntheticEvent as any);
    else if (msg.type === "pointerup") eventSystem._onPointerUp(syntheticEvent as any);
    else if (msg.type === "pointerleave") eventSystem._onPointerOverOut(syntheticEvent as any);
  } catch (err) {
    // PixiJS event system can throw if the synthetic event shape is slightly off.
    // Log but don't crash the worker.
    postError(`Pointer dispatch error: ${(err as Error).message}`, (err as Error).stack);
  }
}

// ── Resize ──

function handleResize(width: number, height: number, resolution?: number): void {
  if (!app?.renderer) return;
  // When the host reports a devicePixelRatio change (window moved between
  // monitors), update the renderer's resolution before resizing so the
  // backing store is rebuilt at the new pixel density. renderer.resize's
  // optional third arg sets the resolution; omitting it reuses the current.
  if (resolution !== undefined && resolution !== (app.renderer as any).resolution) {
    app.renderer.resize(width, height, resolution);
  } else {
    app.renderer.resize(width, height);
  }
  scene?.resize?.(width, height);
  // Layout may have shifted — force a regions update on the next tick by
  // clearing the cache so postInteractiveRegionsIfChanged re-posts.
  lastRegionsKey = "";
  lastOpaqueKey = "";
}

// ── Font scale ──

function handleSetFontScale(scale: number): void {
  const clamped = Math.max(1, scale);
  if (clamped === fontScale) return;
  fontScale = clamped;
  // Update the scene context so scenes that read ctx.fontScale see the new
  // value. The scene's update() will be called on the next tick, which gives
  // React scenes (via their worker store) a chance to re-render with the
  // new scale. Imperative scenes that cache font sizes should re-create
  // their text objects in response to a fontScale change.
  if (sceneCtx) sceneCtx.fontScale = clamped;
  // Force a regions update since text sizes may have changed.
  lastRegionsKey = "";
  lastOpaqueKey = "";
}

// ── Stats sync (SAB polyfill fallback) ──

function handleStatsSync(msg: StatsSyncMessage): void {
  if (!uiStatsSab) return;
  // SAB polyfill: the worker's UiStatsSAB is a separate ArrayBuffer (not
  // shared with the main thread). Copy the received bytes into the local SAB
  // so readUiStats() returns current values on the next tick.
  new Uint8Array(uiStatsSab).set(new Uint8Array(msg.data));
}

// ── Scene state query (for MCP) ──

function handleQueryScene(requestId: number): void {
  try {
    const nodes = scene?.summarize?.() ?? summarizeScene(scene?.root ?? null);
    postToMain({
      kind: "sceneState",
      requestId,
      state: { nodes, interactive, backend: (app?.renderer as any)?.name ?? config?.backend ?? "unknown" },
    });
  } catch (err) {
    postError(`queryScene error: ${(err as Error).message}`, (err as Error).stack);
    // Still respond so the host doesn't time out
    postToMain({ kind: "sceneState", requestId, state: { nodes: [], interactive, backend: "error" } });
  }
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
  lastRegionsKey = "";
  lastOpaqueKey = "";
}

// ── Default scene (when no sceneModuleUrl configured) ──

function createDefaultScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = new Container();
  root.name = "default-root";

  const label = new Text({
    text: "PixiUI ready",
    style: { fill: 0x00ffaa, fontSize: Math.round(26 * ctx.fontScale), fontFamily: "monospace" },
  });
  label.name = "ready-label";
  label.x = 16;
  label.y = 16;
  root.addChild(label);

  const fpsLabel = new Text({
    text: "FPS: --",
    style: { fill: 0xffffff, fontSize: Math.round(18 * ctx.fontScale), fontFamily: "monospace" },
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
