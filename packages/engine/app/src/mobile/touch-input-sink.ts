// ============================================================================
// TouchInputSink — abstraction the TouchInputAdapter writes to
// ============================================================================
//
// Mobile devices have no keyboard, mouse, or pointer lock. The
// TouchInputAdapter translates touch events into a normalized input shape and
// forwards it to a `TouchInputSink`. This decouples the adapter from the
// concrete input representation a game uses:
//
//   - Engine SAB-based games (3D FPS/TPS using InputBufferWriter) use the
//     default `InputBufferWriterSink`, which wraps the engine's
//     InputBufferWriter and maps movement → KEY.W/A/S/D + SPACE, pointer →
//     setMousePos, look delta → setMouseDelta, mouse buttons →
//     setMouseButton, zoom → setWheel, hotbar → KEY.ONE..NINE.
//   - Games with a custom input state object (e.g. overburden's
//     `BlockheadsInputState`) implement `TouchInputSink` themselves and write
//     to their own state, which their renderer reads each frame.
//
// All methods are optional so a sink can implement only the subset it cares
// about (e.g. a 2D click-based game may only implement setPointer +
// setMouseButton).

import { InputBufferWriter, KEY } from "@downdraft/engine";

/** Normalized movement state. Forward/back map to W/S, left/right to A/D,
 *  jump to Space. */
export interface MovementState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

/**
 * Abstraction the TouchInputAdapter writes to. Games with custom input state
 * (e.g. overburden's `BlockheadsInputState`) implement this; the default
 * `InputBufferWriterSink` wraps the engine `InputBufferWriter` for SAB-based
 * 3D games.
 *
 * All methods are optional — a sink implements only the subset it uses.
 */
export interface TouchInputSink {
  /** Set movement key state (W/A/S/D + jump). */
  setMovement?(state: MovementState): void;
  /** Set the pointer (mouse) position in canvas pixels. */
  setPointer?(x: number, y: number): void;
  /** Accumulate a look/camera delta (e.g. drag-look). */
  setLookDelta?(dx: number, dy: number): void;
  /** Set a mouse button state. button: 0 = left (mine), 1 = middle, 2 = right (place). */
  setMouseButton?(button: number, pressed: boolean): void;
  /** Accumulate a zoom delta. Positive = zoom in, negative = zoom out. */
  setZoom?(delta: number): void;
  /** Select a hotbar slot (0-indexed, 0..8). */
  setHotbarSlot?(slot: number): void;
}

/** The default sink: wraps the engine `InputBufferWriter` (SAB) and maps the
 *  normalized touch input onto the engine's key/mouse/wheel SAB layout.
 *
 *  Used by 3D/SAB-based games (e.g. to-the-ocean). Games with custom input
 *  state provide their own `TouchInputSink` and do not use this class. */
export class InputBufferWriterSink implements TouchInputSink {
  private writer: InputBufferWriter;
  private playerIdx = 0;
  private movement: MovementState = {
    forward: false, back: false, left: false, right: false, jump: false,
  };

  constructor(writer: InputBufferWriter) {
    this.writer = writer;
  }

  setMovement(state: MovementState): void {
    this.movement = { ...state };
    const w = this.writer, p = this.playerIdx;
    w.setKey(p, KEY.W, state.forward);
    w.setKey(p, KEY.S, state.back);
    w.setKey(p, KEY.A, state.left);
    w.setKey(p, KEY.D, state.right);
    w.setKey(p, KEY.SPACE, state.jump);
  }

  setPointer(x: number, y: number): void {
    this.writer.setMousePos(this.playerIdx, x, y);
  }

  setLookDelta(dx: number, dy: number): void {
    this.writer.setMouseDelta(this.playerIdx, dx, dy);
  }

  setMouseButton(button: number, pressed: boolean): void {
    this.writer.setMouseButton(this.playerIdx, button, pressed);
  }

  setZoom(delta: number): void {
    // setWheel accumulates; positive deltaY = scroll up = zoom in for the
    // engine's InputManager. We pass delta through directly.
    this.writer.setWheel(this.playerIdx, delta);
  }

  setHotbarSlot(slot: number): void {
    // KEY.ONE=49 .. KEY.NINE=57 map to slots 0..8.
    const key = KEY.ONE + slot;
    // Press + release the key so the game's keydown handler fires once.
    this.writer.setKey(this.playerIdx, key, true);
    this.writer.setKey(this.playerIdx, key, false);
  }

  /** Current movement state (read by the OSD to draw the joystick thumb). */
  getMovement(): MovementState {
    return this.movement;
  }
}

/** A no-op sink used when no input writer is available (e.g. misconfigured
 *  mobile entry). All methods are safe no-ops so the adapter/OSD still render
 *  without throwing. */
export class NullTouchInputSink implements TouchInputSink {
  setMovement(): void {}
  setPointer(): void {}
  setLookDelta(): void {}
  setMouseButton(): void {}
  setZoom(): void {}
  setHotbarSlot(): void {}
}
