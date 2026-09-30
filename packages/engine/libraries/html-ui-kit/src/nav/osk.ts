// ============================================================================
// osk.ts — engine-provided on-screen keyboard for controller-driven html-ui.
//
// openOsk() mounts a bottom-anchored html-ui panel of kit buttons, gives it
// its own NavController pushed onto the "osk" zone, and forwards typed
// characters into the *target* panel via handle.sendKey — so the focused
// <input>/<textarea> in that doc receives real key events (text insertion,
// backspace, Enter) exactly as if typed.
//
// Usage: while open, route your nav dispatch through osk.dispatch(action);
// it returns false once closed so the app resumes its own nav.
// ============================================================================

import type { HtmlUiHost, UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { kitStyleTag } from "../theme";
import { NavController, type NavAction } from "./nav-controller";

export interface OskOptions {
  /** Screen-space size for bottom anchoring. */
  screenW: number;
  screenH: number;
  /** Panel height in CSS px (default 190). */
  height?: number;
  /** Initial text shown in the preview row (read from the field if unset). */
  value?: string;
  onDone?(text: string): void;
  onCancel?(): void;
}

export interface OskSession {
  /** Route nav actions here while open; returns false once closed. */
  dispatch(action: NavAction): boolean;
  /** Current text as last read from the target field. */
  text(): string;
  close(commit: boolean): void;
}

const ROWS = [
  "1234567890",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
];

const KEY_CSS = `
/* overflow:visible — kit's body{overflow:hidden} clips everything when the
   body has no in-flow content (.osk is absolute → body height collapses). */
body { overflow: visible; }
.osk { position:absolute; left:0; top:0; right:0; bottom:0; background:#0d1117;
  display:flex; flex-direction:column; gap:6px; padding:10px; }
.osk-row { display:flex; flex-direction:row; gap:5px; justify-content:center; }
.osk-key { min-width:30px; text-align:center; padding:8px 6px; border-radius:5px;
  border:1px solid #30363d; background:#1a212b; color:#e8edf2; font-size:13px; }
.osk-key[data-nav-focus="1"] { border-color:#58a6ff; background:#26303d; }
.osk-wide { min-width:64px; }
.osk-preview { color:#8b98a5; font-size:12px; text-align:center; min-height:14px; }
`;

function keyBtn(k: string, wide = false): string {
  return `<div class="osk-key${wide ? " osk-wide" : ""}" data-action="osk:key" data-key="${k}">${k}</div>`;
}

function oskHtml(): string {
  const rows = ROWS.map((r) =>
    `<div class="osk-row">${[...r].map((k) => keyBtn(k)).join("")}</div>`,
  ).join("");
  const ctl = `<div class="osk-row">
    ${keyBtn("⇧", true)}${keyBtn("space", true)}${keyBtn("⌫", true)}${keyBtn("done", true)}${keyBtn("esc", true)}
  </div>`;
  return `<html><head>${kitStyleTag()}<style>${KEY_CSS}</style></head>
<body><div class="osk" data-nav-zone="osk">
  <div class="osk-preview" id="osk-preview"></div>
  ${rows}${ctl}
</div></body></html>`;
}

/**
 * Open an OSK bound to `target` (the panel whose focused field receives the
 * typed keys). The caller must keep routing NavActions through
 * session.dispatch() from its pad/keyboard driver.
 */
export function openOsk(
  host: HtmlUiHost,
  target: UiPanelHandle,
  targetNode: number | string,
  opts: OskOptions,
): OskSession {
  const height = opts.height ?? 190;
  const panel = host.mount({
    id: "dd-osk",
    rect: { x: 0, y: opts.screenH - height, w: opts.screenW, h: height },
    z: 1000,
    scale: 1,
    html: oskHtml(),
  });

  let text = opts.value ?? "";
  let shift = false;
  let open = true;
  const nav = new NavController(panel, { zone: "osk" });

  const type = (key: string) => {
    const keyName = key === "space" ? " " : key === "⌫" ? "Backspace" : key === "done" ? "Enter"
      : shift && key.length === 1 ? key.toUpperCase() : key;
    const text = key.length === 1 ? (shift ? key.toUpperCase() : key) : key === "space" ? " " : undefined;
    target.sendKey(true, keyName, { text });
    target.sendKey(false, keyName, {});
  };

  const refreshPreview = async () => {
    const v = await target.getAttr(targetNode, "value");
    if (v !== null) text = v;
    panel.setText("#osk-preview", text);
  };

  void refreshPreview();
  void nav.refresh();

  const session: OskSession = {
    text: () => text,
    dispatch(action) {
      if (!open) return false;
      if (action === "cancel") { session.close(false); return false; }
      if (action === "confirm") {
        // Which OSK key is focused (or first candidate before first move)?
        void (async () => {
          const info = await nav.current();
          if (!info) return;
          const key = await panel.getAttr(info.node, "data-key");
          if (!key) return;
          if (key === "esc") { session.close(false); return; }
          if (key === "done") { session.close(true); return; }
          if (key === "⇧") { shift = !shift; panel.setAttr(info.node, "data-on", String(shift)); return; }
          type(key);
          if (key !== "⇧" && shift) shift = false;
          void refreshPreview();
        })();
        return true;
      }
      void nav.dispatch(action);
      return true;
    },
    close(commit) {
      if (!open) return;
      open = false;
      if (commit) opts.onDone?.(text);
      else opts.onCancel?.();
      nav.dispose();
      panel.dispose();
    },
  };
  return session;
}
