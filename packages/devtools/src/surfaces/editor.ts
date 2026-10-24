// ============================================================================
// editor.ts — multiline code editor for GPU surfaces.
//
// EditorModel: lines, cursor, selection, undo/redo — the whole buffer.
// EditorView: hit-testing, scrolling, caret blink, syntax-highlighted render
// into a GpuTextPass via RunCache.
//
// Kept generic — the console input uses it, and the source viewer reuses
// the same rendering path read-only.
// ============================================================================

import { chroma, hex, tokens } from "../app/theme";
import { freshLexState, lineTokens, type LexState, type TokKind } from "../syntax/js";
import type { GpuTextPass, Rgba } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { MONO } from "./text-surface";

export interface Pos { row: number; col: number; }

const cmpPos = (a: Pos, b: Pos): number => a.row - b.row || a.col - b.col;
const clonePos = (p: Pos): Pos => ({ row: p.row, col: p.col });

interface Snapshot { lines: string[]; cursor: Pos; anchor: Pos | null; }

export class EditorModel {
  lines: string[] = [""];
  cursor: Pos = { row: 0, col: 0 };
  anchor: Pos | null = null;          // selection anchor (null = no selection)
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastOpKind = "";
  private seq = 0;

  text(): string { return this.lines.join("\n"); }

  setText(t: string): void {
    this.lines = t.length ? t.split("\n") : [""];
    this.cursor = { row: this.lines.length - 1, col: this.lines[this.lines.length - 1]!.length };
    this.anchor = null;
    this.bump();
  }

  get dirty(): number { return this.seq; }
  private bump(): void { this.seq++; }

  selection(): { a: Pos; b: Pos } | null {
    if (!this.anchor) return null;
    const a = this.anchor, b = this.cursor;
    return cmpPos(a, b) <= 0 ? { a, b } : { a: b, b: a };
  }

  selectedText(): string {
    const sel = this.selection();
    if (!sel) return "";
    if (sel.a.row === sel.b.row) return this.lines[sel.a.row]!.slice(sel.a.col, sel.b.col);
    const parts: string[] = [this.lines[sel.a.row]!.slice(sel.a.col)];
    for (let r = sel.a.row + 1; r < sel.b.row; r++) parts.push(this.lines[r]!);
    parts.push(this.lines[sel.b.row]!.slice(0, sel.b.col));
    return parts.join("\n");
  }

  private snap(): Snapshot {
    return { lines: [...this.lines], cursor: clonePos(this.cursor), anchor: this.anchor && clonePos(this.anchor) };
  }

  private pushUndo(kind: string): void {
    // Coalesce same-kind ops (typing runs become one undo unit).
    if (kind !== this.lastOpKind) {
      this.undoStack.push(this.snap());
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.lastOpKind = kind;
  }
  private breakOp(): void { this.lastOpKind = ""; }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snap());
    this.lines = s.lines; this.cursor = clonePos(s.cursor); this.anchor = s.anchor && clonePos(s.anchor);
    this.breakOp(); this.bump();
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snap());
    this.lines = s.lines; this.cursor = clonePos(s.cursor); this.anchor = s.anchor && clonePos(s.anchor);
    this.breakOp(); this.bump();
    return true;
  }

  private deleteSelection(): boolean {
    const sel = this.selection();
    if (!sel) return false;
    const { a, b } = sel;
    if (a.row === b.row) {
      this.lines[a.row] = this.lines[a.row]!.slice(0, a.col) + this.lines[a.row]!.slice(b.col);
    } else {
      const merged = this.lines[a.row]!.slice(0, a.col) + this.lines[b.row]!.slice(b.col);
      this.lines.splice(a.row, b.row - a.row + 1, merged);
    }
    this.cursor = clonePos(a);
    this.anchor = null;
    return true;
  }

  insertText(s: string): void {
    this.pushUndo("ins");
    this.deleteSelection();
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    this.lines[row] = line.slice(0, col) + s + line.slice(col);
    this.cursor.col += s.length;
    this.bump();
  }

  newline(): void {
    this.pushUndo("nl");
    this.deleteSelection();
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    const before = line.slice(0, col);
    const after = line.slice(col);
    // Auto-indent: carry the line's leading whitespace.
    const indent = (before.match(/^\s*/) ?? [""])[0] +
      (/[{[(]\s*$/.test(before) ? "  " : "");
    this.lines.splice(row, 1, before, indent + after);
    this.cursor = { row: row + 1, col: indent.length };
    this.bump();
  }

  backspace(): void {
    if (this.selection()) {
      this.pushUndo("del");
      this.deleteSelection();
      this.bump();
      return;
    }
    const { row, col } = this.cursor;
    if (col > 0) {
      this.pushUndo("bs");
      const line = this.lines[row]!;
      // If the line is all-whitespace up to the cursor, eat to the previous
      // indent stop (2-space stops) — feels like a real editor.
      const pre = line.slice(0, col);
      let eat = 1;
      if (/^\s+$/.test(pre)) {
        const stop = Math.floor((pre.length - 1) / 2) * 2;
        eat = pre.length - stop;
      }
      this.lines[row] = line.slice(0, col - eat) + line.slice(col);
      this.cursor.col -= eat;
      this.bump();
    } else if (row > 0) {
      this.pushUndo("bs");
      const prevLen = this.lines[row - 1]!.length;
      this.lines.splice(row - 1, 2, this.lines[row - 1]! + this.lines[row]!);
      this.cursor = { row: row - 1, col: prevLen };
      this.bump();
    }
  }

  deleteForward(): void {
    if (this.selection()) {
      this.pushUndo("del");
      this.deleteSelection();
      this.bump();
      return;
    }
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    if (col < line.length) {
      this.pushUndo("del");
      this.lines[row] = line.slice(0, col) + line.slice(col + 1);
      this.bump();
    } else if (row < this.lines.length - 1) {
      this.pushUndo("del");
      this.lines.splice(row, 2, line + this.lines[row + 1]!);
      this.bump();
    }
  }

  deleteWordBack(): void {
    if (this.selection()) { this.pushUndo("del"); this.deleteSelection(); this.bump(); return; }
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    if (col === 0) { this.backspace(); return; }
    this.pushUndo("bs");
    let i = col;
    for (; i > 0 && /\s/.test(line[i - 1]!);) i--;
    for (; i > 0 && /[\w$]/.test(line[i - 1]!);) i--;
    if (i === col) for (; i > 0 && !/[\w$\s]/.test(line[i - 1]!);) i--;
    this.lines[row] = line.slice(0, i) + line.slice(col);
    this.cursor.col = i;
    this.bump();
  }

  private wordRight(): Pos {
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    let i = col;
    for (; i < line.length && /\s/.test(line[i]!);) i++;
    if (i < line.length && /[\w$]/.test(line[i]!)) {
      for (; i < line.length && /[\w$]/.test(line[i]!);) i++;
    } else if (i < line.length) {
      for (; i < line.length && !/[\w$\s]/.test(line[i]!);) i++;
    }
    return { row, col: i };
  }

  move(cmd: "left" | "right" | "up" | "down" | "home" | "end" | "wordLeft" | "wordRight" | "docHome" | "docEnd", extend: boolean): void {
    this.breakOp();
    if (!extend && this.anchor) {
      const sel = this.selection()!;
      this.cursor = cmd === "left" || cmd === "up" || cmd === "home" || cmd === "wordLeft" || cmd === "docHome" ? clonePos(sel.a) : clonePos(sel.b);
      this.anchor = null;
      return;
    }
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    let next: Pos;
    switch (cmd) {
      case "left":  next = col > 0 ? { row, col: col - 1 } : row > 0 ? { row: row - 1, col: this.lines[row - 1]!.length } : { row, col }; break;
      case "right": next = col < line.length ? { row, col: col + 1 } : row < this.lines.length - 1 ? { row: row + 1, col: 0 } : { row, col }; break;
      case "up":    next = row > 0 ? { row: row - 1, col: Math.min(col, this.lines[row - 1]!.length) } : { row: 0, col: 0 }; break;
      case "down":  next = row < this.lines.length - 1 ? { row: row + 1, col: Math.min(col, this.lines[row + 1]!.length) } : { row, col: line.length }; break;
      case "home":  {
        const firstNonWs = line.match(/\S/)?.index ?? 0;
        next = { row, col: col === firstNonWs ? 0 : firstNonWs };
        break;
      }
      case "end":       next = { row, col: line.length }; break;
      case "wordLeft": {
        if (col === 0) { next = row > 0 ? { row: row - 1, col: this.lines[row - 1]!.length } : { row, col }; break; }
        let i = col;
        for (; i > 0 && /\s/.test(line[i - 1]!);) i--;
        if (i > 0 && /[\w$]/.test(line[i - 1]!)) { for (; i > 0 && /[\w$]/.test(line[i - 1]!);) i--; }
        else { for (; i > 0 && !/[\w$\s]/.test(line[i - 1]!);) i--; }
        next = { row, col: i };
        break;
      }
      case "wordRight": next = this.wordRight(); break;
      case "docHome":   next = { row: 0, col: 0 }; break;
      case "docEnd":    next = { row: this.lines.length - 1, col: this.lines[this.lines.length - 1]!.length }; break;
    }
    if (extend) {
      if (!this.anchor) this.anchor = clonePos(this.cursor);
    } else {
      this.anchor = null;
    }
    this.cursor = next;
  }

  selectAll(): void {
    this.anchor = { row: 0, col: 0 };
    this.cursor = { row: this.lines.length - 1, col: this.lines[this.lines.length - 1]!.length };
    this.breakOp();
  }

  selectWord(): void {
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    let s = col, e = col;
    if (col > 0 && !/[\w$]/.test(line[col] ?? "") && /[\w$]/.test(line[col - 1]!)) s = col - 1;
    for (; s > 0 && /[\w$]/.test(line[s - 1]!);) s--;
    for (; e < line.length && /[\w$]/.test(line[e]!);) e++;
    this.anchor = { row, col: s };
    this.cursor = { row, col: e };
    this.breakOp();
  }
}

// ---------------------------------------------------------------------------
// Clipboard — native window clipboard API with navigator fallback.
// ---------------------------------------------------------------------------

export function clipboardGet(): string {
  const nw = (globalThis as { __nativeWindow?: { getClipboardText?: () => string } }).__nativeWindow;
  try { return nw?.getClipboardText?.() ?? ""; } catch { return ""; }
}
export function clipboardSet(t: string): void {
  const nw = (globalThis as { __nativeWindow?: { setClipboardText?: (t: string) => void } }).__nativeWindow;
  try { nw?.setClipboardText?.(t); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// EditorView — renders an EditorModel with syntax highlighting; owns
// scroll offset, caret blink, pointer → position mapping.
// ---------------------------------------------------------------------------

export interface EditorViewOpts {
  lineHeight: number;
  padX: number;
  padY: number;
  gutterW: number;        // prompt gutter width (0 for source view)
  readonly: boolean;
  lineNumbers: boolean;
}

const KEY_CLR: Record<TokKind, () => string> = {
  keyword: () => tokens().synKeyword,
  string: () => tokens().synString,
  template: () => tokens().synString,
  comment: () => tokens().synComment,
  number: () => tokens().synNumber,
  type: () => tokens().synType,
  builtin: () => tokens().synBuiltin,
  operator: () => tokens().synOperator,
  plain: () => tokens().synPlain,
  property: () => tokens().synProperty,
  regex: () => tokens().synString,
};

export class EditorView {
  model = new EditorModel();
  scrollY = 0;
  scrollX = 0;
  caretOn = true;
  private lastBlink = 0;
  private highlightCache = new Map<number, { line: string; spans: { s: number; e: number; k: TokKind }[] }>();
  private lexStates: LexState[] = [];
  private modelSeq = -1;

  constructor(private cache: RunCache, public opts: EditorViewOpts) {}

  get lineH(): number { return this.opts.lineHeight; }

  private refreshHighlights(): void {
    if (this.modelSeq === this.model.dirty) return;
    this.modelSeq = this.model.dirty;
    this.highlightCache.clear();
    this.lexStates = this.model.lines.map(() => freshLexState());
    let st = freshLexState();
    this.model.lines.forEach((line, i) => {
      const { toks, end } = lineTokens(line, st);
      this.highlightCache.set(i, { line, spans: toks });
      st = end;
      this.lexStates[i] = st;
    });
  }

  /** x-pixel position of a column on a line (UTF-16 boundary → x offset). */
  colX(line: string, col: number): number {
    if (col <= 0) return 0;
    const run = this.cache.getRun(MONO(), this.lineH * 0.78, line);
    if (!run) return col * this.lineH * 0.5;
    const i = Math.min(col, run.clusterOffsets.length - 1);
    return run.clusterOffsets[i]!;
  }

  contentHeight(): number { return this.model.lines.length * this.lineH; }

  /** pixel → document position. */
  posAt(px: number, py: number, rectY: number, rectX: number): Pos {
    const { padX, padY, gutterW } = this.opts;
    const row = Math.max(0, Math.min(this.model.lines.length - 1,
      Math.floor((py - rectY - padY + this.scrollY) / this.lineH)));
    const line = this.model.lines[row]!;
    const x = px - rectX - padX - gutterW + this.scrollX;
    if (x <= 0) return { row, col: 0 };
    const run = this.cache.getRun(MONO(), this.lineH * 0.78, line);
    if (!run) return { row, col: Math.min(line.length, Math.round(x / (this.lineH * 0.5))) };
    const offs = run.clusterOffsets;
    // Find the boundary whose midpoint in the run crosses x.
    let col = line.length;
    for (let i = 0; i < offs.length - 1; i++) {
      const mid = (offs[i]! + offs[i + 1]!) / 2;
      if (x < mid) { col = i; break; }
    }
    return { row, col: Math.max(0, Math.min(line.length, col)) };
  }

  /** Render the editor into `rect`. Returns the visible cursor screen pos. */
  render(pass: GpuTextPass, x: number, y: number, w: number, h: number, now: number): { x: number; y: number } | null {
    this.refreshHighlights();
    const t = tokens();
    const { padX, padY, gutterW, lineHeight, readonly, lineNumbers } = this.opts;
    const size = Math.round(lineHeight * 0.78);
    const font = MONO();
    const viewH = h - padY * 2;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, this.contentHeight() - viewH)));

    const firstRow = Math.max(0, Math.floor(this.scrollY / lineHeight));
    const lastRow = Math.min(this.model.lines.length - 1, Math.ceil((this.scrollY + viewH) / lineHeight));

    const sel = this.model.selection();
    const selBg = chroma(t.accent, 0.28);
    const gutterClr = hex(t.textFaint);

    // Caret blink: 530ms phase.
    if (now - this.lastBlink > 530) { this.lastBlink = now; this.caretOn = !this.caretOn; }

    let caretScreen: { x: number; y: number } | null = null;

    for (let row = firstRow; row <= lastRow; row++) {
      const line = this.model.lines[row]!;
      const ly = y + padY + row * lineHeight - this.scrollY;
      const textX = x + padX + gutterW - this.scrollX;
      const baselineY = ly + Math.round(lineHeight * 0.72);

      // Line number.
      if (lineNumbers) {
        const ln = String(row + 1);
        const chunk = this.cache.getChunk(MONO(), size - 2, ln);
        if (chunk?.region) {
          // Right-align the run's advance edge: the bitmap spans " ln ", so
          // its right edge sits padX past the advance — subtract it back.
          pass.text(Math.round(x + gutterW - 6 - (chunk.w - chunk.padX)), baselineY - chunk.baselineInBitmap - 1,
            chunk.w, chunk.h, { region: chunk.region, atlasSize: this.cache.atlas.size }, gutterClr);
        }
      }

      // Selection range for this row.
      if (sel && sel.a.row <= row && sel.b.row >= row) {
        const sCol = row === sel.a.row ? sel.a.col : 0;
        const eCol = row === sel.b.row ? sel.b.col : (sel.a.row !== sel.b.row ? line.length : sel.b.col);
        const sx = textX + this.colX(line, sCol);
        const ex = textX + this.colX(line, eCol) + (eCol === line.length && row < sel.b.row ? 8 : 0);
        pass.rect(Math.max(sx, x + padX), ly, Math.max(ex - sx, 4), lineHeight, selBg);
      }

      // Highlighted spans — one chunk bitmap per span (atlas-cached).
      const spans = this.highlightCache.get(row)?.spans ?? [];
      const emit = (str: string, sx: number, rgba: Rgba) => {
        if (!str) return;
        const chunk = this.cache.getChunk(font, size, str);
        if (chunk?.region) {
          // Bitmap origin is padX before the pen (padded raster); snap to
          // whole pixels so the integer-placed glyphs aren't resampled.
          pass.text(Math.round(sx - chunk.padX), baselineY - chunk.baselineInBitmap, chunk.w, chunk.h,
            { region: chunk.region, atlasSize: this.cache.atlas.size }, rgba);
        }
      };

      let prevEnd = 0;
      for (let si = 0; si < spans.length; si++) {
        const sp = spans[si]!;
        if (sp.s > prevEnd) emit(line.slice(prevEnd, sp.s), textX + this.colX(line, prevEnd), hex(t.synPlain));
        emit(line.slice(sp.s, sp.e), textX + this.colX(line, sp.s), hex(KEY_CLR[sp.k]()));
        prevEnd = sp.e;
      }
      if (prevEnd < line.length) emit(line.slice(prevEnd), textX + this.colX(line, prevEnd), hex(t.synPlain));
      if (line.length === 0) { /* nothing */ }

      // Caret.
      if (!readonly && row === this.model.cursor.row && this.caretOn) {
        const cx = textX + this.colX(line, this.model.cursor.col);
        caretScreen = { x: cx, y: ly };
      }
    }

    if (caretScreen) {
      pass.rect(caretScreen.x, caretScreen.y + 1, 1.5, lineHeight - 3, hex(t.caret));
      // Keep caret visible horizontally.
      const relX = caretScreen.x - x - padX - gutterW;
      const visW = w - padX * 2 - gutterW;
      if (relX < 0) this.scrollX += relX - 20;
      else if (relX > visW - 4) this.scrollX += relX - visW + 24;
      const relY = caretScreen.y - y - padY;
      if (relY < 0) this.scrollY += relY;
      else if (relY + lineHeight > viewH) this.scrollY += relY + lineHeight - viewH;
    }
    return caretScreen;
  }

  clearHighlights(): void {
    this.modelSeq = -1;
  }
}
