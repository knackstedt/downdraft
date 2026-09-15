// ============================================================================
// Falling-sand input handler — thin adapter over core's createDomInputHandler.
//
// The DOM event wiring (keyMap, mouse buttons, canvas-space coords,
// contextmenu suppression, destroy) is engine-provided; this file exposes the
// legacy flat-field shape the renderer reads each frame plus the game-owned
// brush fields (selectedMaterial, brushRadius).
// ============================================================================

import { createDomInputHandler, type DomInputHandler } from "@downdraft/core";

export interface FallingSandInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  mouseDown: boolean;
  mouseRight: boolean;
  mouseMiddle: boolean;
  /** Mouse position in canvas backing-store pixels. */
  mouseX: number;
  mouseY: number;
  /** Game-owned brush state (synced from the store by the renderer). */
  selectedMaterial: number;
  brushRadius: number;
  /** Underlying engine handler (update()/injectInput()/destroy()). */
  readonly handler: DomInputHandler;
  /** Apply queued MCP-injected input frames. Call once per frame. */
  update(): void;
  /** Remove DOM listeners (hot-reload safe). */
  destroy(): void;
}

export function createInputHandler(canvas: HTMLCanvasElement): FallingSandInput {
  const handler = createDomInputHandler({
    canvas,
    preset: "wasd", // a/d/w/s/arrows + space → left/right/up/down/jump
    mouseCoords: "canvas", // backing-store pixels (renderer maps to grid coords)
    centerInitialMouse: false,
    wheel: false,
  });
  const { state } = handler;

  return {
    get left() { return handler.held.left ?? false; },
    get right() { return handler.held.right ?? false; },
    get up() { return handler.held.up ?? false; },
    get down() { return handler.held.down ?? false; },
    get jump() { return handler.held.jump ?? false; },
    get mouseDown() { return state.isMouseDown(0); },
    get mouseRight() { return state.isMouseDown(2); },
    get mouseMiddle() { return state.isMouseDown(1); },
    get mouseX() { return state.mouseX; },
    get mouseY() { return state.mouseY; },
    selectedMaterial: 1,
    brushRadius: 3,
    handler,
    update: () => handler.update(),
    destroy: () => handler.destroy(),
  };
}
