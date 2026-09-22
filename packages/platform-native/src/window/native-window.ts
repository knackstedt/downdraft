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

import { MiniEventTarget } from "../dom/mini-event-target";
import { wgpu } from "../gpu/wgpu-ffi";
import { NativeSurface } from "./native-surface";
import {
    KMOD_ALT,
    KMOD_CTRL,
    KMOD_GUI,
    KMOD_SHIFT,
    sdl,
    SDL_EVENT_DROP_FILE,
    SDL_EVENT_FOCUS_GAINED,
    SDL_EVENT_FOCUS_LOST,
    SDL_EVENT_KEY_DOWN,
    SDL_EVENT_KEY_UP,
    SDL_EVENT_MOUSE_DOWN,
    SDL_EVENT_MOUSE_MOVE,
    SDL_EVENT_MOUSE_UP,
    SDL_EVENT_MOVED,
    SDL_EVENT_NONE,
    SDL_EVENT_QUIT,
    SDL_EVENT_RESIZE,
    SDL_EVENT_TEXT_INPUT,
    SDL_EVENT_WHEEL,
    sdlButtonsToDom,
} from "./sdl-ffi";

export interface NativeWindowConfig {
  title: string;
  width: number;
  height: number;
  resizable?: boolean;
}

type RAFCallback = (time: number) => void;

// setImmediate is Node/Bun-only — Deno and browser-likes use setTimeout(0).
const scheduleImmediate: (fn: () => void) => void =
  typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);

export class NativeWindow extends MiniEventTarget {
  private surface: NativeSurface | null = null;
  // rAF handles: unique IDs → callbacks. The previous implementation used a
  // Set and returned Set.size as the "id", so ids collided and
  // cancelAnimationFrame was a documented no-op.
  private rafCallbacks: Map<number, RAFCallback> = new Map();
  private nextRafId = 1;
  private running: boolean = false;
  private startTime: number = 0;
  private surfacePtr: number = 0;
  private pressedKeys = new Set<number>();
  // SDL event read buffer — hoisted out of the loop so we don't allocate a
  // new ArrayBuffer every frame.
  private eventData = new ArrayBuffer(64);
  private eventView = new Int32Array(this.eventData);
  private eventFloatView = new Float32Array(this.eventData);

  constructor(config: NativeWindowConfig) {
    super();
    // 1. Create SDL2 window
    const result = sdl.sdl_shim_create_window(config.title, config.width, config.height);
    if (result !== 0) {
      throw new Error(`Failed to create SDL2 window (error ${result})`);
    }

    // 2. Create wgpu surface from the window.
    // The instance ptr is published by installGPU() on the global object.
    const instance = (globalThis as any).__wgpuInstancePtr ?? 0;
    this.surfacePtr = sdl.sdl_shim_create_wgpu_surface(instance) as unknown as number;
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
    const id = this.nextRafId++;
    this.rafCallbacks.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.rafCallbacks.delete(id);
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

  /** Toggle borderless-desktop fullscreen. */
  setFullscreen(enabled: boolean): void {
    sdl.sdl_shim_set_fullscreen(enabled ? 1 : 0);
  }

  /** Window position in screen coordinates. */
  getWindowPos(): { x: number; y: number } {
    const out = new Int32Array(2);
    sdl.sdl_shim_get_window_pos(out.subarray(0, 1) as any, out.subarray(1, 2) as any);
    return { x: out[0]!, y: out[1]! };
  }

  setWindowPos(x: number, y: number): void {
    sdl.sdl_shim_set_window_pos(x, y);
  }

  /** Window size in pixels. */
  getWindowSize(): { width: number; height: number } {
    const out = new Int32Array(2);
    sdl.sdl_shim_get_window_size(out.subarray(0, 1) as any, out.subarray(1, 2) as any);
    return { width: out[0]!, height: out[1]! };
  }

  setWindowSize(width: number, height: number): void {
    sdl.sdl_shim_set_window_size(width, height);
  }

  /** Refresh rate (Hz) and content scale factor of the display the window is on. */
  getDisplayInfo(): { refreshRate: number; scaleFactor: number } {
    const refresh = new Int32Array(1);
    const scale = new Float32Array(1);
    sdl.sdl_shim_get_display_info(refresh as any, scale as any);
    return { refreshRate: refresh[0] ?? 0, scaleFactor: scale[0] ?? 1.0 };
  }

  /** Push SDL_QUIT so the event loop exits through the normal close path. */
  requestQuit(): void {
    sdl.sdl_shim_request_quit();
  }

  /** Modal error dialog. */
  showMessageBox(title: string, message: string): void {
    sdl.sdl_shim_show_message_box(title, message);
  }

  setClipboardText(text: string): void {
    sdl.sdl_shim_set_clipboard(text);
  }

  getClipboardText(): string {
    const buf = new Uint8Array(4096);
    const len = sdl.sdl_shim_get_clipboard(buf as any, buf.length);
    if (len <= 0) return "";
    return new TextDecoder().decode(buf.subarray(0, Math.min(len, buf.length - 1)));
  }

  private runLoop(): void {
    if (!this.running) return;

    // Poll SDL events until the queue is drained.
    let eventType: number;
    let sawEvent = false;
    do {
      eventType = sdl.sdl_shim_poll_event(this.eventData as any);
      if (eventType !== SDL_EVENT_NONE) {
        sawEvent = true;
        this.handleEvent(eventType, this.eventView, this.eventFloatView);
      }
    } while (eventType !== SDL_EVENT_NONE);

    // When idle (no pending rAF work and no events just arrived), briefly
    // block on the SDL event queue instead of busy-spinning through
    // setImmediate. 4ms keeps the loop responsive while taking the thread
    // off the CPU between frames.
    if (!sawEvent && this.rafCallbacks.size === 0) {
      const wt = sdl.sdl_shim_wait_event(this.eventData as any, 4);
      if (wt !== SDL_EVENT_NONE) {
        this.handleEvent(wt, this.eventView, this.eventFloatView);
        // Drain anything that arrived behind it.
        do {
          eventType = sdl.sdl_shim_poll_event(this.eventData as any);
          if (eventType !== SDL_EVENT_NONE) {
            this.handleEvent(eventType, this.eventView, this.eventFloatView);
          }
        } while (eventType !== SDL_EVENT_NONE);
      }
    }

    // Dispatch rAF callbacks. Callbacks run once per dispatch; anything a
    // callback re-registers lands in the map for the next frame.
    const now = performance.now() - this.startTime;
    if (this.rafCallbacks.size > 0) {
      const callbacks = Array.from(this.rafCallbacks.values());
      this.rafCallbacks.clear();
      for (const cb of callbacks) {
        try { cb(now); } catch (e) { console.error("[NativeWindow] rAF callback error:", e); }
      }
    }

    // Process wgpu events (for async callback delivery)
    const instancePtr = (globalThis as any).__wgpuInstancePtr ?? 0;
    if (instancePtr) {
      wgpu.wgpu_shim_process_events(instancePtr);
    }

    // Schedule next frame
    scheduleImmediate(() => this.runLoop());
  }

  private modifiers(mod: number) {
    return {
      shiftKey: (mod & KMOD_SHIFT) !== 0,
      ctrlKey: (mod & KMOD_CTRL) !== 0,
      altKey: (mod & KMOD_ALT) !== 0,
      metaKey: (mod & KMOD_GUI) !== 0,
    };
  }

  private handleEvent(eventType: number, eventView: Int32Array, floatView: Float32Array): void {
    switch (eventType) {
      case SDL_EVENT_NONE:
        break;

      case SDL_EVENT_QUIT:
        this.running = false;
        this.dispatchEvent({ type: "close" });
        break;

      case SDL_EVENT_FOCUS_LOST:
        // Clear pressed-key tracking so keys don't get "stuck" when focus is
        // lost mid-press, and notify listeners (DOM "blur").
        this.pressedKeys.clear();
        this.dispatchEvent({ type: "blur" });
        break;

      case SDL_EVENT_FOCUS_GAINED:
        this.dispatchEvent({ type: "focus" });
        break;

      case SDL_EVENT_MOVED:
        this.dispatchEvent({ type: "moved", x: eventView[0], y: eventView[1] });
        break;

      case SDL_EVENT_DROP_FILE: {
        const path = new TextDecoder().decode(new Uint8Array(this.eventData)).replace(/\0.*$/, "");
        if (path) this.dispatchEvent({ type: "dropfile", path });
        break;
      }

      case SDL_EVENT_KEY_DOWN: {
        const keycode = eventView[0];
        const mod = eventView[1];
        // Prefer the shim's repeat flag; fall back to our pressed-key set for
        // drivers that don't report it.
        const repeat = eventView[2] !== 0 || this.pressedKeys.has(keycode);
        this.pressedKeys.add(keycode);
        const domKeyCode = sdlToDomKeyCode(keycode);
        this.dispatchEvent({
          type: "keydown",
          keyCode: domKeyCode,
          key: sdlKeyToKey(keycode),
          code: sdlKeyToCode(keycode),
          repeat,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_KEY_UP: {
        const keycode = eventView[0];
        const mod = eventView[1];
        this.pressedKeys.delete(keycode);
        const domKeyCode = sdlToDomKeyCode(keycode);
        this.dispatchEvent({
          type: "keyup",
          keyCode: domKeyCode,
          key: sdlKeyToKey(keycode),
          code: sdlKeyToCode(keycode),
          repeat: false,
          ...this.modifiers(mod),
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
        const buttons = sdlButtonsToDom(eventView[4]);
        const mod = eventView[5];
        this.dispatchEvent({
          type: "mousemove",
          clientX: x,
          clientY: y,
          movementX: xrel,
          movementY: yrel,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_MOUSE_DOWN: {
        const x = eventView[0];
        const y = eventView[1];
        const button = eventView[2];
        const buttons = sdlButtonsToDom(eventView[3]);
        const mod = eventView[4];
        const domButton = button - 1; // SDL: 1=l,2=m,3=r → DOM: 0=l,1=m,2=r
        this.dispatchEvent({
          type: "mousedown",
          clientX: x,
          clientY: y,
          button: domButton,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        // DOM dispatches "contextmenu" on right-button press.
        if (domButton === 2) {
          this.dispatchEvent({
            type: "contextmenu",
            clientX: x,
            clientY: y,
            button: domButton,
            buttons,
            ...this.modifiers(mod),
            preventDefault: () => {},
            stopPropagation: () => {},
          });
        }
        break;
      }

      case SDL_EVENT_MOUSE_UP: {
        const x = eventView[0];
        const y = eventView[1];
        const button = eventView[2];
        const buttons = sdlButtonsToDom(eventView[3]);
        const mod = eventView[4];
        this.dispatchEvent({
          type: "mouseup",
          clientX: x,
          clientY: y,
          button: button - 1,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_WHEEL: {
        const deltaX = floatView[0];
        const deltaY = floatView[1];
        const mod = eventView[2];
        this.dispatchEvent({
          type: "wheel",
          deltaX,
          deltaY,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_RESIZE: {
        const width = eventView[0];
        const height = eventView[1];
        this.surface?.resize(width, height);
        this.dispatchEvent({ type: "resize", width, height });
        break;
      }

      case SDL_EVENT_TEXT_INPUT: {
        const text = new TextDecoder().decode(new Uint8Array(this.eventData, 0, 32)).replace(/\0.*$/, "");
        this.dispatchEvent({ type: "textinput", text });
        break;
      }
    }
  }

  destroy(): void {
    this.running = false;
    // Unconfigure then release the wgpu surface before destroying the
    // window — the surface holds a reference to the native window handle.
    try { this.surface?.getContext("webgpu")?.unconfigure(); } catch { /* best-effort */ }
    if (this.surfacePtr) {
      try { wgpu.wgpu_shim_release_surface(this.surfacePtr); } catch { /* best-effort */ }
      this.surfacePtr = 0;
    }
    this.surface = null;
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
