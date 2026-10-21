// ============================================================================
// sources.ts — script inventory (Debugger.scriptParsed) with a search field,
// a node_modules/vendor filter toggle, grouped directory layout, and
// click → source viewer navigation.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens, chroma } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import { store } from "../app/store";
import { revealSource } from "../ui/drawer";

const LINE_H = 18;
const BAR_H = 30;

const VENDOR_RE = /node_modules|\/vendor\/|\.min\.js$|\/bun:|^bun:|\/internal\//i;

interface Hit { x: number; y: number; w: number; h: number; act: () => void }

export class SourcesSurface extends TextSurface {
  private pctx: PanelCtx;
  private hit: Hit[] = [];
  private query = "";
  private searchFocus = false;
  private hideVendor = true;
  private contentH = 0;

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { hz.act(); this.dirty = true; return; }
      // Click in the bar's dead space focuses search.
      if (e.clientY < this.rect.y + this.z(BAR_H)) this.searchFocus = true;
      else this.searchFocus = false;
    }, 30));
    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.active || !this.searchFocus) return;
      if (e.key.length === 1) { this.query += e.key; this.scrollTarget = 0; this.dirty = true; ctrl.stopPropagation(); return; }
      if (e.key === "Backspace") { this.query = this.query.slice(0, -1); this.dirty = true; ctrl.stopPropagation(); }
      if (e.key === "Escape" || e.key === "Enter") { this.searchFocus = false; if (e.key === "Escape") this.query = ""; this.dirty = true; ctrl.stopPropagation(); }
    }, 50));
  }

  protected contentHeight(): number { return this.contentH; }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const LH = this.z(LINE_H);
    this.hit = [];
    this.contentH = 0;
    this.rangePre = 0;
    this.rangePost = 0;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));

    const s = this.pctx.session();
    this.drawBar(pass, s ? [...s.scripts.values()].length : 0);
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + this.z(14), r.y + this.z(BAR_H + 18), hex(t.textFaint));
      return;
    }

    // Filter.
    let scripts = [...s.scripts.values()];
    if (this.hideVendor) scripts = scripts.filter((sc) => !VENDOR_RE.test(sc.url));
    if (this.query) {
      const q = this.query.toLowerCase();
      scripts = scripts.filter((sc) => sc.url.toLowerCase().includes(q));
    }
    scripts.sort((a, b) => a.url.localeCompare(b.url));

    if (!scripts.length) {
      this.drawText(pass, MONO(), 11,
        s.scripts.size ? "nothing matches the filter" : "no script inventory — CDP Debugger populates this; mirror targets get sources via log links",
        r.x + this.z(14), r.y + this.z(BAR_H + 18), hex(t.textFaint));
      return;
    }

    // Group by directory; headers stick in flow.
    this.rangePre = pass.quadCount;
    let y = r.y + this.z(BAR_H + 8) - this.scrollY;
    let lastDir = "";
    const contentTop = r.y + this.z(BAR_H);
    scripts.forEach((sc) => {
      const parts = sc.url.split("/");
      const file = parts.pop() ?? sc.url;
      const dir = parts.join("/") || "/";
      if (dir !== lastDir) {
        lastDir = dir;
        if (y + LH > contentTop && y < r.y + r.h) {
          const shown = dir.replace(/^file:\/\//, "");
          this.drawText(pass, MONO(700), 9, shown.length > 110 ? "…" + shown.slice(-109) : shown, r.x + this.z(14), y + LH - 3, hex(t.accent2), r.w - this.z(30));
        }
        y += LH;
      }
      if (y + LH > contentTop && y < r.y + r.h) {
        // Highlight the query match within the filename.
        const fx = r.x + this.z(22);
        if (this.query && file.toLowerCase().includes(this.query.toLowerCase())) {
          const qi = file.toLowerCase().indexOf(this.query.toLowerCase());
          const pre = this.measure(MONO(), 11, file.slice(0, qi));
          const mw = this.measure(MONO(), 11, file.slice(qi, qi + this.query.length));
          pass.rect(fx + pre, y + 1, mw, LH - 4, chroma(t.accent, 0.3));
        }
        this.drawText(pass, MONO(), 11, file, fx, y + LH - 4, hex(t.text));
        const lines = sc.endLine - sc.startLine + 1;
        this.drawText(pass, MONO(), 9, `${lines} ln`, r.x + r.w - this.z(80), y + LH - 4, hex(t.textFaint));
        const cy = y;
        this.hit.push({
          x: r.x + this.z(10), y: cy, w: r.w - this.z(20), h: LH,
          act: () => revealSource(sc.url, sc.startLine + 1, 0),
        });
      }
      y += LH;
    });
    this.contentH = y - (r.y + this.z(BAR_H + 8)) + this.scrollY + this.z(BAR_H) + this.z(12);
    this.rangePost = pass.quadCount;
  }

  private rangePre = 0;
  private rangePost = 0;
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    const top = r.y + this.z(BAR_H);
    const band: [number, number, number, number] = [r.x, top, r.w, Math.max(0, r.h - this.z(BAR_H))];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }

  private drawBar(pass: GpuTextPass, total: number): void {
    const t = tokens();
    const r = this.rect;
    const BH = this.z(BAR_H);
    pass.rect(r.x, r.y, r.w, BH, hex(t.bgRaised));
    pass.rect(r.x, r.y + BH - 1, r.w, 1, hex(t.borderSoft));

    let x = r.x + this.z(8);
    const by = r.y + BH - this.z(8);

    // Search field.
    const fw = Math.min(this.z(260), r.w * 0.4);
    pass.rect(x, r.y + this.z(4), fw, BH - this.z(8), hex(this.searchFocus ? t.bgSunken : t.bgPanel));
    this.outline(pass, x, r.y + this.z(4), fw, BH - this.z(8), hex(this.searchFocus ? t.border : t.borderSoft));
    this.drawText(pass, MONO(), 10, this.query || "search scripts…  (type to filter)",
      x + this.z(6), by, hex(this.query ? t.text : t.textFaint), fw - this.z(10));
    this.hit.push({ x, y: r.y + this.z(4), w: fw, h: BH - this.z(8), act: () => { this.searchFocus = true; } });
    x += fw + this.z(8);

    // node_modules toggle.
    const label = this.hideVendor ? "hide node_modules" : "show node_modules";
    const tw = this.measure(MONO(), 10, label) + this.z(16);
    pass.rect(x, r.y + this.z(5), tw, BH - this.z(10), this.hideVendor ? chroma(t.accent, 0.18) : hex(t.bgPanel));
    this.outline(pass, x, r.y + this.z(5), tw, BH - this.z(10), hex(this.hideVendor ? t.border : t.borderSoft));
    this.drawText(pass, MONO(), 10, label, x + this.z(8), by, hex(this.hideVendor ? t.accent : t.textDim));
    const cx = x;
    this.hit.push({ x: cx, y: r.y + this.z(5), w: tw, h: BH - this.z(10), act: () => { this.hideVendor = !this.hideVendor; this.scrollTarget = 0; } });
    x += tw + this.z(10);

    this.drawText(pass, MONO(), 9, `${total} scripts loaded`, x, by, hex(t.textFaint));
  }
}
