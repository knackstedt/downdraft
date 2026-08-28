// ============================================================================
// TouchInputAdapter — maps touch/pointer events to InputBufferWriter
// ============================================================================
//
// Mobile devices have no keyboard, mouse, or pointer lock. This adapter
// translates touch events into the engine's existing input buffer format
// (the same InputBufferWriter that the desktop InputManager writes to).
//
// Schemes:
//   - "dual-stick": Left half of screen = virtual movement joystick (W/A/S/D
//     or gamepad axes). Right half = drag-look (mouse delta for camera).
//     Tap right = left mouse (action). Two-finger tap right = right mouse.
//   - "tap-to-move": Single tap = left mouse at position. Drag = mouse delta.
//     Used by 2D/3D games with click-to-move.
//   - "tap": Pure tap = left mouse click at position. Used by 2D click-based
//     games (falling-sand, sandjongg). No movement joystick, no drag-look.
//
// The adapter is additive — it does not alter the existing keyboard/mouse/
// pointer-lock path. On desktop, it is never instantiated.

import { InputBufferWriter, KEY } from "@downdraft/core";

export type TouchInputScheme = "dual-stick" | "tap-to-move" | "tap";

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

/**
 * Touch input adapter that writes to the engine's InputBufferWriter.
 *
 * Attach to a canvas via `attach(writer)`. The adapter listens for
 * touchstart/touchmove/touchend on the canvas and translates them to
 * key presses, mouse deltas, and mouse button states in the input SAB.
 */
export class TouchInputAdapter {
  private canvas: HTMLCanvasElement;
  private writer: InputBufferWriter | null = null;
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

  constructor(canvas: HTMLCanvasElement, options: TouchInputOptions) {
    this.canvas = canvas;
    this.scheme = options.scheme;
    this.deadZone = options.joystickDeadZone ?? 24;
    this.lookSensitivity = options.lookSensitivity ?? 1.0;
  }

  /**
   * Attach to an InputBufferWriter and start listening for touch events.
   * The writer is the same one the desktop InputManager writes to.
   */
  attach(writer: InputBufferWriter): void {
    if (this.attached) {
      this.detach();
    }
    this.writer = writer;
    this.attached = true;

    const add = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler, { passive: false });
      this.listeners.push({ target, event, handler });
    };

    // Use pointer events for unified mouse/touch/pen handling on mobile.
    // touch events are the primary path; pointer events cover stylus.
    add(this.canvas, "touchstart", this.onTouchStart as EventListener);
    add(this.canvas, "touchmove", this.onTouchMove as EventListener);
    add(this.canvas, "touchend", this.onTouchEnd as EventListener);
    add(this.canvas, "touchcancel", this.onTouchEnd as EventListener);

    // Prevent default to avoid scrolling/zooming on the canvas.
    add(this.canvas, "touchstart", ((e: TouchEvent) => e.preventDefault()) as EventListener);
    add(this.canvas, "touchmove", ((e: TouchEvent) => e.preventDefault()) as EventListener);
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
  }

  // --- Touch event handlers ---

  private onTouchStart = (e: TouchEvent): void => {
    if (!this.writer) return;
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
          this.writer.setMouseButton(0, 0, true);
        }
      } else if (this.scheme === "tap-to-move" || this.scheme === "tap") {
        // Set mouse position and press left button
        this.writer.setMousePos(0, x, y);
        this.writer.setMouseButton(0, 0, true);
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
    if (!this.writer) return;
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
          this.writer.setMouseDelta(0, dx, dy);
          active.lastX = x;
          active.lastY = y;
          active.currentX = x;
          active.currentY = y;
        }
      } else if (this.scheme === "tap-to-move") {
        // Drag = mouse movement
        this.writer.setMousePos(0, x, y);
        active.currentX = x;
        active.currentY = y;
      }
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.writer) return;

    for (const touch of Array.from(e.changedTouches)) {
      const active = this.touches.get(touch.identifier);
      if (!active) continue;

      if (this.scheme === "dual-stick") {
        if (touch.identifier === this.moveTouchId) {
          // Release all movement keys
          this.writer.setKey(0, KEY.W, false);
          this.writer.setKey(0, KEY.A, false);
          this.writer.setKey(0, KEY.S, false);
          this.writer.setKey(0, KEY.D, false);
          this.moveTouchId = null;
        } else if (touch.identifier === this.lookTouchId) {
          this.writer.setMouseButton(0, 0, false);
          this.writer.setMouseDelta(0, 0, 0);
          this.lookTouchId = null;
        }
        // Two-finger tap release = right mouse
        if (this.rightTapPending && e.touches.length === 0) {
          this.writer.setMouseButton(0, 2, true);
          setTimeout(() => this.writer?.setMouseButton(0, 2, false), 100);
          this.rightTapPending = false;
        }
      } else if (this.scheme === "tap-to-move" || this.scheme === "tap") {
        this.writer.setMouseButton(0, 0, false);
      }

      this.touches.delete(touch.identifier);
    }
  };

  /**
   * Apply a virtual movement joystick to the input buffer.
   * Maps joystick direction to W/A/S/D key presses.
   */
  private applyMovementJoystick(touch: ActiveTouch): void {
    if (!this.writer) return;
    const dx = touch.currentX - touch.startX;
    const dy = touch.currentY - touch.startY;
    const dist = Math.hypot(dx, dy);

    // Dead zone
    const forward = dist > this.deadZone && dy < -this.deadZone;
    const back = dist > this.deadZone && dy > this.deadZone;
    const left = dist > this.deadZone && dx < -this.deadZone;
    const right = dist > this.deadZone && dx > this.deadZone;

    this.writer.setKey(0, KEY.W, forward);
    this.writer.setKey(0, KEY.S, back);
    this.writer.setKey(0, KEY.A, left);
    this.writer.setKey(0, KEY.D, right);
  }
}
