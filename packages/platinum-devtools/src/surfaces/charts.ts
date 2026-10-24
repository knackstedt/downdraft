// ============================================================================
// charts.ts — shared chart drawing helpers for GPU surfaces.
// ============================================================================

import type { GpuTextPass, Rgba } from "../text/gpu-text";
import type { MetricSeries } from "../targets/model";
import { hex, chroma, tokens } from "../app/theme";

export function fmtValue(v: number, unit: string): string {
  if (!isFinite(v)) return "—";
  switch (unit) {
    case "B": {
      const a = Math.abs(v);
      if (a >= 1 << 30) return `${(v / (1 << 30)).toFixed(2)} GB`;
      if (a >= 1 << 20) return `${(v / (1 << 20)).toFixed(1)} MB`;
      if (a >= 1 << 10) return `${(v / 1024).toFixed(1)} KB`;
      return `${v | 0} B`;
    }
    case "%": return `${v.toFixed(0)}%`;
    case "ms": return `${v.toFixed(1)} ms`;
    case "us": return v >= 1000 ? `${(v / 1000).toFixed(1)} ms` : `${v.toFixed(0)} µs`;
    case "ops": return `${v.toFixed(0)}/s`;
    default: return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
}

export interface ChartOpts {
  color: Rgba;
  fill?: boolean;
  min?: number;
  max?: number;
  /** Window in seconds of `t` to show (default: full range). */
  windowSec?: number;
  nowSec?: number;
  grid?: boolean;
}

/** Draw a time-series line chart into rect. */
export function drawSeries(
  pass: GpuTextPass,
  s: MetricSeries,
  x: number, y: number, w: number, h: number,
  o: ChartOpts,
): { min: number; max: number; last: number } {
  const t = tokens();
  const now = o.nowSec ?? (s.t[s.t.length - 1] ?? 0);
  const win = o.windowSec ?? Math.max(10, (s.t[s.t.length - 1] ?? 0) - (s.t[0] ?? 0));
  const t0 = now - win;

  let lo = o.min ?? Infinity, hi = o.max ?? -Infinity;
  if (o.min === undefined || o.max === undefined) {
    for (let i = s.v.length - 1; i >= 0 && s.t[i]! >= t0; i--) {
      if (s.v[i]! < lo) lo = s.v[i]!;
      if (s.v[i]! > hi) hi = s.v[i]!;
    }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) hi = lo + 1;
  // A little headroom.
  const pad = (hi - lo) * 0.08;
  if (o.min === undefined) lo -= pad;
  if (o.max === undefined) hi += pad;

  if (o.grid !== false) {
    for (let g = 1; g < 4; g++) {
      const gy = y + (h * g) / 4;
      pass.rect(x, gy, w, 0.5, chroma(t.borderSoft, 0.8));
    }
  }

  // Build the polyline (downsampled to pixel width).
  const maxPts = Math.max(2, Math.floor(w));
  const pts = new Float32Array(Math.min(s.t.length, maxPts) * 2);
  let n = 0;
  const step = Math.max(1, Math.floor(s.t.length / maxPts));
  for (let i = 0; i < s.t.length; i += step) {
    const ts = s.t[i]!;
    if (ts < t0) continue;
    const px = x + ((ts - t0) / win) * w;
    const py = y + h - ((s.v[i]! - lo) / (hi - lo)) * h;
    pts[n++] = px;
    pts[n++] = py;
  }
  if (n >= 4) pass.stroke(pts.subarray(0, n), 1, o.color);
  else if (n === 2) pass.ellipse(pts[0]! - 1.5, pts[1]! - 1.5, 3, 3, o.color);

  if (o.fill && n >= 4) {
    // Cheap area fill: vertical slivers every few px under the line.
    for (let i = 0; i + 1 < n; i += 2) {
      const px = pts[i]!, py = pts[i + 1]!;
      if (i % 8 === 0) pass.rect(px, py, 1.5, y + h - py, chroma(hexToCss(o.color), 0.12));
    }
  }

  const last = s.v[s.v.length - 1] ?? 0;
  return { min: isFinite(lo) ? lo : 0, max: isFinite(hi) ? hi : 1, last };
}

function hexToCss(c: Rgba): string {
  const f = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

const LANE_COLORS = ["#4f9cf9", "#5ec98a", "#e8b04b", "#f47067", "#9a8cf0", "#4fd6be", "#e5c07b", "#7ab3f0"];

export function laneColor(i: number): Rgba {
  return hex(LANE_COLORS[i % LANE_COLORS.length]!);
}
