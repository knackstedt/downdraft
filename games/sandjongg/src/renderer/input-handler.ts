// ============================================================================
// Input handler — pointer events on the tile canvas overlay.
//
// Left click (button 0) selects/matches tiles. Right-drag (button 2) or
// middle-drag (button 1) pans the view when the board is larger than the
// viewport. Pan deltas are accumulated and consumed by the renderer each frame.
// ============================================================================

import { getDpr } from "@downdraft/core";

export interface InputHandler {
  mouseX: number;
  mouseY: number;
  /** True when a new left-button click occurred (consumed by the renderer). */
  hasClick: boolean;
  /** Accumulated pan delta (canvas px) since the last consumePanDelta() call. */
  panDeltaX: number;
  panDeltaY: number;
  /** True while a pan drag is in progress. */
  isPanning: boolean;
  /** Read and reset the accumulated pan delta. */
  consumePanDelta(): { dx: number; dy: number };
  destroy(): void;
}

export function createInputHandler(canvas: HTMLCanvasElement): InputHandler {
  const state: InputHandler = {
    mouseX: 0,
    mouseY: 0,
    hasClick: false,
    panDeltaX: 0,
    panDeltaY: 0,
    isPanning: false,
    consumePanDelta() {
      const dx = state.panDeltaX;
      const dy = state.panDeltaY;
      state.panDeltaX = 0;
      state.panDeltaY = 0;
      return { dx, dy };
    },
    destroy() {},
  };

  const getCanvasPos = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const dpr = getDpr();
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  };

  // Right-drag (button 2) and middle-drag (button 1) pan the view.
  const isPanButton = (e: PointerEvent): boolean => e.button === 1 || e.button === 2;

  const onPointerDown = (e: PointerEvent): void => {
    const pos = getCanvasPos(e);
    state.mouseX = pos.x;
    state.mouseY = pos.y;
    if (isPanButton(e)) {
      state.isPanning = true;
      // Prevent the canvas from losing pointer capture mid-drag.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    } else if (e.button === 0) {
      state.hasClick = true;
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const pos = getCanvasPos(e);
    if (state.isPanning) {
      // Compute the pan delta from the absolute position change rather than
      // e.movementX/movementY — position-delta is equivalent and robust to
      // synthetic/forwarded events that carry zero movement.
      state.panDeltaX += pos.x - state.mouseX;
      state.panDeltaY += pos.y - state.mouseY;
    }
    state.mouseX = pos.x;
    state.mouseY = pos.y;
  };

  const endPan = (e: PointerEvent): void => {
    if (state.isPanning) {
      state.isPanning = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  };

  const onPointerUp = (e: PointerEvent): void => endPan(e);
  const onPointerCancel = (e: PointerEvent): void => endPan(e);

  // Suppress the browser context menu so right-drag can pan freely.
  const onContextMenu = (e: MouseEvent): void => { e.preventDefault(); };

  canvas.style.pointerEvents = "auto";
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("contextmenu", onContextMenu);

  state.destroy = () => {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };

  return state;
}
