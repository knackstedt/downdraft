// ============================================================================
// gallery.ts — the Widgets gallery page, the Settings page, and the
// 10-foot "TV mode" document.
//
// The gallery is one long `.dd-scroll` page that mounts every standard kit
// widget — including a live WebGPU-rendered surface composited inside a
// nested scroll view (`#gpu-slot` inside `#gpu-scroll`), driven by the
// gpu-slot renderer module.
// ============================================================================

import { downdraft } from "@downdraft/engine/app/main";
import * as kit from "@downdraft/engine/libraries/html-ui-kit";
import { store } from "./state";

// ── widgets page ──

function wgSection(title: string, html: string, note = ""): string {
  return `<div style="margin-bottom:18px">
    ${kit.sectionLabel(title)}
    <div class="dd-panel">${html}${note ? `<div class="wg-note">${kit.esc(note)}</div>` : ""}</div>
  </div>`;
}

function wgButtons(): string {
  return wgSection("BUTTONS + TOOLBAR", `
    <div class="wg-row">
      ${kit.button({ label: "Normal" })}
      ${kit.button({ label: "Accent", kind: "accent" })}
      ${kit.button({ label: "Danger", kind: "danger" })}
      ${kit.button({ label: "Ghost", kind: "ghost" })}
      ${kit.button({ label: "Disabled", disabled: true })}
      ${kit.button({ label: "Toggled", on: true })}
      ${kit.tooltipWrap(kit.button({ label: "Hover me" }), "tooltipWrap() around a button")}
    </div>
    ${kit.toolbar(`
      ${kit.button({ label: "T-One", kind: "ghost", action: "wg:tb-one" })}
      ${kit.button({ label: "T-Two", kind: "ghost", action: "wg:tb-two" })}
      ${kit.divider()}
      ${kit.label("toolbar() with mixed content")}
      ${kit.badge({ label: "v1.0", kind: "accent" })}
    `)}
    <div class="wg-row">${kit.label("click actions toast on the right →")}</div>
  `);
}

function wgToggles(): string {
  return wgSection("TOGGLES", `
    <div class="wg-grid">
      <div class="wg-col">
        ${kit.checkbox({ id: "wg-check-a", label: "checkbox — on", on: true })}
        ${kit.checkbox({ id: "wg-check-b", label: "checkbox — off" })}
        ${kit.checkbox({ id: "wg-check-c", label: "checkbox — disabled", disabled: true })}
        ${kit.switchToggle({ id: "wg-switch-a", label: "switchToggle — on", on: true })}
        ${kit.switchToggle({ id: "wg-switch-b", label: "switchToggle — off" })}
      </div>
      <div class="wg-col">
        ${kit.radioGroup({ id: "wg-radio", options: ["Radio Alpha", "Radio Beta", "Radio Gamma"], selected: 1 })}
      </div>
    </div>
  `);
}

function wgInputs(): string {
  return wgSection("INPUTS", `
    <div class="wg-grid">
      <div class="wg-col">
        ${kit.textInput({ id: "wg-input", label: "textInput", placeholder: "type here…" })}
        ${kit.textArea({ id: "wg-area", label: "textArea", rows: 3, value: "Multi-line editing surface." })}
        ${kit.numberField({ id: "wg-num", label: "numberField", value: "7", min: 0, max: 99, step: 1 })}
      </div>
      <div class="wg-col">
        ${kit.textInput({ id: "wg-invalid", label: "invalid textInput", value: "bad value", invalid: true })}
        ${kit.fieldError("fieldError() — validation message lives here", "wg-field-err")}
        ${kit.textInput({ id: "wg-disabled", label: "disabled input", value: "can't touch this", disabled: true })}
        <div class="dd-field"><div class="dd-lbl">dropdown()</div>
          ${kit.dropdown({ id: "wg-dd", options: ["Mercury", "Venus", "Earth", "Mars"], selected: 2 })}</div>
      </div>
    </div>
  `);
}

function wgPickers(): string {
  return wgSection("PICKERS + VALUES", `
    <div class="wg-row">${kit.segmented({ id: "wg-seg", options: ["Day", "Week", "Month", "Year"], selected: 1 })}</div>
    <div class="wg-row">${kit.tabs({ id: "wg-tabs", tabs: ["Alpha", "Beta", "Gamma"], selected: 0 })}
      <span class="dd-label">— a second tabs() instance, independent of the app tab bar</span></div>
    ${kit.slider({ id: "wg-slider", label: "slider() with live value", min: 0, max: 100, value: 42, showValue: true })}
    <div class="wg-row">
      <div style="flex:1">${kit.progressBar({ value: 25, kind: "accent" })}</div>
      <div style="flex:1">${kit.progressBar({ value: 55, kind: "good" })}</div>
      <div style="flex:1">${kit.progressBar({ value: 78, kind: "warn" })}</div>
      <div style="flex:1">${kit.progressBar({ value: 93, kind: "bad" })}</div>
    </div>
    <div class="wg-row">${kit.spinner({})}${kit.spinner({ size: 26 })}${kit.label("spinner() in two sizes")}</div>
  `);
}

function wgCollections(): string {
  return wgSection("COLLECTIONS", `
    <div class="wg-grid">
      <div class="wg-col">
        ${kit.label("listView()")}
        ${kit.listView({ id: "wg-list", height: 110, items: ["Alpha list item", "Beta list item", "Gamma", "Delta", "Epsilon", "Zeta"], selected: 1 })}
        ${kit.spacer(6)}
        ${kit.label("treeView()")}
        ${kit.treeView({
          id: "wg-tree", height: 130,
          nodes: [
            { label: "src", children: [{ label: "app-module.ts" }, { label: "state.ts" }, { label: "gpu-slot.ts" }] },
            { label: "widgets", children: [{ label: "buttons" }, { label: "pickers" }, { label: "overlays" }] },
            { label: "docs", open: false, children: [{ label: "architecture" }] },
          ],
        })}
      </div>
      <div class="wg-col">
        ${kit.label("dataTable()")}
        ${kit.dataTable({
          id: "wg-table",
          cols: ["Widget", "Events", "State attr"],
          rows: [
            ["button", "kit:press", "data-on / data-disabled"],
            ["slider", "kit:drag", "data-value"],
            ["dropdown", "kit:open / kit:choice", "data-open / data-value"],
            ["tabs", "kit:select", "data-on per tab"],
          ],
        })}
        ${kit.spacer(6)}
        ${kit.label("menu() — inline menu surface")}
        ${kit.menu([
          { label: "Menu item one", value: "one" },
          { label: "Menu item two", value: "two" },
          { sep: true, label: "" },
          { label: "After separator", value: "three" },
        ], "kit:choice", "wg-dd")}
      </div>
    </div>
    ${kit.accordion({
      id: "wg-acc",
      sections: [
        { title: "accordion() section — open", html: kit.label("Content inside the open section. Headers toggle via kit:acc.") },
        { title: "Second section", open: false, html: kit.label("Collapsed content.") },
        { title: "Third section", open: false, html: kit.label("More content.") },
      ],
    })}
    <div class="wg-row">${kit.label("scrollView() — nested, independent scroll:")}</div>
    ${kit.scrollView({ id: "wg-nested-scroll", height: 90, html:
      Array.from({ length: 12 }, (_, i) => `<div style="padding:3px 4px;font-size:11px;color:var(--dd-dim)">Nested scroll row ${i + 1} — wheel over this box scrolls it, not the page.</div>`).join("") })}
  `);
}

function wgOverlays(): string {
  return wgSection("OVERLAYS", `
    <div class="wg-row">
      ${kit.button({ label: "modal()", action: "wg:modal" })}
      ${kit.button({ label: "contextMenu()", action: "wg:ctx" })}
      ${kit.button({ label: "blade()", action: "wg:blade" })}
      ${kit.button({ label: "commandPalette()", action: "wg:palette" })}
    </div>
    <div class="wg-row">
      ${kit.button({ label: "toast good", kind: "ghost", action: "toast:good" })}
      ${kit.button({ label: "toast warn", kind: "ghost", action: "toast:warn" })}
      ${kit.button({ label: "toast bad", kind: "ghost", action: "toast:bad" })}
      ${kit.button({ label: "toast info", kind: "ghost", action: "toast:info" })}
      ${kit.label("toastStack() renders top-right")}
    </div>
    <div class="wg-row">${kit.label("Right-click any kanban card on the Board page for the live contextMenu(); right-click a column header for popupMenu().")}</div>
  `);
}

function wgGpuSurface(): string {
  return wgSection("WEBGPU SURFACE IN A SCROLL AREA", `
    <div class="wg-row">${kit.label(
      "The box below is a real WebGPU render — a cube pass encoded every frame into an " +
      "offscreen rgba8unorm texture and composited into this .dd-scroll viewport through " +
      "a second ScreenUiCompositor (PanelBlitPass). Its rect tracks the placeholder element " +
      "and clips against the scroll container. Click it to pause/resume.")}</div>
    <div class="dd-scroll" id="gpu-scroll" data-kit="scroll" data-id="gpu-scroll">
      <div style="padding:4px 2px 6px">${kit.label("Scroll inside this box — the GPU surface moves with the document and clips at the viewport edges.")}</div>
      <div id="gpu-slot" data-action="gpu:toggle" data-nav></div>
      <div style="padding:6px 2px">${kit.label("Content below the surface keeps flowing — the quad is composited at the element's live rect each frame.")}
        ${kit.progressBar({ id: "gpu-progress", value: 0, kind: "accent" })}</div>
    </div>
  `);
}

function wgMisc(): string {
  return wgSection("MISC", `
    <div class="wg-grid">
      <div class="wg-col">
        ${kit.label("kvTable()")}
        ${kit.kvTable([["runtime", "native wgpu"], ["ui worker", "blitz OSR"], ["theme", "kit dark"]])}
      </div>
      <div class="wg-col">
        ${kit.label("badge() kinds")}
        <div class="wg-row">
          ${kit.badge({ label: "default" })}
          ${kit.badge({ label: "accent", kind: "accent" })}
          ${kit.badge({ label: "good", kind: "good" })}
          ${kit.badge({ label: "warn", kind: "warn" })}
          ${kit.badge({ label: "bad", kind: "bad" })}
        </div>
        ${kit.label("label() / sectionLabel() / divider() / spacer() / panel() / row() / col() — used throughout this page")}
      </div>
    </div>
  `);
}

export function widgetsPageHtml(): string {
  return `<div class="dd-scroll" id="gallery-scroll" data-kit="scroll" data-id="gallery-scroll"
      style="flex:1;min-height:0;border:none;background:transparent">
        <div style="padding:4px 2px 12px">
          ${kit.sectionLabel("KIT GALLERY — every standard widget, live")}
        </div>
        ${wgButtons()}
        ${wgToggles()}
        ${wgInputs()}
        ${wgPickers()}
        ${wgCollections()}
        ${wgOverlays()}
        ${wgGpuSurface()}
        ${wgMisc()}
        ${kit.spacer(20)}
    </div>`;
}

// ── settings page ──

function settingsRows(): string {
  const paths = downdraft.paths;
  return `
    ${kit.sectionLabel("PREFERENCES")}
    ${kit.settingsRow({
      id: "set-compact", label: "Compact cards",
      hint: "Tighter card density on the board",
      control: kit.switchToggle({ id: "sw-compact", on: store.prefs.compact }),
      on: store.prefs.compact,
    })}
    ${kit.settingsRow({
      id: "set-notify", label: "Notify on card moves",
      hint: "Post an OS notification when a task changes column",
      control: kit.switchToggle({ id: "sw-notify", on: store.prefs.notifyOnMove }),
      on: store.prefs.notifyOnMove,
    })}
    ${kit.settingsRow({
      id: "set-veto", label: "Simulate unsaved changes",
      hint: "Close requests get vetoed while armed",
      control: kit.switchToggle({ id: "sw-veto", on: store.prefs.vetoArmed }),
      on: store.prefs.vetoArmed,
    })}
    ${kit.settingsRow({
      id: "set-zoom", label: "UI zoom",
      hint: "App-wide ui zoom — Ctrl+= / Ctrl+- also work",
      control: kit.slider({ id: "sl-zoom", min: 50, max: 200, value: 100, showValue: true, width: 200 }),
    })}
    ${kit.sectionLabel("DEFAULTS")}
    <div class="dd-row">
      <div class="dd-field"><div class="dd-lbl">Default sort</div>
        ${kit.dropdown({ id: "set-sort", options: ["Newest first", "Priority", "Points"], selected: { created: 0, priority: 1, points: 2 }[store.prefs.sort], width: 160 })}</div>
      <div class="dd-field"><div class="dd-lbl">Startup page</div>
        ${kit.radioGroup({ id: "set-startpage", options: ["Board", "Dashboard", "Widgets"], selected: 0 })}</div>
    </div>
    ${kit.sectionLabel("HOST")}
    ${kit.panel(kit.kvTable([
      ["configDir", paths?.configDir ?? "n/a"],
      ["dataDir", paths?.dataDir ?? "n/a"],
      ["cacheDir", paths?.cacheDir ?? "n/a"],
      ["theme", downdraft.getTheme?.() ?? "unknown"],
    ]))}
    ${kit.sectionLabel("ACTIONS")}
    <div class="wg-row">
      ${kit.button({ label: "Export board JSON", action: "set:export" })}
      ${kit.button({ label: "Import board JSON", action: "set:import" })}
      ${kit.button({ label: "Send notification", action: "set:notify" })}
      ${kit.button({ label: "Toggle tray", action: "set:tray" })}
      ${kit.button({ label: "Reset board", kind: "danger", action: "set:reset" })}
    </div>
    ${kit.sectionLabel("SHORTCUTS")}
    ${kit.listView({
      id: "set-shortcuts", height: 110,
      items: [
        `${kit.acceleratorText("CmdOrCtrl+N")} — new task`,
        `${kit.acceleratorText("CmdOrCtrl+K")} — command palette`,
        `${kit.acceleratorText("CmdOrCtrl+E")} — export board`,
        `${kit.acceleratorText("CmdOrCtrl+=")} / ${kit.acceleratorText("CmdOrCtrl+-")} — UI zoom`,
        "Esc — close palette / blade / modal",
      ],
    })}
  `;
}

export function settingsPageHtml(): string {
  return `<div id="settings-page" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:4px">
    ${settingsRows()}
  </div>`;
}

// ── TV / 10-foot document ──

export function tvDocHtml(): string {
  const cards = [
    { label: "Board", sub: "kanban view", art: "▦", action: "tv:goto", data: { page: 0 } },
    { label: "Dashboard", sub: "stats + feed", art: "◔", action: "tv:goto", data: { page: 1 } },
    { label: "Widgets", sub: "kit gallery", art: "✦", action: "tv:goto", data: { page: 2 } },
    { label: "Settings", sub: "prefs", art: "⚙", action: "tv:goto", data: { page: 3 } },
    { label: "New task", sub: "create card", art: "＋", action: "tv:new" },
    { label: "Palette", sub: "commands", art: "⌘", action: "tv:palette" },
  ];
  return `<html><head>${kit.kitStyleTag()}<style>${kit.tvCss()}</style></head><body>
    <div style="padding:22px">
      ${kit.detailPanel({
        title: "Task Board — TV mode",
        sub: "10-foot interface · every couch widget from ten-foot.ts",
        description: "This document is a separate html-ui panel with the tvCss() preset — " +
          "shelf() rows of mediaCard(), detailPanel(), settingsRow() and blade() markup, " +
          "nav zones and the OSK all wired by the kit.",
        actionsHtml: kit.button({ label: "Back to desktop UI", kind: "accent", action: "tv:close" }),
      })}
      ${kit.shelf({ id: "tv-shelf-pages", title: "PAGES", items: cards.slice(0, 4) })}
      ${kit.shelf({ id: "tv-shelf-actions", title: "ACTIONS", items: cards.slice(4) })}
      ${kit.sectionLabel("PINNED")}
      ${kit.mediaGrid({ id: "tv-grid", items: [...cards.slice(0, 3), ...cards.slice(0, 3)], cols: 3, cardWidth: 150 })}
      ${kit.sectionLabel("SETTINGS ROWS")}
      ${kit.settingsRow({ id: "tv-srow-1", label: "Compact cards", hint: "Denser board layout", control: kit.switchToggle({ id: "tv-sw-1", on: store.prefs.compact }) })}
      ${kit.settingsRow({ id: "tv-srow-2", label: "Notifications", hint: "OS notifications on moves", control: kit.switchToggle({ id: "tv-sw-2", on: store.prefs.notifyOnMove }) })}
      ${kit.settingsRow({ id: "tv-srow-3", label: "Open the blade", hint: "Xbox-style edge panel — fires tv:blade", control: kit.button({ label: "Open", action: "tv:blade" }), action: "tv:blade" })}
    </div>
    ${kit.blade({
      id: "tv-blade", title: "TV blade", side: "left", open: false,
      html: `${kit.label("A slide-in edge panel (blade()). It carries a nav zone — pad focus is trapped here until dismissed.")}
        ${kit.spacer(10)}${kit.button({ label: "Close blade", action: "tv:blade-close" })}`,
    })}
    </body></html>`;
}
