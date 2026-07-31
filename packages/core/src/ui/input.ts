import type { InputState } from "../input/state.ts";
import type { UIElement, UIRoot } from "./element.ts";

export class UIInputRouter {
  private root: UIRoot | null = null;
  private inputState: InputState | null = null;
  private focusedElement: UIElement | null = null;
  private hoveredElement: UIElement | null = null;
  private pressedElement: UIElement | null = null;
  private lastMouseX: number = -1;
  private lastMouseY: number = -1;
  private wasMouseDown: boolean = false;

  setRoot(root: UIRoot | null): void {
    this.root = root;
    if (!root) {
      this.focusedElement = null;
      this.hoveredElement = null;
      this.pressedElement = null;
    }
  }

  getRoot(): UIRoot | null {
    return this.root;
  }

  setInputState(state: InputState | null): void {
    this.inputState = state;
  }

  getFocusedElement(): UIElement | null {
    return this.focusedElement;
  }

  update(): void {
    if (!this.root || !this.inputState) return;

    const mx = this.inputState.mouseX;
    const my = this.inputState.mouseY;
    const mouseDown = this.inputState.isMouseDown(0);
    const mousePressed = this.inputState.wasMousePressed(0);
    const mouseReleased = this.inputState.wasMouseReleased(0);

    if (mx !== this.lastMouseX || my !== this.lastMouseY) {
      this.lastMouseX = mx;
      this.lastMouseY = my;
      this.updateHover(mx, my);
    }

    if (mousePressed) {
      this.handlePress(mx, my);
    }

    if (mouseReleased) {
      this.handleRelease(mx, my);
    }

    this.wasMouseDown = mouseDown;
  }

  handleKeyDown(code: number): void {
    if (this.focusedElement) {
      this.focusedElement.callbacks.onKeyDown?.(this.focusedElement, code);
    }
  }

  handleKeyUp(code: number): void {
    if (this.focusedElement) {
      this.focusedElement.callbacks.onKeyUp?.(this.focusedElement, code);
    }
  }

  handleMouseMove(mx: number, my: number): void {
    if (mx !== this.lastMouseX || my !== this.lastMouseY) {
      this.lastMouseX = mx;
      this.lastMouseY = my;
      this.updateHover(mx, my);
    }
  }

  handleMouseDown(mx: number, my: number): void {
    this.handlePress(mx, my);
  }

  handleMouseUp(mx: number, my: number): void {
    this.handleRelease(mx, my);
  }

  private updateHover(mx: number, my: number): void {
    if (!this.root) return;
    const hit = this.root.hitTest(mx, my);

    if (this.hoveredElement !== hit) {
      this.hoveredElement?.setHovered(false);
      this.hoveredElement = hit;
      this.hoveredElement?.setHovered(true);
    }
  }

  private handlePress(mx: number, my: number): void {
    if (!this.root) return;
    const hit = this.root.hitTest(mx, my);

    if (hit) {
      hit.setPressed(true);
      this.pressedElement = hit;

      if (hit.focusable) {
        if (this.focusedElement !== hit) {
          this.focusedElement?.setFocused(false);
          this.focusedElement = hit;
          hit.setFocused(true);
        }
      } else if (this.focusedElement) {
        this.focusedElement.setFocused(false);
        this.focusedElement = null;
      }
    } else if (this.focusedElement) {
      this.focusedElement.setFocused(false);
      this.focusedElement = null;
    }
  }

  private handleRelease(mx: number, my: number): void {
    if (!this.root) return;
    const hit = this.root.hitTest(mx, my);

    if (this.pressedElement) {
      this.pressedElement.setPressed(false);
      if (this.pressedElement === hit) {
        this.pressedElement.callbacks.onClick?.(this.pressedElement);
      }
      this.pressedElement = null;
    }
  }

  clearFocus(): void {
    if (this.focusedElement) {
      this.focusedElement.setFocused(false);
      this.focusedElement = null;
    }
  }
}
