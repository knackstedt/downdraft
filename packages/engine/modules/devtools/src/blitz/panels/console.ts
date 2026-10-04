// ============================================================================
// panels/console.ts — Console panel: streamed log/console entries + per-thread
// REPL eval. Port of packages/devtools-web/panels/console.js.
// ============================================================================

import type { ThreadInfo } from "@downdraft/engine/libraries/devtools";
import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";
import { esc, type DtPanel, type DtPanelCtx } from "./types";

const MAX_ROWS = 2000;
const RENDER_ROWS = 600;
const SEV_NAMES = ["All", "Info+", "Warn+", "Errors"];

interface ConsoleRow { text: string; severity: number; thread: string }

export class ConsolePanel implements DtPanel {
  readonly id = "console";
  readonly title = "Console";
  dirty = true;
  shellDirty = false;

  private ctx: DtPanelCtx;
  private rows: ConsoleRow[] = [];
  private minSev = 0;
  private filter = "";
  private replThread = "main";
  private threads: ThreadInfo[] = [{ id: "main", name: "main", kind: 0 }];
  private history: string[] = [];
  private histIdx = -1;
  private replValue = "";
  /** True while the log tail should stay pinned to the bottom. */
  private stickToBottom = true;

  constructor(ctx: DtPanelCtx) { this.ctx = ctx; }

  renderTop(): string {
    return `<div class="panel-toolbar">
      <span class="dbtn" data-action="console.clear">Clear</span>
      <span class="dbtn" data-action="console.sev">Level: ${SEV_NAMES[this.minSev]}</span>
      <input class="console-filter" data-dt="filter" placeholder="filter" value="${esc(this.filter)}">
      <span class="spacer"></span>
      <span class="count">${this.rows.length} entries</span>
    </div>`;
  }

  renderBody(): string {
    const f = this.filter.toLowerCase();
    const shown = this.rows
      .filter((r) => r.severity >= this.minSev && (!f || r.text.toLowerCase().includes(f)))
      .slice(-RENDER_ROWS);
    const html = shown.map((r, i) =>
      `<div class="crow sev-${r.severity}" data-sev="${r.severity}"><span class="th">[${esc(r.thread)}]</span>${esc(r.text)}</div>`
    ).join("");
    return `<div class="console-log">${html || `<div class="empty-note">console is empty</div>`}<div id="console-end"></div></div>`;
  }

  renderBottom(): string {
    const thr = this.threads.map((t) =>
      `<span class="thr${t.id === this.replThread ? " on" : ""}" data-action="console.thread" data-thread="${esc(t.id)}">${esc(t.name)}</span>`
    ).join("");
    return `<div class="console-repl">
      <span class="prompt">&gt;</span>${thr}
      <input data-dt="repl" placeholder="evaluate JS (Enter to run)" spellcheck="false" value="${esc(this.replValue)}">
    </div>`;
  }

  onBackendEvent(event: string, data: unknown): void {
    if (event === "console") {
      const e = data as { text?: string; severity?: number; thread?: string };
      this.rows.push({ text: e.text ?? "", severity: e.severity ?? 0, thread: e.thread ?? "main" });
      if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
      this.dirty = true;
    } else if (event === "console.clear") {
      this.rows = [];
      this.dirty = true;
    } else if (event === "threads") {
      const list = (data as ThreadInfo[]) ?? [];
      this.threads = [{ id: "main", name: "main", kind: 0 }, ...list.filter((t) => t.id !== "main")];
      if (!this.threads.some((t) => t.id === this.replThread)) this.replThread = "main";
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    const act = data.action;
    if (act === "console.clear") {
      void this.ctx.call("console.clear");
    } else if (act === "console.sev") {
      this.minSev = (this.minSev + 1) % SEV_NAMES.length;
      this.dirty = true;
      this.shellDirty = true;
    } else if (act === "console.thread") {
      const t = data.thread;
      if (t) { this.replThread = t; this.shellDirty = true; }
    }
  }

  onEvent(ev: OsrDomEvent): void {
    // User scroll on the log scrollport releases/re-engages tail pinning —
    // Chrome unpins autoscroll once you scroll away from the bottom.
    if (ev.t === "scroll" && ev.id === "dt-body") {
      this.stickToBottom = (ev.st ?? 0) >= this.maxScroll - 8;
      return;
    }
    const tag = ev.d?.dt;
    if (tag === "filter" && ev.t === "input") {
      this.filter = ev.v ?? "";
      this.dirty = true;
      return;
    }
    if (tag !== "repl") return;
    if (ev.t === "input") {
      this.replValue = ev.v ?? "";
      return;
    }
    if (ev.t === "keydown") {
      if (ev.k === "Enter" && this.replValue.trim()) {
        const expr = this.replValue;
        this.history.push(expr);
        this.histIdx = this.history.length;
        this.replValue = "";
        this.ctx.setValue("[data-dt=repl]", "");
        this.addRow({ text: `> ${expr}`, severity: 0, thread: this.replThread });
        void this.eval(expr);
      } else if (ev.k === "ArrowUp" && this.histIdx > 0) {
        this.replValue = this.history[--this.histIdx]!;
        this.ctx.setValue("[data-dt=repl]", this.replValue);
      } else if (ev.k === "ArrowDown" && this.histIdx < this.history.length - 1) {
        this.replValue = this.history[++this.histIdx]!;
        this.ctx.setValue("[data-dt=repl]", this.replValue);
      }
    }
  }

  private maxScroll = 0;

  afterRender(): void {
    // #dt-body is the scrollport — scrollIntoView can't reach nested
    // containers in Blitz, so pin by absolute offset instead.
    if (this.stickToBottom) this.ctx.scrollTo("#dt-body", 0, 1e9);
    void (async () => {
      const [logEl, body] = await Promise.all([
        this.ctx.getRect(".console-log"),
        this.ctx.getRect("#dt-body"),
      ]);
      if (logEl && body) this.maxScroll = Math.max(0, logEl.h - body.h + 16);
    })();
  }

  private addRow(r: ConsoleRow): void {
    this.rows.push(r);
    this.dirty = true;
  }

  private async eval(expr: string): Promise<void> {
    try {
      const res = await this.ctx.call("eval", { thread: this.replThread, expr }) as
        { result?: unknown; error?: string } | undefined;
      if (res?.error) {
        this.addRow({ text: res.error, severity: 3, thread: this.replThread });
      } else {
        const r = res?.result;
        this.addRow({
          text: typeof r === "string" ? r : JSON.stringify(r, null, 2),
          severity: 0, thread: this.replThread,
        });
      }
    } catch (e) {
      this.addRow({ text: String(e), severity: 3, thread: "devtools" });
    }
  }
}
