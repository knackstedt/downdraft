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

interface ConsoleRow { text: string; severity: number; thread: string; seq: number }

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
  /** Monotonic row id — the incremental path appends only rows newer
   *  than `appendedSeq`. */
  private seq = 0;
  /** seq watermark: rows ≤ this are already in the DOM (or trimmed). */
  private appendedSeq = -1;
  /** The DOM currently shows the empty-state note — the first append must
   *  go through a full render to drop it. */
  private domEmpty = true;
  /** Next dirty flush must rebuild #dt-body wholesale (filter/severity
   *  change, clear, remount, or a backend without appendHtml). */
  private needsFullRender = true;

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
    const shown = this.shownRows().slice(-RENDER_ROWS);
    // The DOM now reflects this render — the append watermark resumes at
    // the last shown row, and whether the empty-note is mounted.
    this.appendedSeq = shown.length ? shown[shown.length - 1]!.seq : this.seq - 1;
    this.domEmpty = shown.length === 0;
    this.needsFullRender = false;
    const html = shown.map((r) => this.rowHtml(r)).join("");
    return `<div class="console-log">${html || `<div class="empty-note">console is empty</div>`}</div>`;
  }

  /**
   * Incremental flush — append only the new rows and trim the DOM back to
   * RENDER_ROWS, instead of shipping a whole rebuilt log for reparse.
   * Returns false when a full renderBody() render is required.
   */
  flushDom(): boolean {
    if (!this.ctx.incrementalDom || this.needsFullRender) return false;
    const shown = this.shownRows();
    const fresh: ConsoleRow[] = [];
    for (let i = shown.length - 1; i >= 0; i--) {
      if (shown[i]!.seq <= this.appendedSeq) break;
      fresh.push(shown[i]!);
    }
    // An append into the empty-note state would leave the note behind —
    // full-render instead.
    if (fresh.length && this.domEmpty) return false;
    if (fresh.length) {
      const html = fresh.reverse().map((r) => this.rowHtml(r)).join("");
      this.appendedSeq = fresh[fresh.length - 1]!.seq;
      this.domEmpty = false;
      this.ctx.mutate([
        { op: "appendHtml", sel: ".console-log", html },
        { op: "trimChildren", sel: ".console-log", keep: RENDER_ROWS },
      ]);
    }
    return true;
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

  private shownRows(): ConsoleRow[] {
    const f = this.filter.toLowerCase();
    return this.rows
      .filter((r) => r.severity >= this.minSev && (!f || r.text.toLowerCase().includes(f)));
  }

  private rowHtml(r: ConsoleRow): string {
    return `<div class="crow sev-${r.severity}" data-sev="${r.severity}"><span class="th">[${esc(r.thread)}]</span>${esc(r.text)}</div>`;
  }

  onBackendEvent(event: string, data: unknown): void {
    if (event === "console") {
      const e = data as { text?: unknown; severity?: number; thread?: string };
      this.rows.push({ text: String(e?.text ?? ""), severity: e?.severity ?? 0, thread: e?.thread ?? "main", seq: this.seq++ });
      if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
      this.dirty = true;
    } else if (event === "console.clear") {
      this.rows = [];
      this.needsFullRender = true;
      this.dirty = true;
    } else if (event === "threads") {
      const list = (data as ThreadInfo[]) ?? [];
      const next = [{ id: "main", name: "main", kind: 0 }, ...list.filter((t) => t.id !== "main")];
      // Thread chips live in the bottom chrome — flag it so the row
      // actually re-renders when a worker appears or disappears.
      const changed = next.length !== this.threads.length
        || next.some((t, i) => t.id !== this.threads[i]!.id || t.name !== this.threads[i]!.name);
      this.threads = next;
      if (!this.threads.some((t) => t.id === this.replThread)) {
        this.replThread = "main";
        this.shellDirty = true;
      }
      if (changed) this.shellDirty = true;
    }
  }

  onAction(data: Record<string, string>, _ev: OsrDomEvent): void {
    const act = data.action;
    if (act === "console.clear") {
      void this.ctx.call("console.clear").catch(() => {});
    } else if (act === "console.sev") {
      this.minSev = (this.minSev + 1) % SEV_NAMES.length;
      this.needsFullRender = true;
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
      this.needsFullRender = true;
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
      } else if (ev.k === "ArrowDown" && this.histIdx >= 0 && this.histIdx < this.history.length) {
        // Stepping past the newest entry restores the empty input —
        // previously the last history item was unreachable-to-leave.
        this.histIdx++;
        this.replValue = this.histIdx < this.history.length ? this.history[this.histIdx]! : "";
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

  private addRow(r: Omit<ConsoleRow, "seq">): void {
    this.rows.push({ ...r, seq: this.seq++ });
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
          text: typeof r === "string" ? r : (r === undefined ? "undefined" : JSON.stringify(r, null, 2)),
          severity: 0, thread: this.replThread,
        });
      }
    } catch (e) {
      this.addRow({ text: String(e), severity: 3, thread: "devtools" });
    }
  }
}
