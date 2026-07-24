import { SeqlockBuffer } from "../sab/seqlock.ts";
import { CHANNEL_LAYOUTS } from "../sab/protocol.ts";
import { InputState } from "./state.ts";

export class InputSABBridge {
  private buf: SeqlockBuffer;
  private state: InputState;

  constructor(sab: SharedArrayBuffer, state: InputState) {
    this.buf = new SeqlockBuffer(sab, CHANNEL_LAYOUTS.input);
    this.state = state;
  }

  poll(): void {
    const data = this.buf.read();
    if (!data) return;

    const keys = data.keys as number[];
    const mouseX = data.mouseX as number;
    const mouseY = data.mouseY as number;
    const mouseDeltaX = data.mouseDeltaX as number;
    const mouseDeltaY = data.mouseDeltaY as number;
    const mouseButtons = data.mouseButtons as number[];
    const wheelDelta = data.wheelDelta as number;

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
  }
}
