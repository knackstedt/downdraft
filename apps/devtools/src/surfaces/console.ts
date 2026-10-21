// ============================================================================
// console.ts — the console REPL surface. The flagship panel.
//
// A custom GPU surface (graphic-notes style): a scrollable transcript of
// console entries + a real multiline code editor input with syntax
// highlighting, async eval states, expandable remote objects, thread-aware
// rows, severity filters, and click-to-source linking.
//
// Beyond Chrome: async rows show pending/resolved state inline; thread tags
// on every row; per-thread eval; severity counts as live toggle pills.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass, Rgba } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens, chroma } from "../app/theme";
import type { ConsoleEntry, RemoteObjectRef, Severity } from "../targets/model";
import type { TargetSession } from "../targets/session";
import type { PanelCtx } from "../ui/panels";
import { EditorView, clipboardGet, clipboardSet } from "./editor";
import { isCompleteExpression, lineTokens, freshLexState } from "../syntax/js";
import { previewRemote, remoteKind } from "../targets/preview";
import { store } from "../app/store";
import { revealSource } from "../ui/drawer";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

const LH_ = 16;
const SIZE = 11;
const GU_ = 14;
const FH_ = 28;
const SH_ = 20;
const EP_ = 8;

interface PropNode {
  name: string;
  ref: RemoteObjectRef | undefined;
  expanded: boolean;
  loading: boolean;
  children: PropNode[] | null;
}

interface HitZone { x: number; y: number; w: number; h: number; act: () => void; }

const SEV_COLOR: Record<Severity, () => string> = {
  0: () => tokens().textDim,
  1: () => tokens().text,
  2: () => tokens().warn,
  3: () => tokens().error,
  4: () => tokens().textFaint,
  5: () => tokens().textFaint,
};

const KIND_CLR = { num: "synNumber", str: "synString", obj: "synType", fn: "synBuiltin", kw: "synKeyword", err: "synError" } as const;

function sevOf(e: ConsoleEntry): Severity { return e.severity; }

export class ConsoleSurface extends TextSurface {
  private pctx: PanelCtx;
  private editor: EditorView;
  private focused = true;
  private filterText = "";
  private filterFocus = false;
  private sevFilter = new Set<Severity>();
  private threadFilter: string | null = null;
  private replThread = "main";
  private history: string[] = [];
  private histIdx = -1;
  private histStash = "";
  private expanded = new Map<number, { node: PropNode }>();
  private rowHeights = new Map<number, { w: number; h: number; sig: string }>();
  private rangePre = 0;
  private rangePost = 0;
  private hit: HitZone[] = [];
  private stickBottom = true;
  private dragging = false;

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    this.editor = new EditorView(cache, {
      lineHeight: this.z(LH_), padX: this.z(EP_), padY: 4, gutterW: 16, readonly: false, lineNumbers: false,
    });
    this.installConsoleInput();
  }

  private get session(): TargetSession | null { return this.pctx.session(); }

  // ── Input ────────────────────────────────────────────────────────

  private installConsoleInput(): void {
    const bus = this.ctx.getInputBus();

    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) {
        this.focused = false;
        return;
      }
      this.focused = true;
      ctrl.stopPropagation();
      // Hit zones first (pills, links, expanders, filter bar).
      const relY = e.clientY - this.rect.y;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { hz.act(); this.dirty = true; return; }
      if (relY < this.z(FH_)) {
        // Click in filter bar empty space = focus filter.
        this.filterFocus = true;
        return;
      }
      this.filterFocus = false;
      if (this.inEditor(e.clientX, e.clientY)) {
        const pos = this.editorPosAt(e.clientX, e.clientY);
        this.editor.model.cursor = pos;
        this.editor.model.anchor = null;
        this.dragging = true;
      }
    }, 30));

    this.unsubs.push(bus.onPointerMove((e) => {
      if (!this.dragging) return;
      const pos = this.editorPosAt(e.clientX, e.clientY);
      if (!this.editor.model.anchor) this.editor.model.anchor = { ...this.editor.model.cursor };
      this.editor.model.cursor = pos;
      this.dirty = true;
    }, 30));

    this.unsubs.push(bus.onPointerUp(() => { this.dragging = false; }, 30));

    this.unsubs.push(bus.onKeyDown((e, ctrl) => {
      if (!this.active || !this.focused) return;
      if (this.filterFocus) {
        // Ignore modified printable keys (ctrl+a mustn't type 'a').
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          this.filterText += e.key;
          this.dirty = true;
          ctrl.stopPropagation();
          return;
        }
        if (this.handleFilterKey(e)) ctrl.stopPropagation();
        return;
      }
      // Printable text input arrives as single-char keys.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        this.editor.model.insertText(e.key);
        this.histIdx = -1;
        this.dirty = true;
        ctrl.stopPropagation();
        return;
      }
      if (this.handleKey(e)) ctrl.stopPropagation();
    }, 50));
  }

  private handleFilterKey(e: { key: string }): boolean {
    if (e.key === "Backspace") {
      this.filterText = this.filterText.slice(0, -1);
      this.dirty = true;
      return true;
    }
    if (e.key === "Escape" || e.key === "Enter") {
      this.filterFocus = false;
      if (e.key === "Escape") this.filterText = "";
      this.dirty = true;
      return true;
    }
    return false;
  }

  private handleKey(e: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
    const m = this.editor.model;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    this.dirty = true;

    if (mod) {
      switch (k.toLowerCase()) {
        case "a": m.selectAll(); return true;
        case "c": {
          const t = m.selectedText();
          if (t) clipboardSet(t);
          return true;
        }
        case "x": {
          const t = m.selectedText();
          if (t) { clipboardSet(t); m.backspace(); }
          return true;
        }
        case "v": {
          const t = clipboardGet();
          if (t) Array.from(t).forEach((ch) => { if (ch === "\n") m.newline(); else m.insertText(ch); });
          return true;
        }
        case "z": return e.shiftKey ? m.redo() : m.undo();
        case "y": return m.redo();
        case "l": case "k": {
          void this.session?.consoleClear();
          return true;
        }
        case "enter": this.submit(true); return true;
        case "arrowleft": m.move("docHome", e.shiftKey); return true;
        case "arrowright": m.move("docEnd", e.shiftKey); return true;
        case "backspace": m.deleteWordBack(); return true;
      }
      return true; // swallow other ctrl combos
    }

    switch (k) {
      case "Enter": {
        if (e.shiftKey || !isCompleteExpression(m.text())) m.newline();
        else this.submit();
        return true;
      }
      case "Tab": m.insertText("  "); return true;
      case "Backspace": m.backspace(); return true;
      case "Delete": m.deleteForward(); return true;
      case "ArrowLeft": m.move("left", e.shiftKey); return true;
      case "ArrowRight": m.move("right", e.shiftKey); return true;
      case "ArrowUp": {
        if (m.cursor.row === 0 && !e.shiftKey) return this.histNav(-1) ? true : (m.move("up", false), true);
        m.move("up", e.shiftKey);
        return true;
      }
      case "ArrowDown": {
        if (m.cursor.row === m.lines.length - 1 && !e.shiftKey) return this.histNav(1) ? true : (m.move("down", false), true);
        m.move("down", e.shiftKey);
        return true;
      }
      case "Home": m.move("home", e.shiftKey); return true;
      case "End": m.move("end", e.shiftKey); return true;
      case "PageUp": this.scrollTarget -= this.rect.h * 0.9; this.stickBottom = false; return true;
      case "PageDown": this.scrollTarget += this.rect.h * 0.9; return true;
    }
    return false;
  }

  private histNav(dir: -1 | 1): boolean {
    const h = this.history;
    if (!h.length) return false;
    if (dir < 0) {
      if (this.histIdx === -1) {
        this.histStash = this.editor.model.text();
        this.histIdx = h.length - 1;
      } else if (this.histIdx > 0) this.histIdx--;
      else return true;
      this.editor.model.setText(h[this.histIdx]!);
      this.editor.clearHighlights();
      return true;
    }
    if (this.histIdx === -1) return false;
    this.histIdx++;
    if (this.histIdx >= h.length) {
      this.histIdx = -1;
      this.editor.model.setText(this.histStash);
    } else {
      this.editor.model.setText(h[this.histIdx]!);
    }
    this.editor.clearHighlights();
    return true;
  }

  private submit(force = false): void {
    const s = this.session;
    const expr = this.editor.model.text().trimEnd();
    if (!expr) return;
    if (!force && !isCompleteExpression(expr)) { this.editor.model.newline(); return; }
    this.history.push(expr);
    if (this.history.length > 300) this.history.shift();
    this.histIdx = -1;
    this.editor.model.setText("");
    this.editor.clearHighlights();
    this.stickBottom = true;
    if (!s) {
      log.warn("console", "no session");
      return;
    }
    s.repl(expr, this.replThread).catch((e) => s.systemNote(`eval failed: ${e}`, 3));
  }

  // ── Layout ───────────────────────────────────────────────────────

  private editorH(): number {
    return Math.min(6, Math.max(1, this.editor.model.lines.length)) * this.z(LH_) + this.z(EP_) * 2 + this.z(SH_);
  }

  private inEditor(x: number, y: number): boolean {
    const r = this.rect;
    return y >= r.y + r.h - this.editorH() && x >= r.x;
  }

  private editorPosAt(x: number, y: number): { row: number; col: number } {
    const r = this.rect;
    const ey = r.y + r.h - this.editorH() + this.z(EP_);
    return this.editor.posAt(x, y, ey, r.x);
  }

  protected onWheel(dy: number, x: number, y: number): void {
    if (this.inEditor(x, y)) {
      this.editor.scrollY = Math.max(0, this.editor.scrollY + dy);
      this.dirty = true;
      return;
    }
    if (dy < 0) this.stickBottom = false;
    super.onWheel(dy, x, y);
  }

  protected contentHeight(): number { return 1 << 20; } // clamped by rows in draw
  protected override scrollHint = false; // console draws its own scrollbar

  // ── Filtering / row heights ─────────────────────────────────────

  private filtered(): ConsoleEntry[] {
    const s = this.session;
    if (!s) return [];
    let list = s.consoleEntries;
    if (this.sevFilter.size) list = list.filter((e) => this.sevFilter.has(sevOf(e)) || e.source === "repl-echo" || e.source === "repl-result");
    if (this.threadFilter) list = list.filter((e) => e.thread === this.threadFilter);
    if (this.filterText) {
      const re = new RegExp(this.filterText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      // Entries often carry an empty `text` with the visible message in the
      // arg previews (Error descriptions etc.) — match what the row draws.
      list = list.filter((e) =>
        re.test(e.text) || re.test(e.url ?? "") ||
        (e.args ?? []).slice(0, 4).some((a) => re.test(previewRemote(a))));
    }
    return list;
  }

  private rowH(e: ConsoleEntry, w: number): number {
    // Key includes a cheap content signature — merged mirror/CDP rows mutate
    // their text after first layout, and a stale cached height is what made
    // rows overlap ("boiling").
    const sig = `${e.text.length}:${e.args?.length ?? 0}:${this.expanded.has(e.seq) ? 1 : 0}`;
    const c = this.rowHeights.get(e.seq);
    if (c && c.w === w && c.sig === sig) return c.h;
    const textW = w - this.z(GU_) - this.z(90);
    const h = this.wrapCount(e, textW) * this.z(LH_) + this.z(4) + this.expandedH(e);
    this.rowHeights.set(e.seq, { w, h, sig });
    if (this.rowHeights.size > 4000) this.rowHeights.clear();
    return h;
  }

  /** Height in px of the expanded property tree under an entry. */
  private expandedH(e: ConsoleEntry): number {
    const exp = this.expanded.get(e.seq);
    if (!exp) return 0;
    const countRows = (n: PropNode, depth: number): number => {
      if (depth > 6) return 0;
      let rows = n.loading ? 1 : (n.children?.length ?? 0);
      if (n.children) {
        n.children.forEach((c) => {
          if (c.expanded) rows += Math.max(1, countRows({ ...c, children: c.children, loading: c.loading }, depth + 1));
        });
      }
      return Math.min(rows, 400);
    };
    return countRows(exp.node, 0) * this.z(LH_);
  }

  /** Wrapped-line count for an entry at width w. */
  private wrapCount(e: ConsoleEntry, w: number): number {
    const text = e.text;
    if (!text) return 1;
    const run = this.cache.getRun(MONO(), SIZE, text);
    if (!run) return Math.max(1, Math.ceil((text.length * SIZE * 0.5) / w));
    const offs = run.clusterOffsets;
    let lines = 1;
    let base = 0;
    let lastBreak = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\n") { lines++; base = offs[i + 1]!; lastBreak = -1; continue; }
      if (ch === " " || ch === "-") lastBreak = i;
      if (offs[i + 1]! - base > w) {
        lines++;
        if (lastBreak > 0) { base = offs[lastBreak + 1]!; i = lastBreak; lastBreak = -1; }
        else base = offs[i]!;
      }
    }
    return lines;
  }

  // ── Draw ─────────────────────────────────────────────────────────

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];

    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    const s = this.session;

    this.drawFilterBar(pass, s);
    this.rangePre = pass.quadCount;
    if (s) this.drawTranscript(pass, s);
    else {
      this.drawText(pass, MONO(), SIZE, "no target attached — pick one in the sidebar or attach via MCP",
        r.x + 16, r.y + this.z(FH_) + 30, hex(t.textFaint));
    }
    this.rangePost = pass.quadCount;
    this.drawEditor(pass);
  }

  /** Transcript quads clip to the transcript band; chrome gets the panel. */
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    const top = r.y + this.z(FH_);
    const band: [number, number, number, number] = [r.x, top, r.w, Math.max(0, r.h - this.z(FH_) - this.editorH())];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }

  private drawFilterBar(pass: GpuTextPass, s: TargetSession | null): void {
    const t = tokens();
    const r = this.rect;
    const y = r.y;
    const fh = this.z(FH_);
    pass.rect(r.x, y, r.w, fh, hex(t.bgRaised));
    pass.rect(r.x, y + fh - 1, r.w, 1, hex(t.borderSoft));

    const fs = SIZE - 1;
    const pad = this.z(4);
    const bh = fh - pad * 2;
    const by = y + pad;
    const base = this.vcenter(by, bh, fs);
    const padX = this.z(8);

    let x = r.x + this.z(8);

    // Filter field.
    const fw = Math.min(this.z(200), r.w * 0.3);
    this.rrect(pass, x, by, fw, bh, this.z(4),
      hex(this.filterFocus ? t.bgSunken : t.bgPanel),
      hex(this.filterFocus ? t.border : t.borderSoft));
    this.drawText(pass, MONO(), fs, this.filterText || "filter…",
      x + this.z(6), base, hex(this.filterText ? t.text : t.textFaint), fw - this.z(18));
    if (this.filterText) {
      this.drawText(pass, MONO(), fs, "×", x + fw - this.z(14), base, hex(t.textDim));
      this.hit.push({ x: x + fw - this.z(18), y: by, w: this.z(18), h: bh,
        act: () => { this.filterText = ""; this.filterFocus = false; } });
    }
    this.hit.push({ x, y: by, w: fw, h: bh, act: () => { this.filterFocus = true; } });
    x += fw + this.z(8);

    // Severity pills with live counts.
    if (s) {
      const counts = [0, 0, 0, 0, 0, 0];
      s.consoleEntries.forEach((e) => { counts[e.severity]!++; });
      const pills: [Severity, string][] = [[0, "log"], [1, "info"], [2, "warn"], [3, "err"], [4, "dbg"]];
      pills.forEach(([sev, label]) => {
        const on = this.sevFilter.size === 0 || this.sevFilter.has(sev);
        const labelText = `${label} ${counts[sev]}`;
        const w = this.measure(MONO(), fs, labelText) + padX * 2;
        this.rrect(pass, x, by, w, bh, bh / 2,
          on ? chroma(t.accent, 0.18) : hex(t.bgPanel),
          hex(on ? t.border : t.borderSoft));
        this.drawText(pass, MONO(), fs, labelText, x + padX, base, hex(SEV_COLOR[sev]()));
        const cx = x;
        this.hit.push({
          x: cx, y: by, w, h: bh, act: () => {
            if (this.sevFilter.has(sev)) this.sevFilter.delete(sev);
            else this.sevFilter.add(sev);
          },
        });
        x += w + this.z(6);
      });

      // Thread pill.
      const thr = `⟨${this.threadFilter ?? "all threads"}⟩`;
      const tw = this.measure(MONO(), fs, thr) + padX * 2;
      this.rrect(pass, x, by, tw, bh, bh / 2, hex(t.bgPanel), hex(t.borderSoft));
      this.drawText(pass, MONO(), fs, thr, x + padX, base, hex(t.accent));
      const tx = x;
      this.hit.push({
        x: tx, y: by, w: tw, h: bh, act: () => {
          const ids = [null, ...s.threads.map((th) => th.id)];
          const i = ids.indexOf(this.threadFilter);
          this.threadFilter = ids[(i + 1) % ids.length] as string | null;
        },
      });
      x += tw + this.z(8);
    }

    // Clear button (right side).
    const cw = this.measure(MONO(), fs, "clear") + padX * 2;
    const cx0 = r.x + r.w - cw - this.z(6);
    this.rrect(pass, cx0, by, cw, bh, bh / 2, hex(t.bgPanel), hex(t.borderSoft));
    this.drawText(pass, MONO(), fs, "clear", cx0 + padX, base, hex(t.textDim));
    this.hit.push({
      x: cx0, y: by, w: cw, h: bh,
      act: () => { void s?.consoleClear(); },
    });
  }

  private drawTranscript(pass: GpuTextPass, _s: TargetSession): void {
    const t = tokens();
    const r = this.rect;
    const top = r.y + this.z(FH_);
    const bottom = r.y + r.h - this.editorH();
    const viewH = bottom - top;
    if (viewH <= 0) return;

    const rows = this.filtered();
    // Total height + stick-to-bottom.
    const textW = r.w - this.z(GU_) - 90;
    let total = 0;
    const heights = Array.from<number>({ length: rows.length });
    for (let i = 0; i < rows.length; i++) {
      heights[i] = this.rowH(rows[i]!, textW);
      total += heights[i]!;
    }
    const maxScroll = Math.max(0, total - viewH);
    if (this.stickBottom) { this.scrollTarget = maxScroll; this.scrollY = maxScroll; }
    else {
      this.scrollTarget = Math.min(maxScroll, this.scrollTarget);
      this.scrollY = Math.min(maxScroll, this.scrollY);
    }

    let y = top - this.scrollY;
    const baseline0 = this.z(LH_) * 0.72;

    for (let i = 0; i < rows.length; i++) {
      const e = rows[i]!;
      const h = heights[i]!;
      if (y + h < top) { y += h; continue; }
      if (y > bottom) break;

      const sev = sevOf(e);
      const sevClr = hex(SEV_COLOR[sev]());
      const isEcho = e.source === "repl-echo";
      const isResult = e.source === "repl-result";
      const isSys = e.source === "system";
      const rowY = y;

      // Alternating row shade — keeps long transcripts scannable.
      if (i % 2 === 1) pass.rect(r.x, rowY, r.w - this.z(6), h, chroma(t.bg, 0.5));

      // Severity gutter bar.
      if (!isEcho && !isResult) {
        pass.rect(r.x, rowY + 2, 3, h - 4, sev === 0 ? hex(t.borderSoft) : sevClr);
      }

      let tx = r.x + this.z(GU_);

      // Echo/result markers.
      if (isEcho) {
        this.drawText(pass, MONO(600), SIZE, "›", r.x + 4, rowY + 2 + baseline0, hex(t.accent));
      } else if (isResult) {
        const pend = e.asyncState === "pending";
        const clr = e.asyncState === "rejected" ? t.err : pend ? t.warn : t.ok;
        this.drawText(pass, MONO(600), SIZE, pend ? "…" : "‹", r.x + 4, rowY + 2 + baseline0, hex(clr));
        if (pend) {
          // animated pulse bar
          const ph = (this.time * 2) % 1;
          pass.rect(tx, rowY + h - 3, (textW * ph), 1.5, chroma(t.warn, 0.6));
        }
      } else if (isSys) {
        this.drawText(pass, MONO(), SIZE, "·", r.x + 5, rowY + 2 + baseline0, hex(t.textFaint));
      } else {
        const expandable = e.args?.some((a) => a.expandable);
        const isErr = sev >= 3;
        const isWarn = sev === 2;
        if (expandable) {
          const open = this.expanded.has(e.seq);
          this.drawText(pass, MONO(), SIZE, open ? "▾" : "▸", r.x + 4, rowY + 2 + baseline0, hex(t.textFaint));
          this.hit.push({
            x: r.x, y: rowY, w: this.z(GU_) + 6, h,
            act: () => this.toggleExpand(e),
          });
        } else if (isErr) {
          this.drawText(pass, MONO(600), SIZE, "✕", r.x + 4, rowY + 2 + baseline0, sevClr);
        } else if (isWarn) {
          this.drawText(pass, MONO(600), SIZE, "▲", r.x + 4, rowY + 2 + baseline0, sevClr);
        }
      }

      // Main text — syntax-highlighted for echoes, plain colored otherwise.
      const textClr = isSys ? hex(t.textFaint) : isEcho ? hex(t.text)
        : isResult && e.asyncState === "rejected" ? hex(t.err)
        : isResult ? hex(t.text) : sev === 0 ? hex(t.text) : sevClr;
      let lastLineW = 0;
      let linesUsed = e.text ? 1 : 0;
      if (e.text) {
        if (isEcho) {
          this.drawHighlighted(pass, e.text, tx, rowY + 2, textW, baseline0, textClr);
        } else {
          const wr = this.drawWrapped(pass, e.text, tx, rowY + 2, textW, baseline0, textClr);
          lastLineW = wr.lastW;
          linesUsed = wr.lines;
        }
      }
      // Structured args — inline after the last text line (or first line
      // when the entry is args-only).
      if (e.args && !isEcho) {
        let ax = tx + Math.min(lastLineW + 12, textW * 0.9);
        const ay = rowY + 2 + Math.max(0, linesUsed - 1) * this.z(LH_) + baseline0;
        const textNorm = e.text.trim();
        e.args.slice(0, 4).forEach((a) => {
          const prev = previewRemote(a);
          // Skip previews that restate the row text (merged Error args, etc.)
          // — the expand caret still exposes the remote object.
          const bare = prev.replace(/^"|"$/g, "").trim();
          if (bare === textNorm && a.expandable) return;
          const kind = remoteKind(a);
          const clrTok = KIND_CLR[kind];
          const clr = clrTok === "synError" ? t.err : t[clrTok as keyof typeof t] as string;
          ax += this.drawText(pass, MONO(), SIZE, prev, ax, ay, hex(clr), 300) + 8;
        });
      }

      // Expanded remote-object tree.
      const exp = this.expanded.get(e.seq);
      if (exp) this.drawProps(pass, exp.node, tx + 12, rowY + 2 + Math.max(1, linesUsed) * this.z(LH_), textW - 12);

      // Right meta: source link (right-aligned so long filenames never clip),
      // then the thread tag to its left.
      let metaX = r.x + r.w - this.z(10);
      if (e.url) {
        const file = e.url.split("/").pop() ?? e.url;
        const link = `${file}:${e.line ?? ""}`;
        const lw = this.measure(MONO(), SIZE - 2, link);
        this.drawText(pass, MONO(), SIZE - 2, link, metaX - lw, rowY + 2 + baseline0, hex(t.link));
        this.hit.push({
          x: metaX - lw - 2, y: rowY, w: lw + 4, h: Math.min(h, this.z(LH_) + 4),
          act: () => this.openSource(e),
        });
        metaX -= lw + this.z(10);
      }
      if (e.thread && e.thread !== "main") {
        const tag = `⟨${e.thread}⟩`;
        const tw = this.measure(MONO(), SIZE - 2, tag);
        this.drawText(pass, MONO(), SIZE - 2, tag, metaX - tw, rowY + 2 + baseline0, hex(t.accent2));
      }
      y += h;
    }

    // Scrollbar — thin track + thumb on the right edge.
    if (total > viewH) {
      const trackX = r.x + r.w - this.z(5);
      pass.rect(trackX, top, this.z(3), viewH, chroma(t.bgSunken, 0.9));
      const thumbH = Math.max(this.z(18), viewH * (viewH / total));
      const thumbY = top + (viewH - thumbH) * (this.scrollY / maxScroll || 0);
      pass.rect(trackX - 1, thumbY, this.z(5), thumbH, chroma(t.textFaint, 0.55));
    }

    // "Jump to latest" pill when scrolled up.
    if (!this.stickBottom && maxScroll - this.scrollY > 40) {
      const label = "↓ jump to latest";
      const bw = this.measure(MONO(), SIZE, label) + this.z(20), bh = this.z(22);
      const bx = r.x + r.w / 2 - bw / 2, byy = bottom - bh - this.z(6);
      this.rrect(pass, bx, byy, bw, bh, bh / 2, hex(t.bgRaised), hex(t.border));
      this.drawText(pass, MONO(), SIZE, label, bx + this.z(10), this.vcenter(byy, bh, SIZE), hex(t.accent));
      this.hit.push({
        x: bx, y: byy, w: bw, h: bh, act: () => { this.stickBottom = true; },
      });
    }
  }

  private toggleExpand(e: ConsoleEntry): void {
    if (this.expanded.has(e.seq)) {
      this.expanded.delete(e.seq);
      this.rowHeights.delete(e.seq);
      return;
    }
    const s = this.session;
    const root: PropNode = { name: "", ref: e.args?.find((a) => a.expandable), expanded: true, loading: true, children: null };
    this.expanded.set(e.seq, { node: root });
    if (root.ref?.objectId && s) {
      void s.getProperties(root.ref.objectId).then((props) => {
        root.children = props.map((p) => ({ name: p.name, ref: p.value, expanded: false, loading: false, children: null }));
        root.loading = false;
        this.rowHeights.delete(e.seq);
      });
    } else {
      root.children = [];
      root.loading = false;
    }
  }

  private drawProps(pass: GpuTextPass, node: PropNode, x: number, y: number, w: number): void {
    const t = tokens();
    const baseline = this.z(LH_) * 0.72;
    if (node.loading) {
      this.drawText(pass, MONO(), SIZE - 1, "…", x, y + baseline, hex(t.textFaint));
      return;
    }
    (node.children ?? []).slice(0, 60).forEach((p) => {
      if (y > this.rect.y + this.rect.h) return;
      const nameClr = hex(t.synProperty);
      let vx = x + this.drawText(pass, MONO(), SIZE - 1, `${p.name}:`, x, y + baseline, nameClr) + 4;
      if (p.ref) {
        const prev = previewRemote(p.ref, 1);
        const kind = remoteKind(p.ref);
        const clr = kind === "err" ? t.err : t[KIND_CLR[kind] as keyof typeof t] as string;
        vx += this.drawText(pass, MONO(), SIZE - 1, prev, vx, y + baseline, hex(clr), w - 60);
      } else {
        this.drawText(pass, MONO(), SIZE - 1, "undefined", vx, y + baseline, hex(t.textFaint));
      }
      if (p.ref?.expandable) {
        // nested expansion — one click level at a time
        this.hit.push({
          x: x - 12, y, w: 14, h: this.z(LH_),
          act: () => {
            p.expanded = !p.expanded;
            if (p.expanded && !p.children && p.ref?.objectId && this.session) {
              p.loading = true;
              void this.session.getProperties(p.ref.objectId).then((props) => {
                p.children = props.map((q) => ({ name: q.name, ref: q.value, expanded: false, loading: false, children: null }));
                p.loading = false;
              });
            }
          },
        });
        this.drawText(pass, MONO(), SIZE - 1, p.expanded ? "▾" : "▸", x - 11, y + baseline, hex(t.textFaint));
      }
      y += this.z(LH_);
      if (p.expanded) {
        this.drawProps(pass, p, x + 12, y, w - 12);
        const sub = (n: PropNode, depth: number): number => {
          if (depth > 6) return 0;
          let rows = n.loading ? 1 : (n.children?.length ?? 0);
          n.children?.forEach((c) => { if (c.expanded) rows += sub(c, depth + 1); });
          return rows;
        };
        y += sub(p, 0) * this.z(LH_);
      }
    });
  }

  /** Wrap-and-draw text; returns lines used + last line's drawn width. */
  private drawWrapped(pass: GpuTextPass, text: string, x: number, y: number, w: number, baseline0: number, clr: Rgba): { lines: number; lastW: number } {
    const run = this.cache.getRun(MONO(), SIZE, text);
    if (!run) {
      const dw = this.drawText(pass, MONO(), SIZE, text, x, y + baseline0, clr, w);
      return { lines: 1, lastW: dw };
    }
    const offs = run.clusterOffsets;
    let line = 0;
    let segStart = 0;
    let base = 0;
    let lastBreak = -1;
    let lastW = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\n") {
        lastW = this.drawText(pass, MONO(), SIZE, text.slice(segStart, i), x, y + line * this.z(LH_) + baseline0, clr, w);
        line++; segStart = i + 1; base = offs[i + 1]!; lastBreak = -1;
        continue;
      }
      if (ch === " " || ch === "-") lastBreak = i;
      if (offs[i + 1]! - base > w) {
        const cut = lastBreak > segStart ? lastBreak + 1 : i;
        lastW = this.drawText(pass, MONO(), SIZE, text.slice(segStart, cut), x, y + line * this.z(LH_) + baseline0, clr, w);
        line++; segStart = cut; base = offs[cut]!; lastBreak = -1;
        if (cut === i) i--; // reprocess current char on new line when hard-break
      }
    }
    lastW = this.drawText(pass, MONO(), SIZE, text.slice(segStart), x, y + line * this.z(LH_) + baseline0, clr, w);
    return { lines: line + 1, lastW };
  }

  /** Syntax-highlighted echo rendering (multiline input echoes). */
  private drawHighlighted(pass: GpuTextPass, text: string, x: number, y: number, w: number, baseline0: number, _clr: Rgba): void {
    const t = tokens();
    const lines = text.split("\n");
    let st = freshLexState();
    const clrFor = (k: string): string => {
      const map: Record<string, string> = {
        keyword: t.synKeyword, string: t.synString, template: t.synString, comment: t.synComment,
        number: t.synNumber, type: t.synType, builtin: t.synBuiltin, operator: t.synOperator,
        plain: t.synPlain, property: t.synProperty, regex: t.synString,
      };
      return map[k] ?? t.synPlain;
    };
    lines.forEach((ln, li) => {
      const { toks, end } = lineTokens(ln, st);
      st = end;
      let pen = x;
      toks.forEach((tk) => {
        const seg = ln.slice(tk.s, tk.e);
        pen += this.drawText(pass, MONO(), SIZE, seg, pen, y + li * this.z(LH_) + baseline0, hex(clrFor(tk.k)), w - (pen - x));
      });
      void w;
    });
  }

  private openSource(e: ConsoleEntry): void {
    if (!e.url) return;
    revealSource(e.url, e.line ?? 0, e.col ?? 0);
  }

  private drawEditor(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    const eh = this.editorH();
    const ey = r.y + r.h - eh;

    pass.rect(r.x, ey, r.w, eh, hex(t.bgSunken));
    pass.rect(r.x, ey, r.w, 1, hex(t.borderSoft));

    // Prompt.
    this.drawText(pass, MONO(600), SIZE + 1, "›", r.x + 6, ey + this.z(EP_) + this.z(LH_) * 0.72, hex(t.accent));

    // Status bar (bottom of editor area).
    const s = this.session;
    const ct = store.getState().consoleThread;
    if (ct && ct !== this.replThread) this.replThread = ct;
    const sy = ey + eh - this.z(SH_);
    pass.rect(r.x, sy, r.w, 1, hex(t.borderSoft));
    const pending = s ? s.consoleEntries.reduce((n, e) => n + (e.asyncState === "pending" ? 1 : 0), 0) : 0;
    const threads = s?.threads ?? [];
    // Only threads with a real eval channel can serve the REPL.
    const evalIds = [...new Set(threads.filter((x) => x.evalId || x.id === "main").map((x) => x.evalId ?? x.id))];
    if (evalIds.length && !evalIds.includes(this.replThread)) this.replThread = evalIds[0] ?? "main";
    const thrName = threads.find((x) => x.id === this.replThread || x.evalId === this.replThread)?.name ?? this.replThread;
    const thrLabel = `[${thrName}${evalIds.length > 1 ? " ▾" : ""}]`;
    const tw = this.measure(MONO(), SIZE - 1, thrLabel) + this.z(12);
    const th = this.z(SH_) - this.z(6);
    this.rrect(pass, r.x + this.z(4), sy + this.z(3), tw, th, th / 2, hex(t.bgPanel), hex(t.borderSoft));
    this.drawText(pass, MONO(), SIZE - 1, thrLabel, r.x + this.z(4) + this.z(6), this.vcenter(sy + this.z(3), th, SIZE - 1), hex(t.accent));
    this.hit.push({
      x: r.x + this.z(4), y: sy + this.z(3), w: tw, h: th, act: () => {
        if (evalIds.length === 0) return;
        const i = evalIds.indexOf(this.replThread);
        this.replThread = evalIds[(i + 1) % evalIds.length] ?? "main";
        store.setState({ consoleThread: this.replThread });
      },
    });
    let hint = "⏎ eval · ⇧⏎ newline · ↑↓ history · ⌃L clear";
    if (pending > 0) hint = `⏳ ${pending} pending · ` + hint;
    this.drawText(pass, MONO(), SIZE - 2, hint, r.x + 14 + tw + 12, sy + this.z(SH_) - 7, hex(t.textFaint), r.w - tw - 60);

    // Editor body (line height tracks global zoom).
    this.editor.opts.lineHeight = this.z(LH_);
    this.editor.opts.padX = this.z(EP_);
    this.editor.render(pass, r.x + 18, ey, r.w - 18, eh - this.z(SH_), this.time * 1000);

    // Placeholder when empty.
    if (this.editor.model.text() === "") {
      this.drawText(pass, MONO(), SIZE, "evaluate JavaScript — multiline, async, threads",
        r.x + 18 + this.z(EP_) + 16, ey + this.z(EP_) + this.z(LH_) * 0.72, hex(t.textFaint));
    }
  }
}
