// ============================================================================
// window-ffi.ts — FFI bindings to the window/event shim (winit in
// libdowndraft_platform; the dd_window_* symbol names are the frozen ABI)
//
// Loading is LAZY: importing this module does not call dlopen. The shared
// library is opened on the first symbol access (e.g. create_window), so
// tools and tests that never create a window can import this safely.
// ============================================================================

import { assertPlatformAbi } from "../ffi/abi";
import { dlopen, type CFunction, type ptr } from "../ffi/ffi-adapter";
import { resolvePlatformLibrary, resolveShimLibrary } from "../ffi/lib-paths";

/** DD_WINDOW_LIB_PATH override → the unified platform lib (ABI-checked). */
function windowLibPath(): string {
  if (process.env.DD_WINDOW_LIB_PATH) {
    return resolveShimLibrary("downdraft_window", "DD_WINDOW_LIB_PATH");
  }
  const libPath = resolvePlatformLibrary();
  assertPlatformAbi(libPath);
  return libPath;
}

const WINDOW_SPEC: Record<string, CFunction> = {
  dd_window_create: { args: ["cstring", "i32", "i32"], returns: "i32" },
  dd_window_get_subsystem: { args: [], returns: "i32" },
  dd_window_get_size: { args: ["ptr", "ptr"], returns: "void" },
  dd_window_set_title: { args: ["cstring"], returns: "void" },
  dd_window_focus: { args: [], returns: "void" },
  dd_window_poll_event: { args: ["ptr"], returns: "i32" },
  dd_window_wait_event: { args: ["ptr", "u32"], returns: "i32" },
  dd_window_grab_input: { args: ["i32"], returns: "void" },
  dd_window_start_text_input: { args: [], returns: "void" },
  dd_window_stop_text_input: { args: [], returns: "void" },
  dd_window_set_text_input_rect: { args: ["i32", "i32", "i32", "i32"], returns: "void" },
  dd_window_destroy: { args: [], returns: "void" },
  dd_window_delay: { args: ["u32"], returns: "void" },
  // Second arg is the shim window handle (0 = primary). Old libs export the
  // same symbol with a 1-arg signature — a trailing arg is ABI-harmless.
  dd_window_create_wgpu_surface: { args: ["ptr", "i32"], returns: "ptr" },
  dd_window_set_fullscreen: { args: ["i32"], returns: "void" },
  dd_window_get_pos: { args: ["ptr", "ptr"], returns: "void" },
  dd_window_set_pos: { args: ["i32", "i32"], returns: "void" },
  dd_window_get_borders: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  dd_window_set_size: { args: ["i32", "i32"], returns: "void" },
  dd_window_get_display_info: { args: ["ptr", "ptr"], returns: "void" },
  dd_window_set_vsync_wanted: { args: ["i32"], returns: "void" },
  dd_window_request_quit: { args: [], returns: "void" },
  dd_window_pump_stats: { args: ["ptr"], returns: "void" },
  dd_window_show_message_box: { args: ["cstring", "cstring"], returns: "i32" },
  dd_window_set_clipboard: { args: ["cstring"], returns: "void" },
  dd_window_get_clipboard: { args: ["ptr", "i32"], returns: "i32" },
};

// Symbols added after the frozen core spec. Probed via a separate dlopen of
// the same lib (refcounted, cheap) so adapters that bind eagerly (koffi,
// Deno.dlopen) don't fail the whole window-shim load when the .so predates them.
const WINDOW_EXT_SPEC: Record<string, CFunction> = {
  dd_window_set_app_name: { args: ["cstring", "cstring"], returns: "void" },
  dd_window_set_icon_file: { args: ["cstring"], returns: "i32" },
};

let _ext: Partial<WindowExtSymbols> | null = null;

function loadWindowExt(): Partial<WindowExtSymbols> {
  if (_ext) return _ext;
  try {
    const libPath = windowLibPath();
    const { symbols } = dlopen(libPath, WINDOW_EXT_SPEC);
    _ext = symbols as unknown as Partial<WindowExtSymbols>;
  } catch {
    _ext = {};
  }
  return _ext;
}

/** Optional window-identity symbols — absent on libs predating them. */
export const winExt: Partial<WindowExtSymbols> = new Proxy({} as Partial<WindowExtSymbols>, {
  get(_target, prop: string) {
    return (loadWindowExt() as any)[prop];
  },
});

export interface WindowExtSymbols {
  dd_window_set_app_name: (general: string, instance: string) => void;
  dd_window_set_icon_file: (path: string) => number;
}

// Multi-window symbols (0.4.5+): secondary windows for overlays/splitscreen.
// Separate probe group so a lib predating them still satisfies the core spec.
const WINDOW_MULTI_SPEC: Record<string, CFunction> = {
  dd_window_secondary_create: {
    args: ["cstring", "i32", "i32", "i32", "i32", "i32"],
    returns: "i32",
  },
  dd_window_secondary_destroy: { args: ["i32"], returns: "void" },
  dd_window_secondary_set_visible: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_set_hittest: { args: ["i32", "i32"], returns: "i32" },
  dd_window_secondary_set_level: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_set_title: { args: ["i32", "cstring"], returns: "void" },
  dd_window_secondary_focus: { args: ["i32"], returns: "void" },
  dd_window_secondary_set_decorations: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_set_fullscreen: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_get_size: { args: ["i32", "ptr", "ptr"], returns: "void" },
  dd_window_secondary_set_size: { args: ["i32", "i32", "i32"], returns: "void" },
  dd_window_secondary_get_pos: { args: ["i32", "ptr", "ptr"], returns: "void" },
  dd_window_secondary_set_pos: { args: ["i32", "i32", "i32"], returns: "void" },
  dd_window_secondary_grab: { args: ["i32", "i32"], returns: "void" },
};

let _win: Partial<MultiWindowSymbols> | null = null;

function loadMultiWindow(): Partial<MultiWindowSymbols> {
  if (_win) return _win;
  try {
    const libPath = windowLibPath();
    const { symbols } = dlopen(libPath, WINDOW_MULTI_SPEC);
    _win = symbols as unknown as Partial<MultiWindowSymbols>;
  } catch {
    _win = {};
  }
  return _win;
}

/** Optional multi-window symbols — absent on libs predating them. */
export const winMulti: Partial<MultiWindowSymbols> = new Proxy(
  {} as Partial<MultiWindowSymbols>,
  {
    get(_target, prop: string) {
      return (loadMultiWindow() as any)[prop];
    },
  },
);

// Global-hotkey symbols (0.4.7+): X11 XGrabKey on the root window over a
// dedicated connection. Linux-only today — absent or -1 elsewhere.
const WINDOW_HOTKEY_SPEC: Record<string, CFunction> = {
  dd_hotkey_grab: { args: ["u32", "u32"], returns: "i32" },
  dd_hotkey_ungrab: { args: ["i32"], returns: "i32" },
};

let _hotkey: Partial<WindowHotkeySymbols> | null = null;

function loadWindowHotkey(): Partial<WindowHotkeySymbols> {
  if (_hotkey) return _hotkey;
  try {
    const libPath = windowLibPath();
    const { symbols } = dlopen(libPath, WINDOW_HOTKEY_SPEC);
    _hotkey = symbols as unknown as Partial<WindowHotkeySymbols>;
  } catch {
    _hotkey = {};
  }
  return _hotkey;
}

/** Optional global-hotkey symbols — absent on libs predating them. */
export const winHotkey: Partial<WindowHotkeySymbols> = new Proxy(
  {} as Partial<WindowHotkeySymbols>,
  {
    get(_target, prop: string) {
      return (loadWindowHotkey() as any)[prop];
    },
  },
);

export interface WindowHotkeySymbols {
  dd_hotkey_grab: (mods: number, keysym: number) => number;
  dd_hotkey_ungrab: (id: number) => number;
}

// Desktop-window controls (0.9+): primary create options + handle-addressed
// runtime ops. Same lazy-probe pattern as the other optional groups — every
// op resolves handle 0 to the primary, so secondaries and the primary share
// the dd_window_secondary_* family.
const WINDOW_DESKTOP_SPEC: Record<string, CFunction> = {
  dd_window_set_create_options: {
    args: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"],
    returns: "void",
  },
  dd_window_secondary_set_minimized: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_set_maximized: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_is_maximized: { args: ["i32"], returns: "i32" },
  dd_window_secondary_set_resizable: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_set_min_size: { args: ["i32", "i32", "i32"], returns: "void" },
  dd_window_secondary_set_max_size: { args: ["i32", "i32", "i32"], returns: "void" },
  dd_window_secondary_request_attention: { args: ["i32", "i32"], returns: "void" },
  dd_window_secondary_get_theme: { args: ["i32"], returns: "i32" },
  dd_window_secondary_set_close_intercept: { args: ["i32", "i32"], returns: "void" },
};

let _winDesktop: Partial<WindowDesktopSymbols> | null = null;

function loadWindowDesktop(): Partial<WindowDesktopSymbols> {
  if (_winDesktop) return _winDesktop;
  try {
    const libPath = windowLibPath();
    const { symbols } = dlopen(libPath, WINDOW_DESKTOP_SPEC);
    _winDesktop = symbols as unknown as Partial<WindowDesktopSymbols>;
  } catch {
    _winDesktop = {};
  }
  return _winDesktop;
}

/** Optional desktop-window-control symbols — absent on libs predating them. */
export const winDesktop: Partial<WindowDesktopSymbols> = new Proxy(
  {} as Partial<WindowDesktopSymbols>,
  {
    get(_target, prop: string) {
      return (loadWindowDesktop() as any)[prop];
    },
  },
);

export interface WindowDesktopSymbols {
  /** Pre-create options for the NEXT dd_window_create (primary window) —
   *  WF_* flag bits (authoritative), position (i32 min = WM placement),
   *  min/max inner size (<=0 = unset). Consumed at create. */
  dd_window_set_create_options: (
    flags: number,
    x: number,
    y: number,
    minW: number,
    minH: number,
    maxW: number,
    maxH: number,
  ) => void;
  dd_window_secondary_set_minimized: (handle: number, on: number) => void;
  dd_window_secondary_set_maximized: (handle: number, on: number) => void;
  dd_window_secondary_is_maximized: (handle: number) => number;
  dd_window_secondary_set_resizable: (handle: number, on: number) => void;
  /** 0,0 clears the bound. Physical px. */
  dd_window_secondary_set_min_size: (handle: number, w: number, h: number) => void;
  dd_window_secondary_set_max_size: (handle: number, w: number, h: number) => void;
  dd_window_secondary_request_attention: (handle: number, urgent: number) => void;
  /** 0 unknown / 1 light / 2 dark. */
  dd_window_secondary_get_theme: (handle: number) => number;
  /** Armed: CloseRequested → DD_EVENT_CLOSE_REQUEST (vetoable, stays
   *  mapped); disarmed: legacy hide-then-Quit/WindowClose. */
  dd_window_secondary_set_close_intercept: (handle: number, on: number) => void;
}

export interface MultiWindowSymbols {
  dd_window_secondary_create: (
    title: string,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ) => number;
  dd_window_secondary_destroy: (handle: number) => void;
  dd_window_secondary_set_visible: (handle: number, visible: number) => void;
  dd_window_secondary_set_hittest: (handle: number, hittest: number) => number;
  dd_window_secondary_set_level: (handle: number, level: number) => void;
  dd_window_secondary_set_title: (handle: number, title: string) => void;
  dd_window_secondary_focus: (handle: number) => void;
  dd_window_secondary_set_decorations: (handle: number, on: number) => void;
  dd_window_secondary_set_fullscreen: (handle: number, enabled: number) => void;
  dd_window_secondary_get_size: (handle: number, wOut: ptr, hOut: ptr) => void;
  dd_window_secondary_set_size: (handle: number, width: number, height: number) => void;
  dd_window_secondary_get_pos: (handle: number, xOut: ptr, yOut: ptr) => void;
  dd_window_secondary_set_pos: (handle: number, x: number, y: number) => void;
  dd_window_secondary_grab: (handle: number, grab: number) => void;
}

// dd_window_secondary_create flag bits (native-rs WF_*)
export const DD_WIN_RESIZABLE = 1;
export const DD_WIN_DECORATIONS = 2;
export const DD_WIN_TRANSPARENT = 4;
export const DD_WIN_ALWAYS_ON_TOP = 8;
export const DD_WIN_SKIP_TASKBAR = 16;
export const DD_WIN_CLICK_THROUGH = 32;
export const DD_WIN_HIDDEN = 64;

let _winCore: WindowSymbols | null = null;

function loadWindow(): WindowSymbols {
  if (_winCore) return _winCore;
  // Resolution order: explicit DD_WINDOW_LIB_PATH override → unified Rust
  // platform lib (downdraft_platform, winit + wgpu surface).
  const libPath = windowLibPath();
  const { symbols } = dlopen(libPath, WINDOW_SPEC);
  _winCore = symbols as unknown as WindowSymbols;
  return _winCore;
}

/** The native window shim symbols — lazily dlopen()d on first access. */
export const win: WindowSymbols = new Proxy({} as WindowSymbols, {
  get(_target, prop: string) {
    const lib = loadWindow();
    const fn = (lib as any)[prop];
    if (fn === undefined) {
      throw new Error(`window shim has no symbol "${prop}"`);
    }
    return fn;
  },
});

export interface WindowSymbols {
  dd_window_create: (title: string, width: number, height: number) => number;
  dd_window_get_subsystem: () => number;
  dd_window_get_size: (widthOut: ptr, heightOut: ptr) => void;
  dd_window_set_title: (title: string) => void;
  dd_window_focus: () => void;
  dd_window_poll_event: (dataOut: ptr) => number;
  dd_window_wait_event: (dataOut: ptr, timeoutMs: number) => number;
  dd_window_grab_input: (grab: number) => void;
  dd_window_start_text_input: () => void;
  dd_window_stop_text_input: () => void;
  dd_window_set_text_input_rect: (x: number, y: number, w: number, h: number) => void;
  dd_window_destroy: () => void;
  dd_window_delay: (ms: number) => void;
  dd_window_create_wgpu_surface: (instance: ptr, window: number) => ptr;
  dd_window_set_fullscreen: (enabled: number) => void;
  dd_window_get_pos: (xOut: ptr, yOut: ptr) => void;
  dd_window_set_pos: (x: number, y: number) => void;
  dd_window_get_borders: (topOut: ptr, leftOut: ptr, bottomOut: ptr, rightOut: ptr) => number;
  dd_window_set_size: (width: number, height: number) => void;
  dd_window_get_display_info: (refreshOut: ptr, scaleOut: ptr) => void;
  dd_window_set_vsync_wanted: (wanted: number) => void;
  dd_window_request_quit: () => void;
  dd_window_pump_stats: (out: ptr) => void;
  dd_window_show_message_box: (title: string, message: string) => number;
  dd_window_set_clipboard: (text: string) => void;
  dd_window_get_clipboard: (out: ptr, maxLen: number) => number;
}

// Event type constants (matching native-rs/src/window/events.rs)
export const DD_EVENT_NONE = 0;
export const DD_EVENT_QUIT = 1;
export const DD_EVENT_KEY_DOWN = 2;
export const DD_EVENT_KEY_UP = 3;
export const DD_EVENT_MOUSE_MOVE = 4;
export const DD_EVENT_MOUSE_DOWN = 5;
export const DD_EVENT_MOUSE_UP = 6;
export const DD_EVENT_WHEEL = 7;
export const DD_EVENT_RESIZE = 8;
export const DD_EVENT_TEXT_INPUT = 9;
export const DD_EVENT_FOCUS_LOST = 10;
export const DD_EVENT_MOVED = 11;
export const DD_EVENT_DROP_FILE = 12;
export const DD_EVENT_FOCUS_GAINED = 13;
export const DD_EVENT_SCALE_CHANGED = 14;
// Mobile lifecycle/input (Android): TOUCH slots are [phase, x, y, id];
// SUSPENDED/RESUMED bracket the loss/recreation of the native window.
export const DD_EVENT_TOUCH = 15;
export const DD_EVENT_SUSPENDED = 16;
export const DD_EVENT_RESUMED = 17;
// Android Choreographer tick — slot0 is a wrapping u32 of vsync microseconds.
export const DD_EVENT_VSYNC = 18;
// Secondary-window close request — the owning window's "close" fires but no
// process quit. Every event's i32 slot 15 carries the owning window handle.
export const DD_EVENT_WINDOW_CLOSE = 19;
// Global hotkey fired — slot 0 carries the dd_hotkey_grab id.
export const DD_EVENT_HOTKEY = 20;
// Vetoable close request — pushed only while the window's close intercept
// is armed (dd_window_secondary_set_close_intercept). The window stays
// mapped; JS decides whether anything closes.
export const DD_EVENT_CLOSE_REQUEST = 21;
// OS occlusion report — slot0 = 1 fully occluded, 0 revealed. Delivered
// where winit reports it (Wayland/macOS/Android); absent elsewhere.
export const DD_EVENT_OCCLUDED = 22;
// Theme changed — slot0 = 0 unknown / 1 light / 2 dark.
export const DD_EVENT_THEME_CHANGED = 23;

// Key-modifier bitmask (native-rs wire values)
export const KMOD_SHIFT = 0x0001 | 0x0002; // LSHIFT | RSHIFT
export const KMOD_CTRL = 0x0040 | 0x0080;  // LCTRL | RCTRL
export const KMOD_ALT = 0x0100 | 0x0200;   // LALT | RALT
export const KMOD_GUI = 0x0400 | 0x0800;   // LGUI | RGUI (meta)

/** Convert wire button-state bitmask (1<<n-1) to DOM `buttons` (0:l,1:r,2:m). */
export function wireButtonsToDom(buttons: number): number {
  return (buttons & 0b001)         // left
    | ((buttons & 0b100) >> 1)     // right  (wire bit2 → DOM bit1)
    | ((buttons & 0b010) << 1);    // middle (wire bit1 → DOM bit2)
}
