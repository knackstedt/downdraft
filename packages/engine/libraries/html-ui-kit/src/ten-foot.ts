// ============================================================================
// ten-foot.ts — 10-foot / couch UI widgets + TV theme preset.
//
// These build on the same conventions as components.ts (data-kit roots,
// data-action verbs, data-* state attrs) plus nav markup understood by
// NavController: `data-nav` marks items focusable and `data-nav-zone`
// declares a focus scope (pushZone traps pad input inside blades/modals,
// popZone returns to the remembered focus).
//
// Pair with tvCss() for distance legibility; then a game only mounts a
// panel — pad nav, OSK, and scroll-into-view come free.
// ============================================================================

import { dataAttrs, esc } from "./components";

const on = (v: boolean | undefined) => (v ? ` data-on="true"` : ` data-on="false"`);

// ── TV theme preset ──

/**
 * Stylesheet for couch-distance UIs (~10 feet). Compose after kitStyleTag():
 * `mount("<style>" + kitCss + tvCss() + "</style>")`. Scales type/controls
 * ~1.5×, widens hit targets, and strengthens the nav focus ring.
 */
export function tvCss(): string {
  return `
body { font-size: 18px; }
.dd-btn { font-size:17px; padding:11px 20px; }
.dd-input, .dd-textarea { font-size:17px; padding:9px 12px; }
.dd-section { font-size:14px; }
.dd-li, .dd-mi { font-size:16px; padding:10px 14px; }
.dd-t { font-size:16px; padding:9px 18px; }
/* NavController focus ring — bigger + animated-friendly for TV. */
[data-nav-focus="1"] { border-color:var(--dd-accent); background:var(--dd-accent-bg); }
.dd-card[data-nav-focus="1"] { border-color:var(--dd-accent); background:#25313f; }
/* Shelf + card widgets. */
.dd-shelf { margin: 14px 0; }
.dd-shelf-title { font-size:15px; color:var(--dd-dim); letter-spacing:1px; margin:0 0 8px 4px; }
.dd-shelf-row { display:flex; gap:14px; overflow-x:auto; padding:4px; }
.dd-card { flex:0 0 auto; width:180px; border:2px solid var(--dd-line); border-radius:8px;
  background:var(--dd-panel); padding:12px; }
.dd-card-art { height:96px; border-radius:5px; background:var(--dd-panel2); margin-bottom:9px;
  display:flex; align-items:center; justify-content:center; color:var(--dd-faint); font-size:26px; }
.dd-card-label { font-size:15px; color:var(--dd-text); }
.dd-card-sub { font-size:12px; color:var(--dd-dim); margin-top:3px; }
/* Blade — slide-in edge panel. data-open controls visibility. */
.dd-blade { position:absolute; top:0; bottom:0; width:360px; background:var(--dd-panel);
  border-left:1px solid var(--dd-line2); padding:22px; }
.dd-blade[data-side="right"] { right:0; border-left:1px solid var(--dd-line2); border-right:0; }
.dd-blade[data-side="left"] { left:0; border-right:1px solid var(--dd-line2); border-left:0; }
.dd-blade[data-open="false"] { display:none; }
.dd-blade-title { font-size:20px; margin-bottom:16px; }
/* Detail hero. */
.dd-detail { padding:26px; }
.dd-detail-title { font-size:30px; margin-bottom:6px; }
.dd-detail-sub { font-size:15px; color:var(--dd-dim); margin-bottom:14px; }
.dd-detail-desc { font-size:15px; line-height:1.5; max-width:640px; margin-bottom:18px; }
/* Command palette. */
.dd-cmdk { position:absolute; top:12%; left:50%; transform:translateX(-50%);
  width:560px; background:var(--dd-panel); border:1px solid var(--dd-line2);
  border-radius:10px; padding:14px; }
.dd-cmdk[data-open="false"] { display:none; }
.dd-cmdk input { width:100%; font-size:17px; padding:11px 13px; margin-bottom:8px;
  background:var(--dd-sink); border:1px solid var(--dd-line2); border-radius:6px; color:var(--dd-text); }
/* Settings row — label left, control right. */
.dd-srow { display:flex; align-items:center; padding:11px 14px; border-radius:6px;
  border:1px solid transparent; gap:16px; }
.dd-srow[data-nav-focus="1"] { background:var(--dd-panel2); border-color:var(--dd-accent); }
.dd-srow-lbl { flex:1; }
.dd-srow-title { font-size:16px; }
.dd-srow-hint { font-size:12px; color:var(--dd-dim); margin-top:2px; }
.dd-srow-ctl { flex:0 0 auto; }
`;
}

// ── shelves / cards ──

export interface MediaCardOpts {
  /** Focusable id (optional — cards are reachable by data-action too). */
  id?: string;
  label: string;
  sub?: string;
  /** Short glyph/text shown in the art tile (e.g. "▶", initials). */
  art?: string;
  /** data-action verb fired on confirm — defaults to "kit:open". */
  action?: string;
  data?: Record<string, string | number>;
  /** Card width in px (default 180). */
  width?: number;
}
export function mediaCard(o: MediaCardOpts): string {
  const id = o.id ?? `card-${o.label.replace(/\W+/g, "-").toLowerCase()}`;
  const w = o.width ? ` style="width:${o.width}px"` : "";
  return `<div class="dd-card" id="${esc(id)}" data-nav data-action="${esc(o.action ?? "kit:open")}"` +
    ` data-id="${esc(id)}"${o.data ? dataAttrs(o.data) : ""}${w}>` +
    `<div class="dd-card-art">${esc(o.art ?? "▶")}</div>` +
    `<div class="dd-card-label">${esc(o.label)}</div>` +
    (o.sub ? `<div class="dd-card-sub">${esc(o.sub)}</div>` : "") + `</div>`;
}

/** Horizontal scrolling shelf of cards — the Netflix row. */
export function shelf(o: { id: string; title?: string; items: MediaCardOpts[] }): string {
  return `<div class="dd-shelf" id="${esc(o.id)}" data-kit="shelf">` +
    (o.title ? `<div class="dd-shelf-title">${esc(o.title)}</div>` : "") +
    `<div class="dd-shelf-row">${o.items.map(mediaCard).join("")}</div></div>`;
}

/** Poster grid — same cards, fixed column count, vertical flow. */
export function mediaGrid(o: { id: string; items: MediaCardOpts[]; cols?: number; cardWidth?: number }): string {
  const w = o.cardWidth ?? 160;
  return `<div id="${esc(o.id)}" data-kit="grid" style="display:flex;flex-wrap:wrap;gap:14px;` +
    `padding:4px">${o.items.map((c) => mediaCard({ ...c, width: w })).join("")}</div>`;
}

// ── blade / detail ──

/**
 * Slide-in edge panel (Xbox blade). Markup carries `data-nav-zone` so the
 * app can `nav.pushZone("blade:<id>")` when opening — cancel pops back out.
 */
export function blade(o: {
  id: string; title: string; html: string;
  side?: "left" | "right"; open?: boolean;
}): string {
  return `<div class="dd-blade" id="${esc(o.id)}" data-kit="blade" data-nav-zone="blade:${esc(o.id)}"` +
    ` data-side="${o.side ?? "right"}" data-open="${o.open ? "true" : "false"}">` +
    `<div class="dd-blade-title">${esc(o.title)}</div>${o.html}</div>`;
}

/** Hero detail panel — title, subtitle, description, action row. */
export function detailPanel(o: {
  title: string; sub?: string; description?: string; actionsHtml?: string;
}): string {
  return `<div class="dd-detail" data-kit="detail">` +
    `<div class="dd-detail-title">${esc(o.title)}</div>` +
    (o.sub ? `<div class="dd-detail-sub">${esc(o.sub)}</div>` : "") +
    (o.description ? `<div class="dd-detail-desc">${esc(o.description)}</div>` : "") +
    (o.actionsHtml ? `<div class="dd-row" style="gap:12px">${o.actionsHtml}</div>` : "") +
    `</div>`;
}

// ── command palette ──

export interface PaletteItem { label: string; hint?: string; action?: string; data?: Record<string, string | number> }
/**
 * Modal command palette — filter input + nav list. `data-nav-zone` scopes
 * pad focus while open; the input is editable so OSK auto-open applies.
 */
export function commandPalette(o: { id: string; items: PaletteItem[]; open?: boolean; placeholder?: string }): string {
  const items = o.items.map((it, i) =>
    `<div class="dd-mi" data-nav data-action="${esc(it.action ?? "kit:palette")}" data-id="${esc(o.id)}"` +
    ` data-i="${i}"${it.data ? dataAttrs(it.data) : ""}>${esc(it.label)}` +
    (it.hint ? ` <span style="color:var(--dd-faint);font-size:12px">${esc(it.hint)}</span>` : "") +
    `</div>`).join("");
  return `<div class="dd-cmdk" id="${esc(o.id)}" data-kit="cmdk" data-nav-zone="cmdk:${esc(o.id)}"` +
    ` data-open="${o.open ? "true" : "false"}">` +
    `<input type="text" placeholder="${esc(o.placeholder ?? "Type a command…")}" data-no-osk>` +
    `<div class="dd-col" style="gap:2px">${items}</div></div>`;
}

// ── settings rows ──

/**
 * Settings row primitive — label + hint on the left, any control markup on
 * the right. The row itself is focusable (`data-nav`) so pad users land on
 * the whole row; confirm fires `action` (e.g. toggle the control).
 */
export function settingsRow(o: {
  id: string; label: string; hint?: string;
  /** Right-side control markup (button/switch/slider/…). */
  control: string;
  /** data-action fired when the row is confirmed. */
  action?: string;
  on?: boolean; disabled?: boolean;
}): string {
  return `<div class="dd-srow" id="${esc(o.id)}" data-kit="srow" data-nav` +
    ` data-action="${esc(o.action ?? "kit:srow")}" data-id="${esc(o.id)}"${on(o.on)}` +
    `${o.disabled ? ` data-disabled="true"` : ""}>` +
    `<div class="dd-srow-lbl"><div class="dd-srow-title">${esc(o.label)}</div>` +
    (o.hint ? `<div class="dd-srow-hint">${esc(o.hint)}</div>` : "") + `</div>` +
    `<div class="dd-srow-ctl">${o.control}</div></div>`;
}
