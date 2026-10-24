// ============================================================================
// network.ts — network panel: column-toggleable request table with a mini
// waterfall per row, click → details pane, and disk-paged history (events
// beyond the in-memory cap spill to a JSONL netlog — shown in the footer).
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens, chroma } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import type { NetworkEvent } from "../targets/model";
import { fmtValue } from "./charts";

const LINE_H = 17;
const BAR_H = 26;
const DETAIL_H = 96;

const COLS = [
  { id: "method", label: "METHOD", w: 52 },
  { id: "status", label: "STATUS", w: 52 },
  { id: "size", label: "SIZE", w: 76 },
  { id: "time", label: "TIME", w: 64 },
] as const;

interface Hit { x: number; y: number; w: number; h: number; act: () => void }

export class NetworkSurface extends TextSurface {
  private pctx: PanelCtx;
  private stick = true;
  private hit: Hit[] = [];
  private colsOn = new Set<string>(["method", "status", "size", "time"]);
  private selected: string | null = null;   // event id
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
    }, -20));
  }

  protected contentHeight(): number { return this.contentH; }

  protected onWheel(dy: number, x: number, y: number): void {
    if (dy < 0) this.stick = false;
    super.onWheel(dy, x, y);
    const s = this.pctx.session();
    if (s) {
      const maxScroll = Math.max(0, this.contentH - (this.rect.h - this.z(BAR_H)));
      if (this.scrollTarget >= maxScroll - 4) this.stick = true;
    }
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const LH = this.z(LINE_H);
    const BH = this.z(BAR_H);
    this.hit = [];
    this.rangePre = 0;
    this.rangePost = 0;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    const s = this.pctx.session();
    this.drawBar(pass, s);

    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + this.z(14), r.y + BH + this.z(18), hex(t.textFaint));
      return;
    }
    const events = s.network;
    if (!events.length) {
      this.drawText(pass, MONO(), 11, "no network events — needs agent fetch-wrap or CDP Network domain",
        r.x + this.z(14), r.y + BH + this.z(18), hex(t.textFaint));
      return;
    }

    const detail = events.find((e) => e.id === this.selected) ?? null;
    const detailH = detail ? this.z(DETAIL_H) : 0;
    const listTop = r.y + BH;
    const listBot = r.y + r.h - detailH;

    // Column layout: name takes the remainder after toggled cols + waterfall.
    let nameW = r.w - this.z(40);
    COLS.forEach((c) => { if (this.colsOn.has(c.id)) nameW -= this.z(c.w); });
    const wfW = Math.max(this.z(80), r.w * 0.22);
    nameW -= wfW;

    const maxScroll = Math.max(0, events.length * LH - (listBot - listTop - this.z(20)));
    if (this.stick) { this.scrollTarget = maxScroll; this.scrollY = maxScroll; }

    // Waterfall axis spans the *visible* rows — on a long session the
    // all-time axis squashes every bar into a sub-pixel sliver.
    const visRows = (listBot - listTop - this.z(20)) / LH;
    const firstRow = Math.max(0, Math.floor(this.scrollY / LH));
    const lastRow = Math.min(events.length - 1, Math.ceil(firstRow + visRows));
    let t0 = Infinity, t1 = -Infinity;
    for (let i = firstRow; i <= lastRow; i++) {
      const ev = events[i]!;
      t0 = Math.min(t0, ev.ts);
      t1 = Math.max(t1, ev.ts + (ev.durationMs ?? 10) / 1000);
    }
    if (!isFinite(t0)) { t0 = events[0]!.ts; t1 = t0 + 1; }
    t1 = Math.max(t1 + 0.05, t0 + 0.3);

    // Column headers.
    let hx = r.x + this.z(14) + nameW;
    COLS.forEach((c) => {
      if (!this.colsOn.has(c.id)) return;
      this.drawText(pass, MONO(700), 9, c.label, hx, listTop + this.z(10), hex(t.textFaint));
      hx += this.z(c.w);
    });
    pass.rect(r.x + this.z(10), listTop + this.z(14), r.w - this.z(20), 1, hex(t.borderSoft));

    let y = listTop + this.z(18) - this.scrollY;
    this.bandTop = listTop + this.z(14);
    this.bandBot = listBot;
    this.rangePre = pass.quadCount;
    events.forEach((ev) => {
      if (y + LH > listTop + this.z(14) && y < listBot) {
        const sel = ev.id === this.selected;
        if (sel) pass.rect(r.x + this.z(8), y, r.w - this.z(16), LH, hex(t.accentSoft));
        const name = ev.url.split("/").pop() || ev.url;
        const err = !!ev.error || (ev.status ?? 0) >= 400;
        this.drawText(pass, MONO(), 10, name, r.x + this.z(14), y + LH - 4,
          hex(err ? t.err : t.text), nameW - this.z(8));

        let cx = r.x + this.z(14) + nameW;
        if (this.colsOn.has("method")) {
          this.drawText(pass, MONO(), 10, ev.method, cx, y + LH - 4, hex(t.textDim), this.z(50));
          cx += this.z(52);
        }
        if (this.colsOn.has("status")) {
          const st = ev.error ?? (ev.status ? `${ev.status}` : ev.finished ? "done" : "…");
          this.drawText(pass, MONO(), 10, st, cx, y + LH - 4, hex(err ? t.err : t.ok), this.z(50));
          cx += this.z(52);
        }
        if (this.colsOn.has("size")) {
          this.drawText(pass, MONO(), 10, ev.resBytes !== null && ev.resBytes !== undefined ? fmtValue(ev.resBytes, "B") : "—",
            cx, y + LH - 4, hex(t.textDim), this.z(74));
          cx += this.z(76);
        }
        if (this.colsOn.has("time")) {
          this.drawText(pass, MONO(), 10, ev.durationMs !== null && ev.durationMs !== undefined ? `${ev.durationMs.toFixed(0)}ms` : "…",
            cx, y + LH - 4, hex(t.textDim), this.z(62));
          cx += this.z(64);
        }
        // Waterfall bar.
        const sx = cx + ((ev.ts - t0) / (t1 - t0)) * wfW;
        const w = Math.max(2, ((ev.durationMs ?? 10) / 1000 / (t1 - t0)) * wfW);
        pass.rect(Math.max(sx, cx), y + 4, Math.min(w, cx + wfW - Math.max(sx, cx)), LH - 10,
          hex(err ? t.err : ev.protocol === "ws" ? t.accent2 : t.accent));

        const ry = y;
        this.hit.push({
          x: r.x + this.z(8), y: ry, w: r.w - this.z(16), h: LH,
          act: () => { this.selected = this.selected === ev.id ? null : ev.id; },
        });
      }
      y += LH;
    });
    // contentHeight feeds the base clamp — include the fixed regions
    // (column bar + header + detail pane) so max scroll lands rows
    // exactly at the bottom of the list area.
    this.contentH = events.length * LH + this.z(20) + BH + this.z(18) + detailH;
    this.rangePost = pass.quadCount;

    if (detail) this.drawDetail(pass, detail, listBot, detailH, t);
  }

  private rangePre = 0;
  private rangePost = 0;
  private bandTop = 0;
  private bandBot = 0;
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    const band: [number, number, number, number] = [r.x, this.bandTop, r.w, Math.max(0, this.bandBot - this.bandTop)];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }

  private drawBar(pass: GpuTextPass, s: import("../targets/session").TargetSession | null): void {
    const t = tokens();
    const r = this.rect;
    const BH = this.z(BAR_H);
    pass.rect(r.x, r.y, r.w, BH, hex(t.bgRaised));
    pass.rect(r.x, r.y + BH - 1, r.w, 1, hex(t.borderSoft));

    let x = r.x + this.z(8);
    const by = r.y + BH - this.z(8);
    const events = s?.network ?? [];
    const totalB = events.reduce((a, e) => a + (e.resBytes ?? 0), 0);
    const errs = events.filter((e) => e.error || (e.status ?? 0) >= 400).length;
    this.drawText(pass, MONO(700), 10, `${events.length} req · ${fmtValue(totalB, "B")} · ${errs} err`,
      x, by, hex(t.textDim));
    x += this.measure(MONO(700), 10, `${events.length} req · ${fmtValue(totalB, "B")} · ${errs} err`) + this.z(14);

    COLS.forEach((c) => {
      const on = this.colsOn.has(c.id);
      const w = this.measure(MONO(), 9, c.label.toLowerCase()) + this.z(14);
      pass.rect(x, r.y + this.z(4), w, BH - this.z(8), on ? chroma(t.accent, 0.18) : hex(t.bgPanel));
      this.outline(pass, x, r.y + this.z(4), w, BH - this.z(8), hex(on ? t.border : t.borderSoft));
      this.drawText(pass, MONO(), 9, c.label.toLowerCase(), x + this.z(7), by, hex(on ? t.text : t.textFaint));
      const cx = x;
      this.hit.push({ x: cx, y: r.y + this.z(4), w, h: BH - this.z(8), act: () => {
        if (this.colsOn.has(c.id)) this.colsOn.delete(c.id); else this.colsOn.add(c.id);
      } });
      x += w + this.z(5);
    });

    if (s?.netSpilled) {
      const msg = `${s.netSpilled} paged to disk`;
      this.drawText(pass, MONO(), 9, msg, r.x + r.w - this.measure(MONO(), 9, msg) - this.z(10), by, hex(t.textFaint));
    }
  }

  private drawDetail(pass: GpuTextPass, ev: NetworkEvent, y: number, h: number, t: ReturnType<typeof tokens>): void {
    const r = this.rect;
    const LH = this.z(LINE_H);
    pass.rect(r.x, y, r.w, h, hex(t.bgRaised));
    pass.rect(r.x, y, r.w, 1, hex(t.border));
    let ty = y + this.z(6);
    const x = r.x + this.z(14);
    const err = !!ev.error || (ev.status ?? 0) >= 400;

    this.drawText(pass, MONO(700), 10, `${ev.method} ${ev.url}`, x, ty + LH - 4,
      hex(err ? t.err : t.text), r.w - this.z(40));
    ty += LH;
    const bits = [
      `status ${ev.error ?? ev.status ?? (ev.finished ? "done" : "pending")}`,
      ev.protocol ? `proto ${ev.protocol}` : null,
      ev.mime ? `mime ${ev.mime}` : null,
      `sent ${fmtValue(ev.reqBytes ?? 0, "B")}`,
      `recv ${fmtValue(ev.resBytes ?? 0, "B")}`,
      ev.durationMs !== null && ev.durationMs !== undefined ? `time ${ev.durationMs.toFixed(1)}ms` : "time …",
    ].filter(Boolean).join("   ·   ");
    this.drawText(pass, MONO(), 10, bits, x, ty + LH - 4, hex(t.textDim), r.w - this.z(28));
    ty += LH;

    // Timing breakdown bar (blocked→connect→tls→send→wait→receive).
    const tm = ev.timing;
    if (tm && ev.durationMs) {
      const segs: [keyof typeof tm, string][] = [
        ["blocked", t.textFaint], ["connect", t.warn], ["tls", t.accent2],
        ["send", t.accent], ["wait", t.ok], ["receive", t.accent],
      ];
      let bx = x;
      const bw = r.w - this.z(28);
      const scale = bw / ev.durationMs;
      segs.forEach(([k, c]) => {
        const segW = (tm[k] ?? 0) * scale;
        if (segW > 0.5) pass.rect(bx, ty + 2, segW, LH - 6, hex(c));
        bx += segW;
      });
      const labels = segs.filter(([k]) => (tm[k] ?? 0) > 0).map(([k]) => `${k} ${(tm[k] ?? 0).toFixed(0)}ms`).join("  ");
      this.drawText(pass, MONO(), 9, labels, x, ty + LH + 2, hex(t.textFaint), bw);
    }
  }
}
