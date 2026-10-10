// ============================================================================
// panels/snapshot.ts — generic PanelSnapshot renderer. Covers every
// provider-registered tab (sim, memory, render-graph, materials, doctor,
// workers, input, postfx, assets, game, …). Port of
// devtools-web/panels/snapshot.js.
// ============================================================================

import { SNAP_FLAG, type PanelSnapshot, type SnapshotControl, type SnapshotSection } from "@downdraft/engine/libraries/devtools";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { esc, multiChartHtml, type DtPanel, type DtPanelCtx } from "./types";

export class SnapshotPanel implements DtPanel {
  readonly id: string;
  readonly title: string;
  /** Backend provider slot this panel displays — the host watches it for
   *  auto-refresh while this tab is active. */
  readonly providerSlot: number;
  dirty = true;
  shellDirty = false;

  private ctx: DtPanelCtx;
  private slot: number;
  private snap: PanelSnapshot | null = null;
  private updatedAt = "";
  private lastError = "";

  constructor(ctx: DtPanelCtx, slot: number, name: string) {
    this.ctx = ctx;
    this.slot = slot;
    this.providerSlot = slot;
    this.id = `snap-${name}`;
    this.title = titleize(name);
  }

  renderTop(): string {
    return `<div class="panel-toolbar">
      <span class="dbtn" data-action="snap.refresh">Refresh</span>
      <span class="spacer"></span><span class="count">${esc(this.updatedAt)}</span>
    </div>`;
  }

  renderBody(): string {
    const err = this.lastError
      ? `<div class="status-banner error">${esc(this.lastError)}</div>` : "";
    const snap = this.snap;
    if (!snap) return err + `<div class="empty-note">no data</div>`;
    const banner = snap.status && snap.status !== "ok"
      ? `<div class="status-banner${snap.status === "error" ? " error" : ""}">${esc(snap.statusMsg ?? snap.status)}</div>`
      : "";
    return err + banner + (snap.sections ?? []).map((s) => this.renderSection(s)).join("");
  }

  onBackendEvent(event: string, data: unknown): void {
    if (event === "snapshot") {
      const d = data as { slot: number; snap: PanelSnapshot };
      if (d?.slot === this.slot) {
        this.snap = d.snap;
        this.lastError = "";
        this.updatedAt = `updated ${new Date().toLocaleTimeString()}`;
        this.dirty = true;
        this.shellDirty = true;
      }
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    if (data.action === "snap.refresh") {
      void this.refresh();
    } else if (data.action === "snap.cmd") {
      const cmd = data.cmd;
      if (!cmd) return;
      void this.ctx.call("command", {
        panel: this.slot, action: cmd, payload: data.payload ?? "",
      }).then(() => this.refresh()).catch(() => {});
    }
  }

  activate(): void {
    void this.refresh();
  }

  private refreshSeq = 0;

  private async refresh(): Promise<void> {
    // Overlapping refreshes (activate + provider push + manual Refresh) are
    // last-call-wins — a slow stale response must not clobber a newer one.
    const req = ++this.refreshSeq;
    try {
      const snap = (await this.ctx.call("snapshot", { panel: this.slot })) as PanelSnapshot;
      if (req !== this.refreshSeq) return;
      this.snap = snap;
      this.lastError = "";
      this.updatedAt = `updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      if (req !== this.refreshSeq) return;
      // Keep the last good snapshot; surface the failure instead of
      // pretending the data is current.
      this.lastError = `refresh failed: ${String(err)}`;
    }
    this.dirty = true;
    this.shellDirty = true;
  }

  private renderSection(s: SnapshotSection): string {
    const h = s.name ? `<h3>${esc(s.name)}</h3>` : "";
    switch (s.kind) {
      case "kv": {
        const rows = (s.rows ?? []).map((r) => {
          if ((r.flags ?? 0) & SNAP_FLAG.header) {
            return `<div class="kvrow hdr"><div class="k">${esc(r.key)}</div><div class="v"></div></div>`;
          }
          const cls = flagCls(r.flags);
          return `<div class="kvrow"><div class="k">${esc(r.key)}</div><div class="v${cls}">${esc(r.value)}</div></div>`;
        }).join("");
        return `<div class="snap-section">${h}<div class="kv">${rows}</div></div>`;
      }
      case "table": {
        const head = `<tr>${(s.cols ?? []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
        const rows = (s.rows ?? []).map((row) =>
          `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
        return `<div class="snap-section">${h}<table class="dt">${head}${rows}</table></div>`;
      }
      case "series": {
        return `<div class="snap-section">${h}${multiChartHtml(s.series ?? [])}</div>`;
      }
      case "lines": {
        const lines = (s.lines ?? []).map((l) =>
          `<div class="${flagCls(l.flags).trim()}">${esc(l.text)}</div>`).join("");
        return `<div class="snap-section">${h}<div class="lines">${lines}</div></div>`;
      }
      case "controls": {
        const ctrls = (s.controls ?? []).map((c) => this.renderControl(c)).join("");
        return `<div class="snap-section">${h}<div class="controls">${ctrls}</div></div>`;
      }
      default:
        return `<div class="snap-section">${h}<div class="empty-note">unknown section ${esc((s as { kind: string }).kind)}</div></div>`;
    }
  }

  private renderControl(c: SnapshotControl): string {
    const cmdAttr = `data-action="snap.cmd" data-cmd="${esc(c.id)}"`;
    if (c.type === "button") {
      return `<span class="dbtn" ${cmdAttr} data-payload="${esc(c.payload ?? "")}">${esc(c.label)}</span>`;
    }
    if (c.type === "checkbox") {
      return `<label><span class="dbtn${c.checked ? " on" : ""}" ${cmdAttr} data-payload="${c.checked ? "0" : "1"}">${c.checked ? "☑" : "☐"}</span> ${esc(c.label)}</label>`;
    }
    if (c.type === "slider") {
      // Providers can emit a slider without min/max/value — coerce so the
      // stepper never ships "NaN" payloads back through snap.cmd.
      const min = Number.isFinite(c.min) ? c.min : 0;
      const max = Number.isFinite(c.max) ? c.max : min + 1;
      const value = Number.isFinite(c.value) ? c.value : min;
      const span = max - min || 1;
      const step = span / 20;
      const dec = (d: number) => Math.min(max, Math.max(min, value + d * step)).toFixed(2);
      return `<label>${esc(c.label)}
        <span class="dbtn" ${cmdAttr} data-payload="${dec(-1)}">−</span>
        <span class="val">${value.toFixed(2)}</span>
        <span class="dbtn" ${cmdAttr} data-payload="${dec(1)}">+</span></label>`;
    }
    return esc((c as { label?: string }).label ?? "");
  }
}

function flagCls(flags = 0): string {
  if (flags & SNAP_FLAG.error) return " fl-err";
  if (flags & SNAP_FLAG.warn) return " fl-warn";
  return "";
}

function titleize(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
