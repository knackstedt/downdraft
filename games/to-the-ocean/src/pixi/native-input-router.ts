// ============================================================================
// native-input-router — routes SDL mouse events to PixiJS's EventSystem when
// interactive UI (menus, overlays) is visible, so @pixi/react components
// with eventMode receive pointer events for hit-testing + click handling.
//
// When no overlay is open, events pass through to the game's input handler
// (camera look, movement, etc.) — the router doesn't interfere.
//
// Mirrors the browser pixi-ui worker's handlePointer() synthetic event
// approach, but runs in-process on the main thread.
// ============================================================================

import type { NativePixiUiHost } from "@downdraft/library-pixi-ui-native";
import { useGameStore } from "../stores/game-store";

export class NativeInputRouter {
  private pixiUi: NativePixiUiHost;
  private canvasW: number;
  private canvasH: number;
  // Track whether the current drag started on a UI element (for pass-through).
  private dragOnUi = false;

  constructor(pixiUi: NativePixiUiHost, canvasW: number, canvasH: number) {
    this.pixiUi = pixiUi;
    this.canvasW = canvasW;
    this.canvasH = canvasH;
  }

  resize(width: number, height: number): void {
    this.canvasW = width;
    this.canvasH = height;
  }

  /** Returns true if the event was consumed by the UI (caller should not
   *  forward it to the game's input handler). */
  handlePointerDown(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.isInteractive()) return false;
    const eventSystem = this.pixiUi.events;
    if (!eventSystem) return false;

    // Hit-test: does this position hit an interactive PixiJS element?
    const hit = this.hitTest(x, y);
    if (!hit) {
      this.dragOnUi = false;
      return false; // miss — let the game handle it
    }
    this.dragOnUi = true;
    this.dispatchSynthetic("pointerdown", x, y, button, modifiers);
    return true;
  }

  handlePointerMove(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.dragOnUi) return false;
    this.dispatchSynthetic("pointermove", x, y, button, modifiers);
    return true;
  }

  handlePointerUp(x: number, y: number, button: number, modifiers: number): boolean {
    if (!this.dragOnUi) return false;
    this.dispatchSynthetic("pointerup", x, y, button, modifiers);
    this.dragOnUi = false;
    return true;
  }

  /** True when any menu/overlay is open and the PixiJS UI should receive
   *  pointer events instead of the game. */
  private isInteractive(): boolean {
    const s = useGameStore.getState();
    return s.showInventory || s.showMap || s.showBuildMenu || s.showCraftMenu ||
      s.showFishingMinigame || s.showTradeMenu || s.showSettings ||
      s.showPauseMenu || s.showCharacterCustomization || s.showCredits ||
      s.showBuilderWheel;
  }

  /** PixiJS hit-test at canvas coordinates. Returns the hit target or null. */
  private hitTest(x: number, y: number): unknown {
    const eventSystem = this.pixiUi.events as any;
    if (!eventSystem) return null;
    const rootBoundary = eventSystem.rootBoundary;
    if (!rootBoundary || typeof rootBoundary.hitTest !== "function") return null;
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
      buttons: type === "pointerdown" ? (button === 0 ? 1 : button === 2 ? 2 : 4) : 0,
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

    // PixiJS v8's EventSystem handler methods are underscore-prefixed.
    const handler = (eventSystem as any)["_" + type] as ((e: any) => void) | undefined;
    if (typeof handler === "function") {
      try { handler.call(eventSystem, syntheticEvent); } catch { /* ignore */ }
    }
  }
}
