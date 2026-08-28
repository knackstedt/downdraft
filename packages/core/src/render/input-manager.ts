// ============================================================================
// InputManager — keyboard, mouse, pointer lock tracking for the renderer
// Extracted from WebGPURenderer's input handling logic.
// ============================================================================

import { UIInputRouter } from "@downdraft/library-imui";

export interface RenderInputState {
  keysDown: Set<number>;
  mouse: { x: number; y: number; left: boolean; right: boolean; wheel: number };
  mouseDelta: { dx: number; dy: number };
  pointerLocked: boolean;
}

export class InputManager {
  private canvas: HTMLCanvasElement;
  private keysDown = new Set<number>();
  private mouseState = { x: 0, y: 0, left: false, right: false, wheel: 0, _wheel: 0 };
  private mouseDelta = { dx: 0, dy: 0 };
  private pointerLocked = false;
  private pointerLockRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerLockRetryCount = 0;
  // When false (the default), the canvas does not auto-grab the pointer on
  // click. Pointer lock is an opt-in FPS-style concern; 2D click-based games
  // (2D grid-based games, …) must not have their cursor
  // captured/hidden. 3D games that want pointer lock either set this flag or
  // manage pointer lock themselves (e.g. games that manage pointer lock themselves).
  private enablePointerLock: boolean;

  private uiInputRouter: UIInputRouter | null = null;
  private listeners: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];

  constructor(canvas: HTMLCanvasElement, enablePointerLock = false) {
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

  getUIInputRouter(): UIInputRouter | null {
    return this.uiInputRouter;
  }

  setupListeners(): void {
    const add = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler);
      this.listeners.push({ target, event, handler });
    };

    add(window, "keydown", ((e: KeyboardEvent) => {
      this.keysDown.add(e.keyCode);
      this.uiInputRouter?.handleKeyDown(e.keyCode);
    }) as EventListener);

    add(window, "keyup", ((e: KeyboardEvent) => {
      this.keysDown.delete(e.keyCode);
      this.uiInputRouter?.handleKeyUp(e.keyCode);
    }) as EventListener);

    // Pointer lock is opt-in: only 3D FPS-style games request it. 2D
    // click-based games (2D grid-based games, …) must keep a visible,
    // free-moving cursor so click-to-dig / click-to-place works.
    if (this.enablePointerLock) {
      add(this.canvas, "click", (() => {
        if (!this.pointerLocked) {
          this.pointerLockRetryCount = 0;
          this.tryLockPointer();
        }
      }) as EventListener);

      add(document, "pointerlockchange", (() => {
        const wasLocked = this.pointerLocked;
        this.pointerLocked = document.pointerLockElement === this.canvas;
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

      add(document, "pointerlockerror", (() => {
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

    add(this.canvas, "mousemove", ((e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseState.x = e.clientX - rect.left;
      this.mouseState.y = e.clientY - rect.top;
      this.uiInputRouter?.handleMouseMove(e.clientX, e.clientY);
      if (this.pointerLocked) {
        this.mouseDelta.dx += e.movementX;
        this.mouseDelta.dy += e.movementY;
      }
    }) as EventListener);

    add(this.canvas, "mousedown", ((e: MouseEvent) => {
      if (e.button === 0) {
        this.mouseState.left = true;
        this.uiInputRouter?.handleMouseDown(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.mouseState.right = true;
      }
    }) as EventListener);

    add(this.canvas, "mouseup", ((e: MouseEvent) => {
      if (e.button === 0) {
        this.mouseState.left = false;
        this.uiInputRouter?.handleMouseUp(e.clientX, e.clientY);
      }
      if (e.button === 2) this.mouseState.right = false;
    }) as EventListener);

    add(this.canvas, "wheel", ((e: WheelEvent) => {
      this.mouseState.wheel = e.deltaY;
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
      this.canvas.requestPointerLock();
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
    for (const { target, event, handler } of this.listeners) {
      target.removeEventListener(event, handler);
    }
    this.listeners = [];
    if (this.pointerLockRetryTimer) {
      clearTimeout(this.pointerLockRetryTimer);
      this.pointerLockRetryTimer = null;
    }
  }
}
