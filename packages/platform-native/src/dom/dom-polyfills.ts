// ============================================================================
// dom-polyfills.ts — browser-global polyfills for native mode
//
// Installs the DOM surface the engine and canvas-shaped npm libraries
// actually use: document, window, ResizeObserver, storage, Worker, UI-event
// constructors, and the canvas globals (HTMLCanvasElement,
// CanvasRenderingContext2D). Extracted from native-host.ts — no GPU/window
// logic lives here.
// ============================================================================

import { createLogger } from "@downdraft/engine";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire as nodeCreateRequire } from "node:module";
import { dirname } from "node:path";
import { VirtualCanvas } from "../compat/virtual-canvas-context";
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
    // This document is a *compat facade* for canvas-shaped and DOM-probing
    // consumers — NOT a DOM compositor. It deliberately has no surface
    // mapping, no overlay stubs, and no elementFromPoint: the live renderer
    // reaches the render surface via getSurface()/ctx.surface, and input is
    // dispatched on the surface directly. Code that still queries for
    // "canvas" / "#game-canvas" / overlay divs gets null — that's the signal
    // to migrate, not a thing to polyfill.
    //
    // Elements appended to document.body — lets `#id` / `tag#id` selectors
    // find game-created elements (e.g. a game's offscreen helper canvas).
    const bodyChildren = new Set<any>();
    const matchIdSelector = (sel: string): any => {
      const m = sel.match(/^(?:([a-zA-Z][\w-]*)?)#([\w-]+)$/);
      if (!m) return undefined;
      const [, tag, id] = m;
      for (const el of bodyChildren.values()) {
        if (el?.id === id && (!tag || el.tagName?.toLowerCase() === tag.toLowerCase())) return el;
      }
      return undefined;
    };

    const doc = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          // Libraries call document.createElement("canvas") to get a canvas
          // whose getContext("webgpu") returns a GPUCanvasContext. Return a
          // VirtualCanvas: its webgpu context is backed by a dedicated
          // GPUTexture (not the swapchain) so a second renderer can draw into
          // a texture the game composites; its 2d context is FreeType-backed
          // for text rasterization.
          return new VirtualCanvas(surface.width, surface.height);
        }
        return createStubElement(tag);
      },
      getElementById: (id: string) => {
        const found = matchIdSelector(`#${id}`);
        return found === undefined ? null : found;
      },
      querySelector: (selector: string) => {
        const byId = matchIdSelector(selector);
        if (byId !== undefined) return byId;
        return null;
      },
      querySelectorAll: (selector: string) => {
        const byId = matchIdSelector(selector);
        if (byId !== undefined && byId !== null) return [byId];
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
      body: {
        appendChild: (n: any) => { bodyChildren.add(n); return n; },
        removeChild: (n: any) => { bodyChildren.delete(n); return n; },
        contains: (n: any) => bodyChildren.has(n),
        get children() { return [...bodyChildren]; },
      },
      pointerLockElement: null as any,
      exitPointerLock: () => surface.exitPointerLock(),
    };
    (globalThis as any).document = doc;

    // ── Browser global constructors ──
    // Libraries feature-probe these globals (instanceof / typeof checks).
    if (typeof (globalThis as any).HTMLCanvasElement === "undefined") {
      // VirtualCanvas should satisfy `instanceof HTMLCanvasElement`.
      // Extend MiniEventTarget so the prototype chain
      // (VirtualCanvas → HTMLCanvasElement → MiniEventTarget) preserves
      // addEventListener/removeEventListener/dispatchEvent.
      class HTMLCanvasElement extends MiniEventTarget {}
      (globalThis as any).HTMLCanvasElement = HTMLCanvasElement;
      try {
        Object.setPrototypeOf(VirtualCanvas.prototype, HTMLCanvasElement.prototype);
      } catch { /* ignore */ }
    }
    if (typeof (globalThis as any).CanvasRenderingContext2D === "undefined") {
      (globalThis as any).CanvasRenderingContext2D = NativeCanvas2D;
    }
  }

  // window polyfill
  const reload = () => {
    // Browser callers use reload() as the everything-is-broken escape
    // hatch (device loss, HMR). On native it routes through the host's
    // restart hook — a detached self-respawn — which is the real reload
    // equivalent. Without the hook (unhosted run) it stays a no-op.
    const req = (globalThis as any).__ddRequestRestart;
    if (typeof req === "function" && req("window.location.reload()")) return;
    log.warn("native", "window.location.reload() called — no restart hook installed");
  };
  if (typeof (globalThis as any).window === "undefined") {
    const win = {
      // Live getters — reflect SDL window resizes.
      get innerWidth() { return surface.width; },
      get innerHeight() { return surface.height; },
      // Live getter — reflects the window's monitor scale factor (HiDPI).
      get devicePixelRatio() { return window.getDisplayInfo().scaleFactor; },
      addEventListener: (type: string, listener: any) => window.addEventListener(type, listener),
      removeEventListener: (type: string, listener: any) => window.removeEventListener(type, listener),
      dispatchEvent: (event: any) => window.dispatchEvent(event),
      requestAnimationFrame: (callback: (time: number) => void) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (id: number) => window.cancelAnimationFrame(id),
      location: { reload },
    };
    (globalThis as any).window = win;
  } else {
    // Augment existing window (Deno defines one — Bun/Node do not)
    (globalThis as any).window.addEventListener = (type: string, listener: any) => window.addEventListener(type, listener);
    (globalThis as any).window.requestAnimationFrame = (callback: (time: number) => void) => window.requestAnimationFrame(callback);
    (globalThis as any).window.location = { reload };
  }

  // DOM event constructors — Bun ships Event/CustomEvent but not the UI
  // event subclasses. The native event targets dispatch plain objects, so
  // these only need to carry the init-dict fields. Subclassing Event gives
  // real preventDefault/stopPropagation/defaultPrevented semantics.
  if (typeof (globalThis as any).KeyboardEvent === "undefined") {
    const NativeEvent = (globalThis as any).Event ?? class {
      type: string; bubbles: boolean; cancelable: boolean; defaultPrevented = false;
      constructor(type: string, init: any = {}) {
        this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
      stopPropagation() {}
      stopImmediatePropagation() {}
    };
    const defineEvent = (name: string, fields: string[]) => {
      const cls = class extends NativeEvent {
        constructor(type: string, init: any = {}) {
          super(type, init);
          fields.forEach((f) => { (this as any)[f] = init[f] ?? (this as any)[f];; });
        }
      };
      Object.defineProperty(cls, "name", { value: name });
      (globalThis as any)[name] = cls;
    };
    defineEvent("KeyboardEvent", [
      "key", "code", "location", "repeat", "isComposing",
      "ctrlKey", "shiftKey", "altKey", "metaKey",
      "charCode", "keyCode", "which",
    ]);
    defineEvent("MouseEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "relatedTarget", "ctrlKey", "shiftKey", "altKey", "metaKey",
      "movementX", "movementY",
    ]);
    defineEvent("PointerEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "relatedTarget", "ctrlKey", "shiftKey", "altKey", "metaKey",
      "movementX", "movementY", "pointerId", "pointerType", "pressure",
      "width", "height", "isPrimary",
    ]);
    defineEvent("WheelEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "ctrlKey", "shiftKey", "altKey", "metaKey",
      "deltaX", "deltaY", "deltaZ", "deltaMode",
    ]);
    defineEvent("InputEvent", ["data", "inputType", "isComposing"]);
    defineEvent("FocusEvent", ["relatedTarget"]);
  }

  // FileReader — async Blob reader with onload/onerror/onloadend callbacks.
  if (typeof (globalThis as any).FileReader === "undefined") {
    (globalThis as any).FileReader = class FileReader {
      result: string | ArrayBuffer | null = null;
      error: Error | null = null;
      readyState = 0; // EMPTY
      onload: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      onloadend: ((ev: any) => void) | null = null;
      private listeners = new Map<string, Set<(ev: any) => void>>();
      addEventListener(type: string, fn: (ev: any) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(fn);
      }
      removeEventListener(type: string, fn: (ev: any) => void) {
        this.listeners.get(type)?.delete(fn);
      }
      private emit(type: string) {
        const ev = { type, target: this };
        (this.listeners.get(type) ?? []).forEach((fn) => { fn(ev);; });
      }
      private read(p: Promise<string | ArrayBuffer>) {
        this.readyState = 1; // LOADING
        p.then((r) => {
          this.result = r;
          this.readyState = 2; // DONE
          this.onload?.({ target: this }); this.emit("load");
          this.onloadend?.({ target: this }); this.emit("loadend");
        }).catch((e) => {
          this.error = e;
          this.readyState = 2;
          this.onerror?.({ target: this }); this.emit("error");
          this.onloadend?.({ target: this }); this.emit("loadend");
        });
      }
      readAsText(blob: Blob) { this.read(blob.text()); }
      readAsArrayBuffer(blob: Blob) { this.read(blob.arrayBuffer()); }
      readAsDataURL(blob: Blob) {
        this.read(blob.arrayBuffer().then((buf) =>
          `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`));
      }
      abort() { /* no-op — reads are already async/atomic */ }
    };
  }

  // No document.elementFromPoint — native input dispatch targets the
  // RenderSurface directly; there is no DOM tree to hit-test.

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

  // performance.memory — Chrome-only API the profiling bridge reads for the
  // renderer heap metrics. Back it with bun:jsc heapStats so the ProfilingSAB
  // renderer slot reports real numbers on the native host. jsHeapSizeLimit
  // has no JSC equivalent — report the current heap capacity as the ceiling.
  if ((globalThis as any).Bun && !(globalThis as any).performance.memory) {
    try {
      const hs = nodeCreateRequire(import.meta.url)("bun:jsc").heapStats as
        () => { heapSize: number; heapCapacity: number };
      (globalThis as any).performance.memory = {
        get usedJSHeapSize() { return hs().heapSize; },
        get totalJSHeapSize() { return hs().heapCapacity; },
        get jsHeapSizeLimit() { return hs().heapCapacity; },
      };
    } catch { /* bun:jsc unavailable — leave memory unset */ }
  }

  // localStorage polyfill — in-memory by default; file-backed (atomic JSON
  // writes) when opts.storagePath is provided, so prefs like the UI font-scale
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

  // globalThis.addEventListener — libraries with their own event systems
  // attach listeners here directly. Bun has it natively; Node does not.
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
