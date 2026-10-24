// ============================================================================
// panels.ts — panel registry + instance host.
//
// A panel is either a GPU `SurfacePanel` (ScreenUiCompositor, drawn in the
// end-of-frame UI pass) or an `HtmlPanel` (Blitz doc via UiPanelHandle).
// Both conform to PanelHandle: setRect / activate / deactivate / dispose.
//
// Panels render the ACTIVE target's session — they re-read it per frame via
// ctx.session() so target switches need no re-binding.
// ============================================================================

import type { ScreenUiCompositor } from "@downdraft/engine/module/renderer-module";
import type { HtmlUiContext, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { Rect } from "../app/store";
import type { TargetSession } from "../targets/session";
import { panelTitles } from "./drawer";

export interface PanelCtx {
  session(): TargetSession | null;
  requestRedraw(): void;
}

export interface PanelHandle {
  id: string;
  title: string;
  kind: "surface" | "html";
  /** Underlying surface instance (surface kind only) — for debugging. */
  surface?: SurfacePanel;
  setRect(r: Rect): void;
  setActive(on: boolean): void;
  tick(dt: number): void;
  dispose(): void;
}

export interface SurfacePanel extends ScreenUiCompositor {
  setRect(r: Rect): void;
  setActive(on: boolean): void;
  /** Optional per-frame hook. */
  tick?(dt: number): void;
  dispose?(): void;
}

export type PanelFactory = (ctx: PanelCtx) => PanelHandle;

const registry = new Map<string, PanelFactory>();

export function registerPanel(id: string, title: string, factory: PanelFactory): void {
  registry.set(id, factory);
  panelTitles.set(id, title);
}

/** Fallback for dynamic panel ids (e.g. provider-<slot>). */
let fallbackFactory: ((id: string, ctx: PanelCtx) => PanelHandle | null) | null = null;
export function setFallbackFactory(f: typeof fallbackFactory): void { fallbackFactory = f; }

export function createPanel(id: string, ctx: PanelCtx): PanelHandle | null {
  const f = registry.get(id);
  if (f) return f(ctx);
  return fallbackFactory ? fallbackFactory(id, ctx) : null;
}

export function hasPanel(id: string): boolean {
  return registry.has(id);
}

export function registeredPanels(): string[] {
  return [...registry.keys()];
}

// ── Adapters ──

/** Wrap a ScreenUiCompositor as a PanelHandle. */
export function surfaceHandle(id: string, title: string, s: SurfacePanel): PanelHandle {
  return {
    id, title, kind: "surface",
    surface: s, // exposed for automation/debugging via __devtoolsHost
    setRect: (r) => s.setRect(r),
    setActive: (on) => s.setActive(on),
    tick: (dt) => s.tick?.(dt),
    dispose: () => s.dispose?.(),
  };
}

/** Wrap a UiPanelHandle (html-ui doc) as a PanelHandle. */
export function htmlHandle(id: string, title: string, h: UiPanelHandle): PanelHandle {
  return {
    id, title, kind: "html",
    setRect: (r) => h.setRect({ x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) }),
    setActive: (on) => h.setStyle("body > *", "visibility", on ? "visible" : "hidden"),
    tick: () => {},
    dispose: () => h.dispose?.(),
  };
}

/** html-ui context holder — set once at ui build time. */
export let htmlUi: HtmlUiContext | null = null;
export function setHtmlUi(ui: HtmlUiContext | null): void {
  htmlUi = ui;
}
