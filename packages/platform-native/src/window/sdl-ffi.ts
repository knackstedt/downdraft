// ============================================================================
// sdl-ffi.ts — bun:ffi bindings to the SDL2 shim
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, type CFunction } from "../ffi/ffi-adapter.js";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

function findSdlShimLibrary(): string {
  const envPath = process.env.SDL_SHIM_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const relativePath = join(_dirname, "..", "..", "native", "libsdl_shim.so");
  if (existsSync(relativePath)) return relativePath;

  throw new Error("libsdl_shim.so not found. Build with: cd native && gcc -shared -fPIC -o libsdl_shim.so sdl_shim.c -I./include -L./lib -lwgpu_native $(pkg-config --cflags --libs sdl2)");
}

const { symbols } = dlopen(findSdlShimLibrary(), {
  sdl_shim_create_window: { args: ["cstring", "i32", "i32"], returns: "i32" } as CFunction,
  sdl_shim_get_window_subsystem: { args: [], returns: "i32" } as CFunction,
  sdl_shim_get_window_size: { args: ["ptr", "ptr"], returns: "void" } as CFunction,
  sdl_shim_set_window_title: { args: ["cstring"], returns: "void" } as CFunction,
  sdl_shim_poll_event: { args: ["ptr"], returns: "i32" } as CFunction,
  sdl_shim_grab_input: { args: ["i32"], returns: "void" } as CFunction,
  sdl_shim_start_text_input: { args: [], returns: "void" } as CFunction,
  sdl_shim_stop_text_input: { args: [], returns: "void" } as CFunction,
  sdl_shim_set_text_input_rect: { args: ["i32", "i32", "i32", "i32"], returns: "void" } as CFunction,
  sdl_shim_destroy_window: { args: [], returns: "void" } as CFunction,
  sdl_shim_delay: { args: ["u32"], returns: "void" } as CFunction,
});

export const sdl = symbols as unknown as SdlShimSymbols;

export interface SdlShimSymbols {
  sdl_shim_create_window: (title: string, width: number, height: number) => number;
  sdl_shim_get_window_subsystem: () => number;
  sdl_shim_get_window_size: (widthOut: ptr, heightOut: ptr) => void;
  sdl_shim_set_window_title: (title: string) => void;
  sdl_shim_poll_event: (dataOut: ptr) => number;
  sdl_shim_grab_input: (grab: number) => void;
  sdl_shim_start_text_input: () => void;
  sdl_shim_stop_text_input: () => void;
  sdl_shim_set_text_input_rect: (x: number, y: number, w: number, h: number) => void;
  sdl_shim_destroy_window: () => void;
  sdl_shim_delay: (ms: number) => void;
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
