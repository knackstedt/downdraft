import { CoreInputChannel } from "./core-input-channel";

export class InputSABChannel {
  private writer: ReturnType<typeof CoreInputChannel.writer>;
  private sab: SharedArrayBuffer;

  constructor(sab?: SharedArrayBuffer) {
    this.sab = sab ?? CoreInputChannel.allocate();
    this.writer = CoreInputChannel.writer(this.sab);
  }

  getBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  write(
    keys: number[],
    mouseX: number,
    mouseY: number,
    mouseDeltaX: number,
    mouseDeltaY: number,
    mouseButtons: number[],
    wheelDelta: number,
    gamepadButtons: number[],
    gamepadAxes: number[],
  ): void {
    const w = this.writer;

    for (let i = 0; i < 8; i++) {
      (w.fields.keys as Int32Array)[i] = i < keys.length ? keys[i] : 0;
    }
    (w.fields.mouseX as Float32Array)[0] = mouseX;
    (w.fields.mouseY as Float32Array)[0] = mouseY;
    (w.fields.mouseDeltaX as Float32Array)[0] = mouseDeltaX;
    (w.fields.mouseDeltaY as Float32Array)[0] = mouseDeltaY;
    for (let i = 0; i < 3; i++) {
      (w.fields.mouseButtons as Int32Array)[i] = i < mouseButtons.length ? mouseButtons[i] : 0;
    }
    (w.fields.wheelDelta as Float32Array)[0] = wheelDelta;
    // gamepadButtons is the bitmask pair [lo, hi] — W3C standard order.
    const gp = w.fields.gamepadButtons as Uint32Array;
    gp[0] = (gamepadButtons[0] ?? 0) >>> 0;
    gp[1] = (gamepadButtons[1] ?? 0) >>> 0;
    for (let i = 0; i < 8; i++) {
      (w.fields.gamepadAxes as Float32Array)[i] = i < gamepadAxes.length ? gamepadAxes[i] : 0;
    }

    w.bumpSequence();
  }

  read() {
    const reader = CoreInputChannel.reader(this.sab);
    return reader.snapshot();
  }
}
