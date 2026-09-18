// ============================================================================
// TouchInputAdapter — maps touch/pointer events to a TouchInputSink
// ============================================================================
//
// Mobile devices have no keyboard, mouse, or pointer lock. This adapter
// translates touch events into a normalized input shape and forwards it to a
// `TouchInputSink` (see touch-input-sink.ts).
//
// Schemes:
//   - "dual-stick": Left half of screen = virtual movement joystick (W/A/S/D
//     or gamepad axes). Right half = drag-look (mouse delta for camera).
//     Tap right = left mouse (action). Two-finger tap right = right mouse.
//   - "joystick-only": Left half = virtual movement joystick. Right half is
//     not handled by the adapter — mining/placing is handled by the pixi-ui
//     host's pass-through synthetic mouse events. Use this for games with a
//     pixi-ui pass-through overlay (e.g. overburden) where the overlay captures
//     all pointer events and dispatches synthetic mouse events on the game
//     canvas for taps that miss PixiJS elements.
//   - "tap-to-move": Single tap = left mouse at position. Drag = mouse delta.
//     Used by 2D/3D games with click-to-move.
//   - "tap": Pure tap = left mouse click at position. Used by 2D click-based
//     games (falling-sand, sandjongg). No movement joystick, no drag-look.
//
// The adapter is additive — it does not alter the existing keyboard/mouse/
// pointer-lock path. On desktop, it is never instantiated.
//
// The adapter exposes joystick state (getMoveJoystick) and action methods
// (pressButton/releaseButton/pressJump/releaseJump/zoom/selectHotbarSlot) so
// an on-screen display (TouchOsd) can both visualize the joystick and route
// button presses back through the same sink.

import { InputBufferWriter, KEY } from "@downdraft/engine";
import {
    InputBufferWriterSink,
    NullTouchInputSink,
    type MovementState,
    type TouchInputSink,
} from "./touch-input-sink";

export type TouchInputScheme = "dual-stick" | "joystick-only" | "tap-to-move" | "tap";

export interface TouchInputOptions {
  scheme: TouchInputScheme;
  /** Dead zone radius for virtual joysticks (in px). Default: 24. */
  joystickDeadZone?: number;
  /** Sensitivity multiplier for drag-look. Default: 1.0. */
  lookSensitivity?: number;
}

interface ActiveTouch {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** Previous position from the last touchmove (for delta computation). */
  lastX: number;
  lastY: number;
  /** Which half of the screen this touch started in (for dual-stick). */
  half: "left" | "right";
}

/** Snapshot of the movement joystick state, read by the OSD each frame. */
export interface JoystickSnapshot {
  active: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

/**
 * Touch input adapter that forwards normalized input to a `TouchInputSink`.
 *
 * Attach via `attach(writer)` (engine SAB games — wraps the writer in an
 * `InputBufferWriterSink`) or `attachSink(sink)` (games with custom input
 * state). The adapter listens for touchstart/touchmove/touchend on the canvas
 * and translates them to movement, pointer, look-delta, and mouse-button
 * calls on the sink.
 */
export class TouchInputAdapter {
  private canvas: HTMLCanvasElement;
  private sink: TouchInputSink = new NullTouchInputSink();
  private scheme: TouchInputScheme;
  private deadZone: number;
  private lookSensitivity: number;
  private touches = new Map<number, ActiveTouch>();
  private listeners: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];
  private attached = false;

  // For dual-stick: track whether the movement joystick is active.
  private moveTouchId: number | null = null;
  // For dual-stick: track the look touch.
  private lookTouchId: number | null = null;
  // For tap actions: track multi-touch for right-click.
  private rightTapTimer: ReturnType<typeof setTimeout> | null = null;
  private rightTapPending = false;

  // Current movement state (kept so jump toggles and OSD reads are consistent).
  private movement: MovementState = {
    forward: false, back: false, left: false, right: false, jump: false,
  };

  constructor(canvas: HTMLCanvasElement, options: TouchInputOptions) {
    this.canvas = canvas;
    this.scheme = options.scheme;
    this.deadZone = options.joystickDeadZone ?? 24;
    this.lookSensitivity = options.lookSensitivity ?? 1.0;
  }

  /**
   * Attach to an `InputBufferWriter` (engine SAB games) and start listening
   * for touch events. The writer is wrapped in an `InputBufferWriterSink`.
   * Backward-compatible with the original API.
   */
  attach(writer: InputBufferWriter): void {
    this.attachSink(new InputBufferWriterSink(writer));
  }

  /**
   * Attach to a `TouchInputSink` (games with custom input state) and start
   * listening for touch events.
   */
  attachSink(sink: TouchInputSink): void {
    if (this.attached) {
      this.detach();
    }
    this.sink = sink;
    this.attached = true;

    const add = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler, { passive: false });
      this.listeners.push({ target, event, handler });
    };

    // Use touch events as the primary path; pointer events cover stylus.
    add(this.canvas, "touchstart", this.onTouchStart as EventListener);
    add(this.canvas, "touchmove", this.onTouchMove as EventListener);
    add(this.canvas, "touchend", this.onTouchEnd as EventListener);
    add(this.canvas, "touchcancel", this.onTouchEnd as EventListener);

    // Prevent default to avoid scrolling/zooming on the canvas.
    add(this.canvas, "touchstart", ((e: TouchEvent) => e.preventDefault()) as EventListener);
    add(this.canvas, "touchmove", ((e: TouchEvent) => e.preventDefault()) as EventListener);

    // When listening on a pixi-ui pass-through overlay canvas (z-index 50,
    // pointer-events: auto), the overlay's pointer event listeners fire BEFORE
    // our touch event listeners (pointer events precede touch events in the
    // browser event sequence). This means a left-half touch would BOTH start
    // the joystick (our touchstart) AND be forwarded by the pixi-ui host as a
    // synthetic mousedown on the game canvas (causing unwanted mining).
    //
    // To prevent this, add capture-phase pointer event listeners that call
    // stopPropagation() for left-half events. Capture phase fires before the
    // target phase, so the pixi-ui host's target-phase pointer listeners never
    // see left-half events. Right-half events pass through normally so the
    // pixi-ui host can forward them for mining/placing.
    if (this.scheme === "joystick-only") {
      const captureOpts = { capture: true } as AddEventListenerOptions;
      this.canvas.addEventListener("pointerdown", this.onPointerCapture, captureOpts);
      this.canvas.addEventListener("pointermove", this.onPointerCapture, captureOpts);
      this.canvas.addEventListener("pointerup", this.onPointerCapture, captureOpts);
      this.listeners.push({ target: this.canvas, event: "pointerdown", handler: this.onPointerCapture as EventListener });
      this.listeners.push({ target: this.canvas, event: "pointermove", handler: this.onPointerCapture as EventListener });
      this.listeners.push({ target: this.canvas, event: "pointerup", handler: this.onPointerCapture as EventListener });
    }
  }

  /** Stop listening and release resources. */
  detach(): void {
    for (const { target, event, handler } of this.listeners) {
      target.removeEventListener(event, handler);
    }
    this.listeners = [];
    this.touches.clear();
    this.moveTouchId = null;
    this.lookTouchId = null;
    this.attached = false;
    this.sink = new NullTouchInputSink();
  }

  // --- Joystick state (read by the OSD) ---

  /** Snapshot of the movement joystick, or null if no move touch is active. */
  getMoveJoystick(): JoystickSnapshot | null {
    if (this.moveTouchId === null) return null;
    const t = this.touches.get(this.moveTouchId);
    if (!t) return null;
    return {
      active: true,
      startX: t.startX,
      startY: t.startY,
      currentX: t.currentX,
      currentY: t.currentY,
    };
  }

  // --- Action methods (called by the OSD buttons) ---

  /** Press a mouse button (0=left/mine, 1=middle, 2=right/place). */
  pressButton(button: 0 | 1 | 2): void {
    this.sink.setMouseButton?.(button, true);
  }

  /** Release a mouse button. */
  releaseButton(button: 0 | 1 | 2): void {
    this.sink.setMouseButton?.(button, false);
  }

  /** Press jump (sets the jump flag in the current movement state). */
  pressJump(): void {
    this.movement.jump = true;
    this.sink.setMovement?.(this.movement);
  }

  /** Release jump. */
  releaseJump(): void {
    this.movement.jump = false;
    this.sink.setMovement?.(this.movement);
  }

  /** Accumulate a zoom delta (positive = zoom in). */
  zoom(delta: number): void {
    this.sink.setZoom?.(delta);
  }

  /** Select a hotbar slot (0-indexed, 0..8). */
  selectHotbarSlot(slot: number): void {
    this.sink.setHotbarSlot?.(slot);
  }

  // --- Touch event handlers ---

  /**
   * Capture-phase pointer event handler for "joystick-only" scheme.
   *
   * When listening on a pixi-ui pass-through overlay, this stops pointer
   * events in the left half (joystick zone) from reaching the overlay's
   * target-phase pointer listeners, preventing unwanted synthetic mouse
   * events (mining) when the user is just moving with the joystick.
   * Right-half events pass through to the pixi-ui host for mining/placing.
   */
  private onPointerCapture = (e: PointerEvent): void => {
    if (e.eventPhase !== Event.CAPTURING_PHASE) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    if (x < w / 2) {
      e.stopPropagation();
    }
  };

  private onTouchStart = (e: TouchEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;

    for (const touch of Array.from(e.changedTouches)) {
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const half: "left" | "right" = x < w / 2 ? "left" : "right";

      this.touches.set(touch.identifier, {
        id: touch.identifier,
        startX: x,
        startY: y,
        currentX: x,
        currentY: y,
        lastX: x,
        lastY: y,
        half,
      });

      if (this.scheme === "dual-stick") {
        if (half === "left" && this.moveTouchId === null) {
          this.moveTouchId = touch.identifier;
        } else if (half === "right" && this.lookTouchId === null) {
          this.lookTouchId = touch.identifier;
          // Tap = left mouse button (action)
          this.sink.setMouseButton?.(0, true);
        }
      } else if (this.scheme === "joystick-only") {
        // Only handle left-half movement. Right-half touches are not handled
        // by the adapter — the pixi-ui host's pass-through synthetic mouse
        // events handle mining/placing for taps that miss PixiJS elements.
        if (half === "left" && this.moveTouchId === null) {
          this.moveTouchId = touch.identifier;
        }
      } else if (this.scheme === "tap-to-move" || this.scheme === "tap") {
        // Set mouse position and press left button
        this.sink.setPointer?.(x, y);
        this.sink.setMouseButton?.(0, true);
      }
    }

    // Two-finger tap on right half = right mouse (context action)
    if (this.scheme === "dual-stick" && e.touches.length >= 2) {
      this.rightTapPending = true;
      if (this.rightTapTimer) clearTimeout(this.rightTapTimer);
      this.rightTapTimer = setTimeout(() => {
        this.rightTapPending = false;
      }, 300);
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    const rect = this.canvas.getBoundingClientRect();

    for (const touch of Array.from(e.changedTouches)) {
      const active = this.touches.get(touch.identifier);
      if (!active) continue;

      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;

      if (this.scheme === "dual-stick") {
        if (touch.identifier === this.moveTouchId) {
          active.currentX = x;
          active.currentY = y;
          this.applyMovementJoystick(active);
        } else if (touch.identifier === this.lookTouchId) {
          // Drag-look: compute delta from last position, then update.
          const dx = (x - active.lastX) * this.lookSensitivity;
          const dy = (y - active.lastY) * this.lookSensitivity;
          this.sink.setLookDelta?.(dx, dy);
          active.lastX = x;
          active.lastY = y;
          active.currentX = x;
          active.currentY = y;
        }
      } else if (this.scheme === "joystick-only") {
        if (touch.identifier === this.moveTouchId) {
          active.currentX = x;
          active.currentY = y;
          this.applyMovementJoystick(active);
        }
      } else if (this.scheme === "tap-to-move") {
        // Drag = mouse movement
        this.sink.setPointer?.(x, y);
        active.currentX = x;
        active.currentY = y;
      }
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (const touch of Array.from(e.changedTouches)) {
      const active = this.touches.get(touch.identifier);
      if (!active) continue;

      if (this.scheme === "dual-stick") {
        if (touch.identifier === this.moveTouchId) {
          // Release all movement keys
          this.movement.forward = false;
          this.movement.back = false;
          this.movement.left = false;
          this.movement.right = false;
          this.movement.jump = false;
          this.sink.setMovement?.(this.movement);
          this.moveTouchId = null;
        } else if (touch.identifier === this.lookTouchId) {
          this.sink.setMouseButton?.(0, false);
          this.sink.setLookDelta?.(0, 0);
          this.lookTouchId = null;
        }
        // Two-finger tap release = right mouse
        if (this.rightTapPending && e.touches.length === 0) {
          this.sink.setMouseButton?.(2, true);
          setTimeout(() => this.sink.setMouseButton?.(2, false), 100);
          this.rightTapPending = false;
        }
      } else if (this.scheme === "joystick-only") {
        if (touch.identifier === this.moveTouchId) {
          // Release all movement keys
          this.movement.forward = false;
          this.movement.back = false;
          this.movement.left = false;
          this.movement.right = false;
          this.movement.jump = false;
          this.sink.setMovement?.(this.movement);
          this.moveTouchId = null;
        }
      } else if (this.scheme === "tap-to-move" || this.scheme === "tap") {
        this.sink.setMouseButton?.(0, false);
      }

      this.touches.delete(touch.identifier);
    }
  };

  /**
   * Apply a virtual movement joystick to the movement state.
   * Maps joystick direction to forward/back/left/right.
   */
  private applyMovementJoystick(touch: ActiveTouch): void {
    const dx = touch.currentX - touch.startX;
    const dy = touch.currentY - touch.startY;
    const dist = Math.hypot(dx, dy);

    // Dead zone
    const forward = dist > this.deadZone && dy < -this.deadZone;
    const back = dist > this.deadZone && dy > this.deadZone;
    const left = dist > this.deadZone && dx < -this.deadZone;
    const right = dist > this.deadZone && dx > this.deadZone;

    this.movement.forward = forward;
    this.movement.back = back;
    this.movement.left = left;
    this.movement.right = right;
    // Preserve jump flag (set by pressJump, cleared by releaseJump).
    this.sink.setMovement?.(this.movement);
  }
}

// Re-export KEY for backward-compat with any code that imported it from here.
export { KEY };
