// ============================================================================
// UIInputRouter — UI-agnostic input router contract.
//
// The InputManager delivers window-level pointer/wheel/key events (already
// converted to canvas backing-pixel coordinates) to the active UI router.
// Concrete UI stacks subclass this: the Blitz/html-ui router forwards into the
// wasm document; a stack with no pointer-interactive UI can use the base class
// (which only tracks the pointer position).
// ============================================================================

import type { InputState } from "./state";

export class UIInputRouter {
  protected inputState: InputState | null = null;
  protected lastMouseX = -1;
  protected lastMouseY = -1;

  /** Optional live input state — when set, update() syncs pointer tracking. */
  setInputState(state: InputState | null): void {
    this.inputState = state;
  }

  /** Last known pointer position in CSS pixels (-1,-1 before first event). */
  getPointerPos(): [number, number] {
    return [this.lastMouseX, this.lastMouseY];
  }

  /**
   * True when the pointer is currently over an interactive UI element.
   * Stacks override `hitTest`; the base class reports no hit.
   */
  isPointerOverUI(): boolean {
    return this.lastMouseX >= 0 && this.hitTest(this.lastMouseX, this.lastMouseY);
  }

  /** Hit-test hook — override to consult the live UI document. */
  protected hitTest(_x: number, _y: number): boolean {
    return false;
  }

  /** Per-frame sync from InputState (used by InputContextRouter). */
  update(): void {
    const s = this.inputState;
    if (!s) return;
    const mx = s.mouseX;
    const my = s.mouseY;
    if (mx !== this.lastMouseX || my !== this.lastMouseY) {
      this.handleMouseMove(mx, my);
    }
    if (s.wasMousePressed(0)) this.handleMouseDown(mx, my);
    if (s.wasMouseReleased(0)) this.handleMouseUp(mx, my);
  }

  handleKeyDown(_code: number): void {}
  handleKeyUp(_code: number): void {}
  /** Printable character (text inputs). */
  handleCharInput(_char: string): void {}

  /**
   * Wheel routing. Returns true when the UI consumed the event (suppresses
   * page/canvas scroll handlers behind a scrollable panel).
   */
  handleWheel(_dx: number, _dy: number): boolean {
    return false;
  }

  handleMouseMove(mx: number, my: number): void {
    this.lastMouseX = mx;
    this.lastMouseY = my;
  }

  handleMouseDown(mx: number, my: number): void {
    this.lastMouseX = mx;
    this.lastMouseY = my;
  }

  handleMouseUp(mx: number, my: number): void {
    this.lastMouseX = mx;
    this.lastMouseY = my;
  }

  /** Pointer left the canvas — clears pointer tracking. */
  handlePointerLeave(): void {
    this.lastMouseX = -1;
    this.lastMouseY = -1;
  }
}
