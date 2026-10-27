// ============================================================================
// menus.ts — in-window application-menu fallback for the html-ui kit.
//
// When the host's setMenu() reports "inwindow" (Linux/Android, or
// DD_MENU=inwindow) the app renders this MenuBar in a top strip panel.
// The same AppMenuModel drives both paths — item ids come back through
// onMenuAction identically whether native or in-window.
//
//   menuBar(model)   → HTML for the top strip + dropdown menus
//   popupMenu(model) → positioned context menu (showPopupMenu binding)
//   menuAccelerators(model) → key chord → item id table for the app's
//      global key path (menus eat clicks, but shortcuts should fire
//      wherever the app routes keydown — input bus, dom handler, etc.)
//
// Interaction verbs (routed by bindKit):
//   kit:menuopen    bar label click      → toggles that menu; one open max
//   kit:menuitem    item pick            → onAction("menuitem", {id, mid})
//                                          where mid is the item's id
//   kit:menudismiss backdrop/explicit    → closes the bar + open menu
//
// Menu state lives in data-open attrs, so every open/close is a doc
// mutation — the html-ui damage tracker marks the frame dirty on its own.
// ============================================================================

import type { AppMenuItem, AppMenuModel } from "@downdraft/engine/app/shared/types";
import { esc } from "./components";

// ── accelerator parsing ──

export interface ParsedAccelerator {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key — lowercase single char or a named key ("f1", "enter"). */
  key: string;
}

/** Parse "CmdOrCtrl+O" / "Shift+Alt+F12" / "Super+Q" into modifier flags +
 *  a normalized key. Returns null for unparseable specs. CmdOrCtrl maps
 *  to meta on macOS-ish hosts, ctrl elsewhere — callers decide via the
 *  isMac flag at match time. */
export function parseAccelerator(spec: string): ParsedAccelerator | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const acc: ParsedAccelerator = { ctrl: false, meta: false, shift: false, alt: false, key: "" };
  for (let pi = 0; pi < parts.length; pi++) {
    const t = parts[pi].toLowerCase();
    switch (t) {
      case "ctrl": case "control": case "cmdorctrl": case "commandorcontrol":
        acc.ctrl = true;
        break;
      case "cmd": case "command": case "meta": case "super": case "win":
        acc.meta = true;
        break;
      case "shift":
        acc.shift = true;
        break;
      case "alt": case "option":
        acc.alt = true;
        break;
      default:
        // The last non-modifier token is the key — normalize to lowercase.
        acc.key = t;
        break;
    }
  }
  return acc.key ? acc : null;
}

/** Compact display form for the menu item's right-aligned shortcut text:
 *  "CmdOrCtrl+Shift+Z" → "Ctrl+Shift+Z". */
export function acceleratorText(spec: string): string {
  const p = parseAccelerator(spec);
  if (!p) return spec;
  const parts: string[] = [];
  if (p.ctrl) parts.push("Ctrl");
  if (p.meta) parts.push("Cmd");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  parts.push(p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1));
  return parts.join("+");
}

/** Match a parsed accelerator against a keydown-shaped event.
 *  CmdOrCtrl accept either ctrl or meta so cross-platform shortcuts work
 *  on both conventions. */
export function matchAccelerator(
  acc: ParsedAccelerator,
  ev: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; key?: string },
): boolean {
  const wantPrimary = acc.ctrl || acc.meta;
  const hasPrimary = Boolean(ev.ctrlKey) || Boolean(ev.metaKey);
  if (wantPrimary !== hasPrimary) return false;
  // Bare-modifier chords (e.g. "Shift+F1") shouldn't fire on plain keys.
  if (acc.shift !== Boolean(ev.shiftKey)) return false;
  if (acc.alt !== Boolean(ev.altKey)) return false;
  return acc.key === (ev.key ?? "").toLowerCase();
}

/** Build the chord→id lookup for a model — the app calls matchAccelerator
 *  against each entry in its keydown path. Disabled items are excluded;
 *  separators/predefineds carry no accelerator by construction. */
export function menuAccelerators(
  model: AppMenuModel,
): { acc: ParsedAccelerator; id: string }[] {
  const out: { acc: ParsedAccelerator; id: string }[] = [];
  const walk = (items: AppMenuItem[]) => {
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      if (it.type === "submenu") {
        walk(it.items);
        continue;
      }
      if (it.type !== "check" && it.type !== "item" && it.type !== undefined) continue;
      if (it.enabled === false || !it.accelerator) continue;
      const acc = parseAccelerator(it.accelerator);
      if (acc) out.push({ acc, id: it.id });
    }
  };
  walk(model.items);
  return out;
}

// ── item rendering ──

/** Default labels for predefined kinds on the in-window path (native
 *  menus get real platform labels from muda). */
const PREDEFINED_LABELS: Record<string, string> = {
  copy: "Copy",
  cut: "Cut",
  paste: "Paste",
  selectall: "Select All",
  undo: "Undo",
  redo: "Redo",
  quit: "Quit",
  about: "About",
  minimize: "Minimize",
  maximize: "Maximize",
  closewindow: "Close Window",
  fullscreen: "Toggle Full Screen",
  hide: "Hide",
  hideothers: "Hide Others",
  showall: "Show All",
  services: "Services",
  bringalltofront: "Bring All to Front",
};

function menuItemHtml(it: AppMenuItem, barId: string, mbIndex: number | null, path: string): string {
  if (it.type === "separator") return `<div class="dd-msep"></div>`;
  if (it.type === "submenu") {
    // Nested submenu — opens on hover (no verb needed).
    const kids = it.items.map((c, j) => menuItemHtml(c, barId, mbIndex, `${path}-${j}`)).join("");
    const dis = it.enabled === false ? ` data-disabled="true"` : "";
    return `<div class="dd-mi dd-msub"${dis}><span>${esc(it.label)}</span>` +
      `<span class="dd-caret">▸</span><div class="dd-menu dd-msubm">${kids}</div></div>`;
  }
  // it: item | check | predefined — narrow on it.type directly (a derived
  // local doesn't narrow the union).
  const id = it.type === "predefined" ? (it.id ?? it.kind) : it.id;
  const label =
    it.type === "predefined"
      ? (it.label ?? PREDEFINED_LABELS[it.kind.toLowerCase().replace(/_/g, "")] ?? it.kind)
      : it.label;
  const dis = "enabled" in it && it.enabled === false ? ` data-disabled="true"` : "";
  const mb = ` data-mb="${esc(barId)}"`;
  const mbi = mbIndex !== null ? ` data-mbi="${mbIndex}"` : "";
  if (it.type === "check") {
    const on = it.checked ? ` data-on="true"` : "";
    // data-mi is the element's own id so the verb can flip the checkmark.
    return `<div class="dd-mi dd-mck" id="m-${esc(barId)}-${path}"${dis}${on}` +
      ` data-action="kit:menuitem" data-mi="m-${esc(barId)}-${path}"${mb}${mbi}` +
      ` data-mid="${esc(id)}"><span class="dd-ckm">${it.checked ? "✓" : ""}</span>` +
      `<span>${esc(label)}</span>${accelSpan(it.accelerator)}</div>`;
  }
  const accel = "accelerator" in it ? accelSpan(it.accelerator) : "";
  return `<div class="dd-mi"${dis} data-action="kit:menuitem"${mb}${mbi}` +
    ` data-mid="${esc(id)}"><span>${esc(label)}</span>${accel}</div>`;
}

function accelSpan(spec?: string): string {
  return spec ? `<span class="dd-maccel">${esc(acceleratorText(spec))}</span>` : "";
}

// ── components ──

export interface MenuBarOpts {
  /** Root id — defaults to "dd-menubar". */
  id?: string;
  model: AppMenuModel;
}

/** Render the model as a menu strip. Top-level "submenu" items become
 *  labeled dropdowns; a bare "item" at top level fires its action
 *  directly on click. data-open on the root + .dd-mb wrappers drives the
 *  open state (mutations mark damage on their own). */
export function menuBar(o: MenuBarOpts): string {
  const id = o.id ?? "dd-menubar";
  const labels = o.model.items
    .map((it, i) => {
      if (it.type === "submenu") {
        const kids = it.items.map((c, j) => menuItemHtml(c, id, i, `${i}-${j}`)).join("");
        const dis = it.enabled === false ? ` data-disabled="true"` : "";
        // data-open on the label mirrors its .dd-mb wrapper so the verb
        // can tell open from closed without a query.
        return `<div class="dd-mb" data-i="${i}" data-open="false"${dis}>` +
          `<div class="dd-mbl" data-action="kit:menuopen" data-id="${esc(id)}" data-i="${i}"` +
          ` data-open="false" data-count="${o.model.items.length}">${esc(it.label)}</div>` +
          `<div class="dd-menu dd-mbm">${kids}</div></div>`;
      }
      if (it.type === "separator") return `<div class="dd-mbsep"></div>`;
      const iid = it.type === "predefined" ? (it.id ?? it.kind) : it.id;
      const label =
        it.type === "predefined"
          ? (it.label ?? PREDEFINED_LABELS[it.kind.toLowerCase().replace(/_/g, "")] ?? it.kind)
          : it.label;
      const dis = "enabled" in it && it.enabled === false ? ` data-disabled="true"` : "";
      return `<div class="dd-mb" data-i="${i}" data-open="false"${dis}>` +
        `<div class="dd-mbl" data-action="kit:menuitem" data-mb="${esc(id)}"` +
        ` data-mid="${esc(iid)}">${esc(label)}</div></div>`;
    })
    .join("");
  return `<div class="dd-menubar" id="${esc(id)}" data-kit="menubar" data-open="false">` +
    `<div class="dd-mback" data-action="kit:menudismiss" data-id="${esc(id)}"` +
    ` data-count="${o.model.items.length}"></div>${labels}</div>`;
}

export interface PopupMenuOpts {
  id: string;
  model: AppMenuModel;
  /** Doc-space position — applied by the caller or showPopupMenu. */
  x?: number;
  y?: number;
}

/** Context-menu surface for the same model — show by toggling data-open
 *  (binding.showContextMenu moves + opens it). */
export function popupMenu(o: PopupMenuOpts): string {
  const items = o.model.items.map((it, j) => menuItemHtml(it, o.id, null, `p-${j}`)).join("");
  return `<div class="dd-ctx dd-popmenu" id="${esc(o.id)}" data-kit="ctxmenu" data-open="false"` +
    ` style="left:${o.x ?? 0}px;top:${o.y ?? 0}px">${items}</div>`;
}
