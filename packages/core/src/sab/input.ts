import { SeqlockBuffer } from "./seqlock.ts";
import { CHANNEL_LAYOUTS, type ChannelName, createSABForChannel } from "./protocol.ts";

export class InputSABChannel {
  private buf: SeqlockBuffer;

  constructor(sab?: SharedArrayBuffer) {
    const buffer = sab ?? createSABForChannel("input", 1);
    this.buf = new SeqlockBuffer(buffer, CHANNEL_LAYOUTS.input);
  }

  getBuffer(): SharedArrayBuffer {
    return this.buf.getBuffer() as SharedArrayBuffer;
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
    this.buf.beginWrite();
    this.buf.writeField("keys", keys);
    this.buf.writeField("mouseX", mouseX);
    this.buf.writeField("mouseY", mouseY);
    this.buf.writeField("mouseDeltaX", mouseDeltaX);
    this.buf.writeField("mouseDeltaY", mouseDeltaY);
    this.buf.writeField("mouseButtons", mouseButtons);
    this.buf.writeField("wheelDelta", wheelDelta);
    this.buf.writeField("gamepadButtons", gamepadButtons);
    this.buf.writeField("gamepadAxes", gamepadAxes);
    this.buf.endWrite();
  }

  read() {
    return this.buf.read();
  }
}
