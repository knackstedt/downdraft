// ============================================================================
// drawer.ts — dock layout manager. Pure logic: computes panel rects from
// window size + dock state, moves/floats tabs, persists layout.
//
// Layout regions (buffer px):
//   ┌────────┬──────────────────────────┬────────┐
//   │sidebar │ tab strip (topbar)       │        │
//   │        ├──────────────────────────┤ right  │
//   │        │ main content             │ dock   │
//   │        ├──────────────────────────┤        │
//   │        │ bottom dock              │        │
//   └────────┴──────────────────────────┴────────┘
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { store, type DockId, type DockState, type Rect } from "../app/store";

/** Panel title lookup — panel registry fills this; shell falls back to id. */
export const panelTitles = new Map<string, string>();

export function panelTitle(id: string): string {
  return panelTitles.get(id) ?? id.replace(/^snapshot:/, "").replace(/^feed:/, "");
}

// ── Layout computation ──

export function computeLayout(): void {
  const s = store.getState();
  const W = s.windowW, H = s.windowH;
  const sw = s.sidebarWidth;
  const th = s.topbarHeight;
  const contentW = W - sw;

  const right: DockState = s.docks.right;
  const bottom: DockState = s.docks.bottom;

  const rightW = right.collapsed || right.active === null ? 0 : Math.min(right.size, contentW - 200);
  const bottomH = bottom.collapsed || bottom.active === null ? 0 : Math.min(bottom.size, H - th - 120);

  const mainRect: Rect = { x: sw, y: th, w: contentW - rightW, h: H - th - bottomH };
  const bottomRect: Rect = bottomH > 0
    ? { x: sw, y: H - bottomH, w: contentW - rightW, h: bottomH }
    : { x: sw, y: H, w: 0, h: 0 };
  const rightRect: Rect = rightW > 0
    ? { x: W - rightW, y: th, w: rightW, h: H - th - bottomH }
    : { x: W, y: th, w: 0, h: 0 };

  store.setState({ mainRect, bottomRect, rightRect });
}

// ── Dock operations ──

function setDock(id: DockId, patch: Partial<DockState>): void {
  store.setState((s) => ({ docks: { ...s.docks, [id]: { ...s.docks[id], ...patch } } }));
  computeLayout();
  saveLayout();
}

export function dockSelect(id: DockId, tab: string): void {
  setDock(id, { active: tab, collapsed: false });
}

export function dockToggle(id: DockId): void {
  const d = store.getState().docks[id];
  const patch: Partial<DockState> = { collapsed: !d.collapsed };
  // Uncollapsing with tabs but no selection should show something.
  if (patch.collapsed === false && !d.active && d.tabs.length) patch.active = d.tabs[0];
  setDock(id, patch);
}

/** Esc behavior: toggles the bottom dock (Chrome's drawer convention). */
export function toggleDrawer(): void {
  dockToggle("bottom");
}

export function dockResize(id: DockId, deltaPx: number): void {
  const d = store.getState().docks[id];
  setDock(id, { size: Math.max(80, Math.min(2000, d.size + deltaPx)) });
}

interface PointerEvtLike { clientX: number; clientY: number }
interface InputBusLike {
  onPointerDown(h: (e: PointerEvtLike, c: { stopPropagation(): void }) => void, p?: number): () => void;
  onPointerMove(h: (e: PointerEvtLike, c: { stopPropagation(): void }) => void, p?: number): () => void;
  onPointerUp(h: (e: PointerEvtLike, c: { stopPropagation(): void }) => void, p?: number): () => void;
}

/** Drag-to-resize on dock dividers — a 5px grab zone along the bottom dock's
 *  top edge and the right dock's left edge. Runs at priority -20, ahead of
 *  html-ui's panel routing (-10) and alongside the surface handlers whose
 *  rects butt against the divider. `isVisible` gates handling so a hidden
 *  embedded overlay never eats the game's input. */
export function installDockDrag(bus: InputBusLike, isVisible: () => boolean = () => true): () => void {
  let dragging: { id: DockId; last: number } | null = null;
  const GRAB = 5;
  const offDown = bus.onPointerDown((e, ctrl) => {
    if (!isVisible()) return;
    const s = store.getState();
    const b = s.docks.bottom;
    if (!b.collapsed && b.active &&
        e.clientY >= s.bottomRect.y - GRAB && e.clientY <= s.bottomRect.y + 1 &&
        e.clientX >= s.sidebarWidth) {
      dragging = { id: "bottom", last: e.clientY };
      ctrl.stopPropagation();
      return;
    }
    const rt = s.docks.right;
    if (!rt.collapsed && rt.active &&
        e.clientX >= s.rightRect.x - GRAB && e.clientX <= s.rightRect.x + 1 &&
        e.clientY > s.topbarHeight) {
      dragging = { id: "right", last: e.clientX };
      ctrl.stopPropagation();
    }
  }, 20);
  const offMove = bus.onPointerMove((e, ctrl) => {
    if (!dragging || !isVisible()) return;
    ctrl.stopPropagation();
    const pos = dragging.id === "bottom" ? e.clientY : e.clientX;
    dockResize(dragging.id, dragging.last - pos);
    dragging.last = pos;
  }, 20);
  const offUp = bus.onPointerUp(() => { dragging = null; }, 20);
  return () => { offDown(); offMove(); offUp(); };
}

export function dockAdd(id: DockId, tab: string, select = true): void {
  const d = store.getState().docks[id];
  const tabs = d.tabs.includes(tab) ? d.tabs : [...d.tabs, tab];
  setDock(id, { tabs, active: select ? tab : d.active, collapsed: false });
}

export function dockRemove(id: DockId, tab: string): void {
  const d = store.getState().docks[id];
  const tabs = d.tabs.filter((t) => t !== tab);
  const active = d.active === tab ? (tabs[tabs.length - 1] ?? null) : d.active;
  setDock(id, { tabs, active });
}

/** Move a tab between docks (drag or context action). */
export function dockMove(tab: string, from: DockId, to: DockId): void {
  const s = store.getState();
  if (!s.docks[from].tabs.includes(tab)) return;
  dockRemove(from, tab);
  dockAdd(to, tab, true);
}

export function setMainTab(tab: string): void {
  store.setState({ mainTab: tab });
}

/** Open a file in the Source dock — console links, profiler frames, Sources list. */
export function revealSource(url: string, line = 0, col = 0): void {
  dockAdd("right", "source");
  store.setState({ sourceRequest: { url, line, col } });
}

// ── Persistence ──

/** Layout prefs persist under the standalone viewer's data dir. Embedded
 *  mounts opt out (persistLayout:false) — a host game shouldn't inherit or
 *  clobber the standalone viewer's saved layout. */
let persistenceEnabled = true;
export function setLayoutPersistence(on: boolean): void { persistenceEnabled = on; }

function prefsPath(): string {
  const dir = join(homedir(), ".local", "share", "downdraft-platinum-devtools");
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return join(dir, "layout.json");
}

export function saveLayout(): void {
  if (!persistenceEnabled) return;
  const s = store.getState();
  try {
    writeFileSync(prefsPath(), JSON.stringify({
      docks: s.docks, sidebarWidth: s.sidebarWidth,
      mainTab: s.mainTab, theme: s.theme, uiZoom: s.uiZoom,
    }), { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function loadLayout(): void {
  if (!persistenceEnabled) { computeLayout(); return; }
  try {
    const p = prefsPath();
    if (!existsSync(p)) return;
    const saved = JSON.parse(readFileSync(p, "utf8"));
    store.setState((s) => ({
      docks: saved.docks ?? s.docks,
      sidebarWidth: typeof saved.sidebarWidth === "number" ? saved.sidebarWidth : s.sidebarWidth,
      mainTab: typeof saved.mainTab === "string" ? saved.mainTab : s.mainTab,
      theme: saved.theme === "light" ? "light" : "dark",
      uiZoom: typeof saved.uiZoom === "number" && saved.uiZoom > 0.3 ? saved.uiZoom : s.uiZoom,
    }));
  } catch { /* corrupt prefs — use defaults */ }
  computeLayout();
}
