// ============================================================================
// widgets.ts — Reusable PixiJS widgets for the native debugger panels.
//
// All widgets are pure-pixi (no DOM, no React). They follow the ProfilerScene
// pattern: each widget is a factory returning a PIXI.Container that the panel
// clears + rebuilds each frame. Interactive regions are reported via
// getInteractiveRegions() so the host can hit-test SDL pointer events.
//
// Click handling model: panels collect "hit regions" (rects + callbacks) as
// they build their view each frame. The DebuggerScene aggregates these into
// getInteractiveRegions() and dispatches pointerdown to the matching region.
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import {
    BG_DARK, BG_GRID, BG_INPUT, BG_PANEL, BG_SELECTED, COLOR_AXIS, COLOR_BORDER,
    COLOR_GREEN,
    COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM,
    FONT,
    fs
} from "./colors";

// ── Hit region (collected during build, dispatched on pointerdown) ──

export interface HitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  onClick: () => void;
}

/** A region collector passed to panels during build.
 *
 * Supports an offset stack so panels/scroll containers can register hit
 * regions in local coordinates while the collector tracks the absolute
 * position. The host's pointer dispatcher uses absolute coordinates.
 */
export class HitCollector {
  regions: HitRegion[] = [];
  private ox = 0;
  private oy = 0;
  private stack: { x: number; y: number }[] = [];

  /** Push a translation offset. All subsequent add() calls will be offset. */
  pushOffset(x: number, y: number): void {
    this.stack.push({ x: this.ox, y: this.oy });
    this.ox += x;
    this.oy += y;
  }

  /** Pop the last pushed offset. */
  popOffset(): void {
    const prev = this.stack.pop();
    if (prev) { this.ox = prev.x; this.oy = prev.y; }
    else { this.ox = 0; this.oy = 0; }
  }

  add(x: number, y: number, w: number, h: number, onClick: () => void): void {
    this.regions.push({ x: x + this.ox, y: y + this.oy, width: w, height: h, onClick });
  }
}

// ── Label helper ──

export function makeLabel(
  text: string,
  x: number,
  y: number,
  color: number = COLOR_TEXT,
  fontSize: number = 12,
): Text {
  return new Text({
    text,
    style: { fontSize: fs(fontSize), fill: color, fontFamily: FONT },
    x, y,
  });
}

// ── Base container with background ──

export function makePanelBg(width: number, height: number, color: number = BG_PANEL, alpha = 0.92): Container {
  const c = new Container();
  const bg = new Graphics();
  bg.rect(0, 0, width, height);
  bg.fill({ color, alpha });
  c.addChild(bg);
  return c;
}

// ── Button ──

export interface ButtonOpts {
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: number;
  bgColor?: number;
  fontSize?: number;
  active?: boolean;
}

export function makeButton(opts: ButtonOpts, hits: HitCollector, onClick: () => void): Container {
  const w = opts.width ?? 70;
  const h = opts.height ?? 24;
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const bg = new Graphics();
  const bgColor = opts.active ? (opts.bgColor ?? BG_SELECTED) : (opts.bgColor ?? BG_DARK);
  bg.roundRect(0, 0, w, h, 4);
  bg.fill({ color: bgColor, alpha: 0.95 });
  bg.stroke({ color: opts.active ? (opts.color ?? COLOR_GREEN) : COLOR_BORDER, width: 1 });
  c.addChild(bg);
  const label = new Text({
    text: opts.label,
    style: { fontSize: fs(opts.fontSize ?? 12), fill: opts.color ?? COLOR_TEXT, fontFamily: FONT },
  });
  label.anchor.set(0.5, 0.5);
  label.x = w / 2;
  label.y = h / 2;
  c.addChild(label);
  hits.add(opts.x, opts.y, w, h, onClick);
  return c;
}

// ── Toggle (checkbox + label) ──

export interface ToggleOpts {
  label: string;
  x: number;
  y: number;
  checked: boolean;
}

export function makeToggle(opts: ToggleOpts, hits: HitCollector, onToggle: () => void): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const box = new Graphics();
  box.rect(0, 0, 14, 14);
  box.fill({ color: opts.checked ? COLOR_GREEN : BG_INPUT });
  box.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(box);
  if (opts.checked) {
    const check = new Graphics();
    check.moveTo(2, 7);
    check.lineTo(6, 11);
    check.lineTo(12, 2);
    check.stroke({ color: 0x000000, width: 2 });
    c.addChild(check);
  }
  const label = makeLabel(opts.label, 20, -1, COLOR_TEXT, 12);
  c.addChild(label);
  hits.add(opts.x, opts.y, 20 + label.width, 14, onToggle);
  return c;
}

// ── Tab bar ──

export interface TabDef {
  id: string;
  label: string;
}

export interface TabBarResult {
  container: Container;
  tabWidth: number;
  height: number;
}

export function makeTabBar(
  tabs: TabDef[],
  activeId: string,
  width: number,
  hits: HitCollector,
  onSelect: (id: string) => void,
  x = 0,
  y = 0,
): TabBarResult {
  const c = new Container();
  c.x = x;
  c.y = y;
  const height = 30;
  const bg = new Graphics();
  bg.rect(0, 0, width, height);
  bg.fill({ color: BG_DARK, alpha: 0.98 });
  // Bottom border
  bg.rect(0, height - 1, width, 1);
  bg.fill({ color: COLOR_BORDER, alpha: 0.6 });
  c.addChild(bg);
  const tabWidth = Math.max(70, Math.floor(width / Math.max(tabs.length, 1)));
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const isActive = tab.id === activeId;
    const tx = i * tabWidth;
    if (isActive) {
      const activeBg = new Graphics();
      activeBg.rect(tx, 0, tabWidth, height);
      activeBg.fill({ color: BG_SELECTED, alpha: 0.6 });
      c.addChild(activeBg);
      // Thin accent underline (Chrome DevTools style)
      const ul = new Graphics();
      ul.rect(tx, height - 2, tabWidth, 2);
      ul.fill({ color: COLOR_GREEN });
      c.addChild(ul);
    }
    const label = new Text({
      text: tab.label,
      style: { fontSize: fs(12), fill: isActive ? COLOR_TEXT_BRIGHT : COLOR_TEXT_DIM, fontFamily: FONT },
    });
    label.anchor.set(0.5, 0.5);
    label.x = tx + tabWidth / 2;
    label.y = height / 2;
    c.addChild(label);
    const id = tab.id;
    hits.add(x + tx, y, tabWidth, height, () => onSelect(id));
  }
  return { container: c, tabWidth, height };
}

// ── Scroll panel (clipped container with scrollbar) ──

export interface ScrollPanelOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  contentHeight: number;
  scrollY: number;
  /** Optional HitCollector — when provided, pushes an offset for content
   * so hit regions registered inside the content container use absolute
   * coordinates. The caller must call hits.popOffset() when done adding
   * content to the scroll panel. */
  hits?: HitCollector;
}

export interface ScrollPanelResult {
  container: Container;
  /** The container to add content to (already offset by -scrollY). */
  content: Container;
  /** Max scroll value. */
  maxScroll: number;
}

export function makeScrollPanel(opts: ScrollPanelOpts): ScrollPanelResult {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  // Background
  const bg = new Graphics();
  bg.rect(0, 0, opts.width, opts.height);
  bg.fill({ color: BG_PANEL, alpha: 0.85 });
  c.addChild(bg);
  // Clip mask — DISABLED: PixiJS masks trigger ensureDepthStencil() which
  // restarts the render pass with an undefined depth/stencil buffer, causing
  // overlapping Graphics to fail the depth test on the native wgpu backend.
  // Content overflow is instead clipped by the scroll panel's bounds.
  const content = new Container();
  content.x = 0;
  content.y = -opts.scrollY;
  // const mask = new Graphics();
  // mask.rect(0, 0, opts.width, opts.height);
  // mask.fill({ color: 0xffffff });
  // content.mask = mask;
  c.addChild(content);
  // Push hit offset so content-registered hit regions are in absolute coords.
  // The caller must call hits.popOffset() after adding all content.
  if (opts.hits) {
    opts.hits.pushOffset(opts.x, opts.y - opts.scrollY);
  }
  // Scrollbar (if content overflows)
  const maxScroll = Math.max(0, opts.contentHeight - opts.height);
  if (maxScroll > 0) {
    const barW = 8;
    const trackH = opts.height;
    const thumbH = Math.max(20, (opts.height / opts.contentHeight) * trackH);
    const thumbY = maxScroll > 0 ? (opts.scrollY / maxScroll) * (trackH - thumbH) : 0;
    const track = new Graphics();
    track.rect(opts.width - barW, 0, barW, trackH);
    track.fill({ color: BG_DARK, alpha: 0.6 });
    c.addChild(track);
    const thumb = new Graphics();
    thumb.roundRect(opts.width - barW, thumbY, barW, thumbH, 2);
    thumb.fill({ color: COLOR_BORDER, alpha: 0.9 });
    c.addChild(thumb);
  }
  return { container: c, content, maxScroll };
}

// ── Tree view (collapsible nodes) ──

export interface TreeNodeData {
  id: string;
  label: string;
  detail?: string;
  expanded: boolean;
  selected: boolean;
  childCount: number;
  depth: number;
}

export interface TreeViewOpts {
  x: number;
  y: number;
  width: number;
  rowHeight?: number;
  fontSize?: number;
}

export interface TreeViewResult {
  container: Container;
  totalHeight: number;
}

export function makeTreeView(
  nodes: TreeNodeData[],
  opts: TreeViewOpts,
  hits: HitCollector,
  onToggle: (id: string) => void,
  onSelect: (id: string) => void,
): TreeViewResult {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const rh = opts.rowHeight ?? 18;
  const fs2 = opts.fontSize ?? 12;
  let y = 0;
  for (const node of nodes) {
    const indent = node.depth * 16;
    const row = new Container();
    row.x = 0;
    row.y = y;
    // Zebra striping (every other row)
    const rowIdx = Math.floor(y / rh);
    if (rowIdx % 2 === 0 && !node.selected) {
      const zebra = new Graphics();
      zebra.rect(0, 0, opts.width, rh);
      zebra.fill({ color: 0x111122, alpha: 0.3 });
      row.addChild(zebra);
    }
    // Row background (selected)
    if (node.selected) {
      const sel = new Graphics();
      sel.rect(0, 0, opts.width, rh);
      sel.fill({ color: BG_SELECTED, alpha: 0.8 });
      // Left accent bar
      sel.rect(0, 0, 2, rh);
      sel.fill({ color: COLOR_GREEN });
      row.addChild(sel);
    }
    // Expand/collapse triangle
    if (node.childCount > 0) {
      const tri = new Graphics();
      const cx = indent + 6;
      const cy = rh / 2;
      if (node.expanded) {
        tri.moveTo(cx - 4, cy - 4);
        tri.lineTo(cx + 4, cy - 4);
        tri.lineTo(cx, cy + 4);
        tri.closePath();
      } else {
        tri.moveTo(cx - 4, cy - 4);
        tri.lineTo(cx - 4, cy + 4);
        tri.lineTo(cx + 4, cy);
        tri.closePath();
      }
      tri.fill({ color: COLOR_TEXT_DIM });
      row.addChild(tri);
      hits.add(opts.x + indent, opts.y + y, 16, rh, () => onToggle(node.id));
    }
    // Label
    const label = makeLabel(node.label, indent + 18, 2, node.selected ? COLOR_TEXT_BRIGHT : COLOR_TEXT, fs2);
    row.addChild(label);
    if (node.detail) {
      const detail = makeLabel(node.detail, indent + 18 + label.width + 8, 2, COLOR_TEXT_DIM, fs2 - 1);
      row.addChild(detail);
    }
    c.addChild(row);
    hits.add(opts.x + indent + 16, opts.y + y, opts.width - indent - 16, rh, () => onSelect(node.id));
    y += rh;
  }
  return { container: c, totalHeight: y };
}

// ── Table view ──

export interface TableColumn {
  key: string;
  label: string;
  width: number;
}

export interface TableViewOpts {
  x: number;
  y: number;
  width: number;
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  rowHeight?: number;
  fontSize?: number;
}

export function makeTableView(opts: TableViewOpts): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const rh = opts.rowHeight ?? 18;
  const fs2 = opts.fontSize ?? 11;
  // Header
  let hx = 0;
  const headerBg = new Graphics();
  headerBg.rect(0, 0, opts.width, rh);
  headerBg.fill({ color: BG_DARK, alpha: 0.95 });
  c.addChild(headerBg);
  for (const col of opts.columns) {
    c.addChild(makeLabel(col.label, hx + 4, 2, COLOR_TEXT_DIM, fs2));
    hx += col.width;
  }
  // Rows
  let y = rh;
  for (let i = 0; i < opts.rows.length; i++) {
    const row = opts.rows[i];
    if (i % 2 === 1) {
      const zebra = new Graphics();
      zebra.rect(0, y, opts.width, rh);
      zebra.fill({ color: BG_PANEL, alpha: 0.4 });
      c.addChild(zebra);
    }
    let cx = 0;
    for (const col of opts.columns) {
      const val = row[col.key];
      const text = val === undefined || val === null ? "" : String(val);
      c.addChild(makeLabel(text, cx + 4, y + 2, COLOR_TEXT, fs2));
      cx += col.width;
    }
    y += rh;
  }
  // Borders
  const border = new Graphics();
  border.rect(0, 0, opts.width, y);
  border.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(border);
  return c;
}

// ── Line chart (time-series) ──

export interface LineSeries {
  label: string;
  data: number[];
  color: number;
}

export interface LineChartOpts {
  x: number;
  y: number;
  width: number;
  height: number;
  series: LineSeries[];
  yMax?: number;
  yLabel?: string;
  scrollOffset?: number;
}

export function makeLineChart(opts: LineChartOpts): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const padL = 40;
  const padT = 20;
  const padB = 18;
  const chartW = opts.width - padL - 10;
  const chartH = opts.height - padT - padB;
  const chartX = padL;
  const chartY = padT;
  // Auto-scale Y
  let maxVal = opts.yMax ?? 0;
  if (maxVal <= 0) {
    for (const s of opts.series) {
      for (const v of s.data) {
        if (v > maxVal) maxVal = v;
      }
    }
  }
  if (maxVal <= 0) maxVal = 1;
  // Background
  const bg = new Graphics();
  bg.rect(chartX, chartY, chartW, chartH);
  bg.fill({ color: 0x0a0a16, alpha: 0.6 });
  c.addChild(bg);
  // Grid (4 horizontal)
  const grid = new Graphics();
  for (let i = 0; i <= 4; i++) {
    const gy = chartY + (chartH * i) / 4;
    grid.moveTo(chartX, gy);
    grid.lineTo(chartX + chartW, gy);
    grid.stroke({ color: BG_GRID, width: 1, alpha: 0.5 });
    const val = maxVal * (1 - i / 4);
    c.addChild(makeLabel(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0), chartX - 34, gy - 6, COLOR_TEXT_DIM, 11));
  }
  for (let i = 0; i <= 6; i++) {
    const gx = chartX + (chartW * i) / 6;
    grid.moveTo(gx, chartY);
    grid.lineTo(gx, chartY + chartH);
    grid.stroke({ color: BG_GRID, width: 1, alpha: 0.3 });
  }
  c.addChild(grid);
  // Axes
  const axes = new Graphics();
  axes.moveTo(chartX, chartY);
  axes.lineTo(chartX, chartY + chartH);
  axes.lineTo(chartX + chartW, chartY + chartH);
  axes.stroke({ color: COLOR_AXIS, width: 1 });
  c.addChild(axes);
  // Lines
  const scroll = opts.scrollOffset ?? 0;
  for (const s of opts.series) {
    if (s.data.length < 2) continue;
    const line = new Graphics();
    const n = s.data.length;
    const sampleW = chartW / Math.max(n - 1, 1);
    for (let i = 0; i < n; i++) {
      const v = s.data[i];
      const px = chartX + chartW - (n - 1 - i) * sampleW - scroll * sampleW;
      const py = chartY + chartH - (v / maxVal) * chartH;
      if (i === 0) line.moveTo(px, py);
      else line.lineTo(px, py);
    }
    line.stroke({ color: s.color, width: 1.5 });
    c.addChild(line);
  }
  // Y label
  if (opts.yLabel) {
    c.addChild(makeLabel(opts.yLabel, 2, chartY - 14, COLOR_TEXT_DIM, 11));
  }
  // Legend
  let lx = chartX + 4;
  const ly = chartY + chartH + 4;
  for (const s of opts.series) {
    const sw = new Graphics();
    sw.rect(lx, ly + 2, 10, 10);
    sw.fill({ color: s.color });
    c.addChild(sw);
    c.addChild(makeLabel(s.label, lx + 14, ly, COLOR_TEXT_DIM, 10));
    lx += 14 + s.label.length * 6 + 16;
  }
  return c;
}

// ── Key/value grid (GPU info, device limits) ──

export interface KeyValueOpts {
  x: number;
  y: number;
  width: number;
  entries: { key: string; value: string }[];
  rowHeight?: number;
  fontSize?: number;
}

export function makeKeyValueGrid(opts: KeyValueOpts): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const rh = opts.rowHeight ?? 16;
  const fs2 = opts.fontSize ?? 11;
  let y = 0;
  for (const entry of opts.entries) {
    c.addChild(makeLabel(entry.key, 4, y + 1, COLOR_TEXT_DIM, fs2));
    c.addChild(makeLabel(entry.value, opts.width * 0.45, y + 1, COLOR_TEXT, fs2));
    y += rh;
  }
  return c;
}

// ── Section (collapsible header + content) ──

export interface SectionOpts {
  label: string;
  x: number;
  y: number;
  width: number;
  expanded: boolean;
}

export function makeSectionHeader(opts: SectionOpts, hits: HitCollector, onToggle: () => void): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const h = 22;
  const bg = new Graphics();
  bg.rect(0, 0, opts.width, h);
  bg.fill({ color: BG_DARK, alpha: 0.9 });
  c.addChild(bg);
  const tri = new Graphics();
  const cx = 8;
  const cy = h / 2;
  if (opts.expanded) {
    tri.moveTo(cx - 4, cy - 4);
    tri.lineTo(cx + 4, cy - 4);
    tri.lineTo(cx, cy + 4);
    tri.closePath();
  } else {
    tri.moveTo(cx - 4, cy - 4);
    tri.lineTo(cx - 4, cy + 4);
    tri.lineTo(cx + 4, cy);
    tri.closePath();
  }
  tri.fill({ color: COLOR_TEXT_DIM });
  c.addChild(tri);
  c.addChild(makeLabel(opts.label, 18, 3, COLOR_TEXT_BRIGHT, 12));
  hits.add(opts.x, opts.y, opts.width, h, onToggle);
  return c;
}

// ── Text input (read-only display + optional editable field) ──

export interface TextInputOpts {
  x: number;
  y: number;
  width: number;
  height?: number;
  placeholder?: string;
  value: string;
  fontSize?: number;
}

export function makeTextInput(opts: TextInputOpts): Container {
  const c = new Container();
  c.x = opts.x;
  c.y = opts.y;
  const h = opts.height ?? 22;
  const bg = new Graphics();
  bg.roundRect(0, 0, opts.width, h, 3);
  bg.fill({ color: BG_INPUT, alpha: 0.95 });
  bg.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(bg);
  const text = opts.value || opts.placeholder || "";
  const color = opts.value ? COLOR_TEXT : COLOR_TEXT_DIM;
  c.addChild(makeLabel(text, 6, 3, color, opts.fontSize ?? 12));
  return c;
}

// ── Format helpers ──

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function formatUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}us`;
  return `${(us / 1000).toFixed(2)}ms`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  return `${ms.toFixed(2)}ms`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
