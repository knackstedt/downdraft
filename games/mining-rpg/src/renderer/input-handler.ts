// ============================================================================
// Input handler — thin adapter over core's createDomInputHandler.
//
// The DOM event wiring (keyMap, mouse buttons, canvas coords, contextmenu
// suppression, destroy) is engine-provided; this file exposes the legacy
// flat-field shape the renderer reads each frame plus the game-owned fields
// (digRadius, zoomDelta, fPressed/gPressed/f1Pressed edge flags).
// ============================================================================

import { createDomInputHandler, type DomInputHandler } from "@downdraft/core";

export interface MiningInputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  mouseDown: boolean;
  mouseRight: boolean;
  mouseX: number; // screen pixels
  mouseY: number; // screen pixels
  digRadius: number;
  // Accumulated zoom steps since the last frame. Each "=" keydown adds +1,
  // each "-" keydown adds -1 (OS key-repeat produces a steady stream while
  // held). The renderer drains this each frame and applies
  //   zoom *= ZOOM_STEP_FACTOR ^ zoomDelta
  // then resets it to 0.
  zoomDelta: number;
  // Edge-triggered: set true on F keydown, consumed by the renderer each frame.
  fPressed: boolean;
  // Edge-triggered: set true on G keydown, consumed by the renderer each frame.
  gPressed: boolean;
  // Edge-triggered: set true on F1 keydown, consumed by the renderer each
  // frame. Toggles fog-of-war + shadows (lighting) off for debugging.
  f1Pressed: boolean;
  /** Underlying engine handler (update()/injectInput()/destroy()). */
  readonly handler: DomInputHandler;
  /** Apply queued MCP-injected input frames. Call once per frame. */
  update(): void;
  /** Remove DOM listeners (hot-reload safe). */
  destroy(): void;
}

export function createMiningInputHandler(canvas: HTMLCanvasElement): MiningInputState {
  // Game-owned fields not covered by the shared handler.
  const game = {
    digRadius: 3,
    zoomDelta: 0,
    fPressed: false,
    gPressed: false,
    f1Pressed: false,
  };

  const handler = createDomInputHandler({
    canvas,
    preset: "wasd", // a/d/w/s/arrows + space → left/right/up/down/jump
    mouseCoords: "css", // screen pixels (renderer maps through the camera)
    wheel: false,
    onKeyPress: {
      // Zoom controls — "=" (and "+", the shifted form on most layouts) zoom
      // in, "-" zooms out. keydown repeats while held, which produces a
      // smooth, OS-throttled zoom stream.
      "=": (e) => { game.zoomDelta += 1; e.preventDefault(); },
      "+": (e) => { game.zoomDelta += 1; e.preventDefault(); },
      "-": (e) => { game.zoomDelta -= 1; e.preventDefault(); },
      "_": (e) => { game.zoomDelta -= 1; e.preventDefault(); },
      // Edge-triggered: set true, renderer consumes and resets to false.
      f: (e) => { game.fPressed = true; e.preventDefault(); },
      F: (e) => { game.fPressed = true; e.preventDefault(); },
      g: () => { game.gPressed = true; },
      G: () => { game.gPressed = true; },
      // Edge-triggered: toggle fog-of-war + shadows. preventDefault stops the
      // browser from opening its own help overlay.
      F1: (e) => { game.f1Pressed = true; e.preventDefault(); },
    },
  });
  const { held, state } = handler;

  return {
    get left() { return held.left ?? false; },
    get right() { return held.right ?? false; },
    get up() { return held.up ?? false; },
    get down() { return held.down ?? false; },
    get jump() { return held.jump ?? false; },
    get mouseDown() { return state.isMouseDown(0); },
    get mouseRight() { return state.isMouseDown(2); },
    get mouseX() { return state.mouseX; },
    get mouseY() { return state.mouseY; },
    get digRadius() { return game.digRadius; },
    set digRadius(v: number) { game.digRadius = v; },
    get zoomDelta() { return game.zoomDelta; },
    set zoomDelta(v: number) { game.zoomDelta = v; },
    get fPressed() { return game.fPressed; },
    set fPressed(v: boolean) { game.fPressed = v; },
    get gPressed() { return game.gPressed; },
    set gPressed(v: boolean) { game.gPressed = v; },
    get f1Pressed() { return game.f1Pressed; },
    set f1Pressed(v: boolean) { game.f1Pressed = v; },
    handler,
    update: () => handler.update(),
    destroy: () => handler.destroy(),
  };
}
