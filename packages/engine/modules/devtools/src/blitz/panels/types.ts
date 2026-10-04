// ============================================================================
// panels/types.ts — Blitz devtools panel contract + shared render helpers.
//
// A panel is a plain state object: backend push events update its state and
// set `dirty`; the host re-renders `#dt-body` for the active dirty panel.
// `renderTop`/`renderBottom` produce persistent chrome (toolbar, REPL row)
// that is mounted once per tab activation — inputs living there keep focus
// across body re-renders.
// ============================================================================

import type { OsrDomEvent } from "@downdraft/engine/modules/html-ui";

export interface DtPanelCtx {
  /** Backend RPC — same methods as the web frontend's call(). */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Set an element's attribute (e.g. an input's `value`) — history recall. */
  setValue(target: number | string, value: string): void;
  /** Scroll a doc element into view (console tail pinning). */
  scrollIntoView(target: number | string): void;
  /** Scroll a scroll-container to absolute offsets — reaches nested
   *  scrollports (scrollIntoView only moves the root viewport). */
  scrollTo(target: number | string, x: number, y: number): void;
  /** Border-box rect of a doc element in CSS px (scroll math). */
  getRect(target: number | string): Promise<{ x: number; y: number; w: number; h: number } | null>;
}

export interface DtPanel {
  readonly id: string;
  readonly title: string;
  /** Set when a body render is needed; host clears after re-render. */
  dirty: boolean;
  /** Set when the persistent chrome (top/bottom) needs re-rendering. */
  shellDirty?: boolean;
  renderTop?(): string;
  renderBody(): string;
  renderBottom?(): string;
  /** `data-action` activations routed by the host. */
  onAction?(data: Record<string, string>, ev: OsrDomEvent): void;
  /** Raw DOM events (input, keydown, mousedown, scroll…). */
  onEvent?(ev: OsrDomEvent): void;
  /** Backend push events (console, scene, dom, gpu, metrics, snapshot…). */
  onBackendEvent?(event: string, data: unknown): void;
  /** Called on tab activation (after shell regions are mounted). */
  activate?(): void;
  /** Called after `#dt-body` was re-rendered (scroll pinning etc.). */
  afterRender?(): void;
  dispose?(): void;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtBytes(b: unknown): string {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export const CHART_COLORS = ["#4da3ff", "#57ab5a", "#e0b341", "#e5534b", "#bc8cff", "#39c5cf"];

/**
 * Div-column chart — Blitz has no canvas/SVG, so a series renders as a flex
 * row of colored columns. `cols` caps the column count (decimation keeps
 * the DOM small). Each column's height is the value normalized to `max`.
 */
export function chartHtml(values: ArrayLike<number>, opts: {
  max?: number;
  cols?: number;
  color?: string;
  cls?: string;
  label?: string;
} = {}): string {
  const vals = Array.from(values, Number);
  const cols = opts.cols ?? 120;
  const color = opts.color ?? CHART_COLORS[0];
  const max = Math.max(opts.max ?? 1e-9, ...vals, 1e-9);
  const step = Math.max(1, Math.floor(vals.length / cols));
  const cells: string[] = [];
  for (let i = 0; i < vals.length; i += step) {
    const h = Math.max(0, Math.min(100, (vals[i]! / max) * 100));
    cells.push(`<div class="col" style="height:${h.toFixed(1)}%;background:${color}"></div>`);
  }
  if (!cells.length) cells.push(`<div class="col" style="height:0%"></div>`);
  const lbl = opts.label ? `<div class="chart-label">${esc(opts.label)}</div>` : "";
  return `${lbl}<div class="chart${opts.cls ? ` ${opts.cls}` : ""}">${cells.join("")}</div>`;
}

/** Multi-series chart — one labeled strip per series. */
export function multiChartHtml(series: { name: string; values: ArrayLike<number> }[], opts: { cols?: number } = {}): string {
  const all = series.flatMap((s) => Array.from(s.values, Number));
  const max = Math.max(1e-9, ...all);
  return series.map((s, i) =>
    chartHtml(s.values, { ...opts, max, color: CHART_COLORS[i % CHART_COLORS.length], cls: "cap", label: s.name })
  ).join("");
}
