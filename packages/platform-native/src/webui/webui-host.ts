// ============================================================================
// webui-host.ts — HostWebUIAPI implementation over the dd_webui_* cdylibs
//
// One host per backend (CEF desktop / WPE linux+android). Views are
// dedicated full-size browser pages — the renderer side pulls dirty BGRA
// frames into GPU textures (screen-space panels composite via PanelBlitPass,
// world-space via WorldSpaceUIPass) and routes input back through the same
// OSR-shaped contract.
//
// Absent backend → createWebUiHost returns { available:false } and the
// bridge leaves `downdraft.webui` undefined — games gate on presence, so a
// missing cdylib never crashes the host.
// ============================================================================

import type { WebUiGlobalInitOpts } from "@downdraft/engine/libraries/webui";
import {
    loadWebUiLib,
    resolveWebUiBackend,
    webUiGlobalInit,
    WebUIView,
} from "@downdraft/engine/libraries/webui";
import type {
    WebUiBackend,
    WebUiHostBridge,
    WebUiInputEvent,
    WebUiViewConfig,
    WebUiViewStatus,
} from "@downdraft/engine/libraries/webui/types";
import { findPackageRoot } from "@downdraft/engine/platform/pkg-root";
import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("info");

const _dirname =
  typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : dirname(fileURLToPath(import.meta.url));

export interface WebUiHost {
  api: WebUiHostBridge;
  /** False when the backend cdylib is missing or global_init failed — the
   *  bridge then leaves downdraft.webui unset. */
  available: boolean;
  backend: WebUiBackend;
  dispose(): void;
}

// ── Runtime-dir resolution ──
// CEF needs its whole runtime tree (libcef.so + .pak/.dat/icudtl + helper);
// WPE needs its SDK prefix (libWPEWebKit + GIO modules + aux processes).
// Resolution mirrors lib-paths ordering: env override → packaged layout →
// dev vendored tree.
function platKey(): string {
  return `${process.platform}-${process.arch}`;
}

function findBackendRuntimeDir(backend: WebUiBackend, libPath: string): string | undefined {
  const envVar = backend === "cef" ? "DD_WEBUI_CEF_DIR" : "DD_WEBUI_WPE_PREFIX";
  const env = process.env[envVar];
  if (env && existsSync(env)) return env;
  const dirName = backend === "cef" ? `cef-${platKey()}` : `wpe-${platKey()}`;
  const candidates = [
    // Packaged layout: <exe>/native/cef (desktop packager stages the tree).
    join(dirname(process.execPath), "native", backend),
    // Dev layout: packages/engine/libraries/webui/vendor/<backend>-<plat>/
    join(findPackageRoot(_dirname), "libraries", "webui", "vendor", dirName),
    // Sibling of the resolved cdylib (dist/<plat>-<arch>/<backend>/).
    join(dirname(libPath), backend),
  ];
  return candidates.find((c) => existsSync(c));
}

// ── Per-backend host cache (forBackend reuses hosts) ──
const hosts = new Map<WebUiBackend, WebUiHost | null>();

/** Resolve + create the host for a backend. `explicit` overrides env —
 *  null backend → host creation is skipped (DD_WEBUI_BACKEND=none). */
export function createWebUiHost(opts: {
  backend?: WebUiBackend | "auto" | "none" | null;
  init?: WebUiGlobalInitOpts;
} = {}): WebUiHost | null {
  const backend = resolveWebUiBackend(opts.backend);
  if (!backend) return null;
  if (hosts.has(backend)) return hosts.get(backend)!;
  const host = buildHost(backend, opts.init);
  hosts.set(backend, host);
  return host;
}

function buildHost(backend: WebUiBackend, initOpts: WebUiGlobalInitOpts = {}): WebUiHost | null {
  const entry = loadWebUiLib(backend);
  if (!entry) {
    log.warn("webui", `libdowndraft_webui_${backend} not found — webui tier disabled (run "bun run build:native")`);
    return null;
  }

  const runtimeDir = findBackendRuntimeDir(backend, entry.path);
  const init: WebUiGlobalInitOpts = {
    headless: true,
    ...initOpts,
  };
  if (backend === "cef") {
    init.cefDir = init.cefDir ?? runtimeDir;
    // The helper binary stages next to the cdylib (build-native `bins`).
    init.helperPath = init.helperPath ?? join(dirname(entry.path), "downdraft_cef_helper");
  } else {
    init.wpePrefix = init.wpePrefix ?? runtimeDir;
  }

  if (!webUiGlobalInit(backend, init)) {
    log.warn("webui", `${backend} global_init failed — webui tier disabled`);
    return null;
  }

  // ── View registry + event plumbing ──
  const views = new Map<string, WebUIView>();
  const cbs = {
    message: new Map<string, Set<(payload: unknown) => void>>(),
    console: new Map<string, Set<(level: number, text: string) => void>>(),
    cursor: new Map<string, Set<(cursor: string) => void>>(),
    status: new Map<string, Set<(status: WebUiViewStatus) => void>>(),
  };
  let evalReq = 0;
  const evalPending = new Map<number, { viewId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const subs = <T>(map: Map<string, Set<T>>, id: string, cb: T): (() => void) => {
    let set = map.get(id);
    if (!set) { set = new Set(); map.set(id, set); }
    set.add(cb);
    return () => set!.delete(cb);
  };

  const drain = (id: string, view: WebUIView) => {
    for (const ev of view.pollEvents()) {
      try {
        switch (ev.t) {
          case "eval": {
            const p = evalPending.get(ev.id);
            if (p) {
              evalPending.delete(ev.id);
              if (ev.ok) {
                try { p.resolve(JSON.parse(ev.v)); }
                catch { p.resolve(ev.v); }
              } else {
                p.reject(new Error(ev.v));
              }
            }
            break;
          }
          case "message":
            cbs.message.get(id)?.forEach((cb) => cb(ev.v));
            break;
          case "console":
            cbs.console.get(id)?.forEach((cb) => cb(ev.lvl, ev.v));
            break;
          case "cursor":
            cbs.cursor.get(id)?.forEach((cb) => cb(ev.v));
            break;
          case "status":
            cbs.status.get(id)?.forEach((cb) => cb(ev.v));
            break;
          case "nav":
            // Forwarded as a message — nav watchers subscribe via onMessage.
            cbs.message.get(id)?.forEach((cb) => cb({ __nav: { url: ev.url, canBack: ev.canBack, canFwd: ev.canFwd } }));
            break;
        }
      } catch (e) {
        log.warn("webui", `event dispatch error (${ev.t}): ${(e as Error).message}`);
      }
    }
  };

  // Periodic drain — eval/message latency when nothing is pulling frames.
  // unref'd so it never keeps the process alive.
  const timer = setInterval(() => {
    views.forEach((view, id) => drain(id, view));
  }, 8);
  (timer as { unref?: () => void }).unref?.();

  const api: WebUiHostBridge = {
    backend,

    createView: async (config: WebUiViewConfig): Promise<boolean> => {
      const existing = views.get(config.id);
      if (existing) { existing.destroy(); views.delete(config.id); }
      const view = WebUIView.create(backend, {
        url: config.url,
        html: config.html,
        transparent: config.transparent ?? true,
        interactive: config.interactive ?? true,
        frameRate: config.frameRate,
        userAgent: config.userAgent,
        maxCrashRetries: config.maxCrashRetries,
      }, config.width, config.height, config.scale ?? 1);
      if (!view) return false;
      views.set(config.id, view);
      return true;
    },

    destroyView: async (id: string): Promise<void> => {
      const view = views.get(id);
      if (!view) return;
      views.delete(id);
      view.destroy();
      for (const set of Object.values(cbs)) set.delete(id);
      evalPending.forEach((p, req) => {
        if (p.viewId === id) { evalPending.delete(req); p.reject(new Error("view destroyed")); }
      });
    },

    loadURL: async (id: string, url: string): Promise<void> => {
      views.get(id)?.loadUrl(url);
    },

    setContent: async (id: string, html: string): Promise<void> => {
      views.get(id)?.setContent(html);
    },

    resize: (id: string, w: number, h: number, scale?: number): void => {
      views.get(id)?.resize(w, h, scale);
    },

    navigate: (id: string, op): void => {
      views.get(id)?.navigate(op);
    },

    setZoom: (id: string, factor: number): void => {
      views.get(id)?.setZoom(factor);
    },

    setFocus: (id: string, focused: boolean): void => {
      views.get(id)?.setFocus(focused);
    },

    setInteractive: (id: string, on: boolean): void => {
      views.get(id)?.setInteractive(on);
    },

    eval: (id: string, js: string): Promise<unknown> => {
      const view = views.get(id);
      if (!view) return Promise.reject(new Error(`no webui view "${id}"`));
      const req = ++evalReq;
      return new Promise((resolve, reject) => {
        evalPending.set(req, { viewId: id, resolve, reject });
        view.eval(req, js);
        // The eval event arrives via poll_events — drain immediately in
        // case nothing else ticks the queue this turn.
        drain(id, view);
      });
    },

    postMessage: (id: string, payload: unknown): void => {
      views.get(id)?.postMessage(payload);
    },

    onMessage: (id, cb) => subs(cbs.message, id, cb),
    onConsole: (id, cb) => subs(cbs.console, id, cb),
    onCursor: (id, cb) => subs(cbs.cursor, id, cb),
    onStatus: (id, cb) => subs(cbs.status, id, cb),

    sendInputEvent: (id: string, ev: WebUiInputEvent): void => {
      const view = views.get(id);
      if (!view) return;
      switch (ev.type) {
        case "mouseMove": view.pointerMove(ev.x, ev.y); break;
        case "mouseDown": view.pointerDown(ev.x, ev.y, ev.button); break;
        case "mouseUp": view.pointerUp(ev.x, ev.y, ev.button); break;
        case "mouseWheel": view.wheel(ev.x, ev.y, ev.deltaX ?? 0, ev.deltaY ?? 0); break;
        case "keyDown": view.key(true, ev.key ?? "", ev.code, ev.text, ev.modifiers, ev.repeat); break;
        case "keyUp": view.key(false, ev.key ?? "", ev.code, ev.text, ev.modifiers); break;
        case "touchDown": view.touch("down", ev.touchId ?? 0, ev.x, ev.y); break;
        case "touchMove": view.touch("move", ev.touchId ?? 0, ev.x, ev.y); break;
        case "touchUp": view.touch("up", ev.touchId ?? 0, ev.x, ev.y); break;
        case "touchCancel": view.touch("cancel", ev.touchId ?? 0, ev.x, ev.y); break;
        case "imePreedit": view.ime("preedit", ev.text ?? ""); break;
        case "imeCommit": view.ime("commit", ev.text ?? ""); break;
        case "imeCancel": view.ime("cancel", ev.text ?? ""); break;
      }
    },

    pullFrame: (id: string): Uint8Array | null => {
      const view = views.get(id);
      if (!view) return null;
      drain(id, view);
      return view.pullFrame();
    },

    frameRect: (id: string) => views.get(id)?.frameRect() ?? null,
    getDimensions: (id: string) => {
      const d = views.get(id)?.dimensions();
      return d ? { w: d.w, h: d.h } : null;
    },
    pixelFormat: (id: string) => views.get(id)?.pixelFormat() ?? "bgra",
    hitTest: (id: string, x: number, y: number) => views.get(id)?.hitTest(x, y) ?? false,
    status: (id: string) => views.get(id)?.status() ?? "failed",
    crashCount: (id: string) => views.get(id)?.crashCount() ?? 0,
    recover: (id: string) => { views.get(id)?.recover(); },
    setCrashPolicy: (id: string, n: number) => { views.get(id)?.setCrashPolicy(n); },

    forBackend: (b: WebUiBackend) => createWebUiHost({ backend: b })?.api ?? null,
  };

  return {
    api,
    available: true,
    backend,
    dispose: () => {
      clearInterval(timer);
      views.forEach((v) => v.destroy());
      views.clear();
      evalPending.forEach((p) => p.reject(new Error("host disposed")));
      evalPending.clear();
      hosts.delete(backend);
    },
  };
}
