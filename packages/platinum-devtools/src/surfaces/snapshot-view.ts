// ============================================================================
// snapshot-view.ts — shared renderer for engine PanelSnapshot sections
// (kv / table / series / lines / controls) against the real wire schema:
//   kv:       { kind:"kv",      name, rows: { key, value, flags? }[] }
//   table:    { kind:"table",   name, cols: string[], rows: string[][] }
//   series:   { kind:"series",  name, series: { name, values }[] }
//   lines:    { kind:"lines",   name, lines: { text, flags? }[] }
//   controls: { kind:"controls",name, controls: { type, id, label, …}[] }
// flags: 1=header, 2=warn, 4=error.
//
// Numeric kv values are tracked over time — a mini sparkline renders inline
// so provider panels show history, not just the latest reading.
// ============================================================================

import type { GpuTextPass } from "../text/gpu-text";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens, chroma } from "../app/theme";
import { drawSeries, fmtValue, laneColor } from "./charts";
import type { PanelSnapshot } from "../targets/model";
import type { TargetSession } from "../targets/session";

const FLAG = { header: 1, warn: 2, error: 4 };

interface SnapSection {
  kind?: string; type?: string; name?: string; title?: string;
  rows?: unknown; items?: unknown; lines?: unknown;
  cols?: string[]; columns?: string[];
  series?: { name?: string; id?: string; label?: string; values?: number[] | Float32Array; points?: [number, number][] }[];
  controls?: SnapControl[];
}
interface SnapControl {
  type?: string; kind?: string; id: string; label?: string;
  payload?: string; checked?: boolean; value?: number; min?: number; max?: number;
}

export interface SectionHit { x: number; y: number; w: number; h: number; act: () => void }

/** Numeric-kv history — sparklines over time for provider readings.
 *  Keyed `${scope}/${key}`; capped ring of samples. */
const kvHistory = new Map<string, { t: number[]; v: number[]; stamp: number }>();
const KV_HIST_CAP = 240;

function kvTrack(scope: string, key: string, stamp: number, value: number): { t: number[]; v: number[] } | null {
  const k = `${scope}/${key}`;
  let e = kvHistory.get(k);
  if (!e) { e = { t: [], v: [], stamp: -1 }; kvHistory.set(k, e); }
  if (e.stamp !== stamp) {
    e.stamp = stamp;
    e.t.push(stamp / 1000); e.v.push(value);
    if (e.t.length > KV_HIST_CAP) { e.t.splice(0, e.t.length - KV_HIST_CAP); e.v.splice(0, e.v.length - KV_HIST_CAP); }
  }
  return e;
}

/** Parse a formatted value like "12.3 ms" / "1.2 MB" / "45%" → {v, unit}. */
function parseNum(raw: string): { v: number; unit: string } | null {
  const m = /^(-?[\d.]+)\s*(GB|MB|KB|B|ms|s|us|µs|%|fps|x|×|ops)?\s*$/i.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!isFinite(v)) return null;
  return { v, unit: m[2] ?? "" };
}

export abstract class SnapSurface extends TextSurface {
  /** Push a hit-zone — subclass owns the array. */
  protected abstract pushHit(h: SectionHit): void;
  /** Dispatch a provider control to the session. */
  protected abstract sendControl(slot: number | string, id: string, payload: string): void;

  private histStampKey = "";
  protected setHistScope(key: string): void { this.histStampKey = key; }

  /**
   * Render all sections of a snapshot. Returns the y position after the
   * last section (for scrollHeight bookkeeping).
   * `stamp` should be a per-snapshot version (provider.lastPush or 0) so
   * numeric history only samples once per snapshot, not per frame.
   */
  protected drawSections(
    pass: GpuTextPass, snap: PanelSnapshot | { sections?: SnapSection[]; statusMsg?: string } | null | undefined,
    slot: number | string, x: number, y: number, w: number, stamp = 0,
  ): number {
    const t = tokens();
    const LH = this.z(16);
    const sections = (snap?.sections ?? []) as SnapSection[];
    const clipTop = this.rect.y, clipBot = this.rect.y + this.rect.h;
    const vis = (yy: number, h: number) => yy + h > clipTop && yy < clipBot;

    // A provider may answer with only a status ("unsupported", "loading") —
    // show the message instead of silently drawing nothing.
    if (!sections.length && snap?.statusMsg) {
      if (vis(y, LH)) {
        this.drawText(pass, MONO(), 10, String(snap.statusMsg), x, y + LH - 4, hex(t.textDim), w - this.z(8));
      }
      return y + LH;
    }

    sections.forEach((sec) => {
      const kind = sec.kind ?? sec.type ?? "kv";
      const name = sec.name ?? sec.title ?? "";
      if (name) {
        if (vis(y, LH)) {
          this.drawText(pass, MONO(700), 10, name.toUpperCase(), x, y + LH - 4, hex(t.accent2));
        }
        y += LH + 4;
      }

      switch (kind) {
        case "kv": {
          const rows = (sec.rows ?? sec.items ?? []) as { key?: string; k?: string; value?: unknown; v?: unknown; flags?: number }[];
          rows.forEach((row) => {
            const key = String(row.key ?? row.k ?? "");
            const value = String(row.value ?? row.v ?? "");
            const fl = row.flags ?? 0;
            if (!key && !value) { y += 4; return; }
            if (vis(y, LH)) {
              if (fl & FLAG.header) {
                this.drawText(pass, MONO(700), 10, key || value, x, y + LH - 4, hex(t.textDim));
              } else {
                const vClr = fl & FLAG.error ? t.err : fl & FLAG.warn ? t.warn : t.text;
                const keyW = Math.min(this.z(180), w * 0.42);
                this.drawText(pass, MONO(), 10, key, x, y + LH - 4, hex(t.textDim), keyW);
                const vx = x + keyW + this.z(8);
                this.drawText(pass, MONO(), 10, value, vx, y + LH - 4, hex(vClr), w - keyW - this.z(160));
                // Numeric → inline history sparkline.
                const num = parseNum(value);
                if (num && key) {
                  const h = kvTrack(this.histStampKey, `${name}/${key}`, stamp, num.v);
                  if (h && h.v.length > 1) {
                    const sw = this.z(110), sh = LH - 4;
                    const fake = { id: key, label: key, unit: "count" as const, group: "kv",
                      t: h.t, v: h.v, cap: KV_HIST_CAP, min: Math.min(...h.v), max: Math.max(...h.v) };
                    drawSeries(pass, fake, x + w - sw, y + 2, sw, sh, { color: laneColor(key.length % 8), grid: false });
                  }
                }
              }
            }
            y += LH;
          });
          break;
        }

        case "table": {
          const cols = sec.cols ?? sec.columns ?? [];
          const rows = (sec.rows ?? []) as (string | number | null | undefined)[][];
          // When the first column names threads we know (thread:<name> series
          // groups), append a sparkline column so tables show trends.
          const ses = this.pctxSession();
          const threadSeries = (name: string) =>
            ses ? [...ses.series.values()].filter((m) => m.group === `thread:${name}` || m.id.startsWith(`thread.${name}.`)) : [];
          const hasSpark = !!ses && /name|thread/i.test(String(cols[0] ?? "")) &&
            rows.some((rw) => threadSeries(String(rw[0] ?? "")).length > 0);
          const sparkW = hasSpark ? Math.min(this.z(150), w * 0.22) : 0;
          const colW = Math.max(this.z(90), Math.min(this.z(220), (w - this.z(20) - sparkW) / Math.max(1, cols.length)));
          if (vis(y, LH)) {
            cols.forEach((c, ci) => {
              this.drawText(pass, MONO(700), 9, String(c).toUpperCase(), x + ci * colW, y + LH - 4, hex(t.textFaint), colW - 6);
            });
            if (hasSpark) this.drawText(pass, MONO(700), 9, "TREND", x + cols.length * colW + this.z(8), y + LH - 4, hex(t.textFaint));
            pass.rect(x, y + LH, Math.min(w, cols.length * colW + sparkW), 1, hex(t.borderSoft));
          }
          y += LH + 4;
          rows.forEach((row) => {
            if (vis(y, LH)) {
              row.forEach((cell, ci) => {
                this.drawText(pass, MONO(), 10, String(cell ?? ""), x + ci * colW, y + LH - 4,
                  hex(ci === 0 ? t.text : t.textDim), colW - 6);
              });
              if (hasSpark) {
                const ms = threadSeries(String(row[0] ?? ""));
                const sx = x + cols.length * colW + this.z(8);
                ms.slice(0, 3).forEach((m, i) => {
                  drawSeries(pass, m, sx, y + 2 + i * 4, sparkW - this.z(10), Math.max(3, LH - 6 - i * 4),
                    { color: laneColor(i), grid: false, windowSec: 60 });
                });
              }
            }
            y += LH;
          });
          break;
        }

        case "series": {
          (sec.series ?? []).forEach((m, i) => {
            const vals = m.values ? [...m.values] : (m.points ?? []).map((p) => p[1]);
            const pts = m.points ?? vals.map((v, vi) => [vi, v] as [number, number]);
            const sh = this.z(30), cardH = sh + this.z(18);
            if (vis(y, cardH)) {
              const fake = { id: m.name ?? m.id ?? `s${i}`, label: m.name ?? m.label ?? m.id ?? "", unit: "count" as const,
                group: "provider", t: pts.map((p) => p[0]), v: pts.map((p) => p[1]),
                cap: pts.length || 2, min: Math.min(...pts.map((p) => p[1])), max: Math.max(...pts.map((p) => p[1])) };
              this.drawText(pass, MONO(), 9, `${fake.label}  ${fmtValue(fake.v[fake.v.length - 1] ?? 0, "count")}`,
                x, y + this.z(11), hex(t.textDim));
              drawSeries(pass, fake, x, y + this.z(14), Math.min(this.z(420), w - this.z(20)), sh,
                { color: laneColor(i), grid: false });
            }
            y += cardH;
          });
          break;
        }

        case "lines": {
          const items = (sec.lines ?? sec.items ?? []) as ({ text?: string; flags?: number } | string)[];
          items.forEach((ln) => {
            const text = typeof ln === "string" ? ln : String(ln.text ?? "");
            const fl = typeof ln === "string" ? 0 : (ln.flags ?? 0);
            if (vis(y, LH)) {
              const clr = fl & FLAG.error ? t.err : fl & FLAG.warn ? t.warn : fl & FLAG.header ? t.accent2 : t.text;
              this.drawText(pass, fl & FLAG.header ? MONO(700) : MONO(), 10, text, x, y + LH - 4, hex(clr), w - this.z(8));
            }
            y += LH;
          });
          break;
        }

        case "controls": {
          let cx = x;
          let rowH = this.z(24);
          (sec.controls ?? []).forEach((c) => {
            const ctype = c.type ?? c.kind ?? "button";
            const label = c.label ?? c.id;
            if (ctype === "checkbox") {
              const cw = this.z(170);
              if (cx + cw > x + w) { cx = x; y += rowH + 4; }
              if (vis(y, rowH)) {
                const on = !!c.checked || c.value === 1;
                pass.rect(cx, y + 4, this.z(12), this.z(12), on ? hex(t.accent) : hex(t.bgRaised));
                this.outline(pass, cx, y + 4, this.z(12), this.z(12), hex(t.border));
                this.drawText(pass, MONO(), 10, label, cx + this.z(18), y + LH - 4, hex(t.text), cw - this.z(20));
                const bx = cx, by = y;
                this.pushHit({ x: bx, y: by, w: cw, h: rowH,
                  act: () => this.sendControl(slot, c.id, String(!on)) });
              }
              cx += cw + this.z(6);
            } else if (ctype === "slider") {
              const sw = this.z(230);
              if (cx + sw > x + w) { cx = x; y += rowH + 4; }
              if (vis(y, rowH)) {
                const min = c.min ?? 0, max = c.max ?? 100, val = Number(c.value ?? 0);
                const pct = Math.max(0, Math.min(1, (val - min) / Math.max(1e-9, max - min)));
                const trackW = this.z(120);
                this.drawText(pass, MONO(), 10, `${label}: ${String(c.value ?? "")}`, cx, y + LH - 4, hex(t.textDim), this.z(100));
                const tx = cx + this.z(104);
                pass.rect(tx, y + rowH / 2 - 2, trackW, 4, hex(t.bgSunken));
                pass.rect(tx, y + rowH / 2 - 2, trackW * pct, 4, hex(t.accent));
                // - / + steppers (2.5% / step).
                const step = (max - min) / 40 || 1;
                [["−", -step], ["+", step]].forEach(([sg, d], si) => {
                  const bx = tx + trackW + this.z(6) + si * this.z(22);
                  pass.rect(bx, y + 3, this.z(18), rowH - 6, hex(t.bgRaised));
                  this.outline(pass, bx, y + 3, this.z(18), rowH - 6, hex(t.borderSoft));
                  this.drawText(pass, MONO(), 10, String(sg), bx + this.z(5), y + LH - 4, hex(t.textDim));
                  const nv = val + Number(d);
                  this.pushHit({ x: bx, y: y + 3, w: this.z(18), h: rowH - 6,
                    act: () => this.sendControl(slot, c.id, String(Math.max(min, Math.min(max, nv)))) });
                });
              }
              cx += sw + this.z(6);
            } else {
              const bw = this.measure(MONO(), 10, label) + this.z(14);
              if (cx + bw > x + w) { cx = x; y += rowH + 4; }
              if (vis(y, rowH)) {
                pass.rect(cx, y + 2, bw, rowH - 4, chroma(t.accent, 0.15));
                this.outline(pass, cx, y + 2, bw, rowH - 4, hex(t.borderSoft));
                this.drawText(pass, MONO(), 10, label, cx + this.z(7), y + LH - 4, hex(t.text));
                const bx = cx, by = y;
                this.pushHit({ x: bx, y: by, w: bw, h: rowH,
                  act: () => this.sendControl(slot, c.id, c.payload ?? "") });
              }
              cx += bw + this.z(6);
            }
          });
          y += rowH + 6;
          break;
        }

        default: {
          const raw = JSON.stringify(sec).slice(0, 300);
          if (vis(y, LH)) {
            this.drawText(pass, MONO(), 9, raw, x, y + LH - 4, hex(t.textFaint), w - this.z(8));
          }
          y += LH;
        }
      }
      y += this.z(4);
    });
    return y;
  }

  /** Whole-snapshot convenience — draws every section at (x,y). */
  protected drawSnapshot(pass: GpuTextPass, slot: number | string, stamp = 0, x = 14, y = 0, w = 0): number {
    const s = this.pctxSession();
    const p = typeof slot === "string" ? s?.provider(slot) : s?.providers.find((pp) => pp.slot === slot);
    return this.drawSections(pass, p?.lastSnapshot, slot, this.rect.x + this.z(x), y, w || this.rect.w - this.z(28), stamp || (p?.lastPush ?? 0));
  }

  protected abstract pctxSession(): TargetSession | null;
}
