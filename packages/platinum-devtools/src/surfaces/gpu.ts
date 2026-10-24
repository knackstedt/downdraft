// ============================================================================
// gpu.ts — the "GPU" tab: device/adapter info, frame timing + pass timings,
// frame-graph slots, GPU errors, and gpu.* metric lanes. This is where
// stutter and GPU-side lag become visible.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { MONO } from "./text-surface";
import { SnapSurface, type SectionHit } from "./snapshot-view";
import { hex, tokens } from "../app/theme";
import { drawSeries, fmtValue, laneColor } from "./charts";
import type { PanelCtx } from "../ui/panels";
import type { TargetSession } from "../targets/session";

export class GpuSurface extends SnapSurface {
  private pctx: PanelCtx;
  private hit: SectionHit[] = [];
  private lastPoll = 0;

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    this.setHistScope("gpu");
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation(); hz.act(); return; }
    }, -20));
  }

  protected pctxSession(): TargetSession | null { return this.pctx.session(); }
  protected pushHit(h: SectionHit): void { this.hit.push(h); }
  protected sendControl(slot: number | string, id: string, payload: string): void {
    void this.pctx.session()?.panelCommand(slot, id, payload);
  }

  tick(dt: number): void {
    super.tick(dt);
    this.lastPoll += dt * 1000;
    if (this.lastPoll >= 750) {
      this.lastPoll = 0;
      const s = this.pctx.session();
      if (s?.mirror?.connected && s.provider("gpu")) void s.pollProvider("gpu").catch(() => {});
    }
  }

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));

    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + this.z(14), r.y + this.z(26), hex(t.textFaint));
      return;
    }

    let y = r.y + this.z(14) - this.scrollY;
    const x0 = r.x + this.z(14);
    const w = r.w - this.z(28);
    let drew = false;

    // Frame pacing — stutter is visible here before it shows up anywhere else.
    const frameSeries = [...s.series.values()].filter((m) =>
      /frame|fps|present|vsync/i.test(m.id) || /frame|fps|present|vsync/i.test(m.label));
    const sim = s.provider("sim");
    const frameKv = (sim?.lastSnapshot?.sections ?? [])
      .filter((sec) => sec.kind === "kv")
      .flatMap((sec) => (sec.rows ?? []).filter((rw) => /fps|frame|p95|p99|present/i.test(rw.key)));
    if (frameSeries.length || (frameKv && frameKv.length)) {
      this.drawText(pass, MONO(700), 12, "FRAME PACING", x0, y + this.z(10), hex(t.accent));
      y += this.z(24);
      drew = true;
      if (frameKv?.length) {
        frameKv.forEach((rw) => {
          this.drawText(pass, MONO(), 11, rw.key, x0 + this.z(6), y + this.z(8), hex(t.textDim));
          this.drawText(pass, MONO(), 11, rw.value, x0 + this.z(180), y + this.z(8), hex(t.text));
          y += this.z(18);
        });
      }
      frameSeries.slice(0, 4).forEach((m, i) => {
        const ch = this.z(54);
        if (y + ch > r.y && y < r.y + r.h) {
          pass.rect(x0 - this.z(4), y, w + this.z(8), ch, hex(t.bgRaised));
          this.drawText(pass, MONO(700), 10, `${m.label}  ${fmtValue(m.v[m.v.length - 1] ?? 0, m.unit)}`,
            x0 + this.z(4), y + this.z(15), hex(t.text));
          drawSeries(pass, m, x0, y + this.z(20), w, ch - this.z(24), { color: laneColor(i), windowSec: 60 });
        }
        y += ch + this.z(6);
      });
      y += this.z(8);
    }

    // GPU metric lanes (feed/mirror pushed gpu.* series).
    const gpuSeries = [...s.series.values()].filter((m) => m.group === "gpu" || m.id.startsWith("gpu."));
    if (gpuSeries.length) {
      this.drawText(pass, MONO(700), 12, "GPU LANES", x0, y + this.z(10), hex(t.accent));
      y += this.z(24);
      drew = true;
      gpuSeries.slice(0, 6).forEach((m, i) => {
        const ch = this.z(54);
        if (y + ch > r.y && y < r.y + r.h) {
          pass.rect(x0 - this.z(4), y, w + this.z(8), ch, hex(t.bgRaised));
          this.drawText(pass, MONO(700), 10, `${m.label}  ${fmtValue(m.v[m.v.length - 1] ?? 0, m.unit)}`,
            x0 + this.z(4), y + this.z(15), hex(t.text));
          drawSeries(pass, m, x0, y + this.z(20), w, ch - this.z(24), { color: laneColor(i), windowSec: 60 });
        }
        y += ch + this.z(6);
      });
      y += this.z(8);
    }

    // VRAM accounting lives on the memory provider; GPU resource inventory on assets.
    const mem = s.provider("memory");
    const vramRows = (mem?.lastSnapshot?.sections ?? [])
      .filter((sec) => sec.kind === "kv")
      .flatMap((sec) => (sec.rows ?? []).filter((rw) => /vram|texture|buffer/i.test(rw.key)));
    const assets = s.provider("assets");
    const gpuResources = (assets?.lastSnapshot?.sections ?? [])
      .filter((sec) => sec.kind === "table" && /gpu|resource/i.test(sec.name ?? ""));
    if ((vramRows && vramRows.length) || (gpuResources && gpuResources.length)) {
      this.drawText(pass, MONO(700), 12, "VRAM & RESOURCES", x0, y + this.z(10), hex(t.accent));
      y += this.z(24);
      drew = true;
      vramRows?.forEach((rw) => {
        this.drawText(pass, MONO(), 11, rw.key, x0 + this.z(6), y + this.z(8), hex(t.textDim));
        this.drawText(pass, MONO(), 11, rw.value, x0 + this.z(180), y + this.z(8), hex(t.text));
        y += this.z(18);
      });
      gpuResources?.forEach((sec) => {
        y = this.drawSections(pass, { sections: [sec] }, assets!.slot, x0, y, w, assets!.lastPush ?? 0);
      });
      y += this.z(8);
    }

    // Render-graph pass timings — GPU time per pass when timestamp queries work.
    const rg = s.provider("render-graph");
    if (rg?.lastSnapshot) {
      this.drawText(pass, MONO(700), 12, "RENDER GRAPH", x0, y + this.z(10), hex(t.accent));
      y += this.z(24);
      drew = true;
      y = this.drawSections(pass, rg.lastSnapshot, rg.slot, x0 + this.z(6), y, w - this.z(12), rg.lastPush ?? 0);
      y += this.z(8);
    }

    // GPU provider snapshot (device info, pass timings, frame graph, errors).
    const p = s.provider("gpu");
    if (p) {
      this.drawText(pass, MONO(700), 12, "DEVICE & PIPELINE", x0, y + this.z(10), hex(t.accent));
      y += this.z(24);
      drew = true;
      if (p.lastSnapshot) {
        y = this.drawSections(pass, p.lastSnapshot, p.slot, x0 + this.z(6), y, w - this.z(12), p.lastPush ?? 0);
      } else {
        this.drawText(pass, MONO(), 10, "waiting for gpu provider snapshot…", x0 + this.z(6), y + this.z(10), hex(t.textFaint));
        y += this.z(24);
      }
    }

    if (!drew) {
      const why = s.mirror?.connected
        ? "target exposes no GPU telemetry — no gpu, sim, or render-graph providers in its devtools hello"
        : "no mirror channel — GPU view needs a downdraft target exposing the gpu provider (pid-only attach has no GPU source)";
      this.drawText(pass, MONO(), 11, why, x0, y + this.z(10), hex(t.textFaint), w);
    }
    this.contentH = y - (r.y + this.z(14)) + this.scrollY + this.z(14) + this.z(20);
  }
}
