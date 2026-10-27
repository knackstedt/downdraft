// ============================================================================
// InputManager — keyboard, mouse, pointer lock tracking for the renderer
// Extracted from WebGPURenderer's input handling logic.
// ============================================================================

import { UIInputRouter } from "../input/ui-router";
import type { RenderSurface } from "../platform/render-surface";

export interface RenderInputState {
  keysDown: Set<number>;
  mouse: { x: number; y: number; left: boolean; right: boolean; wheel: number };
  mouseDelta: { dx: number; dy: number };
  pointerLocked: boolean;
}

export class InputManager {
  private canvas: RenderSurface;
  private keysDown = new Set<number>();
  private mouseState = { x: 0, y: 0, left: false, right: false, wheel: 0, _wheel: 0 };
  private mouseDelta = { dx: 0, dy: 0 };
  private pointerLocked = false;
  private pointerLockRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerLockRetryCount = 0;
  // When false (the default), the canvas does not auto-grab the pointer on
  // click. Pointer lock is an opt-in FPS-style concern; 2D click-based apps
  // (2D grid-based apps, …) must not have their cursor
  // captured/hidden. 3D apps that want pointer lock either set this flag or
  // manage pointer lock themselves (e.g. apps that manage pointer lock themselves).
  private enablePointerLock: boolean;

  private uiInputRouter: UIInputRouter | null = null;
  /** Reports whether the most recent pointerdown was consumed by UI
   *  (input-bus subscriber or a UI element under the pointer). When true,
   *  the canvas click handler must not re-acquire pointer lock. */
  private uiConsumedCheck: (() => boolean) | null = null;
  /** Set at mousedown: the gesture began on a UI element. Click-time
   *  hit-testing alone is unreliable — a row action may close the menu
   *  before the click event fires, leaving nothing under the pointer. */
  private pointerDownOnUI = false;
  private listeners: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];

  constructor(canvas: RenderSurface, enablePointerLock = false) {
    this.canvas = canvas;
    this.enablePointerLock = enablePointerLock;
  }

  /** Toggle whether clicking the canvas requests pointer lock. */
  setPointerLockEnabled(enabled: boolean): void {
    this.enablePointerLock = enabled;
  }

  setUIInputRouter(router: UIInputRouter | null): void {
    this.uiInputRouter = router;
  }

  setUiConsumedCheck(fn: (() => boolean) | null): void {
    this.uiConsumedCheck = fn;
  }

  getUIInputRouter(): UIInputRouter | null {
    return this.uiInputRouter;
  }

  setupListeners(): void {
    const add = (target: EventTarget, event: string, handler: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, handler, options);
      this.listeners.push({ target, event, handler });
    };

    add(window, "keydown", ((e: KeyboardEvent) => {
      this.keysDown.add(e.keyCode);
      this.uiInputRouter?.handleKeyDown(e.keyCode);
      if (e.key.length === 1) {
        this.uiInputRouter?.handleCharInput(e.key);
      }
    }) as EventListener);

    add(window, "keyup", ((e: KeyboardEvent) => {
      this.keysDown.delete(e.keyCode);
      this.uiInputRouter?.handleKeyUp(e.keyCode);
    }) as EventListener);

    // Pointer lock is opt-in: only 3D FPS-style apps request it. 2D
    // click-based apps (2D grid-based apps, …) must keep a visible,
    // free-moving cursor so click-to-dig / click-to-place works.
    if (this.enablePointerLock) {
      add(this.canvas, "click", (() => {
        // UI-consumed clicks (bus subscribers like webui panels, or UI
        // elements under the router's pointer) must not grab the pointer.
        if (!this.pointerLocked && !(this.pointerDownOnUI || this.uiInputRouter?.isPointerOverUI() || (this.uiConsumedCheck?.() ?? false))) {
          this.pointerLockRetryCount = 0;
          this.tryLockPointer();
        }
      }) as EventListener);

      add(this.canvas, "pointerlockchange", (() => {
        const wasLocked = this.pointerLocked;
        this.pointerLocked = this.canvas.pointerLocked === true;
        if (this.pointerLocked) {
          this.pointerLockRetryCount = 0;
          if (this.pointerLockRetryTimer) {
            clearTimeout(this.pointerLockRetryTimer);
            this.pointerLockRetryTimer = null;
          }
        } else if (wasLocked) {
          this.keysDown.clear();
          this.mouseState.left = false;
          this.mouseState.right = false;
          this.mouseDelta.dx = 0;
          this.mouseDelta.dy = 0;
        }
      }) as EventListener);

      add(this.canvas, "pointerlockerror", (() => {
        // No action needed — tryLockPointer's fallback timer will retry.
      }) as EventListener);
    }

    add(window, "blur", (() => {
      this.keysDown.clear();
      this.mouseState.left = false;
      this.mouseState.right = false;
      this.mouseDelta.dx = 0;
      this.mouseDelta.dy = 0;
    }) as EventListener);

    // Convert a DOM event to canvas backing-pixel coordinates for UI
    // hit-testing (UI panels are laid out in canvas.width/height space).
    const toCanvas = (e: MouseEvent): [number, number] => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = rect.width > 0 ? this.canvas.width / rect.width : 1;
      const sy = rect.height > 0 ? this.canvas.height / rect.height : 1;
      return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
    };

    add(this.canvas, "mousemove", ((e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseState.x = e.clientX - rect.left;
      this.mouseState.y = e.clientY - rect.top;
      if (this.pointerLocked) {
        this.mouseDelta.dx += e.movementX ?? 0;
        this.mouseDelta.dy += e.movementY ?? 0;
      }
    }) as EventListener);

    add(this.canvas, "mousedown", ((e: MouseEvent) => {
      if (e.button === 0) {
        this.mouseState.left = true;
      }
      if (e.button === 2) {
        this.mouseState.right = true;
      }
    }) as EventListener);

    add(this.canvas, "mouseup", ((e: MouseEvent) => {
      if (e.button === 0) {
        this.mouseState.left = false;
      }
      if (e.button === 2) this.mouseState.right = false;
    }) as EventListener);

    // UI routing listens on window — app UI draws on the app canvas, but apps
    // may stack additional interactive canvases above it (e.g. an app's
    // tile canvas). Window-level listeners see events regardless of which
    // element is on top; toCanvas() converts to backing-pixel space and
    // hit-testing bounds-checks, so off-canvas events are no-ops.
    add(window, "mousemove", ((e: MouseEvent) => {
      const [cx, cy] = toCanvas(e);
      this.uiInputRouter?.handleMouseMove(cx, cy);
    }) as EventListener);

    add(window, "mousedown", ((e: MouseEvent) => {
      if (e.button === 0) {
        const [cx, cy] = toCanvas(e);
        // Capture BEFORE routing the press into the UI doc — a menu row can
        // close its menu on this very gesture, so hit-testing afterwards
        // (or at click time) would find nothing and wrongly allow pointer
        // lock.
        this.pointerDownOnUI = this.uiInputRouter?.isPointOverUI(cx, cy) ?? false;
        this.uiInputRouter?.handleMouseDown(cx, cy);
      }
    }) as EventListener);

    add(window, "mouseup", ((e: MouseEvent) => {
      if (e.button === 0) {
        const [cx, cy] = toCanvas(e);
        this.uiInputRouter?.handleMouseUp(cx, cy);
      }
    }) as EventListener);

    add(window, "wheel", ((e: WheelEvent) => {
      const [cx, cy] = toCanvas(e);
      this.uiInputRouter?.handleMouseMove(cx, cy);
      if (e.target === this.canvas) {
        this.mouseState.wheel = e.deltaY;
      }
      if (this.uiInputRouter?.handleWheel(e.deltaX, e.deltaY)) {
        e.preventDefault();
      }
    }) as EventListener, { passive: false });

    // Window-level mouseleave: a second interactive canvas stacked above
    // (e.g. a tile canvas) would otherwise trigger the canvas's
    // own mouseleave and break UI hover/pressed state.
    add(window, "mouseleave", (() => {
      this.uiInputRouter?.handlePointerLeave();
    }) as EventListener);

    add(this.canvas, "contextmenu", ((e: Event) => {
      e.preventDefault();
    }) as EventListener);
  }

  lockPointer(): void {
    if (this.pointerLocked) return;
    this.pointerLockRetryCount = 0;
    this.tryLockPointer();
  }

  private tryLockPointer(): void {
    if (this.pointerLocked) return;
    if (this.pointerLockRetryCount >= 20) return;
    this.pointerLockRetryCount++;
    try {
      this.canvas.requestPointerLock?.();
    } catch (_e) {
      // ignore — fallback timer below will retry
    }
    if (this.pointerLockRetryTimer) clearTimeout(this.pointerLockRetryTimer);
    this.pointerLockRetryTimer = setTimeout(() => {
      this.pointerLockRetryTimer = null;
      if (!this.pointerLocked) this.tryLockPointer();
    }, 300);
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  getKeysDown(): number[] {
    return Array.from(this.keysDown);
  }

  getKeysDownSet(): Set<number> {
    return this.keysDown;
  }

  getMouseState() {
    const wheel = this.mouseState.wheel;
    this.mouseState.wheel = 0;
    this.mouseState._wheel = wheel;
    return this.mouseState;
  }

  getMouseDelta(): { dx: number; dy: number } {
    return this.mouseDelta;
  }

  resetMouseDelta(): void {
    this.mouseDelta.dx = 0;
    this.mouseDelta.dy = 0;
  }

  clearKeys(): void {
    this.keysDown.clear();
  }

  destroy(): void {
    this.listeners.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler);
    });
    this.listeners = [];
    if (this.pointerLockRetryTimer) {
      clearTimeout(this.pointerLockRetryTimer);
      this.pointerLockRetryTimer = null;
    }
  }
}
