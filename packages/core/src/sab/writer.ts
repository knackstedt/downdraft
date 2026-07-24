import { SeqlockBuffer, type BufferLayout } from "./seqlock.ts";
import type { ChannelName } from "./protocol.ts";
import { CHANNEL_LAYOUTS, createSABForChannel } from "./protocol.ts";

export class SABWriter {
  private buffers: Map<ChannelName, SeqlockBuffer> = new Map();

  createChannel(name: ChannelName, entityCapacity: number = 1): SeqlockBuffer {
    const sab = createSABForChannel(name, entityCapacity);
    const layout = CHANNEL_LAYOUTS[name];
    const buf = new SeqlockBuffer(sab, layout);
    this.buffers.set(name, buf);
    return buf;
  }

  attachChannel(name: ChannelName, sab: SharedArrayBuffer): SeqlockBuffer {
    const layout = CHANNEL_LAYOUTS[name];
    const buf = new SeqlockBuffer(sab, layout);
    this.buffers.set(name, buf);
    return buf;
  }

  getChannel(name: ChannelName): SeqlockBuffer | undefined {
    return this.buffers.get(name);
  }

  writeChannel(name: ChannelName, fn: (buf: SeqlockBuffer) => void): void {
    const buf = this.buffers.get(name);
    if (!buf) return;
    buf.beginWrite();
    fn(buf);
    buf.endWrite();
  }

  getBuffer(name: ChannelName): SharedArrayBuffer | undefined {
    return this.buffers.get(name)?.getBuffer() as SharedArrayBuffer | undefined;
  }

  getAllBuffers(): Map<ChannelName, SharedArrayBuffer> {
    const result = new Map<ChannelName, SharedArrayBuffer>();
    for (const [name, buf] of this.buffers) {
      result.set(name, buf.getBuffer() as SharedArrayBuffer);
    }
    return result;
  }
}
