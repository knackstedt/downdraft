// ============================================================================
// app-module.ts — Task Board: a desktop-style kanban + kit showcase app.
//
// Pages: Board (kanban), Dashboard (stats), Widgets (gallery of every
// standard html-ui-kit widget, including a live WebGPU surface composited
// inside a Blitz scroll area), Settings, plus a 10-foot "TV mode" document.
// Exercises the whole desktop surface: AppMenuModel (native or in-window
// kit fallback), tray, dialogs, notifications, settings persistence, close
// veto, second-instance forwarding, and MCP tools.
// ============================================================================

import { AppRenderer } from "@downdraft/engine";
import { createAppMcp, downdraft, jsonResult, type AppContext, type AppModule } from "@downdraft/engine/app/main";
import type { AppMenuBackend, AppMenuModel } from "@downdraft/engine/app/shared/types";
import {
    bindKit, listView, matchAccelerator, menuAccelerators, toastStack,
    type KitBinding, type Toast
} from "@downdraft/engine/libraries/html-ui-kit";
import type { RendererModule } from "@downdraft/engine/module";
import { createHtmlUi, type DocMutation, type OsrDomEvent, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { AppWindow } from "@downdraft/platform-native";
import { readFile, writeFile } from "node:fs/promises";
import { settingsPageHtml, tvDocHtml, widgetsPageHtml } from "./gallery";
import { createGpuSlot } from "./gpu-slot";
import { bladeContent, columnInnerHtml, dashInnerHtml, markDroppedTask, shellHtml } from "./markup";
import { COLUMNS, store, type ColumnId, type Priority } from "./state";

// ── menu model ──

const MENU: AppMenuModel = {
  items: [
    {
      type: "submenu", label: "File", items: [
        { id: "file.new", label: "New Task", accelerator: "CmdOrCtrl+N" },
        { type: "separator" },
        { id: "file.export", label: "Export Board JSON…", accelerator: "CmdOrCtrl+E" },
        { id: "file.import", label: "Import Board JSON…" },
        { type: "separator" },
        { id: "file.close", label: "Close Window", accelerator: "CmdOrCtrl+W" },
      ],
    },
    {
      type: "submenu", label: "View", items: [
        { id: "view.board", label: "Board", accelerator: "CmdOrCtrl+1" },
        { id: "view.dashboard", label: "Dashboard", accelerator: "CmdOrCtrl+2" },
        { id: "view.widgets", label: "Widget Gallery", accelerator: "CmdOrCtrl+3" },
        { id: "view.settings", label: "Settings", accelerator: "CmdOrCtrl+4" },
        { type: "separator" },
        { type: "check", id: "view.compact", label: "Compact Cards", checked: false },
        { type: "check", id: "view.veto", label: "Simulate Unsaved Changes", checked: false },
        { type: "separator" },
        { id: "view.repaint", label: "Repaint", accelerator: "F5" },
      ],
    },
    {
      type: "submenu", label: "Tools", items: [
        { id: "tools.palette", label: "Command Palette", accelerator: "CmdOrCtrl+K" },
        { id: "tools.tv", label: "TV Mode (10-foot UI)" },
        { type: "separator" },
        { id: "tools.tray", label: "Toggle Tray Icon" },
        { id: "tools.notify", label: "Send Notification" },
        { id: "tools.messagebox", label: "Message Box Demo" },
      ],
    },
    {
      type: "submenu", label: "Help", items: [
        { id: "help.about", label: "About Task Board" },
        { id: "help.docs", label: "Kit documentation", enabled: false },
      ],
    },
  ],
};

const PAGE_IDS = ["page-board", "page-dash", "page-widgets", "page-settings"] as const;
const PRIORITIES: Priority[] = ["low", "med", "high"];

// ── module-scope UI state ──

let appWindow: AppWindow | undefined;
let menuBackend: AppMenuBackend = "unavailable";
let doc: UiPanelHandle | undefined;
let kb: KitBinding | undefined;
let tvPanel: UiPanelHandle | undefined;
let tvKb: KitBinding | undefined;

let activePage = 0;
let openTaskId: string | null = null;
let ctxTaskId: string | null = null;
let ctxColId: ColumnId | null = null;
let pendingDeleteId: string | null = null;
let trayCreated = false;
let widgetsMounted = false;
let settingsMounted = false;

// Live text for the new-task modal — input events can't be re-read from the
// doc reliably (the `value` attr lags typed text), so values accumulate here.
const ntValues = { title: "", desc: "" };
let modalPriority: Priority = "med";

const toasts: Toast[] = [];
let toastSeq = 0;

const gpu = createGpuSlot();

// Shared close-veto flag consulted by native-entry's onCloseRequest.
(globalThis as any).__tbVetoArmed = false;

// ── small doc helpers ──

/** Overlay elements that must cover the GPU surface — the slot blits above
 *  the whole panel, so any open overlay needs the blit suppressed. */
const openOverlays = new Set<string>();
function updateGpuOcclusion(): void {
  gpu.setOccluded(openOverlays.size > 0);
}

function setOpen(id: string, open: boolean): void {
  if (open) openOverlays.add(id); else openOverlays.delete(id);
  updateGpuOcclusion();
  doc?.setAttr(`#${id}`, "data-open", open ? "true" : "false");
}

function renderToasts(): void {
  doc?.setInnerHtml("#toast-root", toastStack(toasts));
}

function pushToast(kind: Toast["kind"], message: string, ms = 4200): void {
  const t: Toast = { id: `toast-${++toastSeq}`, kind, message };
  toasts.push(t);
  renderToasts();
  setTimeout(() => {
    const i = toasts.indexOf(t);
    if (i >= 0) { toasts.splice(i, 1); renderToasts(); }
  }, ms);
}

function setVeto(armed: boolean): void {
  store.prefs.vetoArmed = armed;
  (globalThis as any).__tbVetoArmed = armed;
  downdraft.setMenuItemChecked?.("view.veto", armed);
}

// ── board refresh ──

// innerHtml under a display:none ancestor leaves new children unlaid out, so
// page-local subtree refreshes are deferred until the page is visible.
let boardDirty = false;

function refreshBoard(): void {
  if (!doc) return;
  if (activePage !== 0) { boardDirty = true; return; }
  boardDirty = false;
  const d = doc;
  COLUMNS.forEach((col) => {
    d.setInnerHtml(`#col-body-${col.id}`, columnInnerHtml(col.id));
    const count = store.tasks.filter((t) => t.column === col.id).length;
    d.setInnerHtml(`#col-count-${col.id}`, `<div class="dd-badge">${count}</div>`);
  });
}

function refreshActivity(): void {
  // Sidebar feed lives on the board page — defer while hidden, same as
  // refreshBoard (the dashboard feed is rebuilt inside refreshDash).
  if (!doc) return;
  if (activePage !== 0) { boardDirty = true; return; }
  doc.setInnerHtml("#side-activity-wrap", listView({
    id: "side-activity", height: 150,
    items: store.activity.slice(0, 8).map((a) => a.text),
  }));
}

function refreshDash(): void {
  // Replace the page element's children, not #dash's — innerHtml on a node
  // nested inside a display:none subtree leaves the new children at 0x0 in
  // the doc worker; targeting the hidden element itself works (same pattern
  // as the lazy widgets/settings mounts).
  doc?.setInnerHtml("#page-dash", `<div id="dash">${dashInnerHtml()}</div>`);
}

function syncAll(): void {
  refreshBoard();
  refreshActivity();
  refreshDash();
}

// ── pages ──

function showPage(i: number): void {
  activePage = i;
  // Flip visibility FIRST — innerHtml on a descendant of a display:none
  // element yields 0x0 children / worker panics; these ops apply in order.
  PAGE_IDS.forEach((pid, k) => doc?.setAttr(`#${pid}`, "data-hidden", k === i ? "false" : "true"));
  // Context menus overlay every page — a stale one would float over the
  // newly-shown page (and keep the GPU slot occluded).
  doc?.setAttr(".dd-ctxwrap[data-open=\"true\"]", "data-open", "false");
  if (i === 0 && boardDirty) { refreshBoard(); refreshActivity(); }
  if (i === 2 && !widgetsMounted && doc) {
    widgetsMounted = true;
    doc.setInnerHtml("#page-widgets", widgetsPageHtml());
  }
  if (i === 3 && !settingsMounted && doc) {
    settingsMounted = true;
    doc.setInnerHtml("#page-settings", settingsPageHtml());
  }
  kb?.setSelect("app-tabs", i, 4);
  gpu.refresh();
}

// ── task operations ──

function openBlade(taskId: string): void {
  const t = store.get(taskId);
  if (!t || !doc) return;
  openTaskId = taskId;
  // Open before innerHtml — the blade is display:none while closed, and
  // innerHtml under display:none yields 0x0 children.
  setOpen("task-blade", true);
  doc.setInnerHtml("#blade-body", bladeContent(t));
}

function closeBlade(): void {
  openTaskId = null;
  setOpen("task-blade", false);
}

function openNewTask(column?: ColumnId): void {
  setOpen("new-task-modal", true);
  doc?.focus("#nt-title");
  if (column !== undefined) {
    const idx = COLUMNS.findIndex((c) => c.id === column);
    doc?.setInnerHtml("#nt-column [data-part='menu']", COLUMNS.map((c, i) =>
      `<div class="dd-mi" data-action="kit:choice" data-id="nt-column" data-i="${i}" data-value="${c.title}"${i === idx ? ` data-on="true"` : ""}>${c.title}</div>`).join(""));
    doc?.setAttr("#nt-column", "data-value", COLUMNS[idx].title);
    doc?.setText("#nt-column [data-part='label']", COLUMNS[idx].title);
  }
}

async function createTaskFromModal(): Promise<void> {
  if (!doc) return;
  const title = ntValues.title.trim();
  if (!title) {
    kb?.setInvalid("nt-title", true);
    doc.setText("#nt-title-err", "Title is required.");
    return;
  }
  const colTitle = (await doc.getAttr("#nt-column", "data-value")) ?? COLUMNS[0].title;
  const assignee = (await doc.getAttr("#nt-assignee", "data-value")) ?? "Unassigned";
  const points = Number((await doc.getAttr("#nt-points", "value")) ?? "0") || 0;
  const column = (COLUMNS.find((c) => c.title === colTitle)?.id ?? "backlog") as ColumnId;
  store.add({
    title, desc: ntValues.desc, column,
    priority: modalPriority,
    assignee: assignee || "Unassigned",
    points: Math.max(0, Math.min(99, points)),
    progress: column === "done" ? 100 : 0,
    tags: [],
    subtasks: [],
  });
  ntValues.title = ""; ntValues.desc = ""; modalPriority = "med";
  setOpen("new-task-modal", false);
  kb?.setInvalid("nt-title", false);
  kb?.setInputValue("nt-title", "");
  pushToast("good", `Created "${title}"`);
  void downdraft.notify?.({ title: "Task Board", body: `New task: ${title}` });
}

function moveTask(taskId: string, dir: number): void {
  const t = store.get(taskId);
  if (!t) return;
  const i = COLUMNS.findIndex((c) => c.id === t.column);
  const next = COLUMNS[i + dir];
  if (!next) return;
  store.move(taskId, next.id);
  if (store.prefs.notifyOnMove) {
    void downdraft.notify?.({ title: "Task Board", body: `"${t.title}" → ${next.title}` });
  }
  if (openTaskId === taskId) openBlade(taskId);
}

function confirmDelete(taskId: string): void {
  pendingDeleteId = taskId;
  const t = store.get(taskId);
  doc?.setText("#confirm-text", `Delete "${t?.title ?? taskId}"? This cannot be undone.`);
  setOpen("confirm-modal", true);
}

// ── context menus / palette ──

function handleCardCtx(value: string): void {
  if (!ctxTaskId) return;
  const t = store.get(ctxTaskId);
  if (value === "open") openBlade(ctxTaskId);
  else if (value === "edit") openBlade(ctxTaskId);
  else if (value === "delete") confirmDelete(ctxTaskId);
  else if (value.startsWith("move:")) {
    const col = value.slice(5) as ColumnId;
    if (t) { store.move(ctxTaskId, col); if (openTaskId === ctxTaskId) openBlade(ctxTaskId); }
  }
  ctxTaskId = null;
}

function togglePalette(open?: boolean): void {
  if (!doc) return;
  const d = doc;
  void d.getAttr("#palette", "data-open").then((v) => {
    const next = open ?? v !== "true";
    setOpen("palette", next);
    if (next) d.focus("#palette input");
  });
}

function toggleTv(): void {
  if (tvPanel) {
    tvKb?.dispose();
    tvKb = undefined;
    tvPanel.dispose();
    tvPanel = undefined;
    return;
  }
  tvPanel = tvMount?.();
}

// tvMount is assigned inside the html-ui build (needs the ui context).
let tvMount: (() => UiPanelHandle) | undefined;

// ── dialogs / host features ──

async function exportBoard(): Promise<void> {
  const path = await downdraft.showSaveDialog?.({ title: "Export Board", defaultName: "taskboard.json" });
  if (!path) { pushToast("info", "Export cancelled"); return; }
  try {
    await writeFile(path, JSON.stringify({ tasks: store.tasks, exportedAt: Date.now() }, null, 2));
    store.log(`Exported board to ${path}`);
    syncAll();
    pushToast("good", "Board exported");
  } catch (e) {
    pushToast("bad", `Export failed: ${(e as Error).message}`);
  }
}

async function importBoard(): Promise<void> {
  const paths = await downdraft.showOpenDialog?.({ title: "Import Board" });
  const path = paths?.[0];
  if (!path) { pushToast("info", "Import cancelled"); return; }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { tasks?: unknown[] };
    if (!Array.isArray(parsed.tasks)) throw new Error("no tasks array");
    store.importTasks(parsed.tasks as never);
    pushToast("good", `Imported ${parsed.tasks.length} tasks`);
  } catch (e) {
    pushToast("bad", `Import failed: ${(e as Error).message}`);
  }
}

function toggleTray(): void {
  const api = downdraft.tray;
  if (!api) { pushToast("warn", "No tray backend on this host"); return; }
  if (trayCreated) {
    trayCreated = !api.destroy();
    pushToast("info", "Tray icon removed");
    return;
  }
  trayCreated = api.create({
    tooltip: "Task Board",
    menu: {
      items: [
        { id: "show", label: "Show window" },
        { id: "new", label: "New task" },
        { type: "separator" },
        { id: "quit", label: "Quit" },
      ],
    },
  });
  pushToast(trayCreated ? "good" : "warn", trayCreated ? "Tray icon created" : "Tray create failed (no SNI watcher)");
}

// ── menu action router (native bar, in-window bar, palette, accelerators) ──

function handleMenu(id: string): void {
  switch (id) {
    case "file.new": openNewTask(); break;
    case "file.export": void exportBoard(); break;
    case "file.import": void importBoard(); break;
    case "file.close": appWindow?.native.requestClose(); break;
    case "view.board": showPage(0); break;
    case "view.dashboard": showPage(1); break;
    case "view.widgets": showPage(2); break;
    case "view.settings": showPage(3); break;
    case "view.compact": {
      store.prefs.compact = !store.prefs.compact;
      downdraft.setMenuItemChecked?.("view.compact", store.prefs.compact);
      doc?.setAttr("body", "data-compact", store.prefs.compact ? "true" : "false");
      break;
    }
    case "view.veto": setVeto(!store.prefs.vetoArmed); break;
    case "view.repaint": syncAll(); break;
    case "tools.palette": togglePalette(); break;
    case "tools.tv": toggleTv(); break;
    case "tools.tray": toggleTray(); break;
    case "tools.notify":
      void downdraft.notify?.({ title: "Task Board", body: "Hello from the Tools menu" })
        .then((ok) => pushToast(ok ? "good" : "warn", ok ? "Notification sent" : "Notifications unavailable"));
      break;
    case "tools.messagebox":
      void downdraft.showMessageBox?.({
        title: "Task Board",
        message: "This is the host's modal message box — yesnocancel returns the picked index.",
        level: "info",
        buttons: "yesnocancel",
      }).then((i) => pushToast("info", `Message box → button ${i}`));
      break;
    case "help.about": setOpen("about-modal", true); break;
    // column popupMenu items (ctx-col)
    case "col.add": openNewTask(ctxColId ?? undefined); ctxColId = null; break;
    case "col.sort.priority": store.prefs.sort = "priority"; refreshBoard(); break;
    case "col.sort.points": store.prefs.sort = "points"; refreshBoard(); break;
    case "col.sort.created": store.prefs.sort = "created"; refreshBoard(); break;
    // palette commands
    default: break;
  }
}

function runPaletteCmd(cmd: string): void {
  setOpen("palette", false);
  if (cmd === "new") openNewTask();
  else if (cmd.startsWith("page:")) showPage(Number(cmd.slice(5)) || 0);
  else if (cmd === "tv") toggleTv();
  else if (cmd === "export") void exportBoard();
  else if (cmd === "notify") handleMenu("tools.notify");
  else if (cmd === "tray") toggleTray();
  else if (cmd === "about") setOpen("about-modal", true);
}

// ── verb table: kit-button verbs (bindKit onAction) + raw data-action verbs
//    (ui.onAction) route through the same handlers. ──

const actions: Record<string, (d: Record<string, string>, ev: OsrDomEvent) => void> = {
  "app:new-task": () => openNewTask(),
  "card:open": (d) => { if (d.task) openBlade(d.task); },
  "card:move": (d) => { if (d.task) moveTask(d.task, Number(d.dir) || 1); },
  "col:add": (d) => openNewTask((d.col as ColumnId) || undefined),
  "blade:move": (d) => { if (d.task) { moveTask(d.task, Number(d.dir) || 1); } },
  "blade:delete": (d) => { if (d.task) confirmDelete(d.task); },
  "blade:edit": () => { setOpen("task-blade", false); openNewTask(); },
  "blade:close": () => closeBlade(),
  "modal:create": () => void createTaskFromModal(),
  "modal:cancel": () => setOpen("new-task-modal", false),
  "confirm:ok": () => { if (pendingDeleteId) { store.remove(pendingDeleteId); closeBlade(); } pendingDeleteId = null; setOpen("confirm-modal", false); },
  "confirm:cancel": () => { pendingDeleteId = null; setOpen("confirm-modal", false); },
  "about:close": () => setOpen("about-modal", false),
  "palette:run": (d) => { if (d.cmd) runPaletteCmd(d.cmd); },
  "gpu:toggle": () => gpu.toggleSpin(),
  "wg:modal": () => setOpen("about-modal", true),
  "wg:ctx": () => {
    // Demo: point the card context menu at the first real task.
    ctxTaskId = store.tasks[0]?.id ?? null;
    kb?.showContextMenu("ctx-card", 140, 220);
  },
  "wg:blade": () => { if (store.tasks[0]) openBlade(store.tasks[0].id); else setOpen("task-blade", true); },
  "wg:palette": () => togglePalette(true),
  "wg:tb-one": () => pushToast("info", "Toolbar button one"),
  "wg:tb-two": () => pushToast("info", "Toolbar button two"),
  "toast:good": () => pushToast("good", "Something succeeded"),
  "toast:warn": () => pushToast("warn", "Something deserves attention"),
  "toast:bad": () => pushToast("bad", "Something failed"),
  "toast:info": () => pushToast("info", "Something happened"),
  "set:export": () => void exportBoard(),
  "set:import": () => void importBoard(),
  "set:notify": () => handleMenu("tools.notify"),
  "set:tray": () => toggleTray(),
  "set:reset": () => { store.importTasks([]); store.log("Board reset"); pushToast("warn", "Board cleared"); },
  "tv:close": () => toggleTv(),
  "tv:goto": (d) => { toggleTv(); showPage(Number(d.page) || 0); },
  "tv:new": () => { toggleTv(); openNewTask(); },
  "tv:palette": () => { toggleTv(); togglePalette(true); },
  "tv:blade": () => setTvBlade(true),
  "tv:blade-close": () => setTvBlade(false),
};

function setTvBlade(open: boolean): void {
  tvPanel?.setAttr("#tv-blade", "data-open", open ? "true" : "false");
}

// ── onChange routing ──

function onWidgetChange(id: string, kind: string, value: unknown): void {
  if (kind === "scroll") { gpu.refresh(); return; }
  switch (id) {
    case "app-tabs": if (kind === "select") showPage(Number(value) || 0); return;
    case "search": if (kind === "input") { store.search = String(value ?? ""); refreshBoard(); } return;
    case "flt-seg": if (kind === "select") {
      // "Mine" treats Ada as the current user persona.
      store.prefs.filterAssignee = Number(value) === 1 ? "Ada" : "All";
      store.highOnly = Number(value) === 2;
      refreshBoard();
    } return;
    case "flt-assignee": if (kind === "choice") {
      store.prefs.filterAssignee = String(value ?? "All");
      kb?.setSelect("flt-seg", store.prefs.filterAssignee === "All" ? 0 : 1, 3);
      refreshBoard();
    } return;
    case "flt-high": if (kind === "toggle") { store.highOnly = value === true; refreshBoard(); } return;
    case "flt-mine": if (kind === "toggle") { store.subtasksOnly = value === true; refreshBoard(); } return;
    case "nt-priority": if (kind === "radio") modalPriority = PRIORITIES[Number(value) || 0]; return;
    case "nt-title": if (kind === "input") {
      ntValues.title = String(value ?? "");
      kb?.setInvalid("nt-title", false);
      doc?.setText("#nt-title-err", "");
    } return;
    case "nt-desc": if (kind === "input") { ntValues.desc = String(value ?? ""); } return;
    case "blade-priority": if (kind === "radio" && openTaskId) {
      store.update(openTaskId, { priority: PRIORITIES[Number(value) || 0] });
      openBlade(openTaskId);
    } return;
    case "blade-progress": if (kind === "slider" && openTaskId) {
      store.update(openTaskId, { progress: Number(value) || 0 });
      openBlade(openTaskId);
    } return;
    case "blade-assignee": if (kind === "choice" && openTaskId) {
      store.update(openTaskId, { assignee: String(value ?? "Unassigned") });
      openBlade(openTaskId);
    } return;
    case "sl-zoom": if (kind === "slider") {
      const z = (Number(value) || 100) / 100;
      downdraft.settings?.set("tb.uiZoom", z);
      uiRef?.setUiZoom(z);
      gpu.refresh();
    } return;
    case "set-sort": if (kind === "choice") {
      store.prefs.sort = value === "Priority" ? "priority" : value === "Points" ? "points" : "created";
      refreshBoard();
    } return;
    case "sw-compact": case "tv-sw-1": if (kind === "toggle") {
      store.prefs.compact = value === true;
      downdraft.setMenuItemChecked?.("view.compact", store.prefs.compact);
      doc?.setAttr("body", "data-compact", store.prefs.compact ? "true" : "false");
    } return;
    case "sw-notify": case "tv-sw-2": if (kind === "toggle") { store.prefs.notifyOnMove = value === true; } return;
    case "sw-veto": if (kind === "toggle") setVeto(value === true); return;
    default: break;
  }
  if (id.startsWith("sub-") && kind === "toggle") {
    const parts = id.split("-");
    const t = store.get(parts.slice(1, -1).join("-"));
    const idx = Number(parts[parts.length - 1]);
    if (t?.subtasks[idx]) {
      t.subtasks[idx].done = value === true;
      store.update(t.id, { subtasks: t.subtasks });
      openBlade(t.id);
    }
  }
}

// ── kanban drag & drop ──
// Press-drag a card past an 8px threshold and a compositor sprite — a crop
// of the card's own raster — follows the pointer at render rate. No DOM
// writes per move (that was the lag: every pointermove used to trigger a
// full worker re-style+repaint+diff). The column under the pointer
// highlights via data-drop — ev.d.col comes free from the event stream's
// merged data-*. Release calls store.move; the rebuilt card animates in
// via data-fresh.

function bindDnd(handle: UiPanelHandle): () => void {
  let cand: { task: string; col: string; x0: number; y0: number } | null = null;
  let dragging = false;
  let dropCol: string | null = null;
  /** Insertion slot within dropCol (excluding the dragged card), or -1. */
  let dropIdx = -1;
  /** Node + attr carrying the drop-line marker right now (0 = none). */
  let markedNode = 0;
  let markedAttr = "";
  /** Hovered column's card geometry — node + task id + vertical midpoint,
   *  fetched once per column entry (DOM order = columnTasks order). */
  let colCards: { node: number; task: string; mid: number }[] | null = null;
  let colCardsFor: string | null = null;
  /** Card border-box in doc CSS px — the sprite's src crop. Queried
   *  speculatively on mousedown so it's resolved by the threshold trip. */
  let cardRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Last pointermove position — the card-rect cache resolves a tick after
   *  the column is entered, so the marker is applied on its arrival, not
   *  only on the next pointermove. */
  let lastPtr = { x: 0, y: 0 };

  const setDropCol = (col: string | null): void => {
    if (col === dropCol) return;
    if (dropCol) handle.mutate([{ op: "rattr", sel: `#col-scroll-${dropCol}`, name: "data-drop" }]);
    dropCol = col;
    if (col) handle.setAttr(`#col-scroll-${col}`, "data-drop", "1");
  };

  const clearMark = (): void => {
    if (!markedNode) return;
    handle.mutate([{ op: "rattr", node: markedNode, name: markedAttr }]);
    markedNode = 0; markedAttr = "";
  };

  /** Move the accent drop-line to insertion slot idx. Mutations only fire
   *  when the slot actually changes — pointer-rate moves stay free. */
  const markAt = (idx: number): void => {
    const cards = (colCards ?? []).filter((c) => c.task !== cand?.task);
    let node = 0, attr = "data-drop-before";
    if (cards.length && idx < cards.length) node = cards[idx]!.node;
    else if (cards.length) { node = cards[cards.length - 1]!.node; attr = "data-drop-after"; }
    if (node === markedNode && attr === markedAttr) return;
    const ops: DocMutation[] = [];
    if (markedNode) ops.push({ op: "rattr", node: markedNode, name: markedAttr });
    markedNode = node; markedAttr = attr;
    if (node) ops.push({ op: "attr", node, name: attr, value: "1" });
    if (ops.length) handle.mutate(ops);
  };

  /** Fetch the hovered column's cards once per entry; pairing with
   *  columnTasks (same DOM order) gives task ids without N attr queries. */
  const cacheCol = (col: string | null): void => {
    if (col === colCardsFor) return;
    colCardsFor = col;
    colCards = null;
    if (!col) return;
    const tasks = store.columnTasks(col as ColumnId).map((t) => t.id);
    void handle.queryAll(`#col-scroll-${col} .kb-card`)
      .then((nodes) => nodes.length ? handle.getRects(nodes).then((rects) => ({ nodes, rects })) : { nodes, rects: [] as ({ x: number; y: number; w: number; h: number } | null)[] })
      .then(({ nodes, rects }) => {
        if (colCardsFor !== col) return;
        colCards = nodes.map((node, i) => ({
          node, task: tasks[i] ?? "",
          mid: (rects[i]?.y ?? 0) + (rects[i]?.h ?? 0) / 2,
        }));
        // The rects landed after the moves that entered the column —
        // re-evaluate the marker at the last seen pointer position.
        if (dragging && cand) {
          dropIdx = colCards.filter((c) => c.task !== cand!.task && lastPtr.y > c.mid).length;
          markAt(dropIdx);
        }
      })
      .catch(() => {});
  };

  const cleanup = (): void => {
    if (cand) handle.mutate([{ op: "rattr", sel: `.kb-card[data-task="${cand.task}"]`, name: "data-drag-src" }]);
    clearMark();
    setDropCol(null);
    handle.setSprite(null);
    cand = null;
    dragging = false;
    cardRect = null;
    dropIdx = -1;
    colCardsFor = null;
    colCards = null;
  };

  return handle.onEvent((ev) => {
    const d = ev.d ?? {};
    if (ev.t === "mousedown" && d.task && (ev.b ?? 0) === 0) {
      cand = { task: d.task, col: d.col ?? "", x0: ev.x ?? 0, y0: ev.y ?? 0 };
      cardRect = null;
      const task = d.task;
      void handle.getRect(`.kb-card[data-task="${task}"]`)
        .then((r) => { if (cand?.task === task) cardRect = r; })
        .catch(() => {});
      return;
    }
    // dblclick arrives after the second mouseup already cleaned `cand` —
    // handle it before the guard or it never reaches this branch.
    if (ev.t === "dblclick" && d.task) {
      openBlade(d.task);
      cleanup();
      return;
    }
    if (!cand) return;
    if (ev.t === "pointermove") {
      const x = ev.x ?? 0, y = ev.y ?? 0;
      if (!dragging && Math.abs(x - cand.x0) + Math.abs(y - cand.y0) > 8) {
        const t = store.get(cand.task);
        if (!t) { cand = null; return; }
        dragging = true;
        handle.setAttr(`.kb-card[data-task="${cand.task}"]`, "data-drag-src", "1");
        pushToast("info", `Dragging "${t.title}" — drop on a column`);
      }
      if (dragging) {
        lastPtr = { x, y };
        if (cardRect) handle.setSprite({ src: cardRect, at: { x: x + 10, y: y + 14 }, modulate: [1, 1, 1, 0.88] });
        const col = d.col ?? null;
        setDropCol(col);
        cacheCol(col);
        if (col) {
          dropIdx = (colCards ?? []).filter((c) => c.task !== cand!.task && y > c.mid).length;
          markAt(dropIdx);
        } else {
          dropIdx = -1;
          clearMark();
        }
      }
      return;
    }
    if (ev.t === "mouseup") {
      const { task, col } = cand;
      if (dragging) {
        const target = d.col ?? dropCol;
        const t = store.get(task);
        if (target && t) {
          // Same-position same-column drop is a no-op; otherwise move with
          // the tracked insertion slot (or append when it never resolved).
          const curIdx = target === col
            ? store.columnTasks(col as ColumnId).filter((x) => x.id !== task).findIndex((x) => (x.ord ?? -x.created) > (t.ord ?? -t.created))
            : -1;
          const idx = dropIdx >= 0 ? dropIdx : undefined;
          if (target !== col || (idx !== undefined && idx !== curIdx)) {
            markDroppedTask(task);
            store.move(task, target as ColumnId, idx);
            if (target !== col && store.prefs.notifyOnMove) {
              const colTitle = COLUMNS.find((c) => c.id === target)?.title ?? target;
              void downdraft.notify?.({ title: "Task Board", body: `"${t.title}" → ${colTitle}` });
            }
            if (openTaskId === task) openBlade(task);
          }
        }
      }
      cleanup();
    }
  });
}

// ── kit delegate + raw-action registration for one doc ──

function bindDoc(handle: UiPanelHandle, onActionExtra?: (verb: string, d: Record<string, string>, ev: OsrDomEvent) => boolean): KitBinding {
  return bindKit(handle, {
    onChange: (id, kind, v) => onWidgetChange(id, kind, v),
    onAction: (verb, d, ev) => {
      if (onActionExtra?.(verb, d, ev)) return;
      // Right-click: cards → kit contextMenu, column headers → popupMenu.
      // ev.x/y are doc-space coords.
      if (verb === "contextmenu") {
        if (d.task) {
          ctxTaskId = d.task;
          kb?.showContextMenu("ctx-card", ev.x ?? 0, ev.y ?? 0);
        } else if (d.action === "col:menu") {
          ctxColId = (d.col as ColumnId) ?? null;
          kb?.showContextMenu("ctx-col", ev.x ?? 0, ev.y ?? 0);
        }
        return;
      }
      if (verb === "menuitem") { handleMenu(d.mid ?? ""); return; }
      if (verb === "ctx") { handleCardCtx(d.value ?? ""); return; }
      if (verb === "dismiss") {
        const i = toasts.findIndex((t) => t.id === d.id);
        if (i >= 0) { toasts.splice(i, 1); renderToasts(); }
        return;
      }
      actions[verb]?.(d, ev);
    },
    onEvent: () => { /* non-kit events — focus/hover keys; nothing needed */ },
  });
}

let uiRef: { setUiZoom(z: number): void; uiZoom: number } | null = null;

// ── app module ──

export const appModule: AppModule = {
  renderer: (canvas) => {
    const r = new AppRenderer(canvas, {
      mode: "2d",
      damageOnly: true,
      clearColor: { r: 0.07, g: 0.08, b: 0.10, a: 1 },
    });
    r.setViewportCount(0);
    return r;
  },

  onReady(ctx: AppContext) {
    appWindow = AppWindow.primary();

    // GPU-slot module — renders the embedded WebGPU surface + tracks the
    // Blitz placeholder rect. Registered from onReady: the module host only
    // exists once the app pipeline has initialized it.
    ctx.renderer.useRendererModule?.(gpu.module);

    // Global hotkeys — menu accelerators + Escape to close overlays. Runs
    // after the ui host's key routing (-10) so typing in inputs never
    // triggers shortcuts (editing keys are stopPropagation'd before +10).
    ctx.renderer.useRendererModule?.({
      name: "hotkeys",
      version: "1.0.0",
      register(mctx) {
        const accs = menuAccelerators(MENU);
        mctx.getInputBus().onKeyDown((e) => {
          if (e.key === "Escape") {
            setOpen("palette", false);
            setOpen("ctx-card", false);
            setOpen("ctx-col", false);
            setOpen("new-task-modal", false);
            setOpen("confirm-modal", false);
            setOpen("about-modal", false);
            if (openTaskId) closeBlade();
            return;
          }
          const hit = accs.find((a) => matchAccelerator(a.acc, e));
          if (hit) handleMenu(hit.id);
        }, 10);
      },
    } satisfies RendererModule);
    store.load();
    doc = undefined;
    menuBackend = downdraft.setMenu?.(MENU) ?? "unavailable";
    downdraft.onMenuAction?.((id) => handleMenu(id));
    downdraft.onSecondInstance?.(() => pushToast("info", "Second instance forwarded its launch"));
    downdraft.tray?.onAction((id) => {
      if (id === "show") appWindow?.setVisible(true);
      else if (id === "new") openNewTask();
      else if (id === "quit") appWindow?.native.requestClose();
    });
    downdraft.onThemeChanged?.(() => { /* theme text lives in About modal */ });

    ctx.renderer.useRendererModule?.(
      createHtmlUi({
        zoomKeys: true,
        build(ui) {
          uiRef = ui;
          const savedZoom = downdraft.settings?.get<number>("tb.uiZoom", 1) ?? 1;
          if (savedZoom !== 1) ui.setUiZoom(savedZoom);

          doc = ui.mount(shellHtml({ menuBackend, menu: MENU }), {
            id: "taskboard",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            fit: true,
            smoothWheel: true, // eased wheel deltas (doc-backend drains over ~135ms)
          });
          kb = bindDoc(doc);
          bindDnd(doc);
          for (const [verb, fn] of Object.entries(actions)) ui.onAction(verb, fn);

          gpu.attach(doc, {
            slot: "#gpu-slot",
            clip: "#gpu-scroll",
            // The slot blits above the whole panel — suppress it while any
            // overlay is open (the doc paints them into the same raster).
            occluders: ".dd-modal[data-open=\"true\"], .dd-blade[data-open=\"true\"], .dd-ctxwrap[data-open=\"true\"], .dd-cmdk[data-open=\"true\"]",
            zoom: () => {
              const s = ctx.surface;
              const scale = s.clientWidth > 0 ? s.width / s.clientWidth : 1;
              return scale * ui.uiZoom;
            },
          });

          tvMount = () => {
            const panel = ui.mount(tvDocHtml(), {
              id: "tv",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              fit: true,
              z: 50,
            });
            // fit panels converge to the surface on resize events and once
            // after build() — a late mount keeps its 1x1 spec rect until the
            // next one. Re-run the surface convergence so it covers now.
            const s = ctx.surface;
            const zf = s.clientWidth > 0 ? s.width / s.clientWidth : 1;
            ui.host.setSurfaceSize(s.width, s.height, zf);
            tvKb = bindDoc(panel, (verb, d) => {
              if (verb === "ctx" || verb === "menuitem") return true; // no menus in tv doc
              if (verb === "press" && d.id === "tv-blade") return true;
              return false;
            });
            tvPanel = panel;
            return panel;
          };

          store.subscribe(() => { syncAll(); });
          syncAll();
          if (store.prefs.compact) doc.setAttr("body", "data-compact", "true");
        },
      }),
    );
  },

  mcp: (ctx) =>
    createAppMcp({
      appId: "downdraft-taskboard",
      surface: () => ctx.surface,
      getUiState: () => ({
        activePage,
        openTaskId,
        tasks: store.tasks.length,
        prefs: store.prefs,
        menuBackend,
        widgetsMounted,
        gpuSpinning: gpu.spinning,
        trayCreated,
        windowClosed: appWindow?.closed ?? true,
      }),
      tools: [
        {
          def: {
            name: "taskboard_state",
            description: "Snapshot of the task board: page, counts per column, prefs.",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () => jsonResult({
            activePage,
            stats: store.stats(),
            prefs: store.prefs,
            menuBackend,
            gpuSpinning: gpu.spinning,
          }),
        },
        {
          def: {
            name: "taskboard_add",
            description: "Create a task on the board.",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
                column: { type: "string", enum: ["backlog", "doing", "review", "done"] },
                priority: { type: "string", enum: ["low", "med", "high"] },
              },
              required: ["title"],
            },
          },
          handler: (p) => {
            const t = store.add({
              title: String(p.title ?? "Untitled"),
              desc: "", column: (p.column as ColumnId) ?? "backlog",
              priority: (p.priority as Priority) ?? "med",
              assignee: "Unassigned", points: 1, progress: 0, tags: [], subtasks: [],
            });
            return jsonResult({ id: t.id });
          },
        },
        {
          def: {
            name: "taskboard_move",
            description: "Move a task to a column.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string" },
                column: { type: "string", enum: ["backlog", "doing", "review", "done"] },
              },
              required: ["id", "column"],
            },
          },
          handler: (p) => {
            store.move(String(p.id), p.column as ColumnId);
            return jsonResult({ moved: true });
          },
        },
        {
          def: {
            name: "taskboard_page",
            description: "Switch the active page (0=Board 1=Dashboard 2=Widgets 3=Settings).",
            inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
          },
          handler: (p) => { showPage(Math.max(0, Math.min(3, Number(p.index) || 0))); return jsonResult({ activePage }); },
        },
        {
          def: {
            name: "taskboard_scroll",
            description: "Scroll a scroll-container element (by selector) to x/y offsets in doc px.",
            inputSchema: {
              type: "object",
              properties: {
                selector: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["selector", "y"],
            },
          },
          handler: (p) => {
            doc?.scrollTo(String(p.selector), Number(p.x) || 0, Number(p.y) || 0);
            gpu.refresh();
            return jsonResult({ scrolled: true });
          },
        },
        {
          def: {
            name: "taskboard_query",
            description:
              "Doc introspection: nodes matching a selector, plus optional rect/attr reads.",
            inputSchema: {
              type: "object",
              properties: {
                selector: { type: "string" },
                attr: { type: "string" },
                rect: { type: "boolean" },
              },
              required: ["selector"],
            },
          },
          handler: async (p) => {
            if (!doc) return jsonResult({ error: "no doc" });
            const nodes = await doc.queryAll(String(p.selector));
            const out: Record<string, unknown> = { count: nodes.length, nodes };
            if (p.attr !== undefined) out.attr = await doc.getAttr(String(p.selector), String(p.attr));
            if (p.rect) out.rect = await doc.getRect(String(p.selector));
            return jsonResult(out);
          },
        },
        {
          def: {
            name: "taskboard_command",
            description:
              "Invoke a UI command verb as bound in the app (e.g. 'app:new-task', 'tv:close', " +
              "'toast:good') or a menu action id prefixed 'menu:' (e.g. 'menu:tools.tv').",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          handler: (p) => {
            const id = String(p.id ?? "");
            if (id.startsWith("menu:")) handleMenu(id.slice(5));
            else actions[id]?.({}, { t: "click" } as OsrDomEvent);
            return jsonResult({ id, handled: id.startsWith("menu:") || id in actions });
          },
        },
      ],
    }),
};
