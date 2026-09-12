// ============================================================================
// native-window.ts — SDL2 window + wgpu surface + event loop + rAF + input
//
// This is the main native window manager. It:
//   1. Creates an SDL2 window
//   2. Creates a wgpu surface from the window's native handle
//   3. Creates a NativeSurface (HTMLCanvasElement-compatible)
//   4. Runs the event loop (poll SDL events, dispatch rAF callbacks)
//   5. Translates SDL events to DOM-compatible events
// ============================================================================

import { wgpu } from "../gpu/wgpu-ffi";
import { NativeSurface } from "./native-surface";
import { sdl, SDL_EVENT_KEY_DOWN, SDL_EVENT_KEY_UP, SDL_EVENT_MOUSE_DOWN, SDL_EVENT_MOUSE_MOVE, SDL_EVENT_MOUSE_UP, SDL_EVENT_NONE, SDL_EVENT_QUIT, SDL_EVENT_RESIZE, SDL_EVENT_TEXT_INPUT, SDL_EVENT_WHEEL } from "./sdl-ffi";

export interface NativeWindowConfig {
  title: string;
  width: number;
  height: number;
  resizable?: boolean;
}

type RAFCallback = (time: number) => void;

export class NativeWindow {
  private surface: NativeSurface | null = null;
  private rafCallbacks: Set<RAFCallback> = new Set();
  private running: boolean = false;
  private startTime: number = 0;
  private inputListeners: Map<string, Set<(event: any) => void>> = new Map();
  private surfacePtr: number = 0;
  private pressedKeys = new Set<number>();

  constructor(config: NativeWindowConfig) {
    // 1. Create SDL2 window
    const result = sdl.sdl_shim_create_window(config.title, config.width, config.height);
    if (result !== 0) {
      throw new Error(`Failed to create SDL2 window (error ${result})`);
    }

    // 2. Create wgpu surface from the window
    // The wgpu surface is created in the C shim using the window's native handle.
    // We need the wgpu instance pointer — it's stored in the WgpuGPU class.
    // For now, we'll create the surface via a C function that takes the instance.
    // The instance is stored globally in the C shim.
    this.surfacePtr = createWgpuSurfaceForSDLWindow();
    if (!this.surfacePtr) {
      throw new Error("Failed to create wgpu surface from SDL2 window");
    }

    // 3. Create NativeSurface
    this.surface = new NativeSurface(config.width, config.height, this.surfacePtr);
    this.startTime = performance.now();
  }

  getSurface(): NativeSurface {
    if (!this.surface) throw new Error("Window not initialized");
    return this.surface;
  }

  // ── requestAnimationFrame ──

  requestAnimationFrame(callback: RAFCallback): number {
    this.rafCallbacks.add(callback);
    return this.rafCallbacks.size; // simple ID
  }

  cancelAnimationFrame(id: number): void {
    // We use a Set, so we can't cancel by ID easily. For simplicity, we clear all.
    // The engine's rafSource seam handles this properly.
    // TODO: use a Map<number, callback> for proper cancellation
  }

  // ── Event listeners (DOM-compatible) ──

  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.inputListeners.has(type)) this.inputListeners.set(type, new Set());
    this.inputListeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.inputListeners.get(type)?.delete(listener);
  }

  private dispatchInputEvent(type: string, event: any): void {
    const set = this.inputListeners.get(type);
    if (set) {
      for (const listener of set) {
        try { listener(event); } catch (e) { console.error("[NativeWindow] Input listener error:", e); }
      }
    }
  }

  // ── Event loop ──

  start(): void {
    this.running = true;
    this.runLoop();
  }

  stop(): void {
    this.running = false;
  }

  grabInput(grab: boolean): void {
    sdl.sdl_shim_grab_input(grab ? 1 : 0);
  }

  /** Enable SDL text input (for the console REPL). */
  startTextInput(): void {
    sdl.sdl_shim_start_text_input();
  }

  /** Disable SDL text input. */
  stopTextInput(): void {
    sdl.sdl_shim_stop_text_input();
  }

  /** Set the text input rect (for IME candidate window positioning). */
  setTextInputRect(x: number, y: number, w: number, h: number): void {
    sdl.sdl_shim_set_text_input_rect(x, y, w, h);
  }

  private runLoop(): void {
    if (!this.running) return;

    // Poll SDL events
    const eventData = new ArrayBuffer(64);
    const eventView = new Int32Array(eventData);
    const floatView = new Float32Array(eventData);

    let eventType: number;
    do {
      eventType = sdl.sdl_shim_poll_event(eventData as any);
      if (eventType !== SDL_EVENT_NONE) {
        this.handleEvent(eventType, eventView, floatView);
      }
    } while (eventType !== SDL_EVENT_NONE);

    // Dispatch rAF callbacks
    const now = performance.now() - this.startTime;
    const callbacks = Array.from(this.rafCallbacks);
    this.rafCallbacks.clear();
    for (const cb of callbacks) {
      try { cb(now); } catch (e) { console.error("[NativeWindow] rAF callback error:", e); }
    }

    // Process wgpu events (for async callback delivery)
    const instancePtr = (globalThis as any).__wgpuInstancePtr ?? 0;
    if (instancePtr) {
      wgpu.wgpu_shim_process_events(instancePtr);
    }

    // Schedule next frame
    setImmediate(() => this.runLoop());
  }

  private handleEvent(eventType: number, eventView: Int32Array, floatView: Float32Array): void {
    switch (eventType) {
      case SDL_EVENT_NONE:
        break;

      case SDL_EVENT_QUIT:
        this.running = false;
        this.dispatchInputEvent("close", { type: "close" });
        break;

      case SDL_EVENT_KEY_DOWN: {
        const keycode = eventView[0];
        const repeat = this.pressedKeys.has(keycode);
        this.pressedKeys.add(keycode);
        const domKeyCode = sdlToDomKeyCode(keycode);
        this.dispatchInputEvent("keydown", {
          type: "keydown",
          keyCode: domKeyCode,
          key: sdlKeyToKey(keycode),
          code: sdlKeyToCode(keycode),
          repeat,
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_KEY_UP: {
        const keycode = eventView[0];
        this.pressedKeys.delete(keycode);
        const domKeyCode = sdlToDomKeyCode(keycode);
        this.dispatchInputEvent("keyup", {
          type: "keyup",
          keyCode: domKeyCode,
          key: sdlKeyToKey(keycode),
          code: sdlKeyToCode(keycode),
          repeat: false,
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_MOUSE_MOVE: {
        const x = eventView[0];
        const y = eventView[1];
        const xrel = eventView[2];
        const yrel = eventView[3];
        this.dispatchInputEvent("mousemove", {
          type: "mousemove",
          clientX: x,
          clientY: y,
          movementX: xrel,
          movementY: yrel,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_MOUSE_DOWN: {
        const x = eventView[0];
        const y = eventView[1];
        const button = eventView[2];
        this.dispatchInputEvent("mousedown", {
          type: "mousedown",
          clientX: x,
          clientY: y,
          button: button - 1, // SDL: 1=left, 2=middle, 3=right → DOM: 0=left, 1=middle, 2=right
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_MOUSE_UP: {
        const x = eventView[0];
        const y = eventView[1];
        const button = eventView[2];
        this.dispatchInputEvent("mouseup", {
          type: "mouseup",
          clientX: x,
          clientY: y,
          button: button - 1,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_WHEEL: {
        const deltaX = floatView[0];
        const deltaY = floatView[1];
        this.dispatchInputEvent("wheel", {
          type: "wheel",
          deltaX,
          deltaY,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_RESIZE: {
        const width = eventView[0];
        const height = eventView[1];
        this.surface?.resize(width, height);
        this.dispatchInputEvent("resize", { type: "resize", width, height });
        break;
      }

      case SDL_EVENT_TEXT_INPUT: {
        const text = new TextDecoder().decode(new Uint8Array(eventView.buffer, 0, 32)).replace(/\0.*$/, "");
        this.dispatchInputEvent("textinput", { type: "textinput", text });
        break;
      }
    }
  }

  destroy(): void {
    this.running = false;
    sdl.sdl_shim_destroy_window();
  }
}

// ── SDL key code → DOM key mapping ──
function sdlKeyToKey(keycode: number): string {
  // SDL2 keycodes: printable chars use ASCII, special keys use 107374xxxx range.
  // But some keys (ESC=27, ENTER=13, TAB=9, BACKSPACE=8) use their ASCII values.
  if (keycode >= 32 && keycode <= 126) return String.fromCharCode(keycode);
  // Special keys — both ASCII-range and SDL scancode-based
  const map: Record<number, string> = {
    27: "Escape",             // SDLK_ESCAPE (ASCII)
    13: "Enter",              // SDLK_RETURN (ASCII)
    9: "Tab",                 // SDLK_TAB (ASCII)
    8: "Backspace",           // SDLK_BACKSPACE (ASCII)
    1073741881: "Escape",     // SDLK_ESCAPE (scancode-based, just in case)
    1073741904: "ArrowLeft",  // SDLK_LEFT
    1073741903: "ArrowRight", // SDLK_RIGHT
    1073741906: "ArrowUp",    // SDLK_UP
    1073741905: "ArrowDown",  // SDLK_DOWN
    1073741898: "Shift",      // SDLK_LSHIFT
    1073741897: "Ctrl",       // SDLK_LCTRL
    1073741899: "Alt",        // SDLK_LALT
    1073741922: "Shift",      // SDLK_RSHIFT
    1073741921: "Ctrl",       // SDLK_RCTRL
    1073741923: "Alt",        // SDLK_RALT
    1073741882: "F1",         // SDLK_F1
    1073741883: "F2",
    1073741884: "F3",
    1073741885: "F4",
    1073741886: "F5",
    1073741887: "F6",
    1073741888: "F7",
    1073741889: "F8",
    1073741890: "F9",
    1073741891: "F10",
    1073741892: "F11",
    1073741893: "F12",
  };
  return map[keycode] ?? `Unknown(${keycode})`;
}

function sdlKeyToCode(keycode: number): string {
  // SDL2 returns lowercase ASCII for letters; DOM code uses uppercase KeyX
  if (keycode >= 65 && keycode <= 90) return `Key${String.fromCharCode(keycode)}`;
  if (keycode >= 97 && keycode <= 122) return `Key${String.fromCharCode(keycode - 32)}`;
  if (keycode >= 48 && keycode <= 57) return `Digit${String.fromCharCode(keycode)}`;
  return sdlKeyToKey(keycode);
}

// Map SDL keycodes to DOM keyCode values so the engine's KEY constants work.
function sdlToDomKeyCode(keycode: number): number {
  // SDL2 returns lowercase ASCII for letter keys (a=97, w=119, etc.).
  // The engine's KEY constants use DOM keyCodes which are uppercase ASCII
  // (A=65, W=87, etc.). Convert lowercase letters to uppercase.
  if (keycode >= 97 && keycode <= 122) return keycode - 32;
  // Non-letter ASCII-range keycodes are the same in SDL and DOM
  if (keycode >= 32 && keycode <= 126) return keycode;
  // SDL scancode-based keys → DOM keyCode
  const map: Record<number, number> = {
    1073741904: 37, // ArrowLeft
    1073741903: 39, // ArrowRight
    1073741906: 38, // ArrowUp
    1073741905: 40, // ArrowDown
    1073741898: 16, // LShift
    1073741897: 17, // LCtrl
    1073741899: 18, // LAlt
    1073741922: 16, // RShift
    1073741921: 17, // RCtrl
    1073741923: 18, // RAlt
    1073741882: 112, // F1
    1073741883: 113, // F2
    1073741884: 114, // F3
    1073741885: 115, // F4
    1073741886: 116, // F5
    1073741887: 117, // F6
    1073741888: 118, // F7
    1073741889: 119, // F8
    1073741890: 120, // F9
    1073741891: 121, // F10
    1073741892: 122, // F11
    1073741893: 123, // F12
  };
  return map[keycode] ?? keycode;
}

// ── Create wgpu surface from SDL window ──
// This calls the C function in sdl_shim.c that creates a wgpu surface
// from the SDL window's native handle.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, type CFunction } from "../ffi/ffi-adapter.js";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

function findSdlShimLib(): string {
  const relativePath = join(_dirname, "..", "..", "native", "libsdl_shim.so");
  if (existsSync(relativePath)) return relativePath;
  throw new Error("libsdl_shim.so not found");
}

const { symbols: sdlSurfaceSymbols } = dlopen(findSdlShimLib(), {
  sdl_shim_create_wgpu_surface: { args: ["ptr"], returns: "ptr" } as CFunction,
});

function createWgpuSurfaceForSDLWindow(): number {
  // The wgpu instance is stored globally in wgpu_shim.c (g_instance).
  // We pass 0 as the instance pointer — the C function will use the global instance.
  // Actually, we need to pass the real instance. Let's get it from the global.
  const instance = (globalThis as any).__wgpuInstancePtr ?? 0;
  return sdlSurfaceSymbols.sdl_shim_create_wgpu_surface(instance) as unknown as number;
}
