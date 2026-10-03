// ============================================================================
// EditorShell — the Blitz html-ui editor chrome.
//
// Four panels over the live viewport:
//   toolbar    — scene name/dirty, New/Save/Undo/Redo, spawn, gizmo mode
//   hierarchy  — entity tree, click-select, per-row delete
//   inspector  — schema-driven component editor for the primary selection
//   journal    — command log (every dispatched command, with source tags)
//
// Every button/field dispatches an EditorCommand — the UI is a thin client
// of the same command surface MCP agents drive. Field edits debounce into
// `component.set`; gizmo drags coalesce via registry transactions.
// ============================================================================

import { createLogger, listComponentDefinitions, sanitizeObject } from "@downdraft/engine";
import type { HtmlUiContext, UiPanelHandle } from "@downdraft/engine/modules/html-ui";

import type { EditorContext } from "./editor-context";

const log = createLogger("info");

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
  :root { color-scheme: dark; }
  body { background: rgba(18,20,24,0.97); color: #d5dae3; font-size: 12px; overflow: hidden; }
  button { background: #2a2f3a; color: #d5dae3; border: 1px solid #3c4454; border-radius: 4px;
           padding: 3px 8px; font-size: 12px; cursor: pointer; }
  button:hover { background: #39414f; }
  button.on { background: #2d4a72; border-color: #4a7ec2; }
  button:disabled { opacity: 0.4; }
  input { background: #171a20; border: 1px solid #3c4454; border-radius: 3px; color: #e8edf4;
          padding: 2px 5px; font-size: 12px; min-width: 0; }
  .tb { display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 8px; }
  .brand { color: #6ea8fe; font-weight: 700; letter-spacing: 0.5px; }
  .doc { color: #e8edf4; font-weight: 600; }
  .dirty { color: #f0b45c; font-weight: 700; }
  .sep { width: 1px; height: 16px; background: #3c4454; }
  .spacer { flex: 1; }
  .hint { color: #7d8794; font-size: 11px; }
  .hdr { display: flex; align-items: center; padding: 6px 8px; border-bottom: 1px solid #2b313c;
         font-weight: 700; color: #9fb3d1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; }
  .hdr .spacer { flex: 1; }
  .row { display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .row:hover { background: #232936; }
  .row.sel { background: #2d4a72; }
  .row .k { color: #7d8794; font-size: 10px; }
  .row .x { margin-left: auto; color: #7d8794; padding: 0 4px; border-radius: 3px; }
  .row .x:hover { background: #5a2d2d; color: #f0b0b0; }
  .empty { padding: 12px 10px; color: #7d8794; }
  .comp { border-bottom: 1px solid #242933; }
  .comp-h { display: flex; align-items: center; padding: 5px 8px; font-weight: 600; color: #a8c3ec; }
  .comp-h .x { margin-left: auto; cursor: pointer; color: #7d8794; padding: 0 5px; border-radius: 3px; }
  .comp-h .x:hover { background: #5a2d2d; color: #f0b0b0; }
  .fld { display: flex; align-items: center; gap: 6px; padding: 2px 8px 4px 12px; }
  .fld label { flex: 0 0 90px; color: #98a5b8; overflow: hidden; text-overflow: ellipsis; }
  .fld input { flex: 1; }
  .fld .ro { flex: 1; color: #7d8794; font-family: monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
  .addc { display: flex; gap: 6px; padding: 8px; }
  .addc input { flex: 1; }
  .jrow { display: flex; gap: 6px; padding: 2px 8px; white-space: nowrap; overflow: hidden; }
  .jrow .seq { color: #566; min-width: 30px; }
  .jrow .src { min-width: 44px; font-size: 10px; border-radius: 3px; padding: 0 4px; text-align: center; }
  .src.ui { background: #2d4a72; color: #bcd4ff; }
  .src.mcp { background: #4a3a72; color: #d4c0ff; }
  .src.internal { background: #333; color: #999; }
  .src.undo, .src.redo { background: #4a5a2d; color: #d4e0a0; }
  .src.net { background: #2d5a5a; color: #a0e0e0; }
`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Blitz parses full documents — styles belong in <head>, not body text. */
function page(body: string): string {
  return `<html><head><style>${CSS}</style></head><body>${body}</body></html>`;
}

export type GizmoModeName = "translate" | "rotate" | "scale";

export interface EditorShellLayout {
  toolbarH: number;
  hierarchyW: number;
  inspectorW: number;
  journalH: number;
}

export const DEFAULT_LAYOUT: EditorShellLayout = {
  toolbarH: 34,
  hierarchyW: 280,
  inspectorW: 320,
  journalH: 170,
};

/**
 * The editor's Blitz UI. Owns panel lifecycles + action dispatch.
 * Re-renders whole panels on state change — at editor scale (a few hundred
 * nodes) a full `setHtml` reparse is cheap, and it keeps the renderer
 * trivially correct.
 */
export class EditorShell {
  private editor: EditorContext;
  private ui: HtmlUiContext;
  private layout: EditorShellLayout;
  private gizmoMode: GizmoModeName = "translate";

  private toolbar!: UiPanelHandle;
  private hierarchy!: UiPanelHandle;
  private inspector!: UiPanelHandle;
  private journal!: UiPanelHandle;

  private pendingField = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingAddComponent = "";
  private screenW = 1280;
  private screenH = 720;
  private disposers: Array<() => void> = [];

  /** Fired when the user picks a gizmo mode button / hotkey equivalent. */
  onGizmoMode: ((mode: GizmoModeName) => void) | null = null;

  constructor(editor: EditorContext, ui: HtmlUiContext, layout?: Partial<EditorShellLayout>) {
    this.editor = editor;
    this.ui = ui;
    this.layout = { ...DEFAULT_LAYOUT, ...layout };
  }

  mount(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    const L = this.layout;

    this.toolbar = this.ui.mount(this.renderToolbar(), {
      id: "ed-toolbar",
      rect: { x: 0, y: 0, w: screenW, h: L.toolbarH },
      z: 10,
    });
    this.hierarchy = this.ui.mount(this.renderHierarchy(), {
      id: "ed-hierarchy",
      rect: { x: 0, y: L.toolbarH + 4, w: L.hierarchyW, h: screenH - L.toolbarH - L.journalH - 8 },
      z: 10,
    });
    this.inspector = this.ui.mount(this.renderInspector(), {
      id: "ed-inspector",
      rect: { x: screenW - L.inspectorW, y: L.toolbarH + 4, w: L.inspectorW, h: screenH - L.toolbarH - L.journalH - 8 },
      z: 10,
    });
    this.journal = this.ui.mount(this.renderJournal(), {
      id: "ed-journal",
      rect: { x: 0, y: screenH - L.journalH, w: screenW, h: L.journalH },
      z: 10,
    });

    // Field edits + add-component text input live on the inspector's raw
    // event stream (input/keydown events don't carry data-action).
    this.disposers.push(this.inspector.onEvent((ev) => this.onInspectorEvent(ev)));

    this.wireActions();

    // Re-render on document/selection/journal changes.
    this.disposers.push(this.editor.document.onChange(() => this.refreshStructure()));
    this.disposers.push(this.editor.selection.onChange(() => {
      this.hierarchy.setHtml(this.renderHierarchy());
      this.inspector.setHtml(this.renderInspector());
    }));
    this.disposers.push(this.editor.commands.onDispatched(() => {
      this.journal.setHtml(this.renderJournal());
      this.toolbar.setHtml(this.renderToolbar());
    }));
  }

  resize(w: number, h: number): void {
    this.screenW = w;
    this.screenH = h;
    const L = this.layout;
    this.toolbar.setRect({ x: 0, y: 0, w, h: L.toolbarH });
    this.hierarchy.setRect({ x: 0, y: L.toolbarH + 4, w: L.hierarchyW, h: h - L.toolbarH - L.journalH - 8 });
    this.inspector.setRect({ x: w - L.inspectorW, y: L.toolbarH + 4, w: L.inspectorW, h: h - L.toolbarH - L.journalH - 8 });
    this.journal.setRect({ x: 0, y: h - L.journalH, w, h: L.journalH });
  }

  setGizmoMode(mode: GizmoModeName): void {
    this.gizmoMode = mode;
    this.toolbar.setHtml(this.renderToolbar());
  }

  getGizmoMode(): GizmoModeName {
    return this.gizmoMode;
  }

  dispose(): void {
    this.disposers.forEach((fn) => fn());
    this.disposers.length = 0;
    this.pendingField.forEach((t) => clearTimeout(t));
    this.pendingField.clear();
  }

  // ── Action wiring ──

  private wireActions(): void {
    const d = (id: string, params: Record<string, unknown> = {}) =>
      this.editor.commands.dispatch(id, params, "ui").catch((e) => log.error("editor", `${id}: ${e}`));

    const ui = this.ui;
    this.disposers.push(
      ui.onAction("ed.new", () => d("scene.new", { name: "untitled" })),
      ui.onAction("ed.save", () => d("scene.save")),
      ui.onAction("ed.undo", () => d("editor.undo")),
      ui.onAction("ed.redo", () => d("editor.redo")),
      ui.onAction("ed.spawn", () => d("entity.spawn", { name: `entity_${this.editor.document.entityCount + 1}` })),
      ui.onAction("ed.select", (data, ev) => {
        const key = data.key;
        if (!key) return;
        const shift = (ev.m ?? 0) & 1;
        if (shift) {
          void this.editor.commands.dispatch(
            this.editor.selection.isSelected(key) ? "selection.remove" : "selection.add",
            { entity: key }, "ui").catch(() => {});
        } else {
          void this.editor.commands.dispatch("selection.set", { entities: [key] }, "ui").catch(() => {});
        }
      }),
      ui.onAction("ed.remove", (data) => { if (data.key) d("entity.remove", { entity: data.key }); }),
      ui.onAction("ed.dup", (data) => { if (data.key) d("entity.duplicate", { entity: data.key }); }),
      ui.onAction("ed.mode", (data) => {
        const mode = data.mode as GizmoModeName;
        if (mode === "translate" || mode === "rotate" || mode === "scale") {
          this.setGizmoMode(mode);
          this.onGizmoMode?.(mode);
        }
      }),
      ui.onAction("ed.removeComponent", (data) => {
        const key = this.editor.selection.primary();
        if (key && data.comp) d("component.remove", { entity: key, component: data.comp });
      }),
      ui.onAction("ed.addComponent", () => {
        const key = this.editor.selection.primary();
        const name = this.pendingAddComponent.trim();
        if (key && name) {
          const def = listComponentDefinitions().find((c) => c.name === name);
          d("component.add", { entity: key, component: name, data: def?.defaults ?? {} });
          this.pendingAddComponent = "";
        }
      }),
    );
  }

  /** Raw DOM events on the inspector doc — text field edits. */
  private onInspectorEvent(ev: { t: string; d?: Record<string, string>; v?: string; k?: string }): void {
    const data = ev.d;
    if (!data) return;

    // Track the add-component input + Enter submits.
    if (data["addcomp"] !== undefined) {
      if (ev.t === "input") this.pendingAddComponent = ev.v ?? "";
      if (ev.t === "keydown" && ev.k === "Enter") {
        const key = this.editor.selection.primary();
        const name = this.pendingAddComponent.trim();
        if (key && name) {
          const def = getComponentDefinitionSafe(name);
          void this.editor.commands.dispatch("component.add",
            { entity: key, component: name, data: def?.defaults ?? {} }, "ui").catch(() => {});
          this.pendingAddComponent = "";
        }
      }
      return;
    }

    // Entity name field.
    if (data["field"] === "__name" && (ev.t === "input" || ev.t === "change")) {
      const entity = data["entity"];
      if (!entity) return;
      this.debounce(`name:${entity}`, () => {
        void this.editor.commands.dispatch("entity.rename",
          { entity, name: ev.v ?? "" }, "ui").catch(() => {});
      }, 400);
      return;
    }

    // Component field edits.
    if (ev.t === "input" && data["entity"] && data["comp"] && data["field"]) {
      const { entity, comp, field } = data;
      this.debounce(`${entity}:${comp}:${field}`, () => {
        const parsed = parseFieldValue(ev.v ?? "", this.currentFieldValue(entity, comp, field));
        void this.editor.commands.dispatch("component.set",
          { entity, component: comp, changes: { [field]: parsed } }, "ui").catch(() => {});
      }, 350);
    }
  }

  private debounce(key: string, fn: () => void, ms: number): void {
    const t = this.pendingField.get(key);
    if (t) clearTimeout(t);
    this.pendingField.set(key, setTimeout(() => { this.pendingField.delete(key); fn(); }, ms));
  }

  private currentFieldValue(entity: string, comp: string, field: string): unknown {
    const e = this.editor.parseEntity(entity);
    if (!e) return undefined;
    const cid = this.editor.engine.getComponentIdByName(comp);
    const data = this.editor.engine.ecsWorld.getComponent<Record<string, unknown>>(e, cid);
    return data?.[field];
  }

  // ── Rendering ──

  private refreshStructure(): void {
    this.hierarchy.setHtml(this.renderHierarchy());
    this.inspector.setHtml(this.renderInspector());
    this.toolbar.setHtml(this.renderToolbar());
  }

  private renderToolbar(): string {
    const doc = this.editor.document;
    const canUndo = this.editor.commands.canUndo();
    const canRedo = this.editor.commands.canRedo();
    const modeBtn = (m: GizmoModeName, label: string) =>
      `<button data-action="ed.mode" data-mode="${m}" class="${this.gizmoMode === m ? "on" : ""}">${label}</button>`;
    return page(`<div class="tb">
      <span class="brand">◆ downdraft</span>
      <span class="doc">${esc(doc.name)}</span>${doc.isDirty() ? `<span class="dirty">●</span>` : ""}
      <span class="sep"></span>
      <button data-action="ed.new">New</button>
      <button data-action="ed.save">Save</button>
      <button data-action="ed.undo" ${canUndo ? "" : "disabled"}>Undo</button>
      <button data-action="ed.redo" ${canRedo ? "" : "disabled"}>Redo</button>
      <span class="sep"></span>
      <button data-action="ed.spawn">+ Entity</button>
      <span class="sep"></span>
      ${modeBtn("translate", "Move")}${modeBtn("rotate", "Rotate")}${modeBtn("scale", "Scale")}
      <span class="spacer"></span>
      <span class="hint">${doc.entityCount} entities · editor_* via draft mcp</span>
    </div>`);
  }

  private renderHierarchy(): string {
    const sel = this.editor.selection;
    const rows: string[] = [];
    const walk = (entityKey: string, depth: number) => {
      const e = this.editor.parseEntity(entityKey);
      if (!e) return;
      const name = this.editor.document.entityName(entityKey) ?? `Entity ${entityKey}`;
      const s = sel.isSelected(entityKey);
      rows.push(
        `<div class="row${s ? " sel" : ""}" data-action="ed.select" data-key="${esc(entityKey)}">
          <span style="padding-left:${depth * 14}px">${esc(name)}</span>
          <span class="k">${esc(entityKey)}</span>
          <span class="x" data-action="ed.remove" data-key="${esc(entityKey)}">✕</span>
        </div>`,
      );
      for (const child of this.editor.engine.hierarchy.getChildren(e)) {
        walk(this.editor.key(child), depth + 1);
      }
    };

    // Roots = tracked entities without a tracked parent.
    const all = this.editor.document.entities();
    const tracked = new Set(all.map((e) => this.editor.key(e)));
    all.forEach((e) => {
      const parent = this.editor.engine.hierarchy.getParent(e);
      if (!parent || !tracked.has(this.editor.key(parent))) {
        walk(this.editor.key(e), 0);
      }
    });

    return page(`
      <div class="hdr">Hierarchy<span class="spacer"></span>
        <button data-action="ed.spawn">+</button></div>
      ${rows.length ? rows.join("") : `<div class="empty">Empty scene — spawn an entity (or ask an agent: editor_entity_spawn).</div>`}`);
  }

  private renderInspector(): string {
    const key = this.editor.selection.primary();
    if (!key) {
      return page(`<div class="hdr">Inspector</div><div class="empty">Nothing selected.</div>`);
    }
    const entity = this.editor.parseEntity(key);
    if (!entity || !this.editor.isAliveKey(key)) {
      return page(`<div class="hdr">Inspector</div><div class="empty">Selection is stale.</div>`);
    }
    const name = this.editor.document.entityName(key) ?? "";
    const arch = this.editor.engine.ecsWorld.getArchetypeForEntity(entity);
    const blocks: string[] = [];

    if (arch) {
      const row = arch.entities.findIndex((e) => e.index === entity.index && e.generation === entity.generation);
      if (row >= 0) {
        for (const [cid, col] of arch.columns.entries()) {
          const compName = this.editor.engine.getComponentNameById(cid);
          const data = sanitizeObject(this.editor.engine.ecsWorld.getComponent<Record<string, unknown>>(entity, cid) ?? {}) as Record<string, unknown>;
          void col;
          const fields = Object.entries(data).map(([field, value]) => {
            const shown = typeof value === "object" ? JSON.stringify(value) : String(value);
            return `<div class="fld"><label>${esc(field)}</label>
              <input value="${esc(shown)}" data-entity="${esc(key)}" data-comp="${esc(compName)}" data-field="${esc(field)}"></div>`;
          }).join("");
          blocks.push(`<div class="comp">
            <div class="comp-h">${esc(compName)}
              <span class="x" data-action="ed.removeComponent" data-comp="${esc(compName)}">✕</span></div>
            ${fields || `<div class="fld"><label style="flex:1;color:#566">(empty)</label></div>`}
          </div>`);
        }
      }
    }

    return page(`
      <div class="hdr">Inspector<span class="k" style="margin-left:6px;color:#7d8794">${esc(key)}</span></div>
      <div class="fld"><label>Name</label>
        <input value="${esc(name)}" data-entity="${esc(key)}" data-field="__name" placeholder="Entity name"></div>
      ${blocks.join("")}
      <div class="addc">
        <input data-addcomp="1" placeholder="+ component name…">
        <button data-action="ed.addComponent">Add</button>
      </div>`);
  }

  private renderJournal(): string {
    const events = this.editor.commands.getEventLog(40);
    const rows = [...events].reverse().map((e) =>
      `<div class="jrow"><span class="seq">${e.seq}</span>
        <span class="src ${e.source}">${e.source}</span>
        <span>${esc(e.description)}</span></div>`,
    ).join("");
    const undoN = this.editor.commands.getJournal().length;
    const redoN = this.editor.commands.getRedoStack().length;
    return page(`
      <div class="hdr">Journal<span class="spacer"></span>
        <span style="color:#7d8794;font-weight:400">${undoN} undoable · ${redoN} redoable</span></div>
      ${rows || `<div class="empty">No commands yet — every human and agent edit lands here.</div>`}`);
  }
}

function getComponentDefinitionSafe(name: string) {
  return listComponentDefinitions().find((c) => c.name === name);
}

function parseFieldValue(text: string, prev: unknown): unknown {
  if (Array.isArray(prev)) {
    const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
    const nums = parts.map((p) => Number(p));
    return nums.every((n) => Number.isFinite(n)) ? nums : prev;
  }
  switch (typeof prev) {
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? n : prev;
    }
    case "boolean":
      return text === "true" || text === "1" || text === "on";
    case "object":
      if (prev === null) return text;
      try { return JSON.parse(text); } catch { return prev; }
    default:
      return text;
  }
}
