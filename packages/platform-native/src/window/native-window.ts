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

// Chromium emits ±100px of deltaY per wheel detent in DOM_DELTA_PIXEL mode;
// SDL reports raw detents, so scale to match the DOM consumers were tuned on.
const WHEEL_PIXELS_PER_DETENT = 100;

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
      // Browser semantics: the canvas auto-presents at end of frame, after
      // the rAF callbacks AND the microtask checkpoint. Renderers driving the
      // surface through GameRenderer already call context.present() (a no-op
      // here — the texture was consumed); bespoke loops (model-viewer,
      // gpu-bench) never call it and rely on auto-present. Deferring a
      // microtask lets synchronous submits and inline promise continuations
      // land before the present; present() itself skips frames that acquired
      // nothing or acquired-but-never-wrote (__ddWritten). present() lives
      // on the webgpu context, not the canvas — getContext returns the
      // NativeCanvasContext that owns the acquired surface texture.
      const ctx = this.surface?.getContext("webgpu") as { present?: () => void } | null;
      if (ctx?.present) queueMicrotask(() => ctx.present!());
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

  /**
   * DOM-parity dispatch for pointer input: the surface is the event target
   * (canvas listeners — RendererInputBus, InputManager mouse tracking), the
   * window sees the bubbled event (window-level listeners — UI router,
   * bus key/up handlers). MiniEventTarget has no real bubbling, so we
   * dispatch the same event object to both, target first.
   */
  private dispatchInputEvent(event: any): void {
    this.surface?.dispatchEvent(event);
    this.dispatchEvent(event);
  }

  /** Fire `pointerType` then `mouseType` (DOM order), each on target+window. */
  private dispatchPointerAndMouse(pointerType: string, pointerEvent: any, mouseEvent: any): void {
    pointerEvent.type = pointerType;
    this.dispatchInputEvent(pointerEvent);
    this.dispatchInputEvent(mouseEvent);
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
        const base = {
          clientX: x,
          clientY: y,
          movementX: xrel,
          movementY: yrel,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        };
        // DOM parity: the pointer event fires first, then its compat mouse
        // event; both target the canvas and bubble to window. Engine code
        // listens on either (RendererInputBus → pointer*, InputManager →
        // mouse*), so both must exist on both targets.
        this.dispatchPointerAndMouse("pointermove", {
          ...base,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          pressure: buttons !== 0 ? 0.5 : 0,
          width: 1,
          height: 1,
        }, { ...base, type: "mousemove" });
        break;
      }

      case SDL_EVENT_MOUSE_DOWN: {
        const x = eventView[0];
        const y = eventView[1];
        const button = eventView[2];
        const buttons = sdlButtonsToDom(eventView[3]);
        const mod = eventView[4];
        const domButton = button - 1; // SDL: 1=l,2=m,3=r → DOM: 0=l,1=m,2=r
        const base = {
          clientX: x,
          clientY: y,
          button: domButton,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        };
        this.dispatchPointerAndMouse("pointerdown", {
          ...base,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0.5,
          width: 1,
          height: 1,
        }, { ...base, type: "mousedown" });
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
        const base = {
          clientX: x,
          clientY: y,
          button: button - 1,
          buttons,
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        };
        this.dispatchPointerAndMouse("pointerup", {
          ...base,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0,
          width: 1,
          height: 1,
        }, { ...base, type: "mouseup" });
        break;
      }

      case SDL_EVENT_WHEEL: {
        // SDL reports wheel movement in detents (+y = scrolled up/away);
        // DOM WheelEvent reports pixels (+deltaY = scrolled down) at ~100px
        // per detent (Chromium's convention). Flip Y and scale both axes so
        // pixel-based consumers (scroll panels, camera zoom) behave the same
        // as on the DOM path. Precise (fractional) detents come through in
        // floatView for hi-res scroll devices.
        const mod = eventView[2];
        this.dispatchInputEvent({
          type: "wheel",
          deltaX: floatView[0] * WHEEL_PIXELS_PER_DETENT,
          deltaY: -floatView[1] * WHEEL_PIXELS_PER_DETENT,
          deltaMode: 0, // DOM_DELTA_PIXEL
          clientX: eventView[3], // mouse_x/mouse_y in slots 3/4 (sdl_shim.c)
          clientY: eventView[4],
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
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

// ── SDL3 keycode → DOM KeyboardEvent mapping ──
// SDL3 keycodes: printable chars are ASCII (a-z, 0-9, punctuation, space),
// special keys are scancode | (1<<30) = 0x40000000+.
// NOTE: DOM `key`/`code`/`keyCode` are three different fields:
//   key  = "w", "Shift", "Escape"   (typed value, layout-dependent)
//   code = "KeyW", "ShiftLeft"      (physical position — what games bind on)
//   keyCode = 87, 16, 27            (deprecated numeric)
const SDL3 = 0x40000000; // SDL_SCANCODE_TO_KEYCODE base

// keycode → [domKey, domCode, domKeyCode]
const SDL_SPECIAL_KEYS: Record<number, [string, string, number]> = {
  // ASCII-range specials (keycodes 8-127 share their ASCII value)
  8:   ["Backspace", "Backspace", 8],
  9:   ["Tab", "Tab", 9],
  13:  ["Enter", "Enter", 13],
  27:  ["Escape", "Escape", 27],
  32:  [" ", "Space", 32],
  45:  ["-", "Minus", 189],
  61:  ["=", "Equal", 187],
  91:  ["[", "BracketLeft", 219],
  93:  ["]", "BracketRight", 221],
  92:  ["\\", "Backslash", 220],
  59:  [";", "Semicolon", 186],
  39:  ["'", "Quote", 222],
  96:  ["`", "Backquote", 192],
  44:  [",", "Comma", 188],
  46:  [".", "Period", 190],
  47:  ["/", "Slash", 191],
  127: ["Delete", "Delete", 46],
  // Scancode-based specials
  [SDL3 + 57]:  ["CapsLock", "CapsLock", 20],          // CAPSLOCK
  [SDL3 + 58]:  ["F1", "F1", 112],
  [SDL3 + 59]:  ["F2", "F2", 113],
  [SDL3 + 60]:  ["F3", "F3", 114],
  [SDL3 + 61]:  ["F4", "F4", 115],
  [SDL3 + 62]:  ["F5", "F5", 116],
  [SDL3 + 63]:  ["F6", "F6", 117],
  [SDL3 + 64]:  ["F7", "F7", 118],
  [SDL3 + 65]:  ["F8", "F8", 119],
  [SDL3 + 66]:  ["F9", "F9", 120],
  [SDL3 + 67]:  ["F10", "F10", 121],
  [SDL3 + 68]:  ["F11", "F11", 122],
  [SDL3 + 69]:  ["F12", "F12", 123],
  [SDL3 + 70]:  ["PrintScreen", "PrintScreen", 44],
  [SDL3 + 71]:  ["ScrollLock", "ScrollLock", 145],
  [SDL3 + 72]:  ["Pause", "Pause", 19],
  [SDL3 + 73]:  ["Insert", "Insert", 45],
  [SDL3 + 74]:  ["Home", "Home", 36],
  [SDL3 + 75]:  ["PageUp", "PageUp", 33],
  [SDL3 + 77]:  ["End", "End", 35],
  [SDL3 + 78]:  ["PageDown", "PageDown", 34],
  [SDL3 + 79]:  ["ArrowRight", "ArrowRight", 39],
  [SDL3 + 80]:  ["ArrowLeft", "ArrowLeft", 37],
  [SDL3 + 81]:  ["ArrowDown", "ArrowDown", 40],
  [SDL3 + 82]:  ["ArrowUp", "ArrowUp", 38],
  // Numpad
  [SDL3 + 83]:  ["NumLock", "NumLock", 144],
  [SDL3 + 84]:  ["/", "NumpadDivide", 111],
  [SDL3 + 85]:  ["*", "NumpadMultiply", 106],
  [SDL3 + 86]:  ["-", "NumpadSubtract", 109],
  [SDL3 + 87]:  ["+", "NumpadAdd", 107],
  [SDL3 + 88]:  ["Enter", "NumpadEnter", 13],
  [SDL3 + 89]:  ["1", "Numpad1", 97],
  [SDL3 + 90]:  ["2", "Numpad2", 98],
  [SDL3 + 91]:  ["3", "Numpad3", 99],
  [SDL3 + 92]:  ["4", "Numpad4", 100],
  [SDL3 + 93]:  ["5", "Numpad5", 101],
  [SDL3 + 94]:  ["6", "Numpad6", 102],
  [SDL3 + 95]:  ["7", "Numpad7", 103],
  [SDL3 + 96]:  ["8", "Numpad8", 104],
  [SDL3 + 97]:  ["9", "Numpad9", 105],
  [SDL3 + 98]:  ["0", "Numpad0", 96],
  [SDL3 + 99]:  [".", "NumpadDecimal", 110],
  // Modifiers — SDL3 modifier keycodes live at 0x400000E0+, NOT 0x40000049+
  // (0x40000049-0x4000004E are Insert/Home/PageUp/End/PageDown).
  [SDL3 + 224]: ["Control", "ControlLeft", 17],
  [SDL3 + 225]: ["Shift", "ShiftLeft", 16],
  [SDL3 + 226]: ["Alt", "AltLeft", 18],
  [SDL3 + 227]: ["Meta", "MetaLeft", 91],
  [SDL3 + 228]: ["Control", "ControlRight", 17],
  [SDL3 + 229]: ["Shift", "ShiftRight", 16],
  [SDL3 + 230]: ["Alt", "AltRight", 18],
  [SDL3 + 231]: ["Meta", "MetaRight", 91],
};

function sdlKeyToKey(keycode: number): string {
  if (keycode >= 32 && keycode <= 126 && !SDL_SPECIAL_KEYS[keycode]) {
    return String.fromCharCode(keycode);
  }
  return SDL_SPECIAL_KEYS[keycode]?.[0] ?? `Unknown(${keycode})`;
}

function sdlKeyToCode(keycode: number): string {
  // Letters: SDL is lowercase ASCII, DOM code is uppercase KeyX
  if (keycode >= 65 && keycode <= 90) return `Key${String.fromCharCode(keycode)}`;
  if (keycode >= 97 && keycode <= 122) return `Key${String.fromCharCode(keycode - 32)}`;
  if (keycode >= 48 && keycode <= 57) return `Digit${String.fromCharCode(keycode)}`;
  return SDL_SPECIAL_KEYS[keycode]?.[1] ?? sdlKeyToKey(keycode);
}

// Map SDL keycodes to DOM keyCode values so the engine's KEY constants work.
function sdlToDomKeyCode(keycode: number): number {
  if (keycode >= 97 && keycode <= 122) return keycode - 32; // lowercase → uppercase
  if (keycode >= 32 && keycode <= 126 && !SDL_SPECIAL_KEYS[keycode]) return keycode;
  return SDL_SPECIAL_KEYS[keycode]?.[2] ?? keycode;
}
