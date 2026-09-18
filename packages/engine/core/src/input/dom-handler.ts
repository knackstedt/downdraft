// ============================================================================
// createDomInputHandler — batteries-included DOM input capture.
//
// Every game hand-rolled the same ~100-270-line input handler: window
// keydown/keyup feeding a keyMap, canvas mousedown + window mouseup for
// buttons, canvas mousemove → canvas-space coords, wheel accumulation,
// contextmenu suppression — with no destroy() (leaks on hot reload) and no
// test-input injection.
//
// This factory wires DOM events into the engine's InputState plus a named
// "held actions" bag (keyMap → action flags like `left`/`jump`), and adds:
//   - destroy() — removes every listener (hot-reload safe)
//   - injectInput()/clearInjectedInput() — MCP test input (satisfies the
//     StandardInputInjector surface used by createStandardAutomationTools)
//   - update() — per-frame drain for injected frames (call once per frame)
//
// Usage:
//   const input = createDomInputHandler({
//     canvas,
//     preset: "wasd",                      // a/d/w/s/arrows/space → left/right/up/down/jump
//     keys: { "e": "use", "code:KeyQ": "drop" },
//     onKeyPress: { "F6": () => toggleInspect() },
//     mouseCoords: "css",
//   });
//   // per frame:
//   input.update();
//   if (input.held.left) ...
//   if (input.state.wheelDelta) zoom *= ...
//   input.state.endFrame();               // clears edge sets + deltas
//   // on hot-reload:
//   input.destroy();
// ============================================================================

import { InputState } from "./state";

/** Standard WASD+arrows+Space preset: e.key → action name. */
const WASD_PRESET: Record<string, string> = {
  a: "left", A: "left", ArrowLeft: "left",
  d: "right", D: "right", ArrowRight: "right",
  w: "up", W: "up", ArrowUp: "up",
  s: "down", S: "down", ArrowDown: "down",
  " ": "jump", Space: "jump", Spacebar: "jump",
};

export interface DomInjectedFrame {
  /** DOM key codes (e.keyCode / KeyboardEvent.keyCode values, see core KEY). */
  keys?: Iterable<number>;
  /** Named actions to hold (same namespace as the keyMap values). */
  actions?: Iterable<string>;
  leftMouse?: boolean;
  rightMouse?: boolean;
  middleMouse?: boolean;
  mouseDx?: number;
  mouseDy?: number;
  wheel?: number;
  /** Frames the injection persists (decremented by update()). */
  framesRemaining: number;
}

export interface DomInputOptions {
  canvas: HTMLCanvasElement;
  /**
   * Map from `e.key` to a held-action name (e.g. `{ "a": "left" }`).
   * Prefix with "code:" to match `e.code` instead (layout-independent,
   * e.g. "code:KeyW" matches the physical W key).
   */
  keys?: Record<string, string>;
  /** Built-in key map preset. "wasd" maps a/d/w/s/arrows/space →
   *  left/right/up/down/jump. Merged under `keys` (explicit keys win). */
  preset?: "wasd";
  /**
   * Edge-triggered keydown handlers by `e.key` (or "code:KeyX"). Fires on
   * every keydown including OS repeats — gate on `e.repeat` inside the
   * handler if you need once-per-press.
   */
  onKeyPress?: Record<string, (e: KeyboardEvent, input: DomInputHandler) => void>;
  /** Raw event hooks for game-specific behavior (run after built-in handling). */
  onKeyDown?: (e: KeyboardEvent, input: DomInputHandler) => void;
  onKeyUp?: (e: KeyboardEvent, input: DomInputHandler) => void;
  onMouseDown?: (e: MouseEvent, pos: { x: number; y: number }, input: DomInputHandler) => void;
  onMouseUp?: (e: MouseEvent, input: DomInputHandler) => void;
  onMouseMove?: (e: MouseEvent, pos: { x: number; y: number }, input: DomInputHandler) => void;
  onWheel?: (e: WheelEvent, input: DomInputHandler) => void;
  /**
   * Mouse position coordinate space. "css" (default): `clientX - rect.left`
   * (CSS pixels). "canvas": scaled to the backing store
   * (`(clientX - rect.left) * canvas.width / rect.width`) — use when the sim
   * consumes framebuffer-space coords.
   */
  mouseCoords?: "css" | "canvas";
  /** Call preventDefault() on mapped keys. Default: true. */
  preventDefaultKeys?: boolean;
  /** Suppress contextmenu + auxclick on the canvas. Default: true. */
  suppressContextMenu?: boolean;
  /**
   * Accumulate wheel events into `state.wheelDelta` (+1/-1 per notch).
   * Default: true (harmless if unused).
   */
  wheel?: boolean;
  /**
   * Listen for mouseup on window instead of the canvas so drags that leave
   * the canvas still release buttons. Default: true.
   */
  windowMouseUp?: boolean;
  /**
   * Listen for mousemove on window instead of the canvas (tracks position
   * even when the pointer is over a DOM overlay; `mouseValid` reports whether
   * the pointer is inside the canvas rect). Default: false (canvas only).
   */
  windowMouseMove?: boolean;
  /**
   * Initialize mouseX/mouseY to the canvas center instead of (0,0), so a
   * click before any mousemove aims at screen center. Default: true.
   */
  centerInitialMouse?: boolean;
}

export interface DomInputHandler {
  /** Raw input state: key codes, buttons, edge sets, deltas. */
  readonly state: InputState;
  /** Named held actions from the keyMap (e.g. held.left, held.jump). */
  readonly held: Record<string, boolean>;
  /** True while the pointer is over the canvas (windowMouseMove mode always updates this; canvas mode sets it on enter/leave). */
  mouseValid: boolean;
  /** Whether an action is currently held. */
  isDown(action: string): boolean;
  /** Queue an injected input frame (MCP test input). */
  injectInput(frame: DomInjectedFrame): void;
  /** Clear all pending injected frames. */
  clearInjectedInput(): void;
  /** Apply queued injected frames to state. Call once per frame before reading state. */
  update(): void;
  /** Remove all DOM listeners + clear injected frames. */
  destroy(): void;
}

export function createDomInputHandler(opts: DomInputOptions): DomInputHandler {
  const { canvas } = opts;
  const state = new InputState();
  const held: Record<string, boolean> = {};
  const injected: DomInjectedFrame[] = [];

  // ── Key map: e.key → action, plus "code:" entries keyed on e.code ──
  const keyMap: Record<string, string> = {
    ...(opts.preset === "wasd" ? WASD_PRESET : {}),
    ...opts.keys,
  };
  const preventKeys = opts.preventDefaultKeys ?? true;

  const recomputeHeld = (action: string) => {
    // An action is held if any mapped key is currently down. We track key
    // strings (not codes) for the held bag since the map is e.key-based.
    held[action] = downKeyStringsFor(action).size > 0;
  };

  // Track which physical key-strings are down per action.
  const downKeysByAction = new Map<string, Set<string>>();
  const downKeyStringsFor = (action: string): Set<string> => {
    let s = downKeysByAction.get(action);
    if (!s) {
      s = new Set();
      downKeysByAction.set(action, s);
    }
    return s;
  };

  const lookupAction = (e: KeyboardEvent): { mapKey: string; action: string } | null => {
    const byCode = keyMap[`code:${e.code}`];
    if (byCode) return { mapKey: `code:${e.code}`, action: byCode };
    const byKey = keyMap[e.key];
    if (byKey) return { mapKey: e.key, action: byKey };
    return null;
  };

  // Track physically-held keys/buttons so injected-frame expiry only releases
  // inputs that aren't also held by the real user.
  const physKeys = new Set<number>();
  const physButtons = new Set<number>();
  // Live-frame contribution counts for injected keys/actions/buttons — a
  // contribution is released when no live frame still holds it.
  const injectedKeys = new Map<number, number>();
  const injectedActions = new Map<string, number>();
  const injectedButtons = new Map<number, number>();
  const liveFrames = new Set<DomInjectedFrame>();

  const releaseFrame = (f: DomInjectedFrame) => {
    for (const code of f.keys ?? []) {
      const n = (injectedKeys.get(code) ?? 1) - 1;
      if (n > 0) injectedKeys.set(code, n);
      else {
        injectedKeys.delete(code);
        if (!physKeys.has(code)) state.keyUp(code);
      }
    }
    for (const action of f.actions ?? []) {
      const n = (injectedActions.get(action) ?? 1) - 1;
      if (n > 0) injectedActions.set(action, n);
      else {
        injectedActions.delete(action);
        recomputeHeld(action);
      }
    }
    const buttons = [f.leftMouse ? 0 : -1, f.middleMouse ? 1 : -1, f.rightMouse ? 2 : -1];
    for (const button of buttons) {
      if (button < 0) continue;
      const n = (injectedButtons.get(button) ?? 1) - 1;
      if (n > 0) injectedButtons.set(button, n);
      else {
        injectedButtons.delete(button);
        if (!physButtons.has(button)) state.mouseUp(button);
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const code = e.keyCode || 0;
    state.keyDown(code);
    physKeys.add(code);
    const hit = lookupAction(e);
    if (hit) {
      downKeyStringsFor(hit.action).add(hit.mapKey);
      held[hit.action] = true;
      if (preventKeys) e.preventDefault();
    }
    opts.onKeyPress?.[e.key]?.(e, handler);
    opts.onKeyPress?.[`code:${e.code}`]?.(e, handler);
    opts.onKeyDown?.(e, handler);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const code = e.keyCode || 0;
    state.keyUp(code);
    physKeys.delete(code);
    const hit = lookupAction(e);
    if (hit) {
      downKeysByAction.get(hit.action)?.delete(hit.mapKey);
      recomputeHeld(hit.action);
      if (preventKeys) e.preventDefault();
    }
    opts.onKeyUp?.(e, handler);
  };

  // ── Mouse ──
  const coordScale = opts.mouseCoords === "canvas";
  const toCanvasCoords = (e: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!coordScale) return { x, y };
    return {
      x: x * (canvas.width / rect.width),
      y: y * (canvas.height / rect.height),
    };
  };

  const insideCanvas = (e: MouseEvent): boolean => {
    const rect = canvas.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right &&
           e.clientY >= rect.top && e.clientY <= rect.bottom;
  };

  const handler: DomInputHandler = {
    state,
    held,
    mouseValid: false,
    isDown: (action) => held[action] === true,
    injectInput(frame) {
      injected.push(frame);
    },
    clearInjectedInput() {
      for (const f of injected) releaseFrame(f);
      injected.length = 0;
      liveFrames.clear();
    },
    update() {
      for (let i = injected.length - 1; i >= 0; i--) {
        const f = injected[i];
        if (!liveFrames.has(f)) {
          liveFrames.add(f);
          for (const code of f.keys ?? []) injectedKeys.set(code, (injectedKeys.get(code) ?? 0) + 1);
          for (const action of f.actions ?? []) injectedActions.set(action, (injectedActions.get(action) ?? 0) + 1);
          if (f.leftMouse) injectedButtons.set(0, (injectedButtons.get(0) ?? 0) + 1);
          if (f.middleMouse) injectedButtons.set(1, (injectedButtons.get(1) ?? 0) + 1);
          if (f.rightMouse) injectedButtons.set(2, (injectedButtons.get(2) ?? 0) + 1);
        }
        for (const code of f.keys ?? []) state.keyDown(code);
        for (const action of f.actions ?? []) held[action] = true;
        if (f.leftMouse) state.mouseDown(0);
        if (f.middleMouse) state.mouseDown(1);
        if (f.rightMouse) state.mouseDown(2);
        if (f.mouseDx || f.mouseDy) {
          state.mouseDeltaX += f.mouseDx ?? 0;
          state.mouseDeltaY += f.mouseDy ?? 0;
        }
        if (f.wheel) state.wheel(f.wheel);
        f.framesRemaining--;
        if (f.framesRemaining <= 0) {
          injected.splice(i, 1);
          liveFrames.delete(f);
          releaseFrame(f);
        }
      }
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousedown", onMouseDown);
      (opts.windowMouseUp ?? true ? window : canvas).removeEventListener("mouseup", onMouseUp as EventListener);
      (opts.windowMouseMove ? window : canvas).removeEventListener("mousemove", onMouseMove as EventListener);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("auxclick", onPrevent);
      canvas.removeEventListener("wheel", onWheel as EventListener);
      injected.length = 0;
    },
  };

  const onMouseDown = (e: MouseEvent) => {
    const pos = toCanvasCoords(e);
    state.mouseMove(pos.x, pos.y, 0, 0);
    state.mouseDown(e.button);
    physButtons.add(e.button);
    opts.onMouseDown?.(e, pos, handler);
  };

  const onMouseUp = (e: MouseEvent) => {
    state.mouseUp(e.button);
    physButtons.delete(e.button);
    opts.onMouseUp?.(e, handler);
  };

  const onMouseMove = (e: MouseEvent) => {
    const pos = toCanvasCoords(e);
    state.mouseMove(pos.x, pos.y, e.movementX ?? 0, e.movementY ?? 0);
    handler.mouseValid = insideCanvas(e);
    opts.onMouseMove?.(e, pos, handler);
  };

  const onContextMenu = (e: Event) => e.preventDefault();
  const onPrevent = (e: Event) => e.preventDefault();

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Normalize to integer notches (scroll up = +1 = zoom in, matching the
    // per-game convention).
    state.wheel(e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0);
    opts.onWheel?.(e, handler);
  };

  // ── Wire listeners ──
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("mousedown", onMouseDown);
  (opts.windowMouseUp ?? true ? window : canvas).addEventListener("mouseup", onMouseUp as EventListener);
  (opts.windowMouseMove ? window : canvas).addEventListener("mousemove", onMouseMove as EventListener);
  if (opts.suppressContextMenu ?? true) {
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("auxclick", onPrevent);
  }
  if (opts.wheel ?? true) {
    canvas.addEventListener("wheel", onWheel as EventListener, { passive: false });
  }

  // Initialize mouse to canvas center so a click before the first mousemove
  // targets the middle of the view (where the player usually is) instead of
  // the top-left corner.
  if (opts.centerInitialMouse ?? true) {
    const rect = canvas.getBoundingClientRect();
    state.mouseX = coordScale ? canvas.width / 2 : rect.width / 2;
    state.mouseY = coordScale ? canvas.height / 2 : rect.height / 2;
  }

  return handler;
}
