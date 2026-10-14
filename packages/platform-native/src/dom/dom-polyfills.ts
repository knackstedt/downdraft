// ============================================================================
// dom-polyfills.ts — browser-global polyfills for native mode
//
// Installs the browser-shaped globals the engine and canvas-shaped npm
// libraries actually use: window, storage, Worker, UI-event constructors,
// blob/fetch plumbing, and performance.memory. There is deliberately NO
// `document` — `RenderSurface` is the surface abstraction; a fake DOM tree
// only produced silent divergence (dead overlays, no-op element stubs).
// Extracted from native-host.ts — no GPU/window logic lives here.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire as nodeCreateRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeSurface } from "../window/native-surface";
import type { NativeWindow } from "../window/native-window";
import { installBlobUrls, resolveBlobUrl } from "./blob-urls";

const log = createLogger();

export interface DOMPolyfillOptions {
  /** When set, localStorage persists to this JSON file (atomic writes). */
  storagePath?: string;
}

export function installDOMPolyfills(window: NativeWindow, surface: NativeSurface, opts: DOMPolyfillOptions = {}): void {
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
    const defineEvent = (name: string, fields: string[], defaults?: Record<string, unknown>) => {
      const cls = class extends NativeEvent {
        constructor(type: string, init: any = {}) {
          super(type, init);
          fields.forEach((f) => { (this as any)[f] = init[f] ?? defaults?.[f] ?? (this as any)[f];; });
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
    // movementX/Y default to 0 on real DOM events — undefined would NaN any
    // `+= e.movementX` consumer (e.g. pointer-lock look controls).
    const XY_ZERO = { movementX: 0, movementY: 0 };
    defineEvent("MouseEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "relatedTarget", "ctrlKey", "shiftKey", "altKey", "metaKey",
      "movementX", "movementY",
    ], XY_ZERO);
    defineEvent("PointerEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "relatedTarget", "ctrlKey", "shiftKey", "altKey", "metaKey",
      "movementX", "movementY", "pointerId", "pointerType", "pressure",
      "width", "height", "isPrimary",
    ], XY_ZERO);
    defineEvent("WheelEvent", [
      "screenX", "screenY", "clientX", "clientY", "button", "buttons",
      "ctrlKey", "shiftKey", "altKey", "metaKey",
      "deltaX", "deltaY", "deltaZ", "deltaMode",
    ]);
    defineEvent("InputEvent", ["data", "inputType", "isComposing"]);
    defineEvent("FocusEvent", ["relatedTarget"]);
  }

  // performance.memory — Chrome-only API the profiling bridge reads for the
  // renderer heap metrics. Back it with process.memoryUsage(), which reports
  // the same JSC counters bun:jsc heapStats() does — but heapStats() walks the
  // whole heap (~200ms+ on a 1GB heap) PER CALL, and devtools/profiling poll
  // these getters ~2-3× per refresh, stalling the main thread. memoryUsage()
  // reads cached counters in <1ms. jsHeapSizeLimit has no cheap equivalent —
  // report RSS as the honest upper bound (worker-prelude maps it to rss).
  if ((globalThis as any).Bun && !(globalThis as any).performance.memory) {
    try {
      (globalThis as any).performance.memory = {
        get usedJSHeapSize() { return process.memoryUsage().heapUsed; },
        // Bun's heapTotal can lag heapUsed — keep the Chrome invariant
        // totalJSHeapSize >= usedJSHeapSize.
        get totalJSHeapSize() { const m = process.memoryUsage(); return Math.max(m.heapTotal, m.heapUsed); },
        get jsHeapSizeLimit() { return process.memoryUsage().rss; },
      };
    } catch { /* process.memoryUsage unavailable — leave memory unset */ }
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
    // Source-mode dev shells resolve @downdraft/* to .ts via the
    // "downdraft-source" export condition — workers get their own resolver
    // (execArgv does not inherit the parent's), so propagate explicitly or
    // they'd land on the dist/ tree while the renderer runs source.
    if (process.env.DD_ENGINE_SOURCE === "1") {
      workerExecArgv.push("--conditions=downdraft-source");
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
      // Event-argument adapters wrap listeners for "message"/"error"/
      // "messageerror" — the wrapper is what Node registers, so removal must
      // go through a lookup of the wrapped fn (previously removeEventListener
      // passed the raw listener to off() and silently removed nothing,
      // leaking a listener per wrap()/expose() call and firing dead closures
      // on every message for the worker's lifetime).
      private __wrappers: Map<any, Map<string, (...args: any[]) => void>> | null = null;
      private __onWrap: Record<string, ((...args: any[]) => void) | null> | null = null;
      private __wrap(type: string, listener: any): (...args: any[]) => void {
        if (type === "error") {
          return (err: any) => listener({ error: err, message: err?.message ?? String(err) });
        }
        if (type === "message" || type === "messageerror") {
          return (data: any) => listener({ data });
        }
        return listener;
      }
      private __setHandler(type: string, handler: any): void {
        // Field initializers run after super() — if a base-class constructor
        // ever assigns `onmessage`, this setter fires before __onWrap exists.
        const onWrap = (this.__onWrap ??= { message: null, error: null, messageerror: null });
        const prev = onWrap[type];
        if (prev) this.off(type, prev);
        // Browser semantics: assignment replaces (and null clears) — the old
        // implementation stacked a listener per assignment.
        onWrap[type] = handler ? this.__wrap(type, handler) : null;
        if (onWrap[type]) this.on(type, onWrap[type]!);
      }
      set onmessage(handler: ((ev: any) => void) | null) {
        this.__setHandler("message", handler);
      }
      set onerror(handler: ((ev: any) => void) | null) {
        this.__setHandler("error", handler);
      }
      set onmessageerror(handler: ((ev: any) => void) | null) {
        this.__setHandler("messageerror", handler);
      }
      // Browser Worker API: addEventListener / removeEventListener
      addEventListener(type: string, listener: any) {
        const wrappers = (this.__wrappers ??= new Map());
        let byType = wrappers.get(listener);
        if (!byType) {
          byType = new Map();
          wrappers.set(listener, byType);
        }
        // DOM semantics: adding the same (type, listener) pair twice is a
        // no-op — overwriting here would strand the first registration.
        if (byType.has(type)) return;
        const wrapped = this.__wrap(type, listener);
        byType.set(type, wrapped);
        this.on(type, wrapped);
      }
      removeEventListener(type: string, listener: any) {
        const byType = this.__wrappers?.get(listener);
        const wrapped = byType?.get(type);
        if (!byType || !wrapped) return;
        this.off(type, wrapped);
        byType.delete(type);
        if (byType.size === 0) this.__wrappers?.delete(listener);
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
  // Re-install on every call: the wrapper's module bindings die with the
  // Vite module runner on dev-session restarts, while the global (and the
  // old wrapper) persists. Pin the underlying fetch once so re-wrapping
  // never chains through a stale wrapper.
  const realFetch = ((globalThis as any).__ddRealFetch ??= globalThis.fetch)?.bind(globalThis);
  if (realFetch) {
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
      return realFetch(input, init);
    };
  }

  log.debug("platform-native", "DOM polyfills installed (window, storage, Worker, blob/fetch, UI events)");
}
