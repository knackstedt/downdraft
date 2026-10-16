// ============================================================================
// create-web-ui.ts — createWebUi() renderer module
//
// The heavyweight browser UI tier: mounts real web-engine views (CEF/WPE
// via downdraft.webui) as screen-space panels composited by PanelBlitPass,
// with pointer/wheel/key routing at UI priority — the same seam html-ui's
// Blitz panels use. Blitz stays canonical for lightweight UI; this module
// exists for pages that need a real DOM/JS/web-API surface.
//
// Absent a backend (no cdylib staged, DD_WEBUI_BACKEND=none, or a platform
// without a backend), mount() returns null and the module stays a no-op —
// games can gate on ui.available / ui.backend at build time.
// ============================================================================

import { downdraft } from "@downdraft/engine/app/main";
import { resolveWebUiBackend } from "@downdraft/engine/libraries/webui";
import type {
    WebUiBackend,
    WebUiHostBridge,
    WebUiViewStatus,
} from "@downdraft/engine/libraries/webui/types";
import type { RendererModule, RendererModuleContext, ScreenUiCompositor } from "@downdraft/engine/module/renderer-module";
import { PanelBlitPass, type CompositePanel } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import { WebUiTextureSource } from "./texture-source";

const log = createLogger("info");

// ── Public surface ──

export interface WebUiPanelSpec {
  /** View id — auto-generated when omitted. */
  id?: string;
  /** Screen-space rect in buffer px — the same input space
   *  NativeWindow.mapX/Y emits (divide by surface zoom for logical size). */
  rect: { x: number; y: number; w: number; h: number };
  url?: string;
  html?: string;
  /** Raster scale (physical px per CSS px). Default: surface scaleFactor. */
  scale?: number;
  /** Forward input to the page. Default true. */
  interactive?: boolean;
  /** Compositor draw order — higher renders later. Default 0. */
  order?: number;
  maxCrashRetries?: number;
  onMessage?: (payload: unknown) => void;
  onConsole?: (level: number, text: string) => void;
  onStatus?: (status: WebUiViewStatus) => void;
}

export interface WebUiViewHandle {
  readonly id: string;
  readonly rect: { x: number; y: number; w: number; h: number };
  readonly status: WebUiViewStatus;
  eval(js: string): Promise<unknown>;
  postMessage(payload: unknown): void;
  loadURL(url: string): Promise<void>;
  setContent(html: string): Promise<void>;
  navigate(op: "back" | "forward" | "reload" | "stop"): void;
  setZoom(factor: number): void;
  /** Move/resize the screen-space rect (buffer px); the view rasters at
   *  the rect size (CSS size × scale internally). */
  setRect(rect: { x: number; y: number; w: number; h: number }): void;
  setInteractive(on: boolean): void;
  destroy(): Promise<void>;
}

export interface WebUiContext {
  /** Mount a screen-space browser panel. Null when no backend is staged. */
  mount(spec: WebUiPanelSpec): Promise<WebUiViewHandle | null>;
  /** Resolved backend ("cef" | "wpe"), or null when the tier is unavailable. */
  readonly backend: WebUiBackend | null;
  readonly available: boolean;
  /** True when a pointer position is over an interactive panel. */
  isPointerOverUI(x?: number, y?: number): boolean;
}

export interface WebUiOptions {
  name?: string;
  /** Backend override — the first precedence slot before env/config/flag/
   *  platform default. "none" disables the tier explicitly. */
  backend?: WebUiBackend | "auto" | "none";
  /** Compositor draw order for all webui panels — html-ui composites at 0,
   *  so embeds that must paint above Blitz chrome should pass > 0. */
  compositorOrder?: number;
  build(ui: WebUiContext): void;
}

// ── Module ──

interface PanelState {
  spec: Required<Pick<WebUiPanelSpec, "interactive">> & WebUiPanelSpec;
  id: string;
  /** Raster scale (physical px per CSS px) captured at mount. */
  scale: number;
  src: WebUiTextureSource;
  comp: CompositePanel;
  unsubs: Array<() => void>;
}

let viewSeq = 0;

export function createWebUi(options: WebUiOptions): RendererModule {
  let panels: PanelState[] = [];
  let bridge: WebUiHostBridge | null = null;
  let blit: PanelBlitPass | null = null;
  let unregCompositor: (() => void) | null = null;
  let unsubs: Array<() => void> = [];
  let pointerDownOn: string | null = null;
  let focusedPanel: string | null = null;

  return {
    name: options.name ?? "webui",
    version: "0.1.0",

    register(ctx: RendererModuleContext): void {
      const device = ctx.getDevice();
      const format = ctx.getFormat();
      const surface = ctx.getSurface();
      // surface.scaleFactor is a () => number accessor, not a field — and a
      // non-finite/garbage scale crashes backends that assert its range.
      const dpr = () => {
        const sf = (surface as { scaleFactor?: number | (() => number) }).scaleFactor;
        const v = typeof sf === "function" ? sf() : sf;
        return typeof v === "number" && isFinite(v) && v > 0.05 && v <= 5 ? v : 1;
      };

      // ── Bridge: explicit backend → forBackend sibling; else host default ──
      const hostBridge = (downdraft as { webui?: WebUiHostBridge }).webui;
      const want = resolveWebUiBackend(options.backend);
      if (want && hostBridge) {
        bridge = hostBridge.backend === want
          ? hostBridge
          : hostBridge.forBackend?.(want) ?? null;
      }
      if (!bridge) {
        if (want) log.warn("webui", `backend "${want}" unavailable — webui panels disabled (is libdowndraft_webui_${want} staged?)`);
      }

      // ── Input routing at UI priority (-10, same as html-ui) ──
      // Panel rects and bus coordinates are buffer px (the input space
      // NativeWindow.mapX/Y emits); the ABI wants CSS px and multiplies by
      // scale itself, so local() divides — at scaleFactor ≠ 1 they diverge.
      const local = (p: PanelState, e: { clientX: number; clientY: number }) => ({
        x: (e.clientX - p.comp.rect.x) / p.scale, y: (e.clientY - p.comp.rect.y) / p.scale,
      });
      const panelAt = (x: number, y: number): PanelState | null => {
        // Topmost first — later panels paint over earlier ones.
        for (let i = panels.length - 1; i >= 0; i--) {
          const p = panels[i];
          if (!p.spec.interactive) continue;
          const r = p.comp.rect;
          if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) continue;
          // Inside the rect — ask the backend whether the pixel is opaque.
          // Until the first frame lands there is nothing to test — fall back
          // to rect-hit so input still works during initial load.
          if (!p.src.hasFrame || bridge!.hitTest(p.id, x - r.x, y - r.y)) return p;
        }
        return null;
      };
      const btn = (b: number): "left" | "middle" | "right" =>
        b === 2 ? "right" : b === 1 ? "middle" : "left";
      const modsOf = (e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) => {
        const m: string[] = [];
        if (e.shiftKey) m.push("shift");
        if (e.ctrlKey) m.push("ctrl");
        if (e.altKey) m.push("alt");
        if (e.metaKey) m.push("meta");
        return m;
      };
      const send = (id: string, ev: Parameters<WebUiHostBridge["sendInputEvent"]>[1]) => {
        bridge?.sendInputEvent(id, { ...ev });
      };

      const bus = ctx.getInputBus();
      unsubs.push(
        bus.onPointerMove((e, _ctrl) => {
          const target = panels.find((p) => p.id === pointerDownOn) ?? panelAt(e.clientX, e.clientY);
          if (target) {
            const c = local(target, e);
            send(target.id, { type: "mouseMove", x: c.x, y: c.y, modifiers: modsOf(e) });
          }
        }, -10),
        bus.onPointerDown((e, ctrl) => {
          const p = panelAt(e.clientX, e.clientY);
          if (!p) {
            log.warn("webui", `pointerdown miss @(${e.clientX},${e.clientY}) panels=${panels.map((q) => `${q.id}@${JSON.stringify(q.comp.rect)}`).join("|")}`);
            if (focusedPanel) { bridge?.setFocus(focusedPanel, false); focusedPanel = null; }
            return;
          }
          const c = local(p, e);
          log.warn("webui", `pointerdown hit ${p.id} @(${e.clientX},${e.clientY}) → local(${c.x.toFixed(1)},${c.y.toFixed(1)})`);
          ctrl.stopPropagation();
          pointerDownOn = p.id;
          focusedPanel = p.id;
          bridge?.setFocus(p.id, true);
          send(p.id, { type: "mouseDown", x: c.x, y: c.y, button: btn(e.button), modifiers: modsOf(e) });
        }, -10),
        bus.onPointerUp((e, ctrl) => {
          const downOn = pointerDownOn ? panels.find((p) => p.id === pointerDownOn) : null;
          pointerDownOn = null;
          const p = downOn ?? panelAt(e.clientX, e.clientY);
          if (!p) return;
          ctrl.stopPropagation();
          const c = local(p, e);
          send(p.id, { type: "mouseUp", x: c.x, y: c.y, button: btn(e.button), modifiers: modsOf(e) });
        }, -10),
        bus.onWheel((e, ctrl) => {
          const p = panelAt(e.clientX, e.clientY);
          if (!p) return;
          ctrl.stopPropagation();
          const c = local(p, e);
          send(p.id, { type: "mouseWheel", x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modsOf(e) });
        }, -10),
        bus.onKeyDown((e, ctrl) => {
          const p = focusedPanel ? panels.find((q) => q.id === focusedPanel) : null;
          if (!p) return;
          // Real browsers want every key while focused — unlike Blitz's
          // editing-gate, a focused web panel owns the keyboard.
          ctrl.stopPropagation();
          send(p.id, { type: "keyDown", x: 0, y: 0, key: e.key, code: e.code, text: e.key.length === 1 ? e.key : undefined, repeat: e.repeat, modifiers: modsOf(e) });
        }, -10),
        bus.onKeyUp((e, ctrl) => {
          const p = focusedPanel ? panels.find((q) => q.id === focusedPanel) : null;
          if (!p) return;
          ctrl.stopPropagation();
          send(p.id, { type: "keyUp", x: 0, y: 0, key: e.key, code: e.code, modifiers: modsOf(e) });
        }, -10),
      );

      // ── Compositor: one ScreenUiCompositor for all webui panels ──
      const compositor: ScreenUiCompositor = {
        order: options.compositorOrder ?? 0,
        hasContent: () => panels.length > 0,
        render: (pass, surfaceW, surfaceH) => {
          if (!blit || panels.length === 0) return;
          // comp rects live in the input space (backing-buffer px — what
          // NativeWindow.mapX/Y emits). The compositor contract passes the
          // surface size in that same space, so sx/sy are 1 — the mapping
          // is kept so a caller that hands CSS-px dims (clientWidth) still
          // draws correctly instead of bleeding zoom× off the right/bottom.
          const sx = surface.width > 0 ? surfaceW / surface.width : 1;
          const sy = surface.height > 0 ? surfaceH / surface.height : 1;
          blit.render(pass, panels.map((p) => ({
            ...p.comp,
            rect: { x: p.comp.rect.x * sx, y: p.comp.rect.y * sy, w: p.comp.rect.w * sx, h: p.comp.rect.h * sy },
          })), surfaceW, surfaceH);
        },
      };
      unregCompositor = ctx.registerUiCompositor?.(compositor) ?? null;

      // ── Frame pull: upload dirty frames every frame ──
      unsubs.push(ctx.onFrame("beforeFrame", () => {
        if (!bridge) return;
        const b = bridge;
        panels.forEach((p) => {
          try {
            // 2 = texture recreated on resize — the bind group holds the
            // old texture and must be rebuilt.
            if (p.src.update(b) === 2) rebuildBindGroup(p);
          } catch (err) {
            log.warn("webui", `frame pull failed for "${p.id}": ${(err as Error).message}`);
          }
        });
      }));

      const rebuildBindGroup = (p: PanelState) => {
        if (!blit) return;
        p.comp.bindGroup = blit.createBindGroup(p.src.getTexture(), p.comp.ubo, p.src.srgbFormat);
      };

      // ── mount() ──
      const mount = async (spec: WebUiPanelSpec): Promise<WebUiViewHandle | null> => {
        if (!bridge) return null;
        if (!blit) blit = new PanelBlitPass(device, format);
        const id = spec.id ?? `webui-${++viewSeq}`;
        const scale = spec.scale ?? dpr();
        const ok = await bridge.createView({
          id,
          // CSS px — the backend rasters at dims × scale = rect size.
          width: Math.round(spec.rect.w / scale),
          height: Math.round(spec.rect.h / scale),
          scale,
          url: spec.url,
          html: spec.html,
          interactive: spec.interactive ?? true,
          frameRate: 60,
          maxCrashRetries: spec.maxCrashRetries,
        });
        if (!ok) return null;

        // Physical dims come from the backend (CSS size × scale = rect size).
        const dims = bridge.getDimensions(id)
          ?? { w: Math.max(1, Math.round(spec.rect.w)), h: Math.max(1, Math.round(spec.rect.h)) };
        const src = new WebUiTextureSource(device, id, dims.w, dims.h, bridge.pixelFormat(id));
        const ubo = blit.createUbo();
        const comp: CompositePanel = {
          ubo,
          bindGroup: blit.createBindGroup(src.getTexture(), ubo, src.srgbFormat),
          rect: { ...spec.rect },
        };
        const unsubs: Array<() => void> = [];
        if (spec.onMessage) unsubs.push(bridge.onMessage(id, spec.onMessage));
        if (spec.onConsole) unsubs.push(bridge.onConsole(id, spec.onConsole));
        if (spec.onStatus) unsubs.push(bridge.onStatus(id, spec.onStatus));

        const state: PanelState = {
          spec: { interactive: true, ...spec },
          id,
          scale,
          src,
          comp,
          unsubs,
        };
        const handle: WebUiViewHandle = {
          id,
          get rect() { return comp.rect; },
          get status() { return bridge?.status(id) ?? "failed"; },
          eval: (js) => bridge!.eval(id, js),
          postMessage: (payload) => bridge?.postMessage(id, payload),
          loadURL: (url) => bridge!.loadURL(id, url),
          setContent: (html) => bridge!.setContent(id, html),
          navigate: (op) => bridge?.navigate(id, op),
          setZoom: (f) => bridge?.setZoom(id, f),
          setRect: (rect) => {
            comp.rect = { ...rect };
            bridge?.resize(id, Math.round(rect.w / scale), Math.round(rect.h / scale), scale);
          },
          setInteractive: (on) => {
            state.spec.interactive = on;
            bridge?.setInteractive(id, on);
          },
          destroy: async () => {
            unsubs.forEach((u) => u());
            panels = panels.filter((q) => q !== state);
            if (focusedPanel === id) focusedPanel = null;
            if (pointerDownOn === id) pointerDownOn = null;
            src.destroy();
            await bridge?.destroyView(id);
          },
        };
        panels.push(state);
        panels.sort((a, b) => (a.spec.order ?? 0) - (b.spec.order ?? 0));
        return handle;
      };

      const ui: WebUiContext = {
        mount,
        get backend() { return bridge?.backend ?? null; },
        get available() { return bridge !== null; },
        isPointerOverUI: (x, y) => {
          if (x === undefined || y === undefined) return panels.some((p) => p.spec.interactive);
          return panelAt(x, y) !== null;
        },
      };

      options.build(ui);

      ctx.onDispose(() => {
        unsubs.forEach((u) => u());
        unsubs = [];
        unregCompositor?.();
        unregCompositor = null;
        panels.forEach((p) => { p.unsubs.forEach((u) => u()); p.src.destroy(); });
        panels = [];
        blit = null;
        bridge = null;
      });
    },
  };
}
