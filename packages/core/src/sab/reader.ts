import { SeqlockBuffer } from "./seqlock.ts";
import type { ChannelName } from "./protocol.ts";
import { CHANNEL_LAYOUTS } from "./protocol.ts";

export class SABReader {
  private buffers: Map<ChannelName, SeqlockBuffer> = new Map();
  private lastSeen: Map<ChannelName, number> = new Map();

  attachChannel(name: ChannelName, sab: SharedArrayBuffer): SeqlockBuffer {
    const layout = CHANNEL_LAYOUTS[name];
    const buf = new SeqlockBuffer(sab, layout);
    this.buffers.set(name, buf);
    this.lastSeen.set(name, buf.getSequence());
    return buf;
  }

  getChannel(name: ChannelName): SeqlockBuffer | undefined {
    return this.buffers.get(name);
  }

  hasChanged(name: ChannelName): boolean {
    const buf = this.buffers.get(name);
    if (!buf) return false;
    const last = this.lastSeen.get(name) ?? 0;
    return buf.hasChanged(last);
  }

  readChannel<T = Record<string, unknown>>(name: ChannelName): T | null {
    const buf = this.buffers.get(name);
    if (!buf) return null;
    const data = buf.read() as T | null;
    this.lastSeen.set(name, buf.getSequence());
    return data;
  }

  readIfChanged<T = Record<string, unknown>>(name: ChannelName): T | null {
    if (!this.hasChanged(name)) return null;
    return this.readChannel<T>(name);
  }
}
