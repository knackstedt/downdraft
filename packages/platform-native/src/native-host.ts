// ============================================================================
// native-host.ts — Bun-native host layer
//
// Ties together:
//   - GPU binding (wgpu-native via bun:ffi)
//   - Native window (SDL2)
//   - Image polyfills (stb_image)
//   - Asset glob (filesystem-based)
//   - requestAnimationFrame (vsync-driven)
//   - Screenshot capture
//
// This is the entry point for native game execution under Bun.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { installAssetGlob } from "./assets/native-assets";
import { installGPU } from "./gpu/install";
import { VirtualCanvas } from "./gpu/virtual-canvas-context";
import { NativeCanvas2D, installImagePolyfills } from "./image/native-image";
import { captureScreenshot } from "./screenshot/screenshot";
import { NativeSurface } from "./window/native-surface";
import { NativeWindow, type NativeWindowConfig } from "./window/native-window";

const log = createLogger();

export interface NativeHostConfig {
  window: NativeWindowConfig;
  screenshotPath?: string;
  screenshotAfterFrames?: number;
}

export interface NativeHostContext {
  window: NativeWindow;
  surface: NativeSurface;
  gpu: any;
  adapter: any;
  device: any;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  captureScreenshot: (path: string) => void;
  destroy: () => void;
}

export async function createNativeHost(config: NativeHostConfig): Promise<NativeHostContext> {
  // 1. Install polyfills
  const gpu = installGPU();
  installImagePolyfills();
  installAssetGlob();

  // 2. Create native window
  const window = new NativeWindow(config.window);
  const surface = window.getSurface();
  (globalThis as any).__nativeWindow = window;

  // 3. Get adapter + device
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found");

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: 256 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 16,
      maxSampledTexturesPerShaderStage: 32,
      maxTextureArrayLayers: 256,
    },
  });

  // 4. Configure the surface context
  const ctx = surface.getContext("webgpu")!;
  const format = gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, usage: 0x0010 | 0x0002 | 0x0001 }); // RENDER_ATTACHMENT | COPY_DST | COPY_SRC

  // 5. Install requestAnimationFrame on globalThis
  const rafSource = {
    request: (callback: (time: number) => void) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
  };
  (globalThis as any).requestAnimationFrame = rafSource.request.bind(window);
  (globalThis as any).cancelAnimationFrame = rafSource.cancel.bind(window);

  // 6. Install other DOM polyfills
  installDOMPolyfills(window, surface);

  // 6b. Forward mouse/click/wheel events from the window to the surface (canvas).
  // The renderer's input handler listens on `canvas` for these events, but
  // SDL events are dispatched to the NativeWindow. We bridge them here.
  // Also synthesize `click` events from mousedown+mouseup pairs.
  let lastMouseDown: { x: number; y: number; button: number; time: number } | null = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  const forwardToSurface = (type: string, event: any) => {
    surface.dispatchEvent({ ...event, type });
  };
  window.addEventListener("mousemove", (e: any) => {
    // SDL already provides relative motion (xrel/yrel) via movementX/movementY
    // when relative mouse mode is enabled. Prefer those over recomputing from
    // absolute positions, which gives wrong deltas under pointer lock.
    const movementX = (typeof e.movementX === "number") ? e.movementX : e.clientX - lastMouseX;
    const movementY = (typeof e.movementY === "number") ? e.movementY : e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    forwardToSurface("mousemove", { ...e, movementX, movementY });
  });
  window.addEventListener("mousedown", (e: any) => {
    lastMouseDown = { x: e.clientX, y: e.clientY, button: e.button, time: performance.now() };
    forwardToSurface("mousedown", e);
  });
  window.addEventListener("mouseup", (e: any) => {
    forwardToSurface("mouseup", e);
    // Synthesize a click event if mouseup is close to the last mousedown
    if (lastMouseDown && lastMouseDown.button === e.button &&
        Math.abs(e.clientX - lastMouseDown.x) < 5 &&
        Math.abs(e.clientY - lastMouseDown.y) < 5 &&
        performance.now() - lastMouseDown.time < 500) {
      forwardToSurface("click", { ...e, type: "click" });
    }
    lastMouseDown = null;
  });
  window.addEventListener("wheel", (e: any) => {
    forwardToSurface("wheel", e);
  });
  window.addEventListener("contextmenu", (e: any) => {
    forwardToSurface("contextmenu", e);
  });

  // 7. Start the event loop
  window.start();

  // 8. Create the screenshot capture function
  // The caller must pass the texture from getCurrentTexture() — we don't
  // re-acquire it because wgpu only allows one outstanding surface texture.
  const screenshotFn = (path: string, texture?: any) => {
    if (texture) {
      captureScreenshot(device, texture, config.window.width, config.window.height, path);
    }
  };

  return {
    window,
    surface,
    gpu,
    adapter,
    device,
    requestAnimationFrame: rafSource.request.bind(window),
    cancelAnimationFrame: rafSource.cancel.bind(window),
    captureScreenshot: screenshotFn,
    destroy: () => {
      window.destroy();
    },
  };
}

// ── DOM polyfills ──
function installDOMPolyfills(window: NativeWindow, surface: NativeSurface): void {
  // document polyfill
  if (typeof (globalThis as any).document === "undefined") {
    const doc = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          // PixiJS (and DOMAdapter.createCanvas) call document.createElement
          // ("canvas") to get a canvas whose getContext("webgpu") returns a
          // GPUCanvasContext. Return a VirtualCanvas: its webgpu context is
          // backed by a dedicated GPUTexture (not the swapchain) so PixiJS can
          // render the UI into a texture the game composites; its 2d context
          // is FreeType-backed for text rasterization.
          return new VirtualCanvas(surface.width, surface.height);
        }
        return {
          style: {},
          setAttribute: () => {},
          getAttribute: () => null,
          appendChild: (n: any) => n,
          removeChild: (n: any) => n,
          remove: () => {},
          contains: () => false,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
          focus: () => {},
          blur: () => {},
          click: () => {},
        };
      },
      getElementById: (id: string) => {
        if (id === "game-canvas" || id === "canvas") return surface;
        return null;
      },
      querySelector: (selector: string) => {
        if (selector === "canvas") return surface;
        return null;
      },
      addEventListener: (type: string, listener: any) => {
        // Document-level events (pointerlockchange, etc.) are stored separately
        if (!(doc as any).__listeners) (doc as any).__listeners = new Map();
        if (!(doc as any).__listeners.has(type)) (doc as any).__listeners.set(type, new Set());
        (doc as any).__listeners.get(type).add(listener);
        // Also forward to the window for events that the window handles (keydown, etc.)
        window.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: any) => {
        (doc as any).__listeners?.get(type)?.delete(listener);
        window.removeEventListener(type, listener);
      },
      body: { appendChild: () => {}, contains: () => true },
      documentElement: { style: {} },
      hidden: false,
      pointerLockElement: null as any,
      exitPointerLock: () => surface.exitPointerLock(),
      // PixiJS DOMAdapter.getBaseUrl() reads document.baseURI ?? window.location.href.
      baseURI: `file://${process.cwd()}/`,
      // PixiJS DOMAdapter.getFontFaceSet() reads document.fonts (FontFaceSet).
      fonts: {
        ready: Promise.resolve(),
        onloadingdone: null,
        load: () => Promise.resolve(),
        check: () => true,
        add: () => {},
        delete: () => {},
        clear: () => {},
        forEach: () => {},
      },
    };
    (globalThis as any).document = doc;

    // ── DOMAdapter / PixiJS surface globals ──
    // PixiJS's BrowserAdapter reads these via DOMAdapter.get().getXxx().
    if (typeof (globalThis as any).HTMLCanvasElement === "undefined") {
      // VirtualCanvas should satisfy `instanceof HTMLCanvasElement` (@pixi/react
      // createRoot checks this). Define the class and chain VirtualCanvas's
      // prototype so the instanceof check succeeds.
      class HTMLCanvasElement {}
      (globalThis as any).HTMLCanvasElement = HTMLCanvasElement;
      try {
        Object.setPrototypeOf(VirtualCanvas.prototype, HTMLCanvasElement.prototype);
      } catch { /* ignore */ }
    }
    if (typeof (globalThis as any).HTMLImageElement === "undefined") {
      (globalThis as any).HTMLImageElement = class HTMLImageElement {};
    }
    if (typeof (globalThis as any).CanvasRenderingContext2D === "undefined") {
      (globalThis as any).CanvasRenderingContext2D = NativeCanvas2D;
    }
    if (typeof (globalThis as any).WebGLRenderingContext === "undefined") {
      // PixiJS DOMAdapter.getWebGLRenderingContext() returns this; the WebGPU
      // path won't use it, but it must be defined.
      (globalThis as any).WebGLRenderingContext = class WebGLRenderingContext {};
    }
    if (typeof (globalThis as any).DOMParser === "undefined") {
      // Minimal stub — PixiJS uses it for SVG parsing. Returns an object with
      // querySelector/getElementsByTagName returning empty results.
      (globalThis as any).DOMParser = class DOMParser {
        parseFromString() {
          return {
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementsByTagName: () => [],
            documentElement: { getAttribute: () => null },
          };
        }
      };
    }
    if (typeof (globalThis as any).FontFace === "undefined") {
      (globalThis as any).FontFace = class FontFace {
        constructor(_family: string, _source: string) {}
        load() { return Promise.resolve(this); }
      };
    }
  }

  // window polyfill
  if (typeof (globalThis as any).window === "undefined") {
    const win = {
      innerWidth: surface.width,
      innerHeight: surface.height,
      devicePixelRatio: 1,
      addEventListener: (type: string, listener: any) => window.addEventListener(type, listener),
      removeEventListener: (type: string, listener: any) => window.removeEventListener(type, listener),
      dispatchEvent: (event: any) => true,
      requestAnimationFrame: (callback: (time: number) => void) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
      location: { reload: () => { console.warn("[native] window.location.reload() called — no-op in native mode"); } },
    };
    (globalThis as any).window = win;
  } else {
    // Augment existing window
    (globalThis as any).window.addEventListener = (type: string, listener: any) => window.addEventListener(type, listener);
    (globalThis as any).window.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
    (globalThis as any).window.location = { reload: () => {} };
  }

  // ResizeObserver polyfill — calls the callback once on observe()
  if (typeof (globalThis as any).ResizeObserver === "undefined") {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      private callback: (entries: any[]) => void;
      constructor(callback: (entries: any[]) => void) {
        this.callback = callback;
      }
      observe(_target: any) {
        // Fire once immediately with the current size
        setTimeout(() => {
          this.callback([{
            contentRect: { width: surface.width, height: surface.height, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 },
            target: _target,
          }]);
        }, 0);
      }
      unobserve() {}
      disconnect() {}
    };
  }

  // IntersectionObserver polyfill (some engine code may use it)
  if (typeof (globalThis as any).IntersectionObserver === "undefined") {
    (globalThis as any).IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // performance.now() — Bun has this but ensure it exists
  if (typeof (globalThis as any).performance === "undefined") {
    const start = Date.now();
    (globalThis as any).performance = { now: () => Date.now() - start };
  }

  // localStorage polyfill (engine save system may use it)
  if (typeof (globalThis as any).localStorage === "undefined") {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    };
  }

  // sessionStorage polyfill
  if (typeof (globalThis as any).sessionStorage === "undefined") {
    const store: Record<string, string> = {};
    (globalThis as any).sessionStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    };
  }

  // indexedDB polyfill — the renderer disables it by default, but provide a stub
  if (typeof (globalThis as any).indexedDB === "undefined") {
    (globalThis as any).indexedDB = {
      open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null, result: {} }),
    };
  }

  log.info("platform-native", "DOM polyfills installed (document, window, ResizeObserver, localStorage, etc.)");
}
