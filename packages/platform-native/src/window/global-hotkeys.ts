// ============================================================================
// global-hotkeys.ts — accelerator → X11 XGrabKey bridge
//
// Games register Electron-style accelerators ("Ctrl+Shift+F1", "F1",
// "MediaPlayPause"). We map the key name to an X11 keysym and the
// modifiers to XCB mask bits, hand them to the native grabber, and invoke
// the callback when a HOTKEY event arrives on the shared event queue.
//
// Linux/X11 only — on Wayland or other platforms grab fails (-1/-2) and
// the callback simply never fires. Re-registering the same callback id is
// handled by the caller (each register returns an unregister closure).
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { winHotkey } from "./window-ffi";

const log = createLogger("info");

// XCB modifier mask bits (xcb.h / xproto.h)
const XCB_SHIFT = 1;
const XCB_CONTROL = 4;
const XCB_MOD1 = 8; // Alt
const XCB_MOD5 = 128; // AltGr / ISO_Level3
const XCB_MOD4 = 64; // Super / Meta / Cmd

const MOD_TOKENS: Record<string, number> = {
  ctrl: XCB_CONTROL,
  control: XCB_CONTROL,
  shift: XCB_SHIFT,
  alt: XCB_MOD1,
  option: XCB_MOD1,
  meta: XCB_MOD4,
  super: XCB_MOD4,
  cmd: XCB_MOD4,
  command: XCB_MOD4,
  altgr: XCB_MOD5,
};

// X11 keysyms for named keys (keysymdef.h). Letters/digits map directly
// onto their lowercase ASCII codepoint — handled in keysymFor().
const KEYSYMS: Record<string, number> = {
  escape: 0xff1b, esc: 0xff1b,
  backspace: 0xff08, tab: 0xff09,
  return: 0xff0d, enter: 0xff0d,
  space: 0x20, spacebar: 0x20,
  insert: 0xff63, ins: 0xff63,
  delete: 0xffff, del: 0xffff,
  home: 0xff50, end: 0xff57,
  pageup: 0xff55, prior: 0xff55, pagedown: 0xff56, next: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  printscreen: 0xff61, print: 0xff61, scrolllock: 0xff14, pausebreak: 0xff13,
  numlock: 0xff7f, capslock: 0xffe5,
  // XF86 multimedia keys (XF86keysym.h)
  mediaplaypause: 0x1008ff14, mediaplay: 0x1008ff14,
  mediapause: 0x1008ff31, mediastop: 0x1008ff15,
  mediatrackprevious: 0x1008ff16, mediaprevious: 0x1008ff16,
  mediatracknext: 0x1008ff17, medianext: 0x1008ff17,
  volumemute: 0x1008ff12, volumedown: 0x1008ff11, volumeup: 0x1008ff13,
  audiomicmute: 0x1008ff18,
};

/** Key name → X11 keysym, or 0 if unmappable. */
export function keysymFor(name: string): number {
  const n = name.trim().toLowerCase();
  if (!n) return 0;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return 0xffbd + parseInt(n.slice(1), 10);
  if (KEYSYMS[n] !== undefined) return KEYSYMS[n];
  // Printable ASCII (a-z, 0-9, punctuation) is its own keysym lowercase.
  if (n.length === 1) {
    const c = n.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return c;
  }
  return 0;
}

/** "Ctrl+Shift+F1" → { mods, keysym } or null when unmappable. */
export function parseAccelerator(accel: string): { mods: number; keysym: number } | null {
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let mods = 0;
  let key = "";
  parts.forEach((p) => {
    const tok = p.toLowerCase();
    if (MOD_TOKENS[tok] !== undefined) mods |= MOD_TOKENS[tok];
    else key = p; // last non-modifier token wins
  });
  const keysym = keysymFor(key);
  return keysym ? { mods, keysym } : null;
}

// id → callback; native-window.ts dispatches HOTKEY events here.
const handlers = new Map<number, () => void>();

/** Called by the event pump when DD_EVENT_HOTKEY arrives (slot 0 = id). */
export function fireGlobalHotkey(id: number): void {
  try {
    handlers.get(id)?.();
  } catch (e) {
    log.error("hotkey", `global hotkey ${id} handler error: ${e}`);
  }
}

/** Returns true when the native hotkey grabber is present (Linux/X11). */
export function globalHotkeySupported(): boolean {
  return typeof winHotkey.dd_hotkey_grab === "function"
    && typeof winHotkey.dd_hotkey_ungrab === "function";
}

/**
 * Grab a global hotkey. Returns an unregister function, or null when the
 * accelerator can't be parsed or the grab fails (no X connection, taken
 * by another client, unsupported platform).
 */
export function registerGlobalHotkey(
  accelerator: string,
  callback: () => void,
): (() => void) | null {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) {
    log.warn("hotkey", `unmappable accelerator "${accelerator}"`);
    return null;
  }
  const grab = winHotkey.dd_hotkey_grab;
  const ungrab = winHotkey.dd_hotkey_ungrab;
  if (!grab || !ungrab) return null; // lib predates hotkey support
  const id = grab(parsed.mods, parsed.keysym);
  if (id <= 0) {
    log.warn("hotkey", `grab failed for "${accelerator}" (${id})`);
    return null;
  }
  handlers.set(id, callback);
  log.info("hotkey", `global hotkey "${accelerator}" registered (id ${id})`);
  return () => {
    handlers.delete(id);
    try { ungrab(id); } catch { /* best effort */ }
  };
}
