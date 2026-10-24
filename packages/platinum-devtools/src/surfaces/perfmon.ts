// ============================================================================
// perfmon.ts — bottom-drawer performance monitor.
//
// Chrome's Perf Monitor shows a fixed row of coarse counters. Ours: a grid
// of live metric tiles — every series the target feeds (per-thread CPU/heap,
// procfs rss/io/fds, fps, external feeds) — each tile a sparkline + current
// value + unit + min/max envelope, grouped by lane. Click a tile to pin it
// to the top row; click the title to open Profiler scoped to the series.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens } from "../app/theme";
import type { MetricSeries } from "../targets/model";
import type { PanelCtx } from "../ui/panels";
import { drawSeries, fmtValue, laneColor } from "./charts";
import { store } from "../app/store";

const TILE_W_ = 190;
const TILE_H_ = 64;
const TILE_GAP_ = 6;
const GROUP_H_ = 22;

export class PerfMonSurface extends TextSurface {
  private pctx: PanelCtx;
  private pinned = new Set<string>();
  private hit: { x: number; y: number; w: number; h: number; act: () => void }[] = [];

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation();
          hz.act();
          this.dirty = true;
          return; }
    }, -20));
  }

  /** Tiles in display order: pinned first, then by group. */
  private ordered(): { group: string; s: MetricSeries }[] {
    const ses = this.pctx.session();
    if (!ses) return [];
    const groups = new Map<string, MetricSeries[]>();
    ses.series.forEach((s) => {
      const g = s.group;
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(s);
    });
    const out: { group: string; s: MetricSeries }[] = [];
    // Pinned lane first.
    ses.series.forEach((s) => { if (this.pinned.has(s.id)) out.push({ group: "pinned", s }); });
    [...groups.keys()].sort().forEach((g) => {
      groups.get(g)!.forEach((s) => { if (!this.pinned.has(s.id)) out.push({ group: g, s }); });
    });
    return out;
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));

    const ses = this.pctx.session();
    if (!ses) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + 12, r.y + 22, hex(t.textFaint));
      return;
    }
    const items = this.ordered();
    if (!items.length) {
      this.drawText(pass, MONO(), 11, "waiting for metrics — attach a target with mirror/procfs/feed data",
        r.x + 12, r.y + 22, hex(t.textFaint));
      return;
    }

    let x = r.x + 8;
    let y = r.y + 6 - this.scrollY;
    let curGroup = "";

    items.forEach((it) => {
      if (it.group !== curGroup) {
        curGroup = it.group;
        if (x !== r.x + 8) { x = r.x + 8; y += this.z(TILE_H_) + this.z(TILE_GAP_); }
        // group label
        if (y + this.z(GROUP_H_) > r.y && y < r.y + r.h) {
          this.drawText(pass, MONO(600), 10, curGroup.toUpperCase(), x + 2, y + this.z(GROUP_H_) - 7, hex(t.textFaint));
        }
        y += this.z(GROUP_H_);
      }
      if (x + this.z(TILE_W_) > r.x + r.w - 8) { x = r.x + 8; y += this.z(TILE_H_) + this.z(TILE_GAP_); }

      const s = it.s;
      if (y + this.z(TILE_H_) > r.y && y < r.y + r.h) {
        const pinned = this.pinned.has(s.id);
        const laneClr = laneColor(hashColor(s.id));
        pass.rect(x, y, this.z(TILE_W_), this.z(TILE_H_), hex(t.bgRaised));
        this.outline(pass, x, y, this.z(TILE_W_), this.z(TILE_H_), hex(pinned ? t.accent : t.borderSoft));
        // label + value
        this.drawText(pass, MONO(), 10, s.label, x + 7, y + 16, hex(t.textDim), this.z(TILE_W_) - 70);
        this.drawText(pass, MONO(600), 13, fmtValue(s.v[s.v.length - 1] ?? 0, s.unit),
          x + 7, y + 34, hex(t.text));
        // min/max envelope (group already shown by the section header)
        this.drawText(pass, MONO(), 8, `${fmtValue(s.min, s.unit)}–${fmtValue(s.max, s.unit)}`,
          x + 7, y + this.z(TILE_H_) - 6, hex(t.textFaint));
        // sparkline
        drawSeries(pass, s, x + 80, y + 6, this.z(TILE_W_) - 88, this.z(TILE_H_) - 12, { color: laneClr, grid: false, windowSec: 60 });
        const cx = x, cy = y;
        this.hit.push({
          x: cx, y: cy, w: this.z(TILE_W_), h: this.z(TILE_H_), act: () => {
            if (this.pinned.has(s.id)) this.pinned.delete(s.id);
            else this.pinned.add(s.id);
          },
        });
      }
      x += this.z(TILE_W_) + this.z(TILE_GAP_);
    });

    this.contentH = y + this.scrollY - r.y + this.z(TILE_H_) + 12;

    // Bottom hint.
    const hint = "click tile to pin · more detail in Profiler";
    this.drawText(pass, MONO(), 9, hint, r.x + r.w - this.measure(MONO(), 9, hint) - 10, r.y + 14, hex(t.textFaint));
  }

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }
}

function hashColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function openProfilerAt(_seriesId: string): void {
  store.setState({ mainTab: "profiler" });
}
