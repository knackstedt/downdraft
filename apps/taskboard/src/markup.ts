// ============================================================================
// markup.ts — document markup for the main app shell: toolbar + tabs + the
// Board and Dashboard pages + every overlay (task blade, modals, context
// menus, command palette, toast stack). The Widgets gallery, Settings page
// and the TV document live in gallery.ts.
// ============================================================================

import type { AppMenuModel } from "@downdraft/engine/app/shared/types";
import * as kit from "@downdraft/engine/libraries/html-ui-kit";
import { ASSIGNEES, COLUMNS, store, type ColumnId, type Task } from "./state";

// ── app stylesheet ──

export const APP_CSS = `
html, body { height:100%; }
#app { display:flex; flex-direction:column; height:100%; }
.tb-toolbar { display:flex; align-items:center; gap:10px; padding:8px 12px;
  background:var(--dd-panel); border-bottom:1px solid var(--dd-line); }
.tb-title { font-size:14px; font-weight:bold; }
.tb-sub { font-size:10px; color:var(--dd-faint); }
.tb-spacer { flex:1; }
#content { flex:1; display:flex; min-height:0; }
.page { flex:1; display:flex; min-height:0; }
.page[data-hidden="true"] { display:none; }

/* ── board ── */
#board-side { width:236px; border-right:1px solid var(--dd-line); padding:10px;
  display:flex; flex-direction:column; gap:10px; overflow-y:auto; background:var(--dd-panel); }
#board-cols { flex:1; display:flex; gap:10px; padding:10px; min-width:0; min-height:0; }
.kb-col { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0;
  background:var(--dd-panel); border:1px solid var(--dd-line); border-radius:8px; }
.kb-col-h { padding:8px 10px; border-bottom:1px solid var(--dd-line);
  display:flex; align-items:center; gap:8px; }
.kb-col-title { font-size:12px; font-weight:bold; flex:1; }
.kb-col-hint { font-size:9px; color:var(--dd-faint); }
.kb-scroll { flex:1; min-height:0; border:none; background:transparent; }
.kb-card { background:var(--dd-panel2); border:1px solid var(--dd-line); user-select:none;
  border-radius:6px; padding:9px; margin-bottom:8px; }
.kb-card:hover { border-color:var(--dd-accent); }
.kb-card-title { font-size:12px; font-weight:bold; margin-bottom:6px; }
.kb-card-desc { font-size:10px; color:var(--dd-dim); margin-bottom:7px; }
.kb-card-tags { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:7px; }
.kb-card-foot { display:flex; align-items:center; gap:6px; margin-top:7px;
  font-size:10px; color:var(--dd-dim); }
.kb-foot-right { margin-left:auto; display:flex; gap:4px; }
.kb-empty { color:var(--dd-faint); font-size:11px; text-align:center; padding:14px 0; }
body[data-compact="true"] .kb-card { padding:5px; }
body[data-compact="true"] .kb-card-desc { display:none; }
body[data-compact="true"] .kb-card-title { font-size:11px; margin-bottom:3px; }

/* ── dashboard ── */
#dash { flex:1; display:flex; gap:10px; padding:10px; min-height:0; }
.dash-col { flex:1; min-width:0; overflow-y:auto; padding:2px; }
/* block layout, not flex: flex children inside a scroll container come out 0x0 */
.dash-col > * { margin-bottom:10px; }
.dash-num { font-size:26px; font-weight:bold; color:var(--dd-accent); }

/* ── task blade ── */
.blade-body { display:flex; flex-direction:column; gap:10px; }
.blade-h2 { font-size:13px; font-weight:bold; }
.blade-muted { font-size:11px; color:var(--dd-dim); }
.blade-btns { display:flex; gap:6px; flex-wrap:wrap; }

/* ── context menu host / palette ── */
.ctx-open-hint { position:absolute; left:0; top:0; width:1px; height:1px; }

/* ten-foot overlay styles live in tvCss(), not kitStyleTag() — desktop-sized
   re-declarations for the widgets this doc mounts (blade + command palette). */
.dd-blade { position:absolute; top:0; bottom:0; width:340px; right:0;
  background:var(--dd-panel); border-left:1px solid var(--dd-line2);
  padding:16px; overflow-y:auto; }
.dd-blade[data-open="false"] { display:none; }
.dd-blade-title { font-size:15px; font-weight:bold; margin-bottom:12px; }
.dd-cmdk { position:absolute; top:12%; left:50%; margin-left:-240px; width:480px;
  background:var(--dd-panel); border:1px solid var(--dd-line2);
  border-radius:10px; padding:12px; }
.dd-cmdk[data-open="false"] { display:none; }
.dd-cmdk input { width:100%; font-size:13px; padding:9px 11px; margin-bottom:6px;
  background:var(--dd-sink); border:1px solid var(--dd-line2); border-radius:6px;
  color:var(--dd-text); }

/* settingsRow styles live in tvCss(), not kitStyleTag() — re-declare them
   scoped to the settings page so .dd-slider's own .dd-srow sub-rows are
   unaffected (class-name collision in the kit). */
#page-settings .dd-srow { display:flex; align-items:center; padding:9px 12px;
  border-radius:6px; border:1px solid transparent; gap:12px; }
#page-settings .dd-srow + .dd-srow { border-top:1px solid var(--dd-line); border-radius:0; }
#page-settings .dd-srow[data-nav-focus="1"] { background:var(--dd-panel2); border-color:var(--dd-accent); }
.dd-srow-lbl { flex:1; }
.dd-srow-title { font-size:13px; }
.dd-srow-hint { font-size:11px; color:var(--dd-dim); margin-top:2px; }
.dd-srow-ctl { flex:0 0 auto; }

/* ── widgets gallery + settings ── */
.wg-note { color:var(--dd-faint); font-size:10px; margin-top:8px; }
.wg-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
.wg-grid { display:flex; flex-wrap:wrap; gap:14px; }
.wg-col { width:330px; }
#gpu-scroll { height:280px; }
#gpu-slot { height:210px; border-radius:6px; border:1px dashed var(--dd-line2);
  background:rgba(79,194,247,0.05); }
#gpu-slot[data-paused="true"] { border-color:var(--dd-warn); border-style:solid;
  background:rgba(255,176,66,0.10); }

/* ── kanban drag & drop — the ghost is a host-side sprite cropped from the
   card's raster (UiPanelHandle.setSprite): no DOM writes per pointermove. ── */
.kb-card[data-drag-src="1"] { opacity:.35; }
.dd-scroll[data-drop="1"] { border-color:var(--dd-accent); }
/* Drop-position preview — the marked card's edge thickens into an accent
   line so cards visibly make room for the drop. */
.kb-card[data-drop-before="1"] { border-top:3px solid var(--dd-accent); }
.kb-card[data-drop-after="1"] { border-bottom:3px solid var(--dd-accent); }
.kb-card[data-fresh="1"] { animation:dd-card-in .28s ease-out; }
@keyframes dd-card-in { from { opacity:0; transform:translateY(-10px) scale(.96); }
  to { opacity:1; transform:translateY(0) scale(1); } }
`;

// ── shared builders ──

export function priorityBadge(p: Task["priority"]): string {
  const kind = p === "high" ? "bad" : p === "med" ? "warn" : "default";
  return kit.badge({ label: p.toUpperCase(), kind });
}

function tagBadge(tag: string): string {
  return kit.badge({ label: tag, kind: "accent" });
}

/** One-shot flag consumed by the next cardHtml render — the dropped card
 *  animates into its new column via .kb-card[data-fresh]. */
let droppedTask: string | null = null;
export function markDroppedTask(id: string): void { droppedTask = id; }

export function cardHtml(t: Task): string {
  const sub = t.subtasks.length
    ? `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length} subtasks`
    : `${t.points} pts`;
  const fresh = t.id === droppedTask;
  if (fresh) droppedTask = null;
  return `<div class="kb-card"${fresh ? ' data-fresh="1"' : ""} data-task="${kit.esc(t.id)}" data-col="${kit.esc(t.column)}" data-nav>
    <div class="kb-card-title">${kit.esc(t.title)}</div>
    <div class="kb-card-desc">${kit.esc(t.desc)}</div>
    <div class="kb-card-tags">${priorityBadge(t.priority)}${t.tags.map(tagBadge).join("")}</div>
    ${kit.progressBar({ value: t.progress, kind: t.column === "done" ? "good" : "accent" })}
    <div class="kb-card-foot">
      <span>${kit.esc(t.assignee)}</span><span>·</span><span>${sub}</span>
      <span class="kb-foot-right">
        ${kit.button({ label: "◀", kind: "ghost", action: "card:move", data: { task: t.id, dir: "-1" } })}
        ${kit.button({ label: "▶", kind: "ghost", action: "card:move", data: { task: t.id, dir: "1" } })}
      </span>
    </div>
  </div>`;
}

export function columnInnerHtml(col: ColumnId): string {
  const tasks = store.columnTasks(col);
  return tasks.length
    ? tasks.map(cardHtml).join("")
    : `<div class="kb-empty">No tasks — drop one here via the card menu.</div>`;
}

export function columnHtml(col: (typeof COLUMNS)[number]): string {
  const count = store.tasks.filter((t) => t.column === col.id).length;
  // scrollView() pins a fixed height; the column needs a flex-growing
  // .dd-scroll instead — same widget markup, custom size.
  return `<div class="kb-col">
    <div class="kb-col-h" data-action="col:menu" data-col="${col.id}">
      <div style="flex:1">
        <div class="kb-col-title">${kit.esc(col.title)}</div>
        <div class="kb-col-hint">${kit.esc(col.hint)} · right-click for column menu</div>
      </div>
      <span id="col-count-${col.id}">${kit.badge({ label: String(count) })}</span>
      ${kit.button({ label: "+", kind: "ghost", action: "col:add", data: { col: col.id } })}
    </div>
    <div class="dd-scroll kb-scroll" id="col-scroll-${col.id}" data-kit="scroll" data-id="col-scroll-${col.id}">
      <div id="col-body-${col.id}" data-col="${col.id}">${columnInnerHtml(col.id)}</div>
    </div>
  </div>`;
}

function sidebarHtml(): string {
  return `<div id="board-side">
    ${kit.sectionLabel("PROJECT")}
    ${kit.treeView({
      id: "project-tree",
      height: 132,
      nodes: [
        { label: "Downdraft Engine", children: [
          { label: "Renderer", children: [{ label: "html-ui" }, { label: "wgpu shim" }] },
          { label: "Kit widgets" },
          { label: "Platform" },
        ] },
        { label: "Task Board app", children: [{ label: "Board" }, { label: "Widgets" }] },
        { label: "Archive", open: false, children: [{ label: "Old experiments" }] },
      ],
    })}
    ${kit.sectionLabel("QUICK FILTERS")}
    ${kit.checkbox({ id: "flt-high", label: "High priority only" })}
    ${kit.checkbox({ id: "flt-mine", label: "Only with subtasks" })}
    ${kit.sectionLabel("BOARD FEED")}
    <div id="side-activity-wrap">${kit.listView({ id: "side-activity", height: 150, items: store.activity.slice(0, 8).map((a) => a.text) })}</div>
  </div>`;
}

export function boardPage(): string {
  return `<div class="page dd-page" id="page-board">
    ${sidebarHtml()}
    <div id="board-cols">${COLUMNS.map(columnHtml).join("")}</div>
  </div>`;
}

// ── dashboard ──

function dashSummary(): string {
  const s = store.stats();
  return kit.panel(`
    ${kit.sectionLabel("BOARD SUMMARY")}
    <div class="dd-row" style="gap:18px;margin-bottom:8px">
      <div><div class="dash-num">${s.total}</div>${kit.label("tasks")}</div>
      <div><div class="dash-num">${s.completion}%</div>${kit.label("points done")}</div>
    </div>
    ${kit.kvTable([
      ["Total points", String(s.totalPts)],
      ["Done points", String(s.donePts)],
      ["Open tasks", String(s.total - (s.perColumn.find((c) => c.id === "done")?.count ?? 0))],
      ["Activity entries", String(store.activity.length)],
    ])}
    ${kit.spacer(8)}
    ${s.perColumn.map((c) => `
      <div class="dd-row" style="gap:8px;margin:3px 0">
        <div style="width:80px;font-size:11px;color:var(--dd-dim)">${kit.esc(c.title)}</div>
        <div style="flex:1">${kit.progressBar({ value: s.totalPts ? (c.points / s.totalPts) * 100 : 0, kind: c.id === "done" ? "good" : "accent" })}</div>
        <div style="width:52px;font-size:10px;color:var(--dd-dim);text-align:right">${c.count} · ${c.points}pt</div>
      </div>`).join("")}
  `);
}

function dashAssignees(): string {
  const s = store.stats();
  return kit.panel(`
    ${kit.sectionLabel("BY ASSIGNEE")}
    ${kit.dataTable({
      cols: ["Assignee", "Open", "Done"],
      rows: s.perAssignee.map((a) => [a.name, String(a.open), String(a.done)]),
    })}
  `);
}

function dashActivity(): string {
  return kit.panel(`
    ${kit.sectionLabel("ACTIVITY FEED")}
    <div id="dash-activity-wrap">${kit.listView({
      id: "dash-activity", height: 170,
      items: store.activity.slice(0, 14).map((a) =>
        `${new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${a.text}`),
    })}</div>
    ${kit.spacer(6)}
    <div class="dd-row">${kit.spinner({})}<span class="dd-label">live — updates as the board changes</span></div>
  `);
}

function dashMilestones(): string {
  const s = store.stats();
  return kit.accordion({
    id: "dash-milestones",
    sections: [
      { title: `Sprint 12 — widget showcase (${s.perColumn.find((c) => c.id === "doing")?.count ?? 0} open)`, html:
        kit.menu([
          { label: "Kanban interactions" },
          { label: "GPU surface in scroll" },
          { label: "Widget gallery" },
        ], "dash:noop") },
      { title: "Sprint 13 — platform polish", open: false, html:
        kit.menu([{ label: "Menus + tray" }, { label: "Import / export" }], "dash:noop") },
      { title: "Backlog — unscheduled", open: false, html:
        kit.menu([{ label: "A11y pass" }, { label: "Docs site refresh" }], "dash:noop") },
    ],
  });
}

export function dashInnerHtml(): string {
  return `<div class="dash-col">${dashSummary()}${dashMilestones()}</div>
    <div class="dash-col">${dashAssignees()}</div>
    <div class="dash-col">${dashActivity()}</div>`;
}

export function dashPage(): string {
  return `<div class="page dd-page" id="page-dash" data-hidden="true"><div id="dash">${dashInnerHtml()}</div></div>`;
}

// ── overlays ──

export function bladeHtml(): string {
  return kit.blade({
    id: "task-blade",
    title: "Task details",
    side: "right",
    open: false,
    html: `<div class="blade-body" id="blade-body">${kit.label("Select a card to see details.")}</div>`,
  });
}

export function bladeContent(t: Task): string {
  const colIdx = COLUMNS.findIndex((c) => c.id === t.column);
  return `
    <div class="blade-h2">${kit.esc(t.title)}</div>
    <div class="dd-row">${priorityBadge(t.priority)}${t.tags.map(tagBadge).join("")}${kit.badge({ label: t.id, kind: "default" })}</div>
    <div class="blade-muted">${kit.esc(t.desc)}</div>
    ${kit.kvTable([
      ["Status", COLUMNS[colIdx]?.title ?? t.column],
      ["Assignee", t.assignee],
      ["Estimate", `${t.points} points`],
      ["Created", new Date(t.created).toLocaleDateString()],
    ])}
    ${kit.sectionLabel("SUBTASKS")}
    ${t.subtasks.length
      ? t.subtasks.map((s, i) => kit.checkbox({ id: `sub-${t.id}-${i}`, label: s.title, on: s.done })).join("")
      : kit.label("No subtasks.")}
    ${kit.slider({ id: "blade-progress", label: "Progress", min: 0, max: 100, value: t.progress, showValue: true })}
    ${kit.dropdown({ id: "blade-assignee", options: ASSIGNEES, selected: Math.max(0, ASSIGNEES.indexOf(t.assignee)) })}
    ${kit.radioGroup({ id: "blade-priority", options: ["Low", "Medium", "High"], selected: { low: 0, med: 1, high: 2 }[t.priority] })}
    <div class="blade-btns">
      ${colIdx > 0 ? kit.button({ label: `← ${COLUMNS[colIdx - 1].title}`, action: "blade:move", data: { task: t.id, dir: "-1" } }) : ""}
      ${colIdx < COLUMNS.length - 1 ? kit.button({ label: `${COLUMNS[colIdx + 1].title} →`, kind: "accent", action: "blade:move", data: { task: t.id, dir: "1" } }) : ""}
    </div>
    <div class="blade-btns">
      ${kit.button({ label: "Edit in modal", kind: "ghost", action: "blade:edit", data: { task: t.id } })}
      ${kit.button({ label: "Delete task", kind: "danger", action: "blade:delete", data: { task: t.id } })}
    </div>`;
}

export function newTaskModalHtml(): string {
  return kit.modal({
    id: "new-task-modal",
    title: "New task",
    open: false,
    html: `
      ${kit.textInput({ id: "nt-title", label: "Title", placeholder: "What needs doing?" })}
      ${kit.fieldError("", "nt-title-err")}
      ${kit.textArea({ id: "nt-desc", label: "Description", rows: 3 })}
      <div class="dd-field"><div class="dd-lbl">Column</div>${kit.dropdown({ id: "nt-column", options: COLUMNS.map((c) => c.title), selected: 0 })}</div>
      <div class="dd-field"><div class="dd-lbl">Assignee</div>${kit.dropdown({ id: "nt-assignee", options: ASSIGNEES, selected: 0 })}</div>
      ${kit.radioGroup({ id: "nt-priority", options: ["Low", "Medium", "High"], selected: 1 })}
      ${kit.numberField({ id: "nt-points", label: "Story points", value: "3", min: 0, max: 21, step: 1 })}
    `,
    buttons: `
      ${kit.button({ label: "Cancel", kind: "ghost", action: "modal:cancel" })}
      ${kit.button({ label: "Create task", kind: "accent", action: "modal:create" })}`,
  });
}

export function confirmModalHtml(): string {
  return kit.modal({
    id: "confirm-modal",
    title: "Delete task",
    open: false,
    html: `<div id="confirm-text">${kit.label("Delete this task?")}</div>`,
    buttons: `
      ${kit.button({ label: "Keep it", kind: "ghost", action: "confirm:cancel" })}
      ${kit.button({ label: "Delete", kind: "danger", action: "confirm:ok" })}`,
  });
}

export function aboutModalHtml(menuBackend: string, theme: string): string {
  return kit.modal({
    id: "about-modal",
    title: "About Task Board",
    open: false,
    html: `
      ${kit.kvTable([
        ["App", "Task Board — kit showcase"],
        ["Menu backend", menuBackend],
        ["Theme", theme],
        ["UI stack", "Blitz html-ui + html-ui-kit"],
        ["Shortcuts", "Ctrl+N new task · Ctrl+K palette · F5 repaint"],
      ])}`,
    buttons: kit.button({ label: "Close", kind: "accent", action: "about:close" }),
  });
}

/** Card context menu — the components.ts contextMenu widget. */
export function cardCtxHtml(): string {
  return kit.contextMenu({
    id: "ctx-card",
    items: [
      { label: "Open details", value: "open" },
      { label: "Move → Backlog", value: "move:backlog" },
      { label: "Move → In Progress", value: "move:doing" },
      { label: "Move → Review", value: "move:review" },
      { label: "Move → Done", value: "move:done" },
      { sep: true, label: "" },
      { label: "Edit in modal", value: "edit" },
      { label: "Delete", value: "delete" },
    ],
  });
}

/** Column-header context menu — menus.ts popupMenu driven by AppMenuModel. */
export function columnCtxHtml(): string {
  return kit.popupMenu({
    id: "ctx-col",
    model: {
      items: [
        { id: "col.add", label: "Add task here" },
        { id: "col.sort.priority", label: "Sort by priority" },
        { id: "col.sort.points", label: "Sort by points" },
        { id: "col.sort.created", label: "Sort by newest" },
        { type: "separator" },
        { id: "col.wip", label: "Column details", enabled: false },
      ],
    },
  });
}

export function paletteHtml(): string {
  return kit.commandPalette({
    id: "palette",
    placeholder: "Type a command…",
    items: [
      { label: "New task", hint: "Ctrl+N", action: "palette:run", data: { cmd: "new" } },
      { label: "Go to Board", hint: "page", action: "palette:run", data: { cmd: "page:0" } },
      { label: "Go to Dashboard", hint: "page", action: "palette:run", data: { cmd: "page:1" } },
      { label: "Go to Widgets", hint: "page", action: "palette:run", data: { cmd: "page:2" } },
      { label: "Go to Settings", hint: "page", action: "palette:run", data: { cmd: "page:3" } },
      { label: "TV mode", hint: "10-foot UI", action: "palette:run", data: { cmd: "tv" } },
      { label: "Export board JSON", hint: "save dialog", action: "palette:run", data: { cmd: "export" } },
      { label: "Send notification", hint: "OS notify", action: "palette:run", data: { cmd: "notify" } },
      { label: "Toggle tray icon", hint: "SNI", action: "palette:run", data: { cmd: "tray" } },
      { label: "About", hint: "modal", action: "palette:run", data: { cmd: "about" } },
    ],
  });
}

export function toastsHtml(): string {
  return `<div id="toast-root">${kit.toastStack([])}</div>`;
}

// ── shell ──

export interface ShellOpts {
  menuBackend: string;
  menu?: AppMenuModel;
}

export function shellHtml(opts: ShellOpts): string {
  const inWindowBar = opts.menuBackend === "inwindow" && opts.menu;
  return `<html><head>${kit.kitStyleTag()}<style>${APP_CSS}</style></head><body>
  <div id="app">
    ${inWindowBar ? kit.menuBar({ model: opts.menu! }) : ""}
    <div class="tb-toolbar">
      <div>
        <div class="tb-title">Task Board</div>
        <div class="tb-sub">html-ui-kit showcase · menu: <b id="tb-backend">${kit.esc(opts.menuBackend)}</b></div>
      </div>
      ${kit.tabs({ id: "app-tabs", tabs: ["Board", "Dashboard", "Widgets", "Settings"], selected: 0 })}
      <div class="tb-spacer"></div>
      ${kit.textInput({ id: "search", placeholder: "Search tasks…", width: 180 })}
      ${kit.segmented({ id: "flt-seg", options: ["All", "Mine", "High"], selected: 0 })}
      ${kit.dropdown({ id: "flt-assignee", options: ["All", ...ASSIGNEES.slice(1)], selected: 0, width: 130 })}
      ${kit.tooltipWrap(kit.button({ label: "+ New Task", kind: "accent", action: "app:new-task" }), "Create a task (Ctrl+N)")}
    </div>
    <div id="content">
      ${boardPage()}
      ${dashPage()}
      <div class="page dd-page" id="page-widgets" data-hidden="true"></div>
      <div class="page dd-page" id="page-settings" data-hidden="true"></div>
    </div>
  </div>
  ${bladeHtml()}
  ${newTaskModalHtml()}
  ${confirmModalHtml()}
  ${aboutModalHtml(opts.menuBackend, "system")}
  ${cardCtxHtml()}
  ${columnCtxHtml()}
  ${paletteHtml()}
  ${toastsHtml()}
  </body></html>`;
}
