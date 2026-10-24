// ============================================================================
// host.ts — PanelHost: syncs store layout → live panel instances.
//
// Visible panels: mainTab (at mainRect), docks.bottom.active (bottomRect),
// docks.right.active (rightRect). GPU surface panels are persistent
// compositors (draw only when active); html panels are UiPanelHandles
// positioned at their rects.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { store } from "../app/store";
import { sessions } from "../targets/runtime";
import { RunCache } from "../text/run-cache";
import { createPanel, type PanelCtx, type PanelHandle } from "./panels";
import { STRIP_H } from "./shell";

export class PanelHost {
  private ctx: RendererModuleContext;
  private instances = new Map<string, PanelHandle>();
  private pctx: PanelCtx;

  constructor(ctx: RendererModuleContext, private cache: RunCache) {
    this.ctx = ctx;
    this.pctx = {
      session: () => sessions.active(),
      requestRedraw: () => { /* surfaces repaint every frame anyway */ },
    };
  }

  private ensure(id: string): PanelHandle | null {
    let h = this.instances.get(id);
    if (h) return h;
    const created = createPanel(id, this.pctx);
    if (!created) return null;
    h = created;
    this.instances.set(id, h);
    return h;
  }

  /** Compute the desired visibility map each frame. */
  private desired(): { id: string; rect: { x: number; y: number; w: number; h: number } }[] {
    const s = store.getState();
    const out: { id: string; rect: typeof s.mainRect }[] = [];
    // Overlay hidden ⇒ no panel instances (hasContent() false → the UI pass
    // is skipped entirely, so a hidden overlay costs ~nothing per frame).
    if (!s.overlayVisible) return out;
    out.push({ id: s.mainTab, rect: s.mainRect });
    // Dock bodies start below the 26px html-ui tab strip — surfaces
    // composite above the UI docs, so overlapping them hides the strip.
    if (!s.docks.bottom.collapsed && s.docks.bottom.active) {
      const r = s.bottomRect;
      out.push({ id: s.docks.bottom.active, rect: { x: r.x, y: r.y + STRIP_H, w: r.w, h: r.h - STRIP_H } });
    }
    if (!s.docks.right.collapsed && s.docks.right.active) {
      const r = s.rightRect;
      out.push({ id: s.docks.right.active, rect: { x: r.x, y: r.y + STRIP_H, w: r.w, h: r.h - STRIP_H } });
    }
    return out;
  }

  /** Per-frame sync + tick. */
  tick(dt: number): void {
    const want = this.desired();

    // Rect/activity updates for visible panels.
    want.forEach((w) => {
      const inst = this.ensure(w.id);
      if (!inst) return;
      inst.setRect(w.rect);
      inst.setActive(true);
      inst.tick(dt);
    });

    // Deactivate the rest — a panel visible in either dock/main counts active.
    this.instances.forEach((inst, id) => {
      const stillVisible = want.some((w) => w.id === id);
      if (!stillVisible) inst.setActive(false);
    });
  }

  dispose(): void {
    this.instances.forEach((i) => i.dispose());
    this.instances.clear();
  }
}
