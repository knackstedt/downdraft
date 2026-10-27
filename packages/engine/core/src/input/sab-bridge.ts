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
    const controllerButtons = data.controllerButtons as number[];
    const controllerAxes = data.controllerAxes as number[];

    // Process keyboard — diff against current state
    const incomingKeys = new Set(keys.filter((k) => k !== 0));
    for (const code of incomingKeys.values()) {
      if (!this.state.isKeyDown(code)) {
        this.state.keyDown(code);
      }
    }
    for (const code of this.state.keys.values()) {
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

    // controllerButtons is the u32 bitmask pair [lo, hi] (W3C standard order).
    const lo = (controllerButtons[0] ?? 0) >>> 0;
    const hi = (controllerButtons[1] ?? 0) >>> 0;
    const incomingController = new Set<number>();
    for (let b = 0; b < 32; b++) {
      if (lo & (1 << b)) incomingController.add(b);
      if (hi & (1 << b)) incomingController.add(32 + b);
    }
    for (const btn of incomingController.values()) {
      this.state.controllerButtons.add(btn);
    }
    for (const btn of this.state.controllerButtons.values()) {
      if (!incomingController.has(btn)) {
        this.state.controllerButtons.delete(btn);
      }
    }
    for (let i = 0; i < controllerAxes.length && i < this.state.controllerAxes.length; i++) {
      this.state.controllerAxes[i] = controllerAxes[i];
    }
  }
}
