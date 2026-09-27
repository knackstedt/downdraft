// ============================================================================
// components.ts — Downdraft kit widget markup builders. Every builder returns
// an HTML string; compose them inside renderHtml()/setHtml() markup.
//
// Conventions understood by bindKit() (behaviors.ts):
//   widget root : id + data-kit="<kind>"
//   triggers    : data-action="kit:<verb>" + data-id="<widget id>"
//   state attrs : data-on / data-open / data-selected / data-disabled
//   parts       : data-part="<track|fill|thumb|value|opt|item|...>"
//
// State styling keys off data-* attributes (see theme.ts), so runtime updates
// are single setAttr mutations — never rebuild markup for a state change.
// ============================================================================

/** Escape a string for HTML text/attr positions. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** data-* attrs from a record (values escaped, `k` gets `data-` prefix). */
export function dataAttrs(d: Record<string, string | number | boolean | undefined>): string {
  let out = "";
  for (const k in d) {
    const v = d[k];
    if (v === undefined) continue;
    out += ` data-${k}="${esc(String(v))}"`;
  }
  return out;
}

const on = (v: boolean | undefined) => (v ? ` data-on="true"` : ` data-on="false"`);
const dis = (v: boolean | undefined) => (v ? ` data-disabled="true"` : "");

// ── primitives ──

export interface ButtonOpts {
  id?: string; label: string; kind?: "normal" | "accent" | "danger" | "ghost";
  disabled?: boolean; on?: boolean;
  /** Custom action verb; defaults to kit:press handled by onAction passthrough. */
  action?: string; data?: Record<string, string | number>;
}
export function button(o: ButtonOpts): string {
  const id = o.id ?? `btn-${o.label.replace(/\W+/g, "-").toLowerCase()}`;
  return `<div class="dd-btn" id="${esc(id)}" data-kit="button" data-action="kit:press" data-id="${esc(id)}"` +
    `${o.kind ? ` data-kind="${o.kind}"` : ""}${o.action ? ` data-verb="${esc(o.action)}"` : ""}` +
    `${on(o.on)}${dis(o.disabled)}${o.data ? dataAttrs(o.data) : ""}>${esc(o.label)}</div>`;
}

export function badge(o: { label: string; kind?: "default" | "accent" | "good" | "warn" | "bad" }): string {
  return `<div class="dd-badge" data-kind="${o.kind ?? "default"}">${esc(o.label)}</div>`;
}

export function label(text: string): string {
  return `<div class="dd-label">${esc(text)}</div>`;
}

export function sectionLabel(text: string): string {
  return `<div class="dd-section">${esc(text)}</div>`;
}

export function divider(): string {
  return `<div class="dd-divider"></div>`;
}

export function spacer(px: number): string {
  return `<div style="height:${px}px"></div>`;
}

export function panel(html: string, extraStyle = ""): string {
  return `<div class="dd-panel" style="${extraStyle}">${html}</div>`;
}

export function row(html: string): string {
  return `<div class="dd-row">${html}</div>`;
}

export function col(html: string): string {
  return `<div class="dd-col">${html}</div>`;
}

// ── toggles ──

export interface ToggleOpts { id: string; label?: string; on?: boolean; disabled?: boolean }

export function checkbox(o: ToggleOpts): string {
  return `<div class="dd-check" id="${esc(o.id)}" data-kit="checkbox" data-action="kit:toggle"` +
    ` data-id="${esc(o.id)}"${on(o.on)}${dis(o.disabled)}>` +
    `<div class="dd-box">${o.on ? "X" : ""}</div>${o.label ? `<div class="dd-lbl">${esc(o.label)}</div>` : ""}</div>`;
}

export function switchToggle(o: ToggleOpts): string {
  return `<div class="dd-switch" id="${esc(o.id)}" data-kit="switch" data-action="kit:toggle"` +
    ` data-id="${esc(o.id)}"${on(o.on)}${dis(o.disabled)}>` +
    `<div class="dd-rail"><div class="dd-knob"></div></div>${o.label ? `<div class="dd-lbl">${esc(o.label)}</div>` : ""}</div>`;
}

export interface RadioOpts { id: string; options: string[]; selected?: number; disabled?: boolean }
export function radioGroup(o: RadioOpts): string {
  const opts = o.options.map((label, i) =>
    `<div class="dd-opt" data-part="opt" data-action="kit:radio" data-id="${esc(o.id)}"` +
    ` data-group="${esc(o.id)}" data-i="${i}"${on(o.selected === i)}${dis(o.disabled)}>` +
    `<div class="dd-dot"></div><div class="dd-lbl">${esc(label)}</div></div>`).join("");
  return `<div class="dd-radio" id="${esc(o.id)}" data-kit="radio" data-count="${o.options.length}">${opts}</div>`;
}

// ── value widgets ──

export interface SliderOpts {
  id: string; label?: string; min?: number; max?: number; value?: number;
  showValue?: boolean; disabled?: boolean; width?: number;
}
export function slider(o: SliderOpts): string {
  const min = o.min ?? 0, max = o.max ?? 100, v = o.value ?? min;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  const w = o.width ? ` style="width:${o.width}px"` : "";
  return `<div class="dd-slider" id="${esc(o.id)}" data-kit="slider" data-min="${min}" data-max="${max}" data-value="${v}"${dis(o.disabled)}${w}>` +
    (o.label || o.showValue
      ? `<div class="dd-srow"><span>${esc(o.label ?? "")}</span><span data-part="value">${v}</span></div>`
      : "") +
    `<div class="dd-track" data-part="track" data-action="kit:drag" data-id="${esc(o.id)}">` +
    `<div class="dd-fill" data-part="fill" style="width:${pct}%"></div>` +
    `<div class="dd-thumb" data-part="thumb" style="left:${pct}%"></div></div></div>`;
}

export function progressBar(o: { id?: string; value: number; kind?: "good" | "accent" | "warn" | "bad" }): string {
  const pct = Math.max(0, Math.min(100, o.value));
  return `<div class="dd-progress"${o.id ? ` id="${esc(o.id)}"` : ""} data-kit="progress"` +
    `${o.kind ? ` data-kind="${o.kind}"` : ""}><div class="dd-pfill" data-part="fill" style="width:${pct}%"></div></div>`;
}

export function spinner(o: { id?: string; size?: number } = {}): string {
  const s = o.size ?? 18;
  return `<div class="dd-spinner"${o.id ? ` id="${esc(o.id)}"` : ""} style="width:${s}px;height:${s}px"></div>`;
}

// ── text inputs ──

export interface InputOpts {
  id: string; label?: string; value?: string; placeholder?: string;
  disabled?: boolean; invalid?: boolean; width?: number;
}
export function textInput(o: InputOpts): string {
  const input = `<input class="dd-input" id="${esc(o.id)}" data-kit="input" data-id="${esc(o.id)}"` +
    ` type="text" value="${esc(o.value ?? "")}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ""}` +
    `${dis(o.disabled)}${o.invalid ? ` data-invalid="true"` : ""}${o.width ? ` style="width:${o.width}px"` : ""}>`;
  return o.label ? `<div class="dd-field"><div class="dd-lbl">${esc(o.label)}</div>${input}</div>` : input;
}

export function textArea(o: InputOpts & { rows?: number }): string {
  const area = `<textarea class="dd-textarea" id="${esc(o.id)}" data-kit="textarea" data-id="${esc(o.id)}"` +
    `${dis(o.disabled)}${o.invalid ? ` data-invalid="true"` : ""}${o.width ? ` style="width:${o.width}px"` : ""}` +
    `${o.rows ? ` style="height:${o.rows * 18}px"` : ""}>${esc(o.value ?? "")}</textarea>`;
  return o.label ? `<div class="dd-field"><div class="dd-lbl">${esc(o.label)}</div>${area}</div>` : area;
}

export interface NumberFieldOpts extends InputOpts { min?: number; max?: number; step?: number }
export function numberField(o: NumberFieldOpts): string {
  const v = o.value ?? "0";
  return `<div class="dd-field"><div class="dd-lbl">${esc(o.label ?? "")}</div>` +
    `<div class="dd-num" data-kit="number" data-id="${esc(o.id)}" data-min="${o.min ?? ""}"` +
    ` data-max="${o.max ?? ""}" data-step="${o.step ?? 1}">` +
    `<input class="dd-input" id="${esc(o.id)}" type="text" value="${esc(String(v))}"${o.width ? ` style="width:${o.width ?? 110}px"` : ""}${dis(o.disabled)}>` +
    `<div class="dd-btn dd-step" data-action="kit:inc" data-id="${esc(o.id)}">+</div>` +
    `<div class="dd-btn dd-step" data-action="kit:dec" data-id="${esc(o.id)}">−</div></div></div>`;
}

// ── pickers ──

export interface SegmentedOpts { id: string; options: string[]; selected?: number; disabled?: boolean }
export function segmented(o: SegmentedOpts): string {
  const opts = o.options.map((label, i) =>
    `<div class="dd-o" data-part="opt" data-action="kit:select" data-id="${esc(o.id)}"` +
    ` data-i="${i}" data-count="${o.options.length}"${on(o.selected === i)}${dis(o.disabled)}>${esc(label)}</div>`).join("");
  return `<div class="dd-seg" id="${esc(o.id)}" data-kit="segmented">${opts}</div>`;
}

export interface TabsOpts { id: string; tabs: string[]; selected?: number }
export function tabs(o: TabsOpts): string {
  const ts = o.tabs.map((t, i) =>
    `<div class="dd-t" data-part="tab" data-action="kit:select" data-id="${esc(o.id)}"` +
    ` data-i="${i}" data-count="${o.tabs.length}"${on(o.selected === i)}>${esc(t)}</div>`).join("");
  return `<div class="dd-tabs" id="${esc(o.id)}" data-kit="tabs">${ts}</div>`;
}

export interface DropdownOpts {
  id: string; options: string[]; selected?: number; placeholder?: string;
  disabled?: boolean; width?: number;
}
export function dropdown(o: DropdownOpts): string {
  const sel = o.selected !== undefined ? o.options[o.selected] : (o.placeholder ?? "Select…");
  const items = o.options.map((opt, i) =>
    `<div class="dd-mi" data-action="kit:choice" data-id="${esc(o.id)}" data-i="${i}"` +
    ` data-value="${esc(opt)}"${on(o.selected === i)}>${esc(opt)}</div>`).join("");
  return `<div class="dd-dd" id="${esc(o.id)}" data-kit="dropdown" data-value="${esc(sel ?? "")}" data-open="false"` +
    `${o.width ? ` style="width:${o.width}px"` : ""}${dis(o.disabled)}>` +
    `<div class="dd-ddbtn" data-action="kit:open" data-id="${esc(o.id)}">` +
    `<span data-part="label">${esc(sel ?? "")}</span><span class="dd-caret">▾</span></div>` +
    `<div class="dd-menu" data-part="menu">${items}</div></div>`;
}

export interface MenuItem { label: string; value?: string; sep?: boolean }
export function menu(items: MenuItem[], actionPrefix = "kit:choice", id = ""): string {
  const body = items.map((it) => it.sep
    ? `<div class="dd-msep"></div>`
    : `<div class="dd-mi" data-action="${actionPrefix}"${id ? ` data-id="${esc(id)}"` : ""}` +
      ` data-value="${esc(it.value ?? it.label)}">${esc(it.label)}</div>`).join("");
  return `<div class="dd-menu" data-part="menu" style="display:block;position:static">${body}</div>`;
}

// ── collections ──

export interface ListOpts { id: string; items: string[]; selected?: number; height?: number }
export function listView(o: ListOpts): string {
  const items = o.items.map((it, i) =>
    `<div class="dd-li" data-part="item" data-action="kit:select" data-id="${esc(o.id)}"` +
    ` data-i="${i}" data-count="${o.items.length}"${on(o.selected === i)}>${esc(it)}</div>`).join("");
  return `<div class="dd-list" id="${esc(o.id)}" data-kit="list" data-count="${o.items.length}"` +
    ` style="height:${o.height ?? 120}px">${items}</div>`;
}

export function scrollView(o: { id: string; html: string; height?: number }): string {
  return `<div class="dd-scroll" id="${esc(o.id)}" data-kit="scroll" data-id="${esc(o.id)}"` +
    ` style="height:${o.height ?? 140}px">${o.html}</div>`;
}

export interface TableOpts { id?: string; cols: string[]; rows: string[][]; selected?: number }
export function dataTable(o: TableOpts): string {
  const head = `<tr>${o.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = o.rows.map((r, i) =>
    `<tr${o.id ? ` data-action="kit:select" data-id="${esc(o.id)}" data-i="${i}" data-count="${o.rows.length}"` : ""}${on(o.selected === i)}>` +
    `${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table class="dd-table"${o.id ? ` id="${esc(o.id)}" data-kit="table"` : ""}>${head}${body}</table>`;
}

export interface TreeNode { label: string; children?: TreeNode[]; open?: boolean }
function treeNodes(id: string, nodes: TreeNode[], path: string, selected?: string): string {
  return nodes.map((n, i) => {
    const p = path ? `${path}.${i}` : `${i}`;
    const kids = n.children?.length
      ? `<div class="dd-kids">${treeNodes(id, n.children, p, selected)}</div>` : "";
    const caret = n.children?.length
      ? `<div class="dd-caret" data-action="kit:node" data-id="${esc(id)}" data-i="${p}">${n.open === false ? "▶" : "▼"}</div>`
      : `<div class="dd-caret"></div>`;
    return `<div class="dd-trow" data-i="${p}" data-action="kit:pick" data-id="${esc(id)}"` +
      `${on(selected === p)}${n.children?.length ? ` data-open="${n.open !== false}"` : ""}>` +
      `${caret}<div>${esc(n.label)}</div></div>${kids}`;
  }).join("");
}
export function treeView(o: { id: string; nodes: TreeNode[]; selected?: string; height?: number }): string {
  return `<div class="dd-tree dd-list" id="${esc(o.id)}" data-kit="tree"` +
    ` style="height:${o.height ?? 140}px">${treeNodes(o.id, o.nodes, "", o.selected)}</div>`;
}

export interface AccordionSection { title: string; html: string; open?: boolean }
export function accordion(o: { id: string; sections: AccordionSection[] }): string {
  const secs = o.sections.map((s, i) =>
    `<div class="dd-as" data-i="${i}" data-open="${s.open !== false}">` +
    `<div class="dd-ah" data-action="kit:acc" data-id="${esc(o.id)}" data-i="${i}">` +
    `<span>${esc(s.title)}</span><span class="dd-caret">${s.open !== false ? "▾" : "▸"}</span></div>` +
    `<div class="dd-ab">${s.html}</div></div>`).join("");
  return `<div class="dd-acc dd-col" id="${esc(o.id)}" data-kit="accordion">${secs}</div>`;
}

// ── overlays ──

export function modal(o: { id: string; title: string; html: string; open?: boolean; buttons?: string }): string {
  return `<div class="dd-modal" id="${esc(o.id)}" data-kit="modal" data-open="${o.open ? "true" : "false"}">` +
    `<div class="dd-backdrop" data-action="kit:close" data-id="${esc(o.id)}"></div>` +
    `<div class="dd-dlg"><div class="dd-dtitle">${esc(o.title)}</div>${o.html}` +
    (o.buttons ? `<div class="dd-dbtns">${o.buttons}</div>` : "") + `</div></div>`;
}

export function tooltipWrap(html: string, tip: string): string {
  return `<div class="dd-tipwrap">${html}<div class="dd-tip">${esc(tip)}</div></div>`;
}

export function contextMenu(o: { id: string; items: MenuItem[]; x?: number; y?: number; open?: boolean }): string {
  const items = o.items.map((it) => it.sep
    ? `<div class="dd-msep"></div>`
    : `<div class="dd-mi" data-action="kit:ctxitem" data-id="${esc(o.id)}"` +
      ` data-value="${esc(it.value ?? it.label)}">${esc(it.label)}</div>`).join("");
  return `<div class="dd-ctx" id="${esc(o.id)}" data-kit="ctxmenu" data-open="${o.open ? "true" : "false"}"` +
    ` style="left:${o.x ?? 0}px;top:${o.y ?? 0}px">${items}</div>`;
}

export type ToastKind = "good" | "warn" | "bad" | "info";
export interface Toast { id: string; kind?: ToastKind; message: string }
export function toastStack(toasts: Toast[]): string {
  const items = toasts.map((t) =>
    `<div class="dd-toast" id="${esc(t.id)}" data-kind="${t.kind ?? "good"}"><div>${esc(t.message)}</div>` +
    `<div class="dd-x" data-action="kit:dismiss" data-id="${esc(t.id)}">✕</div></div>`).join("");
  return `<div class="dd-toasts" data-kit="toasts">${items}</div>`;
}

// ── misc ──

export function toolbar(html: string): string {
  return `<div class="dd-toolbar">${html}</div>`;
}

export function kvTable(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) =>
    `<div class="dd-kv"><div class="dd-k">${esc(k)}</div><div class="dd-v">${esc(v)}</div></div>`).join("");
}

export function fieldError(msg: string, id?: string): string {
  return `<div class="dd-err"${id ? ` id="${esc(id)}"` : ""}>${esc(msg)}</div>`;
}
