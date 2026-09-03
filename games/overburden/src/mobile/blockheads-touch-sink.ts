// ============================================================================
// BlockheadsInputSink — TouchInputSink for overburden's BlockheadsInputState
// ============================================================================
//
// Overburden does NOT use the engine InputBufferWriter (SAB). It has a custom
// `BlockheadsInputState` (a plain object from createInputHandler(canvas)),
// exposed via renderer.getInput(). The renderer's updateInput() reads
// input.left/right/up/down/jump/mouseDown/mouseRight/mouseX/mouseY/zoomDelta/
// selectedSlot each frame and writes them into the sim input SAB.
//
// This sink writes touch input to that same BlockheadsInputState object, so
// the renderer's per-frame read picks it up and forwards it to the sim —
// composing correctly with no clobbering (both the touch adapter and the
// renderer use the same source object, unlike writing to the SAB directly
// which the renderer would overwrite).

import type { TouchInputSink, MovementState } from "@downdraft/app/mobile";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";
import type { BlockheadsInputState } from "../renderer/input-handler";

/**
 * TouchInputSink that writes to overburden's BlockheadsInputState.
 *
 * Constructed in mobile.tsx's `sinkFactory` (which receives the GameContext
 * after the renderer is created) and passed to createDowndraftMobileApp's
 * touchInput.sinkFactory.
 */
export class BlockheadsInputSink implements TouchInputSink {
  private renderer: BlockheadsRenderer;

  constructor(renderer: BlockheadsRenderer) {
    this.renderer = renderer;
  }

  private input(): BlockheadsInputState | null {
    return this.renderer.getInput();
  }

  setMovement(state: MovementState): void {
    const i = this.input();
    if (!i) return;
    // BlockheadsInputState uses up/down/left/right/jump (not forward/back).
    i.up = state.forward;
    i.down = state.back;
    i.left = state.left;
    i.right = state.right;
    i.jump = state.jump;
  }

  setPointer(x: number, y: number): void {
    const i = this.input();
    if (!i) return;
    i.mouseX = x;
    i.mouseY = y;
  }

  setLookDelta(_dx: number, _dy: number): void {
    // Overburden is a 2D side-view game — no drag-look. The right-half touch
    // in dual-stick mode sets the pointer position instead (handled by the
    // adapter's tap-to-move path). This is a no-op.
  }

  setMouseButton(button: number, pressed: boolean): void {
    const i = this.input();
    if (!i) return;
    if (button === 0) i.mouseDown = pressed;
    else if (button === 2) i.mouseRight = pressed;
    // button === 1 (middle) → panning; not exposed via touch.
  }

  setZoom(delta: number): void {
    const i = this.input();
    if (!i) return;
    // BlockheadsInputState.zoomDelta accumulates wheel steps (positive = in).
    i.zoomDelta += delta;
  }

  setHotbarSlot(slot: number): void {
    const i = this.input();
    if (!i) return;
    // selectedSlot is 0-indexed (0..8). The renderer reads it each frame and
    // writes it to the sim SAB + forwards it to the pixi-ui hotbar display.
    i.selectedSlot = slot;
  }
}
