// ============================================================================
// events.ts — lifecycle/HMR/GC/profile event timeline for the active target.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens } from "../app/theme";
import type { EventMarker } from "../targets/model";
import type { PanelCtx } from "../ui/panels";

const LINE_H_ = 18;

const KIND_COLOR: Record<EventMarker["kind"], string> = {
  attach: "#5ec98a", detach: "#f47067", hmr: "#e8b04b", gc: "#4fd6be",
  snapshot: "#9a8cf0", profile: "#4f9cf9", feed: "#7ab3f0", error: "#f47067", lifecycle: "#9aa4b0",
};

export class EventsSurface extends TextSurface {
  private pctx: PanelCtx;
  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.rangePre = 0;
    this.rangePost = 0;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + 14, r.y + 26, hex(t.textFaint));
      return;
    }
    const evs = s.events;
    this.drawText(pass, MONO(600), 10, `${evs.length} EVENTS — HMR, attach/detach, GC, snapshots, feeds`,
      r.x + 14, r.y + 18, hex(t.textFaint));
    const total = evs.length * this.z(LINE_H_) + 30;
    this.contentH = 24 + total;
    const maxScroll = Math.max(0, this.contentH - r.h);
    if (this.stick) { this.scrollTarget = maxScroll; this.scrollY = maxScroll; }
    this.rangePre = pass.quadCount;
    let y = r.y + 24 - this.scrollY;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      if (y + this.z(LINE_H_) > r.y + 22 && y < r.y + r.h) {
        const ts = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false }) + `.${String(Math.floor(e.ts % 1000)).padStart(3, "0")}`;
        pass.rect(r.x + 10, y + 3, 8, 8, hex(KIND_COLOR[e.kind]));
        this.drawText(pass, MONO(), 10, ts, r.x + 24, y + this.z(LINE_H_) - 5, hex(t.textFaint));
        const kindX = r.x + 24 + this.measure(MONO(), 10, ts) + 12;
        this.drawText(pass, MONO(600), 10, e.kind.toUpperCase(), kindX, y + this.z(LINE_H_) - 5, hex(KIND_COLOR[e.kind]));
        const lblX = kindX + this.measure(MONO(600), 10, e.kind.toUpperCase()) + 16;
        this.drawText(pass, MONO(), 10, e.label + (e.detail ? `  ${e.detail}` : ""), lblX, y + this.z(LINE_H_) - 5, hex(t.text), r.x + r.w - lblX - 12);
      }
      y += this.z(LINE_H_);
    }
    this.rangePost = pass.quadCount;
  }

  private stick = true;
  private contentH = 0;
  private rangePre = 0;
  private rangePost = 0;
  protected contentHeight(): number { return this.contentH; }
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    const band: [number, number, number, number] = [r.x, r.y + this.z(22), r.w, Math.max(0, r.h - this.z(22))];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }
  protected onWheel(dy: number, x: number, y: number): void {
    if (dy < 0) this.stick = false;
    if (this.scrollY + dy > 0) { /* scrolling down re-sticks near bottom */ }
    super.onWheel(dy, x, y);
    const s = this.pctx.session();
    if (s) {
      const maxScroll = Math.max(0, s.events.length * this.z(LINE_H_) + 54 - this.rect.h);
      if (this.scrollTarget >= maxScroll - 4) this.stick = true;
    }
  }
}
