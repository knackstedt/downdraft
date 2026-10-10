// ============================================================================
// panels/performance.ts — Performance panel: per-thread CPU/heap/GC/latency
// table, heap history chart, and the CDP CPU profiler (record → top frames).
// Port of devtools-web/panels/metrics.js + the gpu.js profile recorder.
// ============================================================================

import type { MetricsSlot, ProfileJson } from "@downdraft/engine/libraries/devtools";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { CHART_COLORS, chartHtml, esc, fmtBytes, type DtPanel, type DtPanelCtx } from "./types";

const HIST = 240;

export class PerformancePanel implements DtPanel {
  readonly id = "performance";
  readonly title = "Performance";
  dirty = true;
  shellDirty = false;

  private ctx: DtPanelCtx;
  private slots: MetricsSlot[] = [];
  private history = new Map<number, { cpu: number[]; heap: number[] }>();
  private recording = false;
  private profile: ProfileJson | null = null;

  constructor(ctx: DtPanelCtx) { this.ctx = ctx; }

  renderTop(): string {
    return `<div class="panel-toolbar">
      <span class="dbtn${this.recording ? " warn" : ""}" data-action="perf.record">${this.recording ? "■ Stop profile" : "● Record CPU profile"}</span>
      ${this.profile ? `<span class="dbtn" data-action="perf.clearProfile">Clear profile</span>` : ""}
      <span class="spacer"></span>
      <span class="count">${this.slots.length} threads</span>
    </div>`;
  }

  renderBody(): string {
    // `chart + table + prof || note` could never fall through — the table
    // markup is non-empty even with zero slots, so the empty-state hint was
    // dead. Gate the whole thing on having anything to show.
    if (!this.slots.length && !this.profile && !this.recording) {
      return `<div class="empty-note">no metrics — is ProfilingSAB attached?</div>`;
    }
    const heapSeries = [...this.history.entries()].map(([slot, rec]) => ({
      name: `heap — ${this.slotName(slot)}`,
      values: rec.heap,
      color: CHART_COLORS[slot % CHART_COLORS.length],
    }));
    const chart = heapSeries.length
      ? `<div class="snap-section"><h3>Heap per thread (MB)</h3>${heapSeries.map((s) =>
          chartHtml(s.values, { max: Math.max(64, ...heapSeries.flatMap((x) => x.values)), color: s.color, label: s.name })).join("")}</div>`
      : "";

    let tbl = "";
    if (this.slots.length) {
      tbl = `<table class="dt"><tr>
      <th>slot</th><th>name</th><th>cpu%</th><th>heap</th>
      <th>gc max µs</th><th>task p95 µs</th></tr>`;
    }
    for (const s of this.slots.values()) {
      const h = s.history?.[0] ?? {} as MetricsSlot["history"][0];
      tbl += `<tr><td>${s.slotIndex}</td><td>${esc(s.name)}</td>
        <td>${(h.cpuPercent ?? 0).toFixed(1)}</td>
        <td>${fmtBytes(h.heapUsed)} / ${fmtBytes(h.heapTotal)}</td>
        <td>${(h.gcPauseMaxUs ?? 0).toFixed(0)}</td>
        <td>${(h.taskLatencyP95Us ?? 0).toFixed(0)}</td></tr>`;
    }
    if (this.slots.length) tbl += `</table>`;
    const table = tbl ? `<div class="snap-section"><h3>Threads</h3>${tbl}</div>` : "";

    let prof = "";
    if (this.recording) {
      prof = `<div class="status-banner">● recording — press Stop to capture</div>`;
    } else if (this.profile && !Array.isArray(this.profile.nodes)) {
      prof = `<div class="status-banner error">malformed profile payload</div>`;
    } else if (this.profile) {
      const nodes = this.profile.nodes;
      const top = [...nodes].sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0)).slice(0, 40);
      const total = Math.max(1, top.reduce((s, n) => s + (n.hitCount ?? 0), 0));
      const durMs = ((this.profile.endUs ?? 0) - (this.profile.startUs ?? 0)) / 1000;
      prof = `<div class="snap-section"><h3>CPU profile — ${nodes.length} nodes, ${durMs.toFixed(0)} ms</h3>
        <div class="lines">${top.map((n) =>
          esc(`${(100 * (n.hitCount ?? 0) / total).toFixed(1).padStart(5)}%  ${n.callFrame}  ${n.url}:${n.line}`)
        ).join("\n")}</div></div>`;
    }

    return chart + table + prof;
  }

  onBackendEvent(event: string, data: unknown): void {
    if (event === "metrics") {
      this.slots = Array.isArray(data) ? data : [];
      for (const s of this.slots.values()) {
        const h = s.history?.[0];
        if (!h) continue;
        let rec = this.history.get(s.slotIndex);
        if (!rec) { rec = { cpu: [], heap: [] }; this.history.set(s.slotIndex, rec); }
        rec.cpu.push(h.cpuPercent ?? 0);
        rec.heap.push((h.heapUsed ?? 0) / 1048576);
        if (rec.cpu.length > HIST) { rec.cpu.shift(); rec.heap.shift(); }
      }
      this.dirty = true;
    } else if (event === "profile") {
      this.profile = data as ProfileJson;
      this.recording = false;
      this.dirty = true;
      this.shellDirty = true;
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    if (data.action === "perf.record") {
      if (!this.recording) {
        this.recording = true;
        this.profile = null;
        void this.ctx.call("profile.start").catch(() => { this.recording = false; });
      } else {
        this.recording = false;
        void this.ctx.call("profile.stop").catch(() => {});
      }
      this.dirty = true;
      this.shellDirty = true;
    } else if (data.action === "perf.clearProfile") {
      this.profile = null;
      this.dirty = true;
      this.shellDirty = true;
    }
  }

  private slotName(slotIndex: number): string {
    return this.slots.find((s) => s.slotIndex === slotIndex)?.name ?? `slot ${slotIndex}`;
  }
}
