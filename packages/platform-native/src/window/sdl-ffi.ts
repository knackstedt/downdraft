// ============================================================================
// sdl-ffi.ts — FFI bindings to the SDL2 shim
//
// Loading is LAZY: importing this module does not call dlopen. The shared
// library is opened on the first symbol access (e.g. create_window), so
// tools and tests that never create a window can import this safely.
// ============================================================================

import { dlopen, type CFunction, type ptr } from "../ffi/ffi-adapter";
import { resolveShimLibrary } from "../ffi/lib-paths";

const SDL_SHIM_SPEC: Record<string, CFunction> = {
  sdl_shim_create_window: { args: ["cstring", "i32", "i32"], returns: "i32" },
  sdl_shim_get_window_subsystem: { args: [], returns: "i32" },
  sdl_shim_get_window_size: { args: ["ptr", "ptr"], returns: "void" },
  sdl_shim_set_window_title: { args: ["cstring"], returns: "void" },
  sdl_shim_poll_event: { args: ["ptr"], returns: "i32" },
  sdl_shim_wait_event: { args: ["ptr", "u32"], returns: "i32" },
  sdl_shim_grab_input: { args: ["i32"], returns: "void" },
  sdl_shim_start_text_input: { args: [], returns: "void" },
  sdl_shim_stop_text_input: { args: [], returns: "void" },
  sdl_shim_set_text_input_rect: { args: ["i32", "i32", "i32", "i32"], returns: "void" },
  sdl_shim_destroy_window: { args: [], returns: "void" },
  sdl_shim_delay: { args: ["u32"], returns: "void" },
  sdl_shim_create_wgpu_surface: { args: ["ptr"], returns: "ptr" },
};

let _sdl: SdlShimSymbols | null = null;

function loadSdl(): SdlShimSymbols {
  if (_sdl) return _sdl;
  const libPath = resolveShimLibrary("sdl_shim", "SDL_SHIM_PATH");
  const { symbols } = dlopen(libPath, SDL_SHIM_SPEC);
  _sdl = symbols as unknown as SdlShimSymbols;
  return _sdl;
}

/** The SDL shim symbols — lazily dlopen()d on first access. */
export const sdl: SdlShimSymbols = new Proxy({} as SdlShimSymbols, {
  get(_target, prop: string) {
    const lib = loadSdl();
    const fn = (lib as any)[prop];
    if (fn === undefined) {
      throw new Error(`sdl shim has no symbol "${prop}"`);
    }
    return fn;
  },
});

export interface SdlShimSymbols {
  sdl_shim_create_window: (title: string, width: number, height: number) => number;
  sdl_shim_get_window_subsystem: () => number;
  sdl_shim_get_window_size: (widthOut: ptr, heightOut: ptr) => void;
  sdl_shim_set_window_title: (title: string) => void;
  sdl_shim_poll_event: (dataOut: ptr) => number;
  sdl_shim_wait_event: (dataOut: ptr, timeoutMs: number) => number;
  sdl_shim_grab_input: (grab: number) => void;
  sdl_shim_start_text_input: () => void;
  sdl_shim_stop_text_input: () => void;
  sdl_shim_set_text_input_rect: (x: number, y: number, w: number, h: number) => void;
  sdl_shim_destroy_window: () => void;
  sdl_shim_delay: (ms: number) => void;
  sdl_shim_create_wgpu_surface: (instance: ptr) => ptr;
}

// Event type constants (matching sdl_shim.c)
export const SDL_EVENT_NONE = 0;
export const SDL_EVENT_QUIT = 1;
export const SDL_EVENT_KEY_DOWN = 2;
export const SDL_EVENT_KEY_UP = 3;
export const SDL_EVENT_MOUSE_MOVE = 4;
export const SDL_EVENT_MOUSE_DOWN = 5;
export const SDL_EVENT_MOUSE_UP = 6;
export const SDL_EVENT_WHEEL = 7;
export const SDL_EVENT_RESIZE = 8;
export const SDL_EVENT_TEXT_INPUT = 9;
export const SDL_EVENT_FOCUS_LOST = 10;

// SDL_Keymod bitmask (SDL_keymod.h)
export const KMOD_SHIFT = 0x0001 | 0x0002; // LSHIFT | RSHIFT
export const KMOD_CTRL = 0x0040 | 0x0080;  // LCTRL | RCTRL
export const KMOD_ALT = 0x0100 | 0x0200;   // LALT | RALT
export const KMOD_GUI = 0x0400 | 0x0800;   // LGUI | RGUI (meta)

/** Convert SDL button-state bitmask (1<<n-1) to DOM `buttons` (0:l,1:r,2:m). */
export function sdlButtonsToDom(sdlButtons: number): number {
  return (sdlButtons & 0b001)         // left
    | ((sdlButtons & 0b100) >> 1)     // right  (SDL bit2 → DOM bit1)
    | ((sdlButtons & 0b010) << 1);    // middle (SDL bit1 → DOM bit2)
}
