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

import { createLogger } from "@downdraft/engine/util/logger";
import { MiniEventTarget } from "../dom/mini-event-target";
import type { ptr } from "../ffi/ffi-adapter";
import { pollLiveDevicesLost } from "../gpu/wgpu-device";
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
    SDL_EVENT_RESUMED,
    SDL_EVENT_SCALE_CHANGED,
    SDL_EVENT_SUSPENDED,
    SDL_EVENT_TEXT_INPUT,
    SDL_EVENT_TOUCH,
    SDL_EVENT_WHEEL,
    sdlButtonsToDom
} from "./sdl-ffi";

const log = createLogger("info");

// Embedded-node-mobile builds report process.platform === "android". On
// Android the window is created by the app thread's winit loop — async from
// this thread's perspective — and can be destroyed/recreated by the OS at
// suspend/resume boundaries.
const IS_ANDROID = process.platform === "android";

// Touch events synthesize pointer events with ids in a dedicated range so
// they can never collide with the synthetic mouse pointerId (1).
const TOUCH_POINTER_BASE = 1000;

export interface NativeWindowConfig {
  title: string;
  width: number;
  height: number;
  resizable?: boolean;
}

type RAFCallback = (time: number) => void;

// setImmediate is Node/Bun-only — Deno and browser-likes use setTimeout(0).
// Under the dev shell the session tracker wraps the global timers and
// cancels session-owned handles on restart; the run loop is host-internal
// and must keep scheduling across session restarts, so it goes through the
// tracker's untracked channel whenever a tracker is installed.
const scheduleImmediate: (fn: () => void) => void = (fn) => {
  const tracker = (globalThis as any).__ddSession;
  if (typeof tracker?.untrackedImmediate === "function") {
    tracker.untrackedImmediate(fn);
    return;
  }
  if (typeof setImmediate === "function") setImmediate(fn);
  else setTimeout(fn, 0);
};

// DOM wheel events report ±100px of deltaY per detent in pixel mode;
// SDL reports raw detents, so scale to match what DOM consumers expect.
const WHEEL_PIXELS_PER_DETENT = 100;

// rAF dispatches may fire up to this much early — absorbs sub-ms timing noise
// so a frame whose acquire blocked ~one vsync isn't double-parked by the
// pacing check.
const RAF_DISPATCH_EPSILON_MS = 0.5;

export class NativeWindow extends MiniEventTarget {
  private surface: NativeSurface | null = null;
  // rAF handles: unique IDs → callbacks. The previous implementation used a
  // Set and returned Set.size as the "id", so ids collided and
  // cancelAnimationFrame was a documented no-op.
  private rafCallbacks: Map<number, RAFCallback> = new Map();
  private nextRafId = 1;
  private running: boolean = false;
  private startTime: number = 0;
  private surfacePtr: ptr = 0;
  // rAF dispatch pacing. Browsers fire rAF at most once per vsync; the native
  // pump otherwise runs at event-loop speed whenever no callback blocks
  // inside getCurrentTexture() — e.g. dirty-tracked frames that skip draws,
  // one-shot renderers, or an acquired-but-unwritten texture left cached.
  // The render loop then free-runs (~1100 "fps" on a 360Hz panel) and burns
  // a core. lastRafDispatch timestamps the previous dispatch; frameIntervalMs
  // is derived from the display's refresh rate (re-queried on window moves).
  private lastRafDispatch = -1e9;
  private loggedFirstRaf = false;
  private frameIntervalMs = 0;
  private pressedKeys = new Set<number>();
  // SDL event read buffer — hoisted out of the loop so we don't allocate a
  // new ArrayBuffer every frame.
  private eventData = new ArrayBuffer(64);
  private eventView = new Int32Array(this.eventData);
  private eventFloatView = new Float32Array(this.eventData);
  // Latest window resize, coalesced — SDL emits one event per pixel during a
  // drag (and a burst on maximize); only the newest dims are applied, once
  // per loop iteration, so listeners + the surface see a single resize.
  private pendingResize: { width: number; height: number } | null = null;
  // Click synthesis — SDL reports raw button transitions only; DOM click /
  // dblclick (which games gate pointer lock and UI activation on) are
  // derived here: a mouseup matching the last mousedown's button fires click.
  private lastMouseDown: { button: number } | null = null;
  private lastClickAt = -1e9;
  private lastClickButton = -1;
  private lastClickX = -1;
  private lastClickY = -1;
  private clickCount = 0;
  // Focus-click suppression: on X11 a click that raises/focuses an unfocused
  // window is still delivered to it as a normal press+release, so the
  // synthesized "click" would fire pointer-lock / UI-activation handlers for
  // what the user meant as pure window activation (e.g. launching the game
  // and clicking the new window to focus it locks the pointer instantly).
  // Any click completing within this window of a Focused(true) is treated as
  // the focus click and its click/dblclick synthesis is skipped — the press
  // and release events themselves still flow through.
  private focusGainedAt = -1e9;
  private static readonly FOCUS_CLICK_SUPPRESS_MS = 250;
  // Boot splash (SplashScreen) — covers the window with a procedural spinner
  // from host creation until the game's render loop registers its first rAF
  // callback (detected in requestAnimationFrame below).
  private splash: { tick: RAFCallback; stop(): void } | null = null;

  // Touch: id of the pointer currently treated as primary (first active
  // contact) — DOM compat mouse events are synthesized only for it.
  private primaryTouchId: number | null = null;
  // Set on SDL_EVENT_SUSPENDED, cleared on RESUMED — gates the resume path's
  // surface recreation.
  private surfaceSuspended = false;

  constructor(config: NativeWindowConfig) {
    super();
    // 1. Create SDL2 window
    const result = sdl.sdl_shim_create_window(config.title, config.width, config.height);
    if (result !== 0) {
      throw new Error(`Failed to create SDL2 window (error ${result})`);
    }

    // Android: create_window only *records* the request — the app thread's
    // winit loop creates the Window when resumed() lands (which may have
    // happened before we even started). Block here until the RESUMED wire
    // event arrives, then the real surface exists for step 2.
    if (IS_ANDROID) {
      this.waitForAndroidResume();
      // The requested dims are advisory — adopt the actual window size.
      const sz = this.getWindowSize();
      if (sz.width > 0 && sz.height > 0) {
        config.width = sz.width;
        config.height = sz.height;
      }
    }

    // 2. Create wgpu surface from the window.
    // The instance ptr is published by installGPU() on the global object.
    const instance = (globalThis as any).__wgpuInstancePtr ?? 0;
    this.surfacePtr = sdl.sdl_shim_create_wgpu_surface(instance) as unknown as number;
    if (!this.surfacePtr) {
      throw new Error("Failed to create wgpu surface from SDL2 window");
    }

    // 3. Create NativeSurface — the scale-factor getter feeds its CSS-px
    //    clientWidth/clientHeight (the window polyfill doesn't exist yet).
    this.surface = new NativeSurface(
      config.width, config.height, this.surfacePtr,
      () => this.getDisplayInfo().scaleFactor,
    );
    this.startTime = performance.now();
  }

  /**
   * Block until the Android winit loop reports RESUMED (window created).
   * Non-RESUMED events can only be pre-window noise — dropped. Bounded so a
   * wedged surface handshake throws instead of hanging startup forever.
   */
  private waitForAndroidResume(): void {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const t = sdl.sdl_shim_wait_event(this.eventData as any, 500);
      if (t === SDL_EVENT_RESUMED) {
        this.surfaceSuspended = false;
        return;
      }
    }
    throw new Error("Timed out waiting for Android window resume (30s)");
  }

  getSurface(): NativeSurface {
    if (!this.surface) throw new Error("Window not initialized");
    return this.surface;
  }

  // ── requestAnimationFrame ──

  /** Attach the boot splash. It runs until the first rAF callback that is
   *  not its own tick registers — i.e. the game's render loop starting. */
  attachSplash(splash: { tick: RAFCallback; start(): void; stop(): void }): void {
    this.splash?.stop();
    this.splash = splash;
    splash.start();
  }

  requestAnimationFrame(callback: RAFCallback): number {
    if (this.splash && callback !== this.splash.tick) {
      this.splash.stop();
      this.splash = null;
    }
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

  /** Frame border sizes ({top,left,bottom,right}); null when the WM hasn't
   *  framed the window yet or doesn't report extents (Wayland). */
  getWindowBorders(): { top: number; left: number; bottom: number; right: number } | null {
    const out = new Int32Array(4);
    const rc = sdl.sdl_shim_get_window_borders(
      out.subarray(0, 1) as any, out.subarray(1, 2) as any,
      out.subarray(2, 3) as any, out.subarray(3, 4) as any);
    if (rc !== 0) return null;
    return { top: out[0]!, left: out[1]!, bottom: out[2]!, right: out[3]! };
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

  /**
   * Minimum milliseconds between rAF dispatches — the display's refresh
   * interval. Late-initialized so a failed display-info query falls back to
   * 60Hz; reset on window moves (the window may land on a different monitor).
   */
  private frameInterval(): number {
    if (this.frameIntervalMs <= 0) {
      const hz = this.getDisplayInfo().refreshRate;
      this.frameIntervalMs = 1000 / (hz > 0 ? hz : 60);
    }
    return this.frameIntervalMs;
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
        this.safeHandleEvent(eventType, this.eventView, this.eventFloatView);
      }
    } while (eventType !== SDL_EVENT_NONE);

    // Wait on the SDL event queue instead of busy-spinning through
    // setImmediate whenever this iteration has no due work:
    //   - no rAF pending → the original 4ms idle poll;
    //   - rAF pending but the frame interval hasn't elapsed → sleep the
    //     remainder of the interval, capped at 4ms so JS timers and the MCP
    //     server stay responsive between frames.
    if (!sawEvent) {
      let waitMs = 4;
      if (this.rafCallbacks.size > 0) {
        const remain = this.lastRafDispatch + this.frameInterval() - (performance.now() - this.startTime);
        // floor() — never overshoot the deadline. The remaining sub-ms tail
        // is absorbed by the setImmediate loop re-checking the dispatch gate.
        waitMs = remain > RAF_DISPATCH_EPSILON_MS ? Math.min(4, Math.floor(remain)) : 0;
      }
      if (waitMs > 0) {
        const wt = sdl.sdl_shim_wait_event(this.eventData as any, waitMs);
        if (wt !== SDL_EVENT_NONE) {
          this.safeHandleEvent(wt, this.eventView, this.eventFloatView);
          // Drain anything that arrived behind it.
          do {
            eventType = sdl.sdl_shim_poll_event(this.eventData as any);
            if (eventType !== SDL_EVENT_NONE) {
              this.safeHandleEvent(eventType, this.eventView, this.eventFloatView);
            }
          } while (eventType !== SDL_EVENT_NONE);
        }
      }
    }

    // Apply the newest pending resize once — never mid-event-drain, so the
    // surface and window listeners observe a single coherent resize per
    // iteration instead of the raw SDL event storm.
    this.flushPendingResize();

    // Dispatch rAF callbacks — at most once per refresh interval (see
    // frameInterval). Callbacks run once per dispatch; anything a callback
    // re-registers lands in the map for the next frame. On Android the
    // surface is dead while suspended — the window stays "open" logically,
    // but frames can't acquire; hold the callbacks until RESUMED rebinds it
    // rather than letting them fault on a stale swapchain.
    const now = performance.now() - this.startTime;
    if (!this.surfaceSuspended && this.rafCallbacks.size > 0 && now - this.lastRafDispatch >= this.frameInterval() - RAF_DISPATCH_EPSILON_MS) {
      // Advance on a fixed grid so sleep/timer jitter doesn't accumulate
      // drift; if we fell more than a frame behind (startup, a long frame,
      // a stall) reset the phase instead of bursting catch-up dispatches.
      this.lastRafDispatch += this.frameInterval();
      if (now - this.lastRafDispatch >= this.frameInterval()) this.lastRafDispatch = now;
      const callbacks = Array.from(this.rafCallbacks.values());
      this.rafCallbacks.clear();
      if (!this.loggedFirstRaf) {
        this.loggedFirstRaf = true;
        log.info("NativeWindow", `first rAF dispatch — ${callbacks.length} callback(s)`);
      }
      callbacks.forEach((cb) => {
        try { cb(now); } catch (e) { log.error("NativeWindow", `rAF callback error: ${e}`); }
      });
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

    // Process wgpu events (for async callback delivery), then poll the
    // device-lost flag on every live device — this is what resolves
    // GPUDevice.lost on native (GameRenderer recovery hooks off that).
    const instancePtr = (globalThis as any).__wgpuInstancePtr ?? 0;
    if (instancePtr) {
      wgpu.wgpu_shim_process_events(instancePtr);
    }
    try { pollLiveDevicesLost(); } catch { /* poll is best-effort */ }

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
    // MiniEventTarget sets __miniStop when a surface listener calls
    // stopPropagation — skip the window dispatch (DOM bubble semantics).
    if (!event?.__miniStop) this.dispatchEvent(event);
  }

  /** Fire `pointerType` then `mouseType` (DOM order), each on target+window. */
  private dispatchPointerAndMouse(pointerType: string, pointerEvent: any, mouseEvent: any): void {
    pointerEvent.type = pointerType;
    this.dispatchInputEvent(pointerEvent);
    this.dispatchInputEvent(mouseEvent);
  }

  /** Physical-px → canvas coordinate space (backing-buffer px). Input
   *  arrives in window physical px; UI hit-testing/compositing run in
   *  buffer px, which differ when buffer < physical (Android dpr cap). */
  private mapX(x: number): number { return this.surface ? this.surface.toBufferX(x) : x; }
  private mapY(y: number): number { return this.surface ? this.surface.toBufferY(y) : y; }

  /** Apply the newest coalesced resize (see pendingResize). */
  private flushPendingResize(): void {
    const r = this.pendingResize;
    this.pendingResize = null;
    if (!r || !this.running) return;
    try {
      this.surface?.resize(r.width, r.height);
      this.dispatchEvent({ type: "resize", width: r.width, height: r.height });
    } catch (e) {
      log.error("NativeWindow", `resize failed (${r.width}x${r.height}): ${e}`);
    }
  }

  /** Dispatch one SDL event; a throwing handler must not kill the loop —
   *  without this, a single bad event strands the whole window frozen. */
  private safeHandleEvent(eventType: number, eventView: Int32Array, floatView: Float32Array): void {
    try {
      this.handleEvent(eventType, eventView, floatView);
    } catch (e) {
      log.error("NativeWindow", `event ${eventType} handler error: ${e}`);
    }
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
        this.focusGainedAt = performance.now();
        this.dispatchEvent({ type: "focus" });
        break;

      case SDL_EVENT_MOVED:
        // The window may have landed on a different monitor — re-query the
        // refresh rate the rAF pacing interval is derived from.
        this.frameIntervalMs = 0;
        this.dispatchEvent({ type: "moved", x: eventView[0], y: eventView[1] });
        break;

      case SDL_EVENT_SCALE_CHANGED:
        // DPI scale changed (OS scale setting or monitor crossing).
        this.dispatchEvent({ type: "scale-changed", scaleFactor: floatView[0] });
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
        const x = this.mapX(eventView[0]);
        const y = this.mapY(eventView[1]);
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
        const x = this.mapX(eventView[0]);
        const y = this.mapY(eventView[1]);
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
        this.lastMouseDown = { button: domButton };
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
        const x = this.mapX(eventView[0]);
        const y = this.mapY(eventView[1]);
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
        // DOM parity: mouseup after a mousedown on the same button fires a
        // "click" on the common target (always the canvas here — the surface
        // is the only pointer target), and a second click within 500ms at
        // ~the same spot fires "dblclick". Without this, listeners that gate
        // pointer lock / UI activation on click never run.
        // The press that (re)focused the window doesn't count — otherwise
        // focusing the game window with a click would immediately lock the
        // pointer / activate whatever UI sits under the cursor.
        const isFocusClick = performance.now() - this.focusGainedAt < NativeWindow.FOCUS_CLICK_SUPPRESS_MS;
        if (this.lastMouseDown?.button === base.button && !isFocusClick) {
          const now = performance.now();
          if (
            base.button === this.lastClickButton
            && now - this.lastClickAt < 500
            && Math.abs(x - this.lastClickX) < 5
            && Math.abs(y - this.lastClickY) < 5
          ) {
            this.clickCount++;
          } else {
            this.clickCount = 1;
          }
          this.lastClickAt = now;
          this.lastClickButton = base.button;
          this.lastClickX = x;
          this.lastClickY = y;
          this.dispatchInputEvent({ ...base, type: "click", detail: this.clickCount });
          if (this.clickCount === 2) {
            this.dispatchInputEvent({ ...base, type: "dblclick", detail: this.clickCount });
          }
        }
        this.lastMouseDown = null;
        break;
      }

      case SDL_EVENT_WHEEL: {
        // SDL reports wheel movement in detents (+y = scrolled up/away);
        // DOM WheelEvent reports pixels (+deltaY = scrolled down) at ~100px
        // per detent. Flip Y and scale both axes so
        // pixel-based consumers (scroll panels, camera zoom) behave the same
        // as on the DOM path. Precise (fractional) detents come through in
        // floatView for hi-res scroll devices.
        const mod = eventView[2];
        this.dispatchInputEvent({
          type: "wheel",
          deltaX: floatView[0] * WHEEL_PIXELS_PER_DETENT,
          deltaY: -floatView[1] * WHEEL_PIXELS_PER_DETENT,
          deltaMode: 0, // DOM_DELTA_PIXEL
          clientX: this.mapX(eventView[3]), // mouse_x/mouse_y in slots 3/4 (native-rs/src/window/events.rs)
          clientY: this.mapY(eventView[4]),
          ...this.modifiers(mod),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        });
        break;
      }

      case SDL_EVENT_RESIZE:
        // Coalesced — applied once per loop iteration by flushPendingResize().
        this.pendingResize = { width: eventView[0], height: eventView[1] };
        break;

      case SDL_EVENT_TEXT_INPUT: {
        const text = new TextDecoder().decode(new Uint8Array(this.eventData, 0, 32)).replace(/\0.*$/, "");
        this.dispatchEvent({ type: "textinput", text });
        break;
      }

      case SDL_EVENT_TOUCH: {
        // Wire slots: [phase, x, y, id] — phase 0=down 1=move 2=up 3=cancel.
        const phase = eventView[0];
        const x = this.mapX(eventView[1]);
        const y = this.mapY(eventView[2]);
        const id = eventView[3];
        const type = phase === 0 ? "pointerdown"
          : phase === 1 ? "pointermove"
          : phase === 2 ? "pointerup"
          : "pointercancel";
        if (phase === 0 && this.primaryTouchId === null) this.primaryTouchId = id;
        const isPrimary = this.primaryTouchId === id;
        const down = phase === 0 || phase === 1;
        const base = {
          clientX: x,
          clientY: y,
          button: 0,
          buttons: down ? 1 : 0,
          ...this.modifiers(0),
          preventDefault: () => {},
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        };
        this.dispatchInputEvent({
          ...base,
          type,
          pointerId: TOUCH_POINTER_BASE + id,
          pointerType: "touch",
          isPrimary,
          pressure: down ? 0.5 : 0,
          width: 1,
          height: 1,
        });
        // DOM parity: the primary touch also fires compat mouse events —
        // engine input paths (InputManager, ui drag) listen on mouse events
        // and must keep working on touch-only devices.
        if (isPrimary && phase !== 3) {
          const mouseType = phase === 0 ? "mousedown" : phase === 1 ? "mousemove" : "mouseup";
          this.dispatchInputEvent({ ...base, type: mouseType });
          if (phase === 0) this.lastMouseDown = { button: 0 };
          if (phase === 2 && this.lastMouseDown) {
            this.dispatchInputEvent({ ...base, type: "click", detail: 1 });
            this.lastMouseDown = null;
          }
        }
        if ((phase === 2 || phase === 3) && isPrimary) this.primaryTouchId = null;
        break;
      }

      case SDL_EVENT_SUSPENDED: {
        // The OS destroyed the ANativeWindow — the wgpu surface is already
        // dead on the Rust side (CTX.window dropped first). Unconfigure +
        // release at the FFI level only: the context keeps its cached
        // device/format so RESUMED can reconfigure the fresh surface without
        // renderer involvement.
        if (this.surfacePtr) {
          try { wgpu.wgpu_shim_surface_unconfigure(this.surfacePtr); } catch { /* best-effort */ }
          try { wgpu.wgpu_shim_release_surface(this.surfacePtr); } catch { /* best-effort */ }
          this.surfacePtr = 0;
        }
        this.surface?.rebindSurface(0);
        this.surfaceSuspended = true;
        this.dispatchEvent({ type: "suspend" });
        break;
      }

      case SDL_EVENT_RESUMED: {
        if (this.surfaceSuspended) {
          // The Rust side re-created the Window — make a fresh wgpu surface
          // and rebind the canvas context; the next acquire lazily
          // reconfigures the swapchain (rebindSurface zeroes configured dims).
          const instance = (globalThis as any).__wgpuInstancePtr ?? 0;
          this.surfacePtr = sdl.sdl_shim_create_wgpu_surface(instance) as unknown as number;
          this.surface?.rebindSurface(this.surfacePtr);
          const sz = this.getWindowSize();
          if (sz.width > 0 && sz.height > 0) {
            this.pendingResize = { width: sz.width, height: sz.height };
          }
        }
        this.surfaceSuspended = false;
        this.dispatchEvent({ type: "resume" });
        break;
      }
    }
  }

  destroy(): void {
    this.running = false;
    try { this.splash?.stop(); } catch { /* best-effort */ }
    this.splash = null;
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
