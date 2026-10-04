// ============================================================================
// panels/gpu.ts — GPU panel: adapter/limits/telemetry/resources kv +
// frame-time chart. Port of devtools-web/panels/gpu.js.
// ============================================================================

import type { GpuInfoJson } from "@downdraft/engine/libraries/devtools";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { chartHtml, esc, type DtPanel, type DtPanelCtx } from "./types";

export class GpuPanel implements DtPanel {
  readonly id = "gpu";
  readonly title = "GPU";
  dirty = true;

  private ctx: DtPanelCtx;
  private info: GpuInfoJson | null = null;

  constructor(ctx: DtPanelCtx) { this.ctx = ctx; }

  renderTop(): string {
    return `<div class="panel-toolbar">
      <span class="dbtn" data-action="gpu.refresh">Refresh</span>
      <span class="spacer"></span>
    </div>`;
  }

  renderBody(): string {
    if (!this.info) return `<div class="empty-note">no GPU info</div>`;
    const times = (this.info.frameTimes ?? []).map((t) => t[0]);
    const chart = `<div class="snap-section"><h3>Frame times (ms)</h3>${chartHtml(times, { max: Math.max(16.7, ...times), label: "" })}</div>`;

    const sections: { header: string | null; rows: { k: string; v: string }[] }[] = [];
    for (const e of this.info.entries ?? []) {
      if (e.isHeader || !sections.length) {
        sections.push({ header: e.isHeader ? e.key : null, rows: [] });
        if (e.isHeader) continue;
      }
      sections[sections.length - 1]!.rows.push({ k: e.key, v: e.value });
    }
    const kv = sections.length
      ? sections.map((s) =>
        `<div class="snap-section">${s.header ? `<h3>${esc(s.header)}</h3>` : ""}
          <div class="kv">${s.rows.map((r) =>
            `<div class="kvrow"><div class="k">${esc(r.k)}</div><div class="v">${esc(r.v)}</div></div>`).join("")}</div>
        </div>`).join("")
      : `<div class="empty-note">no entries</div>`;

    return chart + kv;
  }

  onBackendEvent(event: string, data: unknown): void {
    if (event === "gpu") {
      this.info = data as GpuInfoJson;
      this.dirty = true;
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    if (data.action === "gpu.refresh") void this.refresh();
  }

  activate(): void {
    if (!this.info) void this.refresh();
  }

  private async refresh(): Promise<void> {
    try { this.info = (await this.ctx.call("gpuInfo")) as GpuInfoJson; } catch { /* keep last */ }
    this.dirty = true;
  }
}
