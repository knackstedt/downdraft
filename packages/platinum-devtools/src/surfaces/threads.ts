// ============================================================================
// threads.ts — per-thread lanes: live CPU/heap/GC sparklines per thread,
// click to scope the console's eval thread; per-thread log counts.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import { drawSeries, fmtValue, laneColor } from "./charts";

const LANE_H_ = 84;

const KIND_NAMES = ["main", "worker", "plugin", "task"];

export class ThreadsSurface extends TextSurface {
  private pctx: PanelCtx;
  private hit: { x: number; y: number; w: number; h: number; act: () => void }[] = [];

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation(); hz.act(); return; }
    }, 30));
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + 14, r.y + 26, hex(t.textFaint));
      return;
    }

    let y = r.y + 8 - this.scrollY;
    this.drawText(pass, MONO(600), 10, `${s.threads.length} THREADS · ${s.series.size} SERIES`, r.x + 14, y + 12, hex(t.textFaint));
    y += 20;

    s.threads.forEach((thr) => {
      // Skip bare eval entries already aliased by a profiling slot lane —
      // the slot row carries the eval chip and the metric series.
      if (thr.evalId === thr.id && thr.id !== "main" &&
          s.threads.some((o) => o !== thr && o.evalId === thr.id)) return;
      if (y + this.z(LANE_H_) > r.y && y < r.y + r.h) {
        pass.rect(r.x + 10, y, r.w - 20, this.z(LANE_H_) - 8, hex(t.bgRaised));
        this.outline(pass, r.x + 10, y, r.w - 20, this.z(LANE_H_) - 8, hex(t.borderSoft));

        // Name + kind + log count.
        const logs = s.consoleEntries.reduce((n, e) => n + (e.thread === thr.id || e.thread === thr.name ? 1 : 0), 0);
        this.drawText(pass, MONO(600), 12, thr.name || thr.id, r.x + 20, y + 18, hex(t.text));
        this.drawText(pass, MONO(), 10, `${KIND_NAMES[thr.kind] ?? "?"}${thr.runtime ? ` · ${thr.runtime}` : ""} · ${logs} log rows`,
          r.x + 20, y + 34, hex(t.textDim));
        // Eval affordance — lanes with a live eval channel get a chip.
        const ev = thr.evalId ?? (thr.id === "main" ? "main" : null);
        const evLabel = ev ? `⏎ eval ${ev === thr.id ? "" : `→ ${ev}`}` : "inspect only";
        const evW = this.measure(MONO(), 9, evLabel) + 10;
        const evX = r.x + r.w - 20 - evW;
        pass.rect(evX, y + 6, evW, 16, hex(t.bgSunken));
        this.outline(pass, evX, y + 6, evW, 16, hex(ev ? t.accent : t.borderSoft));
        this.drawText(pass, MONO(), 9, evLabel, evX + 5, y + 18, hex(ev ? t.accent : t.textFaint));

        // Series lanes.
        thr.series.forEach((sid, j) => {
          const m = s.series.get(sid);
          if (!m) return;
          const sx = r.x + 20 + j * ((r.w - 60) / Math.max(1, thr.series.length));
          const sw = (r.w - 60) / Math.max(1, thr.series.length) - 10;
          this.drawText(pass, MONO(), 9, `${m.label} ${fmtValue(m.v[m.v.length - 1] ?? 0, m.unit)}`,
            sx, y + 48, hex(t.textDim));
          drawSeries(pass, m, sx, y + 52, sw, this.z(LANE_H_) - 62, { color: laneColor(j), grid: false, windowSec: 60 });
        });
        const cy = y;
        this.hit.push({
          x: r.x + 10, y: cy, w: r.w - 20, h: 44,
          act: () => {
            // click lane → scope console's eval thread + main tab.
            store.setState({ consoleThread: thr.evalId ?? thr.id, mainTab: "console" });
          },
        });
      }
      y += this.z(LANE_H_);
    });

    if (s.threads.length <= 1) {
      this.drawText(pass, MONO(), 11,
        "one thread — workers/sim threads appear here when the target registers them",
        r.x + 14, y + 16, hex(t.textFaint));
      y += 30;
    }
    this.contentH = y + this.scrollY - r.y + 12;
  }

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }
}

import { store } from "../app/store";
