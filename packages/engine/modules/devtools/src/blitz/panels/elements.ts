// ============================================================================
// panels/elements.ts — Elements panel: scene graph / ECS entity tree.
//
// Clicking a row selects it (Chrome-style): the .sel class flips via
// incremental attr mutation so the scrollport survives, and a details strip
// in the bottom chrome shows the row fields plus `getNodeJSON` output when
// the node has a stable id and the scene inspector is live. The caret on
// parent rows folds/unfolds the subtree.
// ============================================================================

import type { TreeRow } from "@downdraft/engine/libraries/devtools";
import type { DocMutation, OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { esc, type DtPanel, type DtPanelCtx } from "./types";

type Mode = "scene" | "ecs";
const MODE_LABEL: Record<Mode, string> = { scene: "Scene graph", ecs: "ECS entities" };
const MAX_ROWS = 4000;

export class ElementsPanel implements DtPanel {
  readonly id = "elements";
  readonly title = "Elements";
  dirty = true;
  shellDirty = false;

  private ctx: DtPanelCtx;
  private mode: Mode = "scene";
  private rows: TreeRow[] = [];
  /** Stable per-row key (nodeId or label path), parallel to rows. */
  private keys: string[] = [];
  private collapsed = new Set<string>();
  /** Logical selection — survives refreshes via keys. */
  private selKey: string | null = null;
  /** Ephemeral DOM id of the row currently carrying .sel — lets pick flip
   *  the class without a body reparse. Stale after a refresh; harmless —
   *  renderBody re-emits .sel from selKey. */
  private selRowId: number | null = null;
  private details: { title: string; body: string } | null = null;
  private lastError = "";
  private lastSig = "";
  /** Scroll offset of #dt-body — restored after every body re-render, since
   *  setInnerHtml replaces the subtree and drops scrollTop. */
  private lastScrollTop = 0;

  constructor(ctx: DtPanelCtx) { this.ctx = ctx; }

  renderTop(): string {
    const btn = (m: Mode) =>
      `<span class="dbtn${this.mode === m ? " on" : ""}" data-action="el.mode" data-mode="${m}">${MODE_LABEL[m]}</span>`;
    return `<div class="panel-toolbar">
      <span class="dbtn" data-action="el.refresh">Refresh</span>
      ${btn("scene")}${btn("ecs")}
      <span class="spacer"></span>
      <span class="count">${this.rows.length} nodes${this.collapsed.size ? ` · ${this.collapsed.size} folded` : ""}</span>
    </div>`;
  }

  renderBody(): string {
    const err = this.lastError
      ? `<div class="status-banner error">${esc(this.lastError)}</div>` : "";
    const vis = this.visibleRows();
    if (!vis.length) return err + `<div class="empty-note">no nodes</div>`;
    const html = vis.slice(0, MAX_ROWS).map(({ row: n, key }) => {
      const isSel = key === this.selKey;
      const folded = this.collapsed.has(key);
      const caret = n.childCount > 0
        ? `<span class="caret" data-action="el.fold" data-node="${n.id}">${folded ? "▸" : "▾"}</span>`
        : `<span class="caret leaf"></span>`;
      return `<div class="trow${isSel ? " sel" : ""}" style="padding-left:${4 + n.depth * 14}px" data-action="el.pick" data-node="${n.id}">
        ${caret}<span>${esc(n.label)}</span>
        ${n.detail ? `<span class="detail">${esc(n.detail)}</span>` : ""}
        ${n.childCount > 0 ? `<span class="kids">(${n.childCount})</span>` : ""}
      </div>`;
    }).join("");
    const more = vis.length > MAX_ROWS
      ? `<div class="empty-note">… ${vis.length - MAX_ROWS} more rows</div>` : "";
    return err + `<div class="tree">${html}${more}</div>`;
  }

  renderBottom(): string {
    if (!this.details) return "";
    return `<div class="el-details">
      <div class="el-details-head"><span class="dt-title">${esc(this.details.title)}</span>
        <span class="spacer"></span><span class="dbtn" data-action="el.unpick">✕</span></div>
      <div class="el-details-body lines">${esc(this.details.body)}</div>
    </div>`;
  }

  // ── Data ──

  /** Cheap change-detection — scene/ecs pushes arrive every ~2s while the
   *  dock is visible; identical payloads must not force a re-render (it
   *  would bounce the scrollport twice per second). */
  private applyRows(rows: TreeRow[]): void {
    const sig = JSON.stringify(rows.map((r) => [r.label, r.detail, r.childCount, r.depth, r.nodeId ?? ""]));
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.setRows(rows);
    this.dirty = true;
    this.shellDirty = true;
  }

  private setRows(rows: TreeRow[]): void {
    this.rows = rows;
    // Rows arrive pre-order flattened — the parent of a row is the most
    // recent row at depth-1. Keys: nodeId when the collector provided one,
    // else a positional label path (stable while the tree shape holds).
    const stack: string[] = [];
    this.keys = rows.map((r, i) => {
      const parent = r.depth > 0 ? (stack[r.depth - 1] ?? "") : "";
      const k = r.nodeId ?? `${parent}/${r.label}@${i}`;
      stack[r.depth] = k;
      stack.length = r.depth + 1;
      return k;
    });
    const present = new Set(this.keys);
    for (const k of [...this.collapsed]) if (!present.has(k)) this.collapsed.delete(k);
    if (this.selKey && !present.has(this.selKey)) {
      this.selKey = null;
      this.selRowId = null;
      this.details = null;
    }
  }

  /** Rows minus descendants of folded parents. */
  private visibleRows(): { row: TreeRow; key: string }[] {
    const out: { row: TreeRow; key: string }[] = [];
    const skipDepths: number[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]!;
      const k = this.keys[i]!;
      while (skipDepths.length && r.depth <= skipDepths[skipDepths.length - 1]!) skipDepths.pop();
      if (!skipDepths.length) out.push({ row: r, key: k });
      if (r.childCount > 0 && this.collapsed.has(k)) skipDepths.push(r.depth);
    }
    return out;
  }

  private localDetails(r: TreeRow): string {
    return [
      `label: ${r.label}`,
      r.detail ? `detail: ${r.detail}` : "",
      `kind: ${r.kind === 1 ? "ecs entity" : "scene node"}`,
      `children: ${r.childCount}`,
      `depth: ${r.depth}`,
      r.nodeId ? `nodeId: ${r.nodeId}` : "nodeId: (none — pick can't reach the inspector)",
    ].filter(Boolean).join("\n");
  }

  private async loadDetails(row: TreeRow, key: string): Promise<void> {
    this.details = { title: row.label, body: this.localDetails(row) };
    this.shellDirty = true;
    const nodeId = row.nodeId;
    if (!nodeId) return;
    // Best-effort inspector enrichment + in-scene selection highlight.
    try {
      await this.ctx.call("inspector.call", { method: "selectNode", args: [nodeId] });
    } catch { /* inspector absent or id unknown — local details stand */ }
    try {
      const json = await this.ctx.call("inspector.call", { method: "getNodeJSON", args: [nodeId] });
      // A newer pick while this call was in flight wins.
      if (this.selKey === key && typeof json === "string" && json) {
        this.details = { title: row.label, body: json };
        this.shellDirty = true;
      }
    } catch { /* no inspector — keep the row-level details */ }
  }

  // ── Events ──

  onBackendEvent(event: string, data: unknown): void {
    // "scene" pushes feed scene mode; "dom" pushes feed ECS mode.
    if (event === "scene" && this.mode === "scene") {
      this.applyRows((data as TreeRow[]) ?? []);
    } else if (event === "dom" && this.mode === "ecs") {
      this.applyRows((data as TreeRow[]) ?? []);
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    const act = data.action;
    if (act === "el.refresh") {
      void this.refresh();
    } else if (act === "el.mode") {
      const m = data.mode as Mode;
      if ((m === "scene" || m === "ecs") && m !== this.mode) {
        this.mode = m;
        this.selKey = null;
        this.selRowId = null;
        this.details = null;
        this.collapsed.clear();
        this.shellDirty = true;
        // Point the backend's periodic push at the mode being viewed.
        void this.ctx.call("domTree.mode", { mode: m }).catch(() => {});
        void this.refresh();
      }
    } else if (act === "el.fold") {
      const id = Number(data.node);
      const i = this.rows.findIndex((r) => r.id === id);
      if (i < 0) return;
      const key = this.keys[i]!;
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      this.dirty = true;
      this.shellDirty = true;
    } else if (act === "el.pick") {
      this.pick(Number(data.node));
    } else if (act === "el.unpick") {
      this.unpick();
    }
  }

  private pick(id: number): void {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const row = this.rows[i]!;
    const key = this.keys[i]!;
    this.selKey = key;
    // Flip .sel via targeted mutations instead of a body re-render —
    // reparse would reset the scrollport mid-browse. Falls back to a full
    // render on backends without incremental ops.
    const ops: DocMutation[] = [];
    if (this.selRowId !== null && this.selRowId !== id) {
      ops.push({ op: "attr", sel: `[data-node="${this.selRowId}"]`, name: "class", value: "trow" });
    }
    ops.push({ op: "attr", sel: `[data-node="${id}"]`, name: "class", value: "trow sel" });
    this.ctx.mutate(ops);
    this.selRowId = id;
    void this.loadDetails(row, key);
  }

  private unpick(): void {
    if (this.selRowId !== null) {
      this.ctx.mutate([{ op: "attr", sel: `[data-node="${this.selRowId}"]`, name: "class", value: "trow" }]);
    }
    this.selKey = null;
    this.selRowId = null;
    this.details = null;
    this.shellDirty = true;
    void this.ctx.call("inspector.call", { method: "selectNode", args: [null] }).catch(() => {});
  }

  onEvent(ev: OsrDomEvent): void {
    if (ev.t === "scroll" && ev.id === "dt-body") {
      this.lastScrollTop = ev.st ?? 0;
    }
  }

  activate(): void {
    // Keep the backend's push mode aligned with what's on screen.
    void this.ctx.call("domTree.mode", { mode: this.mode }).catch(() => {});
    void this.refresh();
  }

  afterRender(): void {
    // Body reparse dropped the scroll position — put it back.
    if (this.lastScrollTop > 0) this.ctx.scrollTo("#dt-body", 0, this.lastScrollTop);
  }

  private async refresh(): Promise<void> {
    try {
      const rows = this.mode === "scene"
        ? await this.ctx.call("sceneTree")
        : await this.ctx.call("domTree", { mode: "ecs" });
      this.lastError = "";
      this.applyRows((rows as TreeRow[]) ?? []);
    } catch (err) {
      // Keep the last good tree; surface the failure instead of blanking.
      this.lastError = `refresh failed: ${String(err)}`;
    }
    this.dirty = true;
    this.shellDirty = true;
  }
}
