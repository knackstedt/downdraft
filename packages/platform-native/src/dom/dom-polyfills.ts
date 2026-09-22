// ============================================================================
// dom-polyfills.ts — browser-global polyfills for native mode
//
// Installs the DOM surface the engine and PixiJS expect: document, window,
// ResizeObserver/IntersectionObserver, storage, Worker, and the PixiJS
// DOMAdapter globals (HTMLCanvasElement, DOMParser, FontFace, ...).
// Extracted from native-host.ts — no GPU/window logic lives here.
// ============================================================================

import { createLogger } from "@downdraft/engine";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire as nodeCreateRequire } from "node:module";
import { dirname } from "node:path";
import { VirtualCanvas } from "../gpu/virtual-canvas-context";
import { NativeCanvas2D } from "../image/native-image";
import type { NativeSurface } from "../window/native-surface";
import type { NativeWindow } from "../window/native-window";
import { installBlobUrls, resolveBlobUrl } from "./blob-urls";
import { MiniEventTarget } from "./mini-event-target";

const log = createLogger();

export interface DOMPolyfillOptions {
  /** When set, localStorage persists to this JSON file (atomic writes). */
  storagePath?: string;
}

/** Minimal HTMLElement stub — enough shape for element APIs that
 *  startGame()/devtools touch without a real DOM (classList, dataset,
 *  event listeners, child management). */
function createStubElement(tag: string): any {
  const children: any[] = [];
  const classes = new Set<string>();
  const el: any = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    children,
    childNodes: children,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
    },
    setAttribute: (k: string, v: string) => { if (k === "id") el.id = v; },
    getAttribute: () => null,
    appendChild: (n: any) => { children.push(n); return n; },
    removeChild: (n: any) => { const i = children.indexOf(n); if (i >= 0) children.splice(i, 1); return n; },
    replaceChildren: (...nodes: any[]) => { children.length = 0; children.push(...nodes); },
    insertBefore: (n: any) => { children.push(n); return n; },
    remove: () => {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
    click: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }),
    clientWidth: 0,
    clientHeight: 0,
    innerHTML: "",
    textContent: "",
    id: "",
  };
  return el;
}

export function installDOMPolyfills(window: NativeWindow, surface: NativeSurface, opts: DOMPolyfillOptions = {}): void {
  // document polyfill
  if (typeof (globalThis as any).document === "undefined") {
    // Persistent overlay stubs — getOverlay(n) maps div[data-dd-overlay="n"]
    // (and legacy #root for n=0). There's no real DOM compositor; the stubs
    // let mountUI callers get an element instead of throwing. Games should
    // use the imui `ui:` path on native — DOM UI won't display.
    const overlays = new Map<number, any>();

    const getOverlayElement = (index: number): any => {
      let el = overlays.get(index);
      if (!el) {
        el = createStubElement("div");
        el.id = index === 0 ? "root" : `dd-overlay-${index}`;
        el.dataset.ddOverlay = String(index);
        overlays.set(index, el);
      }
      return el;
    };

    const matchCanvasSelector = (sel: string): boolean =>
      sel === "canvas" ||
      sel === "#game-canvas" ||
      /^canvas\[data-dd-layer="0"\]$/.test(sel) ||
      sel === "canvas[data-dd-layer]";

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
        return createStubElement(tag);
      },
      getElementById: (id: string) => {
        if (id === "game-canvas" || id === "canvas") return surface;
        if (id === "root") return getOverlayElement(0);
        for (const [i, el] of overlays) if (el.id === id) { void i; return el; }
        return null;
      },
      querySelector: (selector: string) => {
        if (matchCanvasSelector(selector)) return surface;
        const overlayMatch = selector.match(/^div\[data-dd-overlay="(\d+)"\]$/);
        if (overlayMatch) return getOverlayElement(Number(overlayMatch[1]));
        if (selector === "#root" || selector === "div#root") return getOverlayElement(0);
        return null;
      },
      querySelectorAll: (selector: string) => {
        // Layer/canvases
        if (selector === "canvas" || selector === "canvas[data-dd-layer]" ||
            /^canvas\[data-dd-layer="0"\]$/.test(selector)) {
          return [surface];
        }
        if (selector === "div[data-dd-overlay]") {
          return [getOverlayElement(0)];
        }
        // Stylesheets and everything else: no real DOM → empty.
        return [];
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
      body: { appendChild: () => {}, removeChild: (n: any) => n, contains: () => true },
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
      // createRoot checks this). Extend MiniEventTarget so the prototype chain
      // (VirtualCanvas → HTMLCanvasElement → MiniEventTarget) preserves
      // addEventListener/removeEventListener/dispatchEvent.
      class HTMLCanvasElement extends MiniEventTarget {}
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

  // localStorage polyfill — in-memory by default; file-backed (atomic JSON
  // writes) when opts.storagePath is provided, so prefs like imui font-scale
  // survive restarts on the native host.
  if (typeof (globalThis as any).localStorage === "undefined") {
    const store: Record<string, string> = {};
    let dirty = false;
    if (opts.storagePath) {
      try {
        const raw = readFileSync(opts.storagePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") Object.assign(store, parsed);
      } catch { /* missing/corrupt file — start empty */ }
    }
    const flush = () => {
      if (!opts.storagePath || !dirty) return;
      dirty = false;
      try {
        mkdirSync(dirname(opts.storagePath), { recursive: true });
        const tmp = `${opts.storagePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(store));
        renameSync(tmp, opts.storagePath);
      } catch (e) {
        log.warn("platform-native", `localStorage persist failed: ${(e as Error).message}`);
      }
    };
    if (opts.storagePath) process.on("exit", flush);
    (globalThis as any).localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = String(value); dirty = true; flush(); },
      removeItem: (key: string) => { if (key in store) { delete store[key]; dirty = true; flush(); } },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; dirty = true; flush(); },
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

  // URL.createObjectURL / revokeObjectURL — blob registry for the thumbnail
  // pipeline (img.src = blob:...) and any engine code round-tripping blobs.
  installBlobUrls();

  // fetch() file:// + blob: support — `?url` asset imports resolve to file://
  // URLs under Bun, whose fetch rejects them. Wrap fetch so those reads fall
  // back to the filesystem/blob registry. Also accepts bare absolute paths.
  const origFetch = globalThis.fetch?.bind(globalThis);
  if (origFetch && !(globalThis as any).__ddFileFetchPatched) {
    (globalThis as any).__ddFileFetchPatched = true;
    (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
      const urlStr = typeof input === "string" ? input : input?.url ?? "";
      if (urlStr.startsWith("blob:")) {
        const blob = resolveBlobUrl(urlStr);
        if (!blob) return new Response("Unknown blob URL", { status: 404 });
        return new Response(blob);
      }
      const isFileUrl = urlStr.startsWith("file://");
      const isBarePath = !isFileUrl && urlStr.startsWith("/") && !urlStr.startsWith("//");
      if (isFileUrl || isBarePath) {
        try {
          const { readFileSync } = await import("node:fs");
          const { fileURLToPath } = await import("node:url");
          // Vite's dev server serves out-of-root files as /@fs/<abs-path>;
          // strip the prefix so the same URL works against the filesystem.
          const path = isFileUrl ? fileURLToPath(urlStr)
            : urlStr.startsWith("/@fs/") ? decodeURIComponent(urlStr.slice(4))
            : decodeURIComponent(urlStr);
          const buf = readFileSync(path);
          return new Response(buf, { status: 200 });
        } catch (err) {
          return new Response(String(err), { status: 404, statusText: "Not Found" });
        }
      }
      return origFetch(input, init);
    };
  }

  log.info("platform-native", "DOM polyfills installed (document, window, ResizeObserver, localStorage, etc.)");
}
