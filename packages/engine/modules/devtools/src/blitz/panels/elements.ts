// ============================================================================
// panels/elements.ts — Elements panel: scene graph / DOM / ECS entity tree.
// Merges the web frontend's scene + dom tabs behind a mode switch, matching
// the Chrome Elements panel's single-tree presentation.
// ============================================================================

import type { TreeRow } from "@downdraft/engine/libraries/devtools";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { esc, type DtPanel, type DtPanelCtx } from "./types";

type Mode = "scene" | "dom" | "ecs";
const MODE_LABEL: Record<Mode, string> = { scene: "Scene graph", dom: "DOM", ecs: "ECS entities" };
const MAX_ROWS = 4000;

export class ElementsPanel implements DtPanel {
  readonly id = "elements";
  readonly title = "Elements";
  dirty = true;
  shellDirty = false;

  private ctx: DtPanelCtx;
  private mode: Mode = "scene";
  private rows: TreeRow[] = [];

  constructor(ctx: DtPanelCtx) { this.ctx = ctx; }

  renderTop(): string {
    const btn = (m: Mode) =>
      `<span class="dbtn${this.mode === m ? " on" : ""}" data-action="el.mode" data-mode="${m}">${MODE_LABEL[m]}</span>`;
    return `<div class="panel-toolbar">
      <span class="dbtn" data-action="el.refresh">Refresh</span>
      ${btn("scene")}${btn("dom")}${btn("ecs")}
      <span class="spacer"></span>
      <span class="count">${this.rows.length} nodes</span>
    </div>`;
  }

  renderBody(): string {
    if (!this.rows.length) return `<div class="empty-note">no nodes</div>`;
    const html = this.rows.slice(0, MAX_ROWS).map((n) =>
      `<div class="trow" style="padding-left:${4 + n.depth * 14}px" data-action="el.pick" data-node="${n.id}">
        <span>${n.childCount > 0 ? "▾" : " "} ${esc(n.label)}</span>
        ${n.detail ? `<span class="detail">${esc(n.detail)}</span>` : ""}
        ${n.childCount > 0 ? `<span class="kids">(${n.childCount})</span>` : ""}
      </div>`
    ).join("");
    const more = this.rows.length > MAX_ROWS
      ? `<div class="empty-note">… ${this.rows.length - MAX_ROWS} more rows</div>` : "";
    return `<div class="tree">${html}${more}</div>`;
  }

  onBackendEvent(event: string, data: unknown): void {
    // "scene" pushes feed the Scene-graph mode; "dom" pushes feed DOM/ECS.
    if (event === "scene" && this.mode === "scene") {
      this.rows = (data as TreeRow[]) ?? [];
      this.dirty = true;
    } else if (event === "dom" && this.mode !== "scene") {
      this.rows = (data as TreeRow[]) ?? [];
      this.dirty = true;
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    if (data.action === "el.refresh") {
      void this.refresh();
    } else if (data.action === "el.mode") {
      const m = data.mode as Mode;
      if (m && m !== this.mode) {
        this.mode = m;
        this.shellDirty = true;
        void this.refresh();
      }
    }
  }

  activate(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const rows = this.mode === "scene"
        ? await this.ctx.call("sceneTree")
        : await this.ctx.call("domTree", { mode: this.mode === "ecs" ? "ecs" : "scene" });
      this.rows = (rows as TreeRow[]) ?? [];
    } catch {
      this.rows = [];
    }
    this.dirty = true;
    this.shellDirty = true; // node count in the toolbar
  }
}
