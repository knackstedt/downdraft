import type { InputState } from "../index";
import type { UIElement, UIRoot } from "./element";

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

  /** Last known pointer position in CSS pixels (-1,-1 before first event). */
  getPointerPos(): [number, number] {
    return [this.lastMouseX, this.lastMouseY];
  }

  /**
   * True when the pointer is currently over any enabled UI element. Games
   * that paint/simulate on canvas clicks (falling-sand style) use this to
   * suppress canvas input while the pointer is over a panel.
   */
  isPointerOverUI(): boolean {
    if (!this.root || this.lastMouseX < 0) return false;
    const hit = this.root.hitTest(this.lastMouseX, this.lastMouseY);
    return hit !== null && hit !== this.root;
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

  /** Dispatch a printable character to the focused element (text inputs). */
  handleCharInput(char: string): void {
    const el = this.focusedElement;
    if (el && (el as any).handleCharInput) {
      (el as any).handleCharInput(char);
    }
  }

  /**
   * Route a wheel event to the nearest scrollable ancestor of the element
   * under the pointer (walks up the parent chain from the hit element).
   * Returns true when a scrollable consumed the event.
   */
  handleWheel(dx: number, dy: number): boolean {
    if (!this.root || this.lastMouseX < 0) return false;
    let el: UIElement | null = this.root.hitTest(this.lastMouseX, this.lastMouseY);
    while (el) {
      if ((el as any).handleWheel) {
        (el as any).handleWheel(dx, dy);
        return true;
      }
      el = el.parent;
    }
    return false;
  }

  handleMouseMove(mx: number, my: number): void {
    if (mx !== this.lastMouseX || my !== this.lastMouseY) {
      this.lastMouseX = mx;
      this.lastMouseY = my;
      this.updateHover(mx, my);
      // Drag support for sliders and other draggable elements
      if (this.pressedElement && (this.pressedElement as any).handleDrag) {
        (this.pressedElement as any).handleDrag(mx, my);
      }
    }
  }

  handleMouseDown(mx: number, my: number): void {
    this.handlePress(mx, my);
    // Slider press support
    if (this.pressedElement && (this.pressedElement as any).handlePress) {
      (this.pressedElement as any).handlePress(mx, my);
    }
  }

  handleMouseUp(mx: number, my: number): void {
    // Slider release support
    if (this.pressedElement && (this.pressedElement as any).handleRelease) {
      (this.pressedElement as any).handleRelease();
    }
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
    this.lastMouseX = mx;
    this.lastMouseY = my;
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

  /** Pointer left the canvas — clears hover + pointer position. */
  handlePointerLeave(): void {
    this.lastMouseX = -1;
    this.lastMouseY = -1;
    if (this.hoveredElement) {
      this.hoveredElement.setHovered(false);
      this.hoveredElement = null;
    }
  }

  /** Programmatically focus a focusable element (e.g. focus a search box
   *  when its dialog opens) — same path as a pointer press on it. */
  setFocus(el: UIElement | null): void {
    if (el === this.focusedElement) return;
    this.focusedElement?.setFocused(false);
    this.focusedElement = el && el.focusable ? el : null;
    this.focusedElement?.setFocused(true);
  }

  clearFocus(): void {
    this.setFocus(null);
  }
}
