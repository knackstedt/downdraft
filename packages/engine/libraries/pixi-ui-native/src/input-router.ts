// ============================================================================
// input-router.ts — routes native pointer events to PixiJS's EventSystem
// when interactive UI (menus, overlays) is visible, so @pixi/react components
// with eventMode receive pointer events for hit-testing + click handling.
//
// When no overlay is interactive (or a pointer-down misses every UI element),
// events pass through to the game's input handler — the router doesn't
// interfere.
//
// Mirrors the browser pixi-ui worker's handlePointer() synthetic event
// approach, but runs in-process on the main thread.
// ============================================================================

import type { NativePixiUiHost } from "./host";

export interface NativePixiInputRouterOptions {
  /**
   * Gate that decides whether the UI should receive pointer events at all
   * (e.g. "a menu is open"). When omitted, the router hit-tests every
   * pointer-down — fine for always-interactive UIs, wasteful for pure HUDs
   * (give it a cheap store check).
   */
  isInteractive?: () => boolean;
}

export class NativePixiInputRouter {
  private pixiUi: NativePixiUiHost;
  private isInteractiveFn: () => boolean;
  /** Swapchain surface dimensions (the space SDL/clientX events arrive in).
   *  The UI texture is stretched over the whole surface by UiBlitPass, so
   *  surface coords must be scaled into stage coords before hit-testing. */
  private surfW: number;
  private surfH: number;
  // Track whether the current drag started on a UI element (for pass-through),
  // and which buttons are held (slider drags check e.buttons).
  private dragOnUi = false;
  private dragButtons = 0;

  constructor(pixiUi: NativePixiUiHost, surfaceW: number, surfaceH: number, opts?: NativePixiInputRouterOptions) {
    this.pixiUi = pixiUi;
    this.surfW = surfaceW;
    this.surfH = surfaceH;
    this.isInteractiveFn = opts?.isInteractive ?? (() => true);
  }

  /** Called with the swapchain surface size on window resize. */
  resize(width: number, height: number): void {
    this.surfW = width;
    this.surfH = height;
  }

  /** Map a surface-space point into UI stage space. */
  private toStage(x: number, y: number): { x: number; y: number } {
    const screen = (this.pixiUi.renderer as any)?.screen;
    const sw = screen?.width || this.surfW;
    const sh = screen?.height || this.surfH;
    if (!this.surfW || !this.surfH) return { x, y };
    return { x: x * sw / this.surfW, y: y * sh / this.surfH };
  }

  /** Returns true if the event was consumed by the UI (caller should not
   *  forward it to the game's input handler). */
  handlePointerDown(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.isInteractiveFn()) return false;
    const eventSystem = this.pixiUi.events;
    if (!eventSystem) return false;

    const p = this.toStage(x, y);
    // Hit-test: does this position hit an interactive PixiJS element?
    const hit = this.hitTest(p.x, p.y);
    if (!hit) {
      this.dragOnUi = false;
      return false; // miss — let the game handle it
    }
    this.dragOnUi = true;
    this.dragButtons = button === 0 ? 1 : button === 2 ? 2 : 4;
    this.dispatchSynthetic("pointerdown", p.x, p.y, button, modifiers);
    return true;
  }

  handlePointerMove(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.dragOnUi) return false;
    const p = this.toStage(x, y);
    this.dispatchSynthetic("pointermove", p.x, p.y, button, modifiers);
    return true;
  }

  handlePointerUp(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.dragOnUi) return false;
    const p = this.toStage(x, y);
    this.dispatchSynthetic("pointerup", p.x, p.y, button, modifiers);
    this.dragOnUi = false;
    this.dragButtons = 0;
    return true;
  }

  handleWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers: number): boolean {
    if (!this.isInteractiveFn()) return false;
    const p = this.toStage(x, y);
    if (!this.hitTest(p.x, p.y)) return false;
    this.dispatchSyntheticWheel(p.x, p.y, deltaX, deltaY, modifiers);
    return true;
  }

  /** PixiJS hit-test at stage coordinates. Returns the hit target or null. */
  private hitTest(x: number, y: number): unknown {
    const eventSystem = this.pixiUi.events as any;
    if (!eventSystem) return null;
    const rootBoundary = eventSystem.rootBoundary;
    if (!rootBoundary || typeof rootBoundary.hitTest !== "function") return null;
    // EventSystem only assigns rootBoundary.rootTarget inside its real DOM
    // event handlers (onPointerDown & co.). Our events are synthesized, so
    // rootTarget is never set — bind it to the rendered root ourselves.
    if (!rootBoundary.rootTarget) {
      rootBoundary.rootTarget =
        (this.pixiUi.renderer as any)?.lastObjectRendered ?? (this.pixiUi as any).app?.stage;
    }
    if (!rootBoundary.rootTarget) return null;
    try {
      return rootBoundary.hitTest(x, y);
    } catch {
      return null;
    }
  }

  /** Dispatch a synthetic pointer event to PixiJS's EventSystem.
   *  Mirrors the browser pixi-ui worker's handlePointer() approach. */
  private dispatchSynthetic(
    type: string, x: number, y: number, button: number, modifiers: number,
  ): void {
    const eventSystem = this.pixiUi.events as any;
    if (!eventSystem) return;
    const domElement = eventSystem.domElement ?? this.pixiUi.canvas;
    const resolution = (this.pixiUi.renderer as any).resolution ?? 1;
    // Scale CSS-pixel coords to backing-store px (PixiJS's mapPositionToPoint
    // divides by resolution, so this cancels out).
    const px = x * resolution;
    const py = y * resolution;

    const syntheticEvent = {
      type,
      pointerId: 1,
      pointerType: "mouse",
      clientX: px,
      clientY: py,
      button,
      buttons: type === "pointerup" ? 0 : this.dragButtons,
      shiftKey: (modifiers & 1) !== 0,
      ctrlKey: (modifiers & 2) !== 0,
      altKey: (modifiers & 4) !== 0,
      metaKey: (modifiers & 8) !== 0,
      preventDefault: () => {},
      stopPropagation: () => {},
      nativeEvent: null,
      isTrusted: true,
      offsetX: px,
      offsetY: py,
      pageX: px,
      pageY: py,
      target: domElement,
      composedPath: () => [domElement],
      cancelable: true,
      isPrimary: true,
      width: 1,
      height: 1,
      tiltX: 0,
      tiltY: 0,
      pressure: 0.5,
      twist: 0,
      tangentialPressure: 0,
    };

    // PixiJS v8 EventSystem handler entry points. These normalize the event,
    // bind rootTarget, and dispatch the federated pointer event.
    const HANDLERS: Record<string, string> = {
      pointerdown: "_onPointerDown",
      pointermove: "_onPointerMove",
      pointerup: "_onPointerUp",
      wheel: "onWheel",
    };
    const handler = (eventSystem as any)[HANDLERS[type]] as ((e: any) => void) | undefined;
    if (typeof handler === "function") {
      try { handler.call(eventSystem, syntheticEvent); } catch { /* ignore */ }
    }
  }

  /** Wheel events carry deltas instead of a button. */
  private dispatchSyntheticWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers: number): void {
    const eventSystem = this.pixiUi.events as any;
    if (!eventSystem || typeof eventSystem.onWheel !== "function") return;
    const domElement = eventSystem.domElement ?? this.pixiUi.canvas;
    const resolution = (this.pixiUi.renderer as any).resolution ?? 1;
    const px = x * resolution;
    const py = y * resolution;
    try {
      eventSystem.onWheel({
        type: "wheel",
        pointerId: 1,
        pointerType: "mouse",
        clientX: px,
        clientY: py,
        deltaX, deltaY, deltaMode: 0,
        shiftKey: (modifiers & 1) !== 0,
        ctrlKey: (modifiers & 2) !== 0,
        altKey: (modifiers & 4) !== 0,
        metaKey: (modifiers & 8) !== 0,
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: null,
        isTrusted: true,
        offsetX: px,
        offsetY: py,
        pageX: px,
        pageY: py,
        target: domElement,
        composedPath: () => [domElement],
        cancelable: true,
        isPrimary: true,
      });
    } catch { /* ignore */ }
  }
}
