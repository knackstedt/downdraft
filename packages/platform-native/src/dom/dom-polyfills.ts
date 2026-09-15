// ============================================================================
// dom-polyfills.ts — browser-global polyfills for native mode
//
// Installs the DOM surface the engine and PixiJS expect: document, window,
// ResizeObserver/IntersectionObserver, storage, Worker, and the PixiJS
// DOMAdapter globals (HTMLCanvasElement, DOMParser, FontFace, ...).
// Extracted from native-host.ts — no GPU/window logic lives here.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { createRequire as nodeCreateRequire } from "node:module";
import { VirtualCanvas } from "../gpu/virtual-canvas-context";
import { NativeCanvas2D } from "../image/native-image";
import type { NativeSurface } from "../window/native-surface";
import type { NativeWindow } from "../window/native-window";
import { MiniEventTarget } from "./mini-event-target";

const log = createLogger();

export function installDOMPolyfills(window: NativeWindow, surface: NativeSurface): void {
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
      // Document-level events (pointerlockchange, etc.) live on a shared
      // MiniEventTarget that NativeSurface can dispatch to directly.
      __events: new MiniEventTarget(),
      addEventListener: (type: string, listener: any) => {
        (doc as any).__events.addEventListener(type, listener);
        // Also forward to the window for events that the window handles (keydown, etc.)
        window.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: any) => {
        (doc as any).__events.removeEventListener(type, listener);
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
      // Live getters — reflect SDL window resizes.
      get innerWidth() { return surface.width; },
      get innerHeight() { return surface.height; },
      devicePixelRatio: 1,
      addEventListener: (type: string, listener: any) => window.addEventListener(type, listener),
      removeEventListener: (type: string, listener: any) => window.removeEventListener(type, listener),
      dispatchEvent: (event: any) => window.dispatchEvent(event),
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

  // globalThis.addEventListener — PixiJS EventSystem reads this directly.
  // Bun has it natively; Node does not.
  if (typeof (globalThis as any).addEventListener === "undefined") {
    (globalThis as any).addEventListener = (type: string, listener: any) => {
      window.addEventListener(type, listener);
    };
    (globalThis as any).removeEventListener = (type: string, listener: any) => {
      window.removeEventListener(type, listener);
    };
    (globalThis as any).dispatchEvent = (event: any) => {
      return window.dispatchEvent(event);
    };
  }

  // Worker polyfill — wraps Node's worker_threads.Worker to expose the browser
  // Worker API (new Worker(url, { type: "module" }), .onmessage, .postMessage).
  // Bun has Worker natively; Node does not have it as a global.
  if (typeof (globalThis as any).Worker === "undefined") {
    const nodeRequire = nodeCreateRequire(import.meta.url);
    const { Worker: NodeWorker } = nodeRequire("node:worker_threads");
    const wgslLoaderPath = new URL("../ffi/wgsl-loader.mjs", import.meta.url).href;
    const workerBootstrapPath = new URL("../ffi/worker-bootstrap.mjs", import.meta.url).href;
    // tsx registers the TS loader in the worker. If it isn't installed we
    // still register the WGSL loader + bootstrap so .mjs workers function.
    const workerExecArgv: string[] = [];
    try {
      workerExecArgv.push("--import", nodeRequire.resolve("tsx"));
    } catch {
      log.warn("platform-native", "tsx not resolvable — Node workers can't load .ts files");
    }
    workerExecArgv.push("--import", wgslLoaderPath, "--import", workerBootstrapPath);
    class BrowserWorker extends NodeWorker {
      constructor(specifier: string | URL, options?: any) {
        let filename: string;
        if (specifier instanceof URL) {
          filename = specifier.pathname;
        } else {
          // Handle new URL("./worker.ts", import.meta.url) pattern — the
          // caller passes the resolved URL string.
          try {
            filename = new URL(specifier).pathname;
          } catch {
            filename = specifier;
          }
        }
        super(filename, { ...options, execArgv: workerExecArgv });
      }
      set onmessage(handler: (ev: any) => void) {
        this.on("message", (data: any) => handler({ data }));
      }
      set onerror(handler: (ev: any) => void) {
        this.on("error", (err: any) => handler({ error: err, message: err?.message ?? String(err) }));
      }
      set onmessageerror(handler: (ev: any) => void) {
        this.on("messageerror", (data: any) => handler({ data }));
      }
      // Browser Worker API: addEventListener / removeEventListener
      addEventListener(type: string, listener: any) {
        if (type === "message") {
          this.on("message", (data: any) => listener({ data }));
        } else if (type === "error") {
          this.on("error", (err: any) => listener({ error: err, message: err?.message ?? String(err) }));
        } else if (type === "messageerror") {
          this.on("messageerror", (data: any) => listener({ data }));
        } else {
          this.on(type, listener);
        }
      }
      removeEventListener(type: string, listener: any) {
        this.off(type, listener);
      }
      // Browser Worker API: .postMessage with transfer list
      postMessage(message: any, transfer?: any[]) {
        super.postMessage(message, transfer);
      }
      // Browser Worker API: .terminate
      terminate() {
        super.terminate();
      }
    }
    (globalThis as any).Worker = BrowserWorker;
  }

  log.info("platform-native", "DOM polyfills installed (document, window, ResizeObserver, localStorage, etc.)");
}
