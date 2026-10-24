// ============================================================================
// profiler.ts — the complete profiler surface: CPU flame + top-functions,
// memory/heap, disk-IO, network waterfall, and a free series overlay.
// Internal view tabs; charts share `drawSeries`.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { chroma, hex, tokens } from "../app/theme";
import type { CpuProfile } from "../targets/model";
import type { TargetSession } from "../targets/session";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { revealSource } from "../ui/drawer";
import type { PanelCtx } from "../ui/panels";
import { drawSeries, fmtValue, laneColor } from "./charts";
import { buildFlameSpans, flameFnColor, type FlameSpan } from "./flame";
import { SnapSurface, type SectionHit } from "./snapshot-view";
import { MONO } from "./text-surface";

const TAB_H = 26;
const LINE_H = 16;

type View = "cpu" | "mem" | "io" | "net" | "series";

interface Hit { x: number; y: number; w: number; h: number; act: () => void }

interface FlameRow {
  name: string;
  url: string;
  line: number;
  selfUs: number;
  totalUs: number;
  depth: number;
}

export class ProfilerSurface extends SnapSurface {
  private pctx: PanelCtx;
  private view: View = "cpu";
  private hit: Hit[] = [];
  private selectedProfile = -1; // index into session.profiles (-1 = latest)
  private sortBy: "self" | "total" = "self";
  private flameZoom: { fn: string; url: string } | null = null;
  /** Flame chart viewport in profile-us; null = whole capture. */
  private flameView: { s: number; e: number } | null = null;
  private flameRect = { x: 0, y: 0, w: 0, h: 0 };
  private flameSpan = { start: 0, total: 1 };
  private panning = false;
  private panX = 0;
  private memPoll = 0;

  protected pctxSession(): TargetSession | null { return this.pctx.session(); }
  protected pushHit(h: SectionHit): void { this.hit.push(h); }
  protected sendControl(slot: number | string, id: string, payload: string): void {
    void this.pctx.session()?.panelCommand(slot, id, payload);
  }

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      // Flame chart: down marks a pending pan — a <4px release is a click
      // (frame zoom / reset chip), a drag pans the viewport.
      const f = this.flameRect;
      if (this.view === "cpu" &&
          e.clientX >= f.x && e.clientX <= f.x + f.w && e.clientY >= f.y && e.clientY <= f.y + f.h) {
        this.panPending = { x: e.clientX, y: e.clientY };
        this.panX = e.clientX;
        ctrl.stopPropagation();
        return;
      }
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation();
          hz.act();
          this.dirty = true;
          return; }
    }, -20));
    this.unsubs.push(bus.onPointerMove((e) => {
      if (this.panPending &&
          Math.abs(e.clientX - this.panPending.x) + Math.abs(e.clientY - this.panPending.y) > 4) {
        this.flameView ??= { s: this.flameSpan.start, e: this.flameSpan.start + this.flameSpan.total };
        this.panning = true;
        this.panPending = null;
      }
      if (!this.panning) return;
      const dx = e.clientX - this.panX;
      this.panX = e.clientX;
      const f = this.flameRect;
      if (f.w > 0 && this.flameView) {
        const spanUs = this.flameView.e - this.flameView.s;
        const dUs = (-dx / f.w) * spanUs;
        const { start, total } = this.flameSpan;
        let s = this.flameView.s + dUs;
        s = Math.max(start, Math.min(start + total - spanUs, s));
        if (spanUs >= total) this.flameView = null;
        else this.flameView = { s, e: s + spanUs };
      }
      this.dirty = true;
    }, -20));
    this.unsubs.push(bus.onPointerUp((e, ctrl) => {
      if (this.panPending) {
        // Released without dragging → flame click (frame zoom / reset).
        const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
        if (hz) { hz.act(); ctrl?.stopPropagation(); }
        this.dirty = true;
      }
      this.panPending = null;
      this.panning = false;
    }, -20));
  }

  private panPending: { x: number; y: number } | null = null;

  /** Wheel: zoom the flame viewport around the cursor when over it. */
  protected onWheel(dy: number, x: number, y: number): void {
    const f = this.flameRect;
    if (this.view === "cpu" && x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) {
      const { start, total } = this.flameSpan;
      const view = this.flameView ?? { s: start, e: start + total };
      const cursorUs = view.s + ((x - f.x) / Math.max(1, f.w)) * (view.e - view.s);
      const factor = dy > 0 ? 1.25 : 0.8;
      let span = (view.e - view.s) * factor;
      span = Math.max(50, Math.min(total, span));
      let s = cursorUs - ((x - f.x) / Math.max(1, f.w)) * span;
      s = Math.max(start, Math.min(start + total - span, s));
      this.flameView = Math.abs(span - total) < 1 ? null : { s, e: s + span };
      this.dirty = true;
      return;
    }
    super.onWheel(dy, x, y);
  }

  tick(dt: number): void {
    super.tick(dt);
    // Auto-stop a capture that exceeded the buffer bound.
    this.pctx.session()?.checkProfileLimit();
    // Memory view polls the memory + assets providers for its sections.
    if (this.view === "mem") {
      this.memPoll += dt * 1000;
      if (this.memPoll >= 900) {
        this.memPoll = 0;
        const s = this.pctx.session();
        if (s?.mirror?.connected) {
          if (s.provider("memory")) void s.pollProvider("memory").catch(() => {});
          if (s.provider("assets")) void s.pollProvider("assets").catch(() => {});
        }
      }
    }
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    this.rangePre = 0;
    this.rangePost = 0;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    this.drawTabs(pass);
    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + 14, r.y + TAB_H + 30, hex(t.textFaint));
      return;
    }
    switch (this.view) {
      case "cpu": this.drawCpu(pass); break;
      case "mem": this.drawMem(pass); break;
      case "io": this.drawIo(pass); break;
      case "net": this.drawNet(pass); break;
      case "series": this.drawAllSeries(pass); break;
    }
  }

  private tab(pass: GpuTextPass, x: number, id: View, label: string): number {
    const t = tokens();
    const r = this.rect;
    const w = this.measure(MONO(), 11, label) + 18;
    const on = this.view === id;
    if (on) pass.rect(x, r.y + TAB_H - 2, w, 2, hex(t.accent));
    this.drawText(pass, MONO(on ? 600 : 400), 11, label, x + 9, r.y + TAB_H - 8, hex(on ? t.text : t.textDim));
    this.hit.push({ x, y: r.y, w, h: TAB_H, act: () => { this.view = id; this.scrollTarget = 0; } });
    return w;
  }

  private drawTabs(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    pass.rect(r.x, r.y, r.w, TAB_H, hex(t.bgRaised));
    pass.rect(r.x, r.y + TAB_H - 1, r.w, 1, hex(t.borderSoft));
    let x = r.x + 6;
    x += this.tab(pass, x, "cpu", "CPU");
    x += this.tab(pass, x, "mem", "Memory");
    x += this.tab(pass, x, "io", "Disk/IO");
    x += this.tab(pass, x, "net", "Network");
    x += this.tab(pass, x, "series", "All series");
  }

  private pill(pass: GpuTextPass, x: number, y: number, label: string, act: () => void, accent = false, disabled = false): number {
    const t = tokens();
    const w = this.measure(MONO(), 10, label) + this.z(16);
    const h = this.z(20);
    this.rrect(pass, x, y, w, h, h / 2,
      accent ? chroma(t.accent, 0.2) : hex(t.bgRaised),
      hex(accent && !disabled ? t.accent : t.borderSoft));
    this.drawText(pass, MONO(), 10, label, x + this.z(8), this.vcenter(y, h, 10),
      hex(disabled ? t.textFaint : accent ? t.accent : t.textDim));
    this.hit.push({ x, y, w, h, act });
    return w + this.z(6);
  }

  // ── CPU ────────────────────────────────────────────────────────

  private drawCpu(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const s = this.pctx.session()!;
    let x = r.x + 10;
    const y = r.y + TAB_H + 8;

    // Controls.
    const canProfile = !!(s.mirror?.connected || s.cdp?.connected || s.agentCmdPort);
    if (s.profiling) {
      x += this.pill(pass, x, y, "■ stop", () => { void s.profileStop(); }, true);
    } else {
      x += this.pill(pass, x, y, "● record", () => { void s.profileStart(); }, false, !canProfile);
    }
    x += this.pill(pass, x, y, "prev ◂", () => { this.selectedProfile = Math.max(0, (this.selectedProfile < 0 ? s.profiles.length : this.selectedProfile) - 1); });
    x += this.pill(pass, x, y, "next ▸", () => { this.selectedProfile = Math.min(s.profiles.length - 1, this.selectedProfile + 1); });
    const idx = this.selectedProfile < 0 ? s.profiles.length - 1 : this.selectedProfile;
    this.drawText(pass, MONO(), 10, `${s.profiles.length ? `profile ${idx + 1}/${s.profiles.length}` : "no profiles"}`,
      x + 4, y + 14, hex(t.textFaint));
    if (s.profiling) {
      // Right-aligned live status: elapsed / buffer limit + usage bar.
      const elapsed = s.profilingSince ? (Date.now() - s.profilingSince) / 1000 : 0;
      const limit = s.profileMaxMs / 1000;
      const msg = `recording ${elapsed.toFixed(1)}s / ${limit}s`;
      const bw = this.z(140);
      const bx = r.x + r.w - bw - 14;
      this.drawText(pass, MONO(), 10, msg, bx - this.measure(MONO(), 10, msg) - this.z(10),
        y + 14, hex(t.warn));
      const frac = Math.min(1, elapsed / Math.max(1, limit));
      pass.rect(bx, y + this.z(16), bw, this.z(4), hex(t.bgSunken));
      pass.rect(bx, y + this.z(16), bw * frac, this.z(4), hex(t.warn));
    }

    const prof = s.profiles[idx];
    if (prof && prof !== this.profCacheKey) {
      this.profCacheKey = prof;
      this.spansCache = null;
    }
    if (!prof) {
      this.drawText(pass, MONO(), 11,
        canProfile ? "record a CPU profile — ● to start" : "target has no profiling channel (needs mirror, CDP profiler, or agent)",
        r.x + 14, y + 44, hex(t.textFaint));
      return;
    }

    // ── Flame chart — pannable/zoomable viewport over the capture ──
    const rows = this.flameRows(prof);
    const totalUs = Math.max(1, prof.endUs - prof.startUs);
    const startUs = prof.startUs;
    this.flameSpan = { start: startUs, total: totalUs };
    const flameTop = y + 30;
    const flameH = Math.min(this.z(220), r.h * 0.42);
    const rowH = this.z(15);
    this.flameRect = { x: r.x + 10, y: flameTop, w: r.w - 20, h: flameH };

    pass.rect(r.x + 10, flameTop, r.w - 20, flameH, hex(t.bgSunken));
    this.outline(pass, r.x + 10, flameTop, r.w - 20, flameH, hex(t.borderSoft));

    // Time ruler along the top of the flame.
    const view = this.flameView ?? { s: startUs, e: startUs + totalUs };
    const span = view.e - view.s;
    const rulerH = this.z(14);
    pass.rect(r.x + 10, flameTop, r.w - 20, rulerH, hex(t.bgRaised));
    const tickUs = niceTick(span / 6);
    for (let tu = Math.ceil(view.s / tickUs) * tickUs; tu <= view.e; tu += tickUs) {
      const tx = r.x + 12 + ((tu - view.s) / span) * (r.w - 24);
      pass.rect(tx, flameTop + rulerH - 4, 1, 4, hex(t.textFaint));
      const label = fmtUs(tu - startUs);
      const labelW = this.measure(MONO(), 9, label);
      const lx = Math.max(r.x + 12, Math.min(tx + 3, r.x + r.w - 14 - labelW));
      this.drawText(pass, MONO(), 9, label, lx, flameTop + rulerH - 4, hex(t.textFaint));
    }

    const scale = (r.w - 24) / Math.max(1, span);
    const scope = this.flameZoom;
    const nodeById = new Map(prof.nodes.map((n) => [n.id, n]));
    const spans = this.flameSpans(prof);

    if (spans.length === 0) {
      this.drawText(pass, MONO(), 10,
        "no sample timeline in this profile — nodes only (imported/folded capture)",
        r.x + 14, flameTop + rulerH + 8, hex(t.textFaint));
    }
    spans.forEach((sp) => {
      const ry = flameTop + rulerH + sp.depth * rowH;
      if (ry + rowH > flameTop + flameH) return;
      // Pixel-joined columns: round outward so adjacent same-depth spans
      // butt-join instead of leaving sub-pixel black comb-teeth.
      const c0 = Math.floor((sp.s - view.s) * scale);
      const c1 = Math.ceil((sp.e - view.s) * scale);
      const rx = r.x + 12 + c0;
      const w = Math.max(1, c1 - c0);
      if (rx + w < r.x + 12 || rx > r.x + r.w - 12) return;
      const n = nodeById.get(sp.nodeId);
      if (!n) return;
      const c = flameFnColor(n.functionName || "(anon)");
      pass.rect(Math.max(rx, r.x + 12), ry + 1, Math.min(w, r.x + r.w - 14 - Math.max(rx, r.x + 12)), rowH - 2,
        chroma(c, scope && scope.fn === n.functionName ? 0.95 : 0.6));
      if (w > 40) {
        this.drawText(pass, MONO(), 9, n.functionName || "(anon)",
          Math.max(rx + 3, r.x + 14), ry + rowH - 4, [0, 0, 0, 0.9], w - 6);
      }
      const nrx = Math.max(rx, r.x + 12);
      this.hit.push({
        x: nrx, y: ry + 1, w: Math.min(w, r.x + r.w - 14 - nrx), h: rowH - 2,
        act: () => {
          // Click a frame: zoom to its span (a bit of padding each side).
          const nTot = sp.e - sp.s;
          const pad = Math.max(20, nTot * 0.04);
          this.flameView = { s: sp.s - pad, e: sp.e + pad };
          this.flameZoom = { fn: n.functionName, url: n.url };
        },
      });
    });
    if (this.flameView || scope) {
      const label = `zoom ${fmtUs(span)} · drag to pan · wheel to zoom`;
      this.drawText(pass, MONO(), 9, label, r.x + 14, flameTop + flameH - 8, hex(t.accent));
      const rw = this.measure(MONO(), 9, "reset") + 12;
      const bx = r.x + r.w - rw - 14;
      pass.rect(bx, flameTop + flameH - 18, rw, 14, hex(t.bgRaised));
      this.outline(pass, bx, flameTop + flameH - 18, rw, 14, hex(t.borderSoft));
      this.drawText(pass, MONO(), 9, "reset", bx + 6, flameTop + flameH - 7, hex(t.textDim));
      this.hit.push({ x: bx, y: flameTop + flameH - 18, w: rw, h: 16, act: () => { this.flameView = null; this.flameZoom = null; } });
    }

    // ── Top functions table (scrollable) ──
    const tableTop = flameTop + flameH + 10;
    const by = this.sortBy === "self" ? (a: FlameRow, b: FlameRow) => b.selfUs - a.selfUs : (a: FlameRow, b: FlameRow) => b.totalUs - a.totalUs;
    const sorted = [...rows].sort(by);
    this.cpuRowsH = tableTop - r.y + sorted.length * this.z(LINE_H) + this.z(30);
    // Header
    const cols = { self: r.x + this.z(14), total: r.x + this.z(96), fn: r.x + this.z(180) };
    const linkW = this.z(110);
    this.drawText(pass, MONO(600), 10, "SELF", cols.self, tableTop + 10, hex(this.sortBy === "self" ? t.accent : t.textFaint));
    this.drawText(pass, MONO(600), 10, "TOTAL", cols.total, tableTop + 10, hex(this.sortBy === "total" ? t.accent : t.textFaint));
    this.drawText(pass, MONO(600), 10, "FUNCTION", cols.fn, tableTop + 10, hex(t.textFaint));
    this.hit.push({ x: cols.self - 4, y: tableTop - 2, w: this.z(74), h: 18, act: () => { this.sortBy = "self"; } });
    this.hit.push({ x: cols.total - 4, y: tableTop - 2, w: this.z(74), h: 18, act: () => { this.sortBy = "total"; } });

    let ty = tableTop + 16 - this.scrollY;
    this.bandTop = tableTop + 14;
    this.rangePre = pass.quadCount;
    sorted.forEach((f) => {
      if (ty < tableTop + 16) { ty += this.z(LINE_H); return; }
      if (ty > r.y + r.h - 4) return;
      const pct = f.totalUs / totalUs;
      pass.rect(cols.self - 4, ty + 2, Math.max(2, this.z(60) * pct), this.z(LINE_H) - 6, chroma(t.accent, 0.3));
      this.drawText(pass, MONO(), 10, `${(f.selfUs / 1000).toFixed(1)}ms`, cols.self, ty + this.z(LINE_H) - 4, hex(t.textDim), this.z(78));
      this.drawText(pass, MONO(), 10, `${(f.totalUs / 1000).toFixed(1)}ms`, cols.total, ty + this.z(LINE_H) - 4, hex(t.text), this.z(80));
      const name = f.name || "(anon)";
      this.drawText(pass, MONO(), 10, name, cols.fn, ty + this.z(LINE_H) - 4, hex(t.text), r.x + r.w - cols.fn - linkW - this.z(10));
      if (f.url) {
        const file = `${f.url.split("/").pop()}:${f.line || 1}`;
        this.drawText(pass, MONO(), 9, file, r.x + r.w - linkW, ty + this.z(LINE_H) - 4, hex(t.link), linkW - 2);
        this.hit.push({
          x: r.x + r.w - linkW - 4, y: ty, w: linkW + 2, h: this.z(LINE_H),
          act: () => { revealSource(f.url, f.line || 1, 0); },
        });
      }
      ty += this.z(LINE_H);
    });
    this.rangePost = pass.quadCount;
  }

  private rangePre = 0;
  private rangePost = 0;
  private bandTop = 0;
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    const band: [number, number, number, number] = [r.x, this.bandTop, r.w, Math.max(0, r.y + r.h - this.bandTop)];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }

  private flameRows(prof: CpuProfile): FlameRow[] {
    // Aggregate by functionName+url.
    const map = new Map<string, FlameRow>();
    prof.nodes.forEach((n) => {
      const key = `${n.functionName}@${n.url}`;
      let row = map.get(key);
      if (!row) { row = { name: n.functionName, url: n.url, line: n.line, selfUs: 0, totalUs: 0, depth: 0 }; map.set(key, row); }
      row.selfUs += n.selfUs ?? 0;
      row.totalUs += n.totalUs ?? 0;
    });
    // If nodes lack selfUs/totalUs, derive from samples.
    if ([...map.values()].every((r) => r.selfUs === 0 && r.totalUs === 0)) {
      const totalDelta = prof.timeDeltasUs.reduce((a, b) => a + b, 0) || 1;
      const nodeById = new Map(prof.nodes.map((n) => [n.id, n]));
      prof.samples.forEach((nid, i) => {
        const n = nodeById.get(nid);
        if (!n) return;
        const key = `${n.functionName}@${n.url}`;
        const row = map.get(key)!;
        row.selfUs += prof.timeDeltasUs[i] ?? totalDelta / Math.max(1, prof.samples.length);
      });
      // total = self + children (walk up via children lists)
      prof.nodes.forEach((n) => {
        const key = `${n.functionName}@${n.url}`;
        const row = map.get(key)!;
        row.totalUs = (row.totalUs || 0) + (row.selfUs || 0); // approx when tree missing
      });
    }
    return [...map.values()];
  }

  /** Per-depth open/close reconstruction of the sampled timeline (see
   *  `flame.ts`) — cached per profile. */
  private flameSpans(prof: CpuProfile): FlameSpan[] {
    this.spansCache ??= buildFlameSpans(prof);
    return this.spansCache!;
  }
  private spansCache: FlameSpan[] | null = null;
  private profCacheKey: CpuProfile | null = null;

  // ── Memory ─────────────────────────────────────────────────────

  private drawMem(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const s = this.pctx.session()!;
    const LH = this.z(LINE_H);
    let x = r.x + 10;
    const y = r.y + this.z(TAB_H + 8);
    x += this.pill(pass, x, y, "heap snapshot", () => {
      // Prefer the agent's jsc snapshot; fall back to the MCP heap tool.
      void s.heapSnapshot();
    });
    x += this.pill(pass, x, y, "import .heapsnapshot", () => {
      s.systemNote("import artifacts via MCP artifact_import or drop on the feed");
    });
    void x;

    // Heap lanes split by scope: per-thread lanes first (broken up by
    // ProfilingSAB slot), then process/feed-level series.
    const bSeries = [...s.series.values()].filter((m) => m.unit === "B" && /heap|rss|mem/i.test(m.id + m.label + m.group));
    const threadSeries = bSeries.filter((m) => m.group.startsWith("thread:"));
    const procSeries = bSeries.filter((m) => !m.group.startsWith("thread:"));
    let cy = y + this.z(30) - this.scrollY;
    this.bandTop = y + this.z(30);
    this.rangePre = pass.quadCount;

    const lane = (m: (typeof bSeries)[number], i: number) => {
      const ch = this.z(56);
      if (cy + ch > r.y + this.z(TAB_H + 28) && cy < r.y + r.h) {
        const g = m.group.replace(/^thread:/, "");
        const right = `${fmtValue(m.min, "B")}–${fmtValue(m.max, "B")}  ·  ${g === "proc" ? "process" : g.startsWith("feed:") ? g : `thread ${g}`}`;
        pass.rect(r.x + 10, cy, r.w - 20, ch, hex(t.bgRaised));
        this.drawText(pass, MONO(600), 10, `${m.label}  ${fmtValue(m.v[m.v.length - 1] ?? 0, "B")}`,
          r.x + 18, cy + this.z(15), hex(t.text));
        this.drawText(pass, MONO(), 9, right, r.x + r.w - this.measure(MONO(), 9, right) - this.z(24),
          cy + this.z(15), hex(t.textFaint));
        drawSeries(pass, m, r.x + 14, cy + this.z(20), r.w - 28, ch - this.z(24), { color: laneColor(i), windowSec: 120 });
      }
      cy += ch + this.z(6);
    };

    if (threadSeries.length) {
      if (cy + this.z(18) > r.y && cy < r.y + r.h) {
        this.drawText(pass, MONO(700), 12, "PER-THREAD HEAP", r.x + 14, cy + this.z(10), hex(t.accent));
      }
      cy += this.z(22);
      threadSeries.slice(0, 10).forEach(lane);
    }
    if (procSeries.length) {
      this.drawText(pass, MONO(700), 12, "PROCESS & FEED", r.x + 14, cy + this.z(10), hex(t.accent));
      cy += this.z(22);
      procSeries.slice(0, 6).forEach(lane);
    }

    // Engine's memory + assets provider snapshots (kv/tables w/ history).
    (["memory", "assets"] as const).forEach((name) => {
      const p = s.provider(name);
      if (!p) return;
      if (cy + this.z(20) > r.y && cy < r.y + r.h) {
        this.drawText(pass, MONO(700), 12, name.toUpperCase(), r.x + 14, cy + this.z(10), hex(t.accent));
      }
      cy += this.z(22);
      if (p.lastSnapshot) {
        cy = this.drawSections(pass, p.lastSnapshot, p.slot, r.x + this.z(20), cy, r.w - this.z(40), p.lastPush ?? 0);
      } else {
        this.drawText(pass, MONO(), 10, "waiting for snapshot…", r.x + this.z(20), cy + this.z(10), hex(t.textFaint));
        cy += this.z(22);
      }
      cy += this.z(8);
    });

    // Last heap snapshot summary table.
    const snap = s.heapSnapshots[s.heapSnapshots.length - 1];
    if (snap) {
      this.drawText(pass, MONO(700), 12, `HEAP SNAPSHOT — ${fmtValue(snap.totalBytes, "B")} / ${snap.objectCount} objects`,
        r.x + 14, cy + this.z(12), hex(t.accent));
      cy += this.z(22);
      snap.classes.slice(0, 40).forEach((c) => {
        if (cy + LH > r.y + r.h - 4) return;
        const max = snap.classes[0]?.shallow || 1;
        pass.rect(r.x + 14, cy + 2, Math.max(2, (r.w - this.z(300)) * (c.shallow / max)), LH - 5, chroma(t.accent2, 0.35));
        this.drawText(pass, MONO(), 10, c.name || "(anon)", r.x + 18, cy + LH - 4, hex(t.text), r.w * 0.45);
        this.drawText(pass, MONO(), 10, `×${c.count}`, r.x + r.w - this.z(260), cy + LH - 4, hex(t.textDim));
        this.drawText(pass, MONO(), 10, fmtValue(c.shallow, "B"), r.x + r.w - this.z(180), cy + LH - 4, hex(t.text));
        this.drawText(pass, MONO(), 10, fmtValue(c.retained ?? 0, "B"), r.x + r.w - this.z(90), cy + LH - 4, hex(t.textDim));
        cy += LH;
      });
    } else if (!bSeries.length) {
      this.drawText(pass, MONO(), 11, "no heap data yet — needs mirror metrics, procfs, or an imported snapshot",
        r.x + 14, cy + this.z(12), hex(t.textFaint));
    }
    this.rangePost = pass.quadCount;
    this.memContentH = cy - (r.y + this.z(TAB_H)) + this.scrollY;
  }

  private memContentH = 0;

  // ── Disk / IO ──────────────────────────────────────────────────

  private drawIo(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const s = this.pctx.session()!;
    const ioSeries = [...s.series.values()].filter((m) => /io|disk|opfs|idb|iops/i.test(m.id + m.label + m.group));
    let cy = r.y + this.z(TAB_H + 36) - this.scrollY;
    if (!ioSeries.length) {
      this.drawText(pass, MONO(), 11, "no disk/IO series — procfs provides read/write rates for local targets; OPFS/IDB lanes arrive via mirror",
        r.x + 14, cy, hex(t.textFaint));
      return;
    }
    this.drawText(pass, MONO(700), 12, "DISK & STORAGE", r.x + 14, r.y + this.z(TAB_H + 16), hex(t.accent));
    this.bandTop = r.y + this.z(TAB_H + 36);
    this.rangePre = pass.quadCount;
    ioSeries.forEach((m, i) => {
      const ch = this.z(58);
      if (cy + ch > r.y && cy < r.y + r.h) {
        pass.rect(r.x + 10, cy, r.w - 20, ch, hex(t.bgRaised));
        const lane = m.group.replace(/^thread:/, "");
        this.drawText(pass, MONO(600), 10, m.label, r.x + 18, cy + this.z(15), hex(t.text));
        this.drawText(pass, MONO(), 9, `${m.id} · ${lane}`, r.x + 18 + this.measure(MONO(600), 10, m.label) + this.z(12),
          cy + this.z(15), hex(t.textFaint), r.w * 0.4);
        const right = `${fmtValue(m.v[m.v.length - 1] ?? 0, m.unit)}  ·  min ${fmtValue(m.min, m.unit)}  max ${fmtValue(m.max, m.unit)}`;
        this.drawText(pass, MONO(), 9, right, r.x + r.w - this.measure(MONO(), 9, right) - this.z(24), cy + this.z(15), hex(t.textDim));
        drawSeries(pass, m, r.x + 14, cy + this.z(20), r.w - 28, ch - this.z(24), { color: laneColor(i), windowSec: 120 });
      }
      cy += ch + this.z(6);
    });
    this.rangePost = pass.quadCount;
    this.ioContentH = cy - (r.y + this.z(TAB_H)) + this.scrollY;
  }

  private ioContentH = 0;

  // ── Network waterfall + throughput ─────────────────────────────

  private drawNet(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const s = this.pctx.session()!;
    const LH = this.z(LINE_H);
    const events = s.network;
    const top = r.y + this.z(TAB_H + 8);
    if (!events.length) {
      this.drawText(pass, MONO(700), 12, "NETWORK", r.x + 14, r.y + this.z(TAB_H + 16), hex(t.accent));
      this.drawText(pass, MONO(), 11, "no network events — needs the platinum-agent fetch wrap or CDP Network domain",
        r.x + 14, r.y + this.z(TAB_H + 36), hex(t.textFaint));
      return;
    }

    // Throughput charts: requests/s + bytes/s over the last 60s.
    const nowS = events[events.length - 1]!.ts;
    const bucketsR = new Float32Array(60);
    const bucketsB = new Float32Array(60);
    events.forEach((e) => {
      const bi = Math.floor(nowS - e.ts);
      if (bi >= 0 && bi < 60) {
        bucketsR[59 - bi]!++;
        bucketsB[59 - bi]! += e.resBytes ?? 0;
      }
    });
    const sparkT = Array.from({ length: 60 }, (_, i) => nowS - 60 + i);
    const reqSeries = { id: "req-s", label: "requests/s", unit: "ops" as const, group: "net",
      t: sparkT, v: [...bucketsR], cap: 60, min: 0, max: Math.max(1, ...bucketsR) };
    const bwSeries = { id: "bw-s", label: "bytes/s", unit: "B" as const, group: "net",
      t: sparkT, v: [...bucketsB], cap: 60, min: 0, max: Math.max(1, ...bucketsB) };

    const ch = this.z(46);
    const sparkW = Math.min(this.z(240), r.w * 0.2);
    let sx = r.x + 14;
    this.drawText(pass, MONO(700), 10, `REQ/S  ${bucketsR[59]!.toFixed(0)}`, sx, top + this.z(12), hex(t.textDim));
    drawSeries(pass, reqSeries, sx + this.z(70), top, sparkW, ch - this.z(10), { color: laneColor(0), grid: false });
    sx += this.z(70) + sparkW + this.z(30);
    this.drawText(pass, MONO(700), 10, `B/S  ${fmtValue(bucketsB[59]!, "B")}`, sx, top + this.z(12), hex(t.textDim));
    drawSeries(pass, bwSeries, sx + this.z(70), top, sparkW, ch - this.z(10), { color: laneColor(1), grid: false });
    sx += this.z(70) + sparkW + this.z(30);
    // IOPS — disk ops/sec from procfs, relevant to net stalls on local IO.
    const iops = [...s.series.values()].find((m) => /iops/i.test(m.id));
    if (iops) {
      this.drawText(pass, MONO(700), 10, `IOPS  ${fmtValue(iops.v[iops.v.length - 1] ?? 0, iops.unit)}`, sx, top + this.z(12), hex(t.textDim));
      drawSeries(pass, iops, sx + this.z(70), top, sparkW, ch - this.z(10), { color: laneColor(2), grid: false, windowSec: 60 });
    }

    const wfTop = top + ch + this.z(8);
    this.drawText(pass, MONO(700), 12, `${events.length} requests — waterfall`, r.x + 14, wfTop, hex(t.accent));
    if (s.netSpilled) {
      const msg = `${s.netSpilled} older requests paged → ${s.netLogPath?.split("/").pop()}`;
      this.drawText(pass, MONO(), 9, msg, r.x + r.w - this.measure(MONO(), 9, msg) - this.z(14), wfTop, hex(t.textFaint));
    }

    const barX = r.x + r.w * 0.42;
    const barW = r.x + r.w - 20 - barX;
    const tail = events.slice(-300);

    // Waterfall axis spans the *visible* rows — on a long session the
    // all-time axis squashes every bar into a sub-pixel sliver.
    const bandTop = wfTop + this.z(12);
    const bandBot = r.y + r.h - 4;
    const firstRow = Math.max(0, Math.floor(this.scrollY / LH));
    const lastRow = Math.min(tail.length - 1, Math.ceil((this.scrollY + (bandBot - bandTop)) / LH));
    let t0 = Infinity, t1 = -Infinity;
    for (let i = firstRow; i <= lastRow; i++) {
      const ev = tail[i]!;
      t0 = Math.min(t0, ev.ts);
      t1 = Math.max(t1, ev.ts + (ev.durationMs ?? 10) / 1000);
    }
    if (!isFinite(t0)) { t0 = events[events.length - 1]!.ts - 1; t1 = t0 + 1.2; }
    t1 = Math.max(t1 + 0.05, t0 + 0.3);

    let cy = bandTop - this.scrollY;
    this.bandTop = bandTop;
    this.rangePre = pass.quadCount;
    tail.forEach((ev) => {
      if (cy + LH > wfTop && cy < r.y + r.h - 4) {
        const name = `${ev.method} ${ev.url.split("/").slice(-2).join("/")}`;
        this.drawText(pass, MONO(), 10, name, r.x + 12, cy + LH - 4, hex(ev.error ? t.err : t.text), r.x + r.w * 0.42 - 60);
        this.drawText(pass, MONO(), 10, ev.status ? String(ev.status) : ev.error ?? "…", r.x + r.w * 0.42 - 50, cy + LH - 4,
          hex(ev.error ? t.err : ev.status && ev.status >= 400 ? t.warn : t.ok));
        const sx = barX + ((ev.ts - t0) / (t1 - t0)) * barW;
        const dur = Math.max(1, (ev.durationMs ?? (ev.finished ? 0 : 8)) / 1000 / (t1 - t0) * barW);
        pass.rect(Math.max(sx, barX), cy + 3, Math.min(dur, barX + barW - sx), LH - 8,
          hex(ev.error ? t.err : ev.protocol === "ws" ? t.accent2 : t.accent));
      }
      cy += LH;
    });
    this.rangePost = pass.quadCount;
    this.netContentH = cy - wfTop + this.scrollY;
  }

  private netContentH = 0;

  /** Per-view scroll height so the table/waterfall regions scroll. */
  protected contentHeight(): number {
    switch (this.view) {
      case "mem": return this.memContentH + this.z(60);
      case "io": return this.ioContentH + this.z(40);
      case "net": return this.netContentH + this.z(80);
      case "cpu": return this.cpuRowsH;
      case "series": return this.seriesContentH + this.z(60);
      default: return 0;
    }
  }

  private cpuRowsH = 0;
  private seriesContentH = 0;

  // ── All series overlay ─────────────────────────────────────────

  private drawAllSeries(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const s = this.pctx.session()!;
    const all = [...s.series.values()];
    let cy = r.y + TAB_H + 10 - this.scrollY;
    this.seriesContentH = all.length * 56 + TAB_H + 20;
    this.bandTop = r.y + TAB_H;
    this.rangePre = pass.quadCount;
    all.forEach((m, i) => {
      if (cy + 54 > r.y && cy < r.y + r.h) {
        this.drawText(pass, MONO(), 10, `${m.id}`, r.x + 14, cy + 12, hex(t.textDim));
        this.drawText(pass, MONO(600), 11, fmtValue(m.v[m.v.length - 1] ?? 0, m.unit),
          r.x + r.w - 130, cy + 12, hex(t.text));
        drawSeries(pass, m, r.x + 14, cy + 16, r.w - 28, 34, { color: laneColor(i), windowSec: 120 });
      }
      cy += 56;
    });
    this.rangePost = pass.quadCount;
    if (!all.length) this.drawText(pass, MONO(), 11, "no metric series yet", r.x + 14, cy + 8, hex(t.textFaint));
  }
}

/** Round a duration in µs to a "nice" tick step (1/2/5 × 10^n). */
function niceTick(rough: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function fmtUs(us: number): string {
  if (us >= 1e6) return `${(us / 1e6).toFixed(2)}s`;
  if (us >= 1e3) return `${(us / 1e3).toFixed(1)}ms`;
  return `${us.toFixed(0)}µs`;
}
