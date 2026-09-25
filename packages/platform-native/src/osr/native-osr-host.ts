// ============================================================================
// native-osr-host.ts — Blitz-backed implementation of DowndraftOsrBridgeAPI
//
// Replaces the Electron OSR stack (BrowserWindow + shared textures + IPC) with
// in-process Blitz documents. One `OsrDoc` per renderer:
//   - dedicated mode: the doc IS the surface (full renderer size)
//   - atlas mode: the doc is a wrapper page whose absolutely-positioned
//     panel divs each carry one panel's HTML (same model as Electron's
//     atlas webview — see electron-osr/main/atlas-html.ts)
//
// Blitz has no JS engine: `loadURL` fetches the document's HTML only (scripts
// never execute) and `updateData` is `{{key}}` template substitution on the
// stored panel HTML followed by a re-parse, rather than DOM mutation.
// ============================================================================

import { createLogger } from "@downdraft/engine";
import type { DowndraftOsrBridgeAPI } from "@downdraft/engine/app/shared/types";
import { OsrDoc } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type {
    AtlasLayout,
    AtlasPanelRect,
    OSRRendererConfig,
    OSRRendererEvent
} from "@downdraft/engine/modules/native-osr";

const log = createLogger("info");

interface PanelState {
  id: string;
  html: string;
  rect: AtlasPanelRect;
}

interface RendererState {
  id: string;
  config: OSRRendererConfig;
  doc: OsrDoc;
  panels: Map<string, PanelState>;
  nextY: number;
}

export interface NativeOsrHost {
  api: DowndraftOsrBridgeAPI;
  /** False when the cdylib is missing — the API stays callable but no-ops. */
  available: boolean;
  dispose(): void;
}

const EMPTY_HTML = `<html><body style="margin:0;background:transparent;"></body></html>`;

/** Rebuild the atlas wrapper document: one positioned div per panel. */
function buildAtlasHtml(r: RendererState): string {
  if (r.panels.size === 0) return EMPTY_HTML;
  let body = "";
  for (const p of r.panels.values()) {
    body += `<div data-panel="${p.id}" style="position:absolute;left:${p.rect.x}px;top:${p.rect.y}px;width:${p.rect.w}px;height:${p.rect.h}px;overflow:hidden;">${p.html}</div>`;
  }
  return `<html><body style="margin:0;padding:0;background:transparent;width:${r.config.width}px;height:${r.config.height}px;overflow:hidden;">${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createNativeOsrHost(): NativeOsrHost {
  const renderers = new Map<string, RendererState>();
  const layoutCbs = new Set<(rendererId: string, layout: AtlasLayout) => void>();
  const eventCbs = new Set<(event: OSRRendererEvent) => void>();
  const cursorCbs = new Set<(rendererId: string, cursor: string) => void>();

  // Probe the cdylib once — absent lib disables OSR instead of crashing.
  const probe = OsrDoc.create(8, 8, 1, EMPTY_HTML);
  const available = probe !== null;
  probe?.destroy();
  if (!available) {
    log.warn("osr", "libdowndraft_blitz_osr not found — OSR panels disabled (cargo build --release in libraries/blitz-ui/native-osr)");
  }

  const emitLayout = (r: RendererState) => {
    const layout: AtlasLayout = {
      width: r.config.width,
      height: r.config.height,
      panels: new Map([...r.panels.values()].map((p) => [p.id, p.rect])),
    };
    for (const cb of layoutCbs) cb(r.id, layout);
  };

  const emitEvent = (r: RendererState, status: OSRRendererEvent["status"], crashCount = 0) => {
    for (const cb of eventCbs) cb({ rendererId: r.id, status, crashCount });
  };

  /** Shelf-pack a new panel into the atlas — same algorithm as the Electron
   *  atlas renderer (left-to-right, wrap when the row overflows). */
  const packPanel = (r: RendererState, w: number, h: number): AtlasPanelRect | null => {
    const last = [...r.panels.values()].at(-1);
    let x = 0;
    let y = 0;
    if (last) {
      if (last.rect.x + last.rect.w + w <= r.config.width) {
        x = last.rect.x + last.rect.w;
        y = last.rect.y;
      } else {
        let maxBottom = 0;
        for (const p of r.panels.values()) {
          if (p.rect.y === r.nextY) maxBottom = Math.max(maxBottom, p.rect.y + p.rect.h);
        }
        x = 0;
        y = maxBottom;
        r.nextY = maxBottom;
      }
    }
    if (x + w > r.config.width || y + h > r.config.height) return null;
    return { x, y, w, h };
  };

  const refreshAtlas = (r: RendererState) => {
    r.doc.setHtml(buildAtlasHtml(r));
    emitLayout(r);
  };

  const api: DowndraftOsrBridgeAPI = {
    createRenderer: async (config) => {
      if (!available) return;
      if (renderers.has(config.id)) return;
      const doc = OsrDoc.create(config.width, config.height, 1, EMPTY_HTML);
      if (!doc) return;
      const r: RendererState = { id: config.id, config, doc, panels: new Map(), nextY: 0 };
      renderers.set(config.id, r);
      emitEvent(r, "running");
    },

    destroyRenderer: async (id) => {
      const r = renderers.get(id);
      if (!r) return;
      r.doc.destroy();
      renderers.delete(id);
    },

    addPanel: async (config) => {
      const r = renderers.get(config.rendererId);
      if (!r || r.panels.has(config.id)) return null;
      const rect = r.config.mode === "dedicated"
        ? { x: 0, y: 0, w: config.width, h: config.height }
        : packPanel(r, config.width, config.height);
      if (!rect) return null;
      r.panels.set(config.id, { id: config.id, html: config.html, rect });
      refreshAtlas(r);
      return rect;
    },

    removePanel: async (rendererId, panelId) => {
      const r = renderers.get(rendererId);
      if (!r || !r.panels.delete(panelId)) return null;
      refreshAtlas(r);
      return {
        width: r.config.width,
        height: r.config.height,
        panels: new Map([...r.panels.values()].map((p) => [p.id, p.rect])),
      };
    },

    updatePanel: async (rendererId, panelId, html) => {
      const r = renderers.get(rendererId);
      const p = r?.panels.get(panelId);
      if (!r || !p) return;
      p.html = html;
      refreshAtlas(r);
    },

    // `updateData` = {{key}} substitution on the stored panel HTML + re-parse
    // (Blitz has no JS to mutate the DOM). Panels opt in by embedding
    // `{{key}}` placeholders; data-osr-key spans are left untouched.
    updateData: (rendererId, panelId, values) => {
      const r = renderers.get(rendererId);
      const p = r?.panels.get(panelId);
      if (!r || !p) return;
      let html = p.html;
      let changed = false;
      for (const [k, v] of Object.entries(values)) {
        const next = html.split(`{{${k}}}`).join(escapeHtml(String(v)));
        if (next !== html) changed = true;
        html = next;
      }
      if (changed) refreshAtlas(r);
    },

    setContent: async (rendererId, html) => {
      const r = renderers.get(rendererId);
      if (!r) return;
      if (r.panels.size === 0) r.doc.setHtml(html);
      else {
        // Dedicated-style full-document replace on an atlas renderer clears
        // the panel set — matches Electron's setContent semantics (whole page).
        r.panels.clear();
        r.doc.setHtml(html);
        emitLayout(r);
      }
    },

    loadURL: async (rendererId, url) => {
      const r = renderers.get(rendererId);
      if (!r) return;
      // Blitz renders the fetched HTML/CSS only — no script execution.
      try {
        const res = await fetch(url);
        const html = await res.text();
        r.doc.setHtml(html);
      } catch (e) {
        log.warn("osr", `loadURL ${url} failed: ${(e as Error).message}`);
        emitEvent(r, "failed");
      }
    },

    sendInputEvent: (rendererId, event) => {
      const r = renderers.get(rendererId);
      if (!r) return;
      switch (event.type) {
        case "mouseMove": r.doc.pointerMove(event.x, event.y, event.modifiers); break;
        case "mouseDown": r.doc.pointerDown(event.x, event.y, event.button, event.modifiers); break;
        case "mouseUp": r.doc.pointerUp(event.x, event.y, event.button, event.modifiers); break;
        case "mouseWheel": r.doc.wheel(event.x, event.y, event.deltaX ?? 0, event.deltaY ?? 0, event.modifiers); break;
        case "keyDown": r.doc.key(true, event.keyCode ?? "", event.keyCode, event.keyCode?.length === 1 ? event.keyCode : undefined, event.modifiers); break;
        case "keyUp": r.doc.key(false, event.keyCode ?? "", event.keyCode, undefined, event.modifiers); break;
      }
    },

    setSoftwareCursor: (_rendererId, _enabled) => {
      // SDL owns the OS cursor natively — nothing to emulate.
    },

    onPanelLayout: (cb) => { layoutCbs.add(cb); },
    onRendererEvent: (cb) => { eventCbs.add(cb); },
    onCursorStyle: (cb) => { cursorCbs.add(cb); },

    // Electron shared-texture machinery — meaningless in-process; the native
    // manager pulls frames via `pullFrame` below.
    registerSharedTextureReceiver: () => false,
    onPaintImage: () => {},
    onPaintRegion: () => {},
    createPaintPort: () => {},

    __nativeIsBlitz: true,
    pullFrame: (rendererId) => renderers.get(rendererId)?.doc.frame() ?? null,
    getDimensions: (rendererId) => {
      const r = renderers.get(rendererId);
      return r ? { width: r.config.width, height: r.config.height } : null;
    },
    hitTest: (rendererId, x, y) => renderers.get(rendererId)?.doc.hitTest(x, y) ?? false,
  };

  return {
    api,
    available,
    dispose: () => {
      for (const r of renderers.values()) r.doc.destroy();
      renderers.clear();
    },
  };
}
