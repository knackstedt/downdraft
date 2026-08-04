import { CoreInputChannel } from "../sab/core-input-channel";
import { InputState } from "./state";

export class InputSABBridge {
  private reader: ReturnType<typeof CoreInputChannel.reader>;
  private state: InputState;

  constructor(sab: SharedArrayBuffer, state: InputState) {
    this.reader = CoreInputChannel.reader(sab);
    this.state = state;
  }

  poll(): void {
    const data = this.reader.snapshot();
    if (!data) return;

    const keys = data.keys as number[];
    const mouseX = data.mouseX as number;
    const mouseY = data.mouseY as number;
    const mouseDeltaX = data.mouseDeltaX as number;
    const mouseDeltaY = data.mouseDeltaY as number;
    const mouseButtons = data.mouseButtons as number[];
    const wheelDelta = data.wheelDelta as number;
    const gamepadButtons = data.gamepadButtons as number[];
    const gamepadAxes = data.gamepadAxes as number[];

    // Process keyboard — diff against current state
    const incomingKeys = new Set(keys.filter((k) => k !== 0));
    for (const code of incomingKeys) {
      if (!this.state.isKeyDown(code)) {
        this.state.keyDown(code);
      }
    }
    for (const code of this.state.keys) {
      if (!incomingKeys.has(code)) {
        this.state.keyUp(code);
      }
    }

    this.state.mouseMove(mouseX, mouseY, mouseDeltaX, mouseDeltaY);
    this.state.wheel(wheelDelta);

    for (let i = 0; i < mouseButtons.length; i++) {
      if (mouseButtons[i] && !this.state.mouseButtons.has(i)) {
        this.state.mouseDown(i);
      } else if (!mouseButtons[i] && this.state.mouseButtons.has(i)) {
        this.state.mouseUp(i);
      }
    }

    const incomingGamepad = new Set(gamepadButtons.filter((b) => b !== 0).map((b, i) => i));
    for (const btn of incomingGamepad) {
      this.state.gamepadButtons.add(btn);
    }
    for (const btn of this.state.gamepadButtons) {
      if (!incomingGamepad.has(btn)) {
        this.state.gamepadButtons.delete(btn);
      }
    }
    for (let i = 0; i < gamepadAxes.length && i < this.state.gamepadAxes.length; i++) {
      this.state.gamepadAxes[i] = gamepadAxes[i];
    }
  }
}
