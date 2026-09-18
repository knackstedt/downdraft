import { WebRTCTransport } from "./webrtc";

export type NetMessageType = number;

export interface NetMessage {
  type: NetMessageType;
  data: Uint8Array;
  reliable: boolean;
  ordered: boolean;
  channel: number;
}


export type TransportType = "websocket" | "webrtc" | "mock";

export interface NetTransport {
  type: TransportType;
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: NetMessage): void;
  onMessage(handler: (msg: NetMessage) => void): void;
  onConnect(handler: () => void): void;
  onDisconnect(handler: () => void): void;
  isConnected(): boolean;
  getRTT(): number;
  getPacketLoss(): number;
}

export class MockTransport implements NetTransport {
  type: TransportType = "mock";
  private connected = false;
  private msgHandlers: Array<(msg: NetMessage) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private rtt = 0;
  private packetLoss = 0;
  private peer: MockTransport | null = null;

  async connect(_url: string): Promise<void> {
    this.connected = true;
    this.connectHandlers.forEach((h) => h());
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectHandlers.forEach((h) => h());
  }

  send(msg: NetMessage): void {
    if (!this.connected || !this.peer) return;
    this.peer.msgHandlers.forEach((h) => h(msg));
  }

  onMessage(handler: (msg: NetMessage) => void): void { this.msgHandlers.push(handler); }
  onConnect(handler: () => void): void { this.connectHandlers.push(handler); }
  onDisconnect(handler: () => void): void { this.disconnectHandlers.push(handler); }

  isConnected(): boolean { return this.connected; }
  getRTT(): number { return this.rtt; }
  getPacketLoss(): number { return this.packetLoss; }

  link(other: MockTransport): void {
    this.peer = other;
    other.peer = this;
  }

  setRTT(rtt: number): void { this.rtt = rtt; }
  setPacketLoss(loss: number): void { this.packetLoss = loss; }
}

export class WebSocketTransport implements NetTransport {
  type: TransportType = "websocket";
  private ws: WebSocket | null = null;
  private connected = false;
  private msgHandlers: Array<(msg: NetMessage) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private rtt = 0;
  private packetLoss = 0;
  private lastPing = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connectingPromise: Promise<void> | null = null;

  async connect(url: string): Promise<void> {
    if (this.connected) {
      throw new Error("connect() already in progress or connected");
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.connected = true;
        this.connectingPromise = null;
        this.connectHandlers.forEach((h) => h());
        this.startPing();
        resolve();
      };

      this.ws.onerror = (e) => {
        if (!this.connected) {
          this.connectingPromise = null;
          reject(e);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.connectingPromise = null;
        this.stopPing();
        this.disconnectHandlers.forEach((h) => h());
      };

      this.ws.onmessage = (e) => {
        const data = new Uint8Array(e.data as ArrayBuffer);
        const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;
        if (data.length > MAX_MESSAGE_SIZE) {
          this.ws?.close(1009, "message too large");
          return;
        }
        if (data.length < 4) return;
        const type = (data[0] << 8) | data[1];
        const channel = data[2];
        const reliable = (data[3] & 1) !== 0;
        const ordered = (data[3] & 2) !== 0;
        const payload = data.slice(4);

        if (type === 0xFFFF) {
          // Ping/pong
          this.rtt = performance.now() - this.lastPing;
          return;
        }

        this.msgHandlers.forEach((h) => h({
          type, data: payload, reliable, ordered, channel,
        }));
      };
    });
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.connectingPromise = null;
    this.disconnectHandlers.forEach((h) => h());
  }

  send(msg: NetMessage): void {
    if (!this.ws || !this.connected) return;
    const header = new Uint8Array(4);
    header[0] = (msg.type >> 8) & 0xFF;
    header[1] = msg.type & 0xFF;
    header[2] = msg.channel;
    header[3] = (msg.reliable ? 1 : 0) | (msg.ordered ? 2 : 0);
    const buf = new Uint8Array(4 + msg.data.length);
    buf.set(header, 0);
    buf.set(msg.data, 4);
    this.ws.send(buf);
  }

  onMessage(handler: (msg: NetMessage) => void): void { this.msgHandlers.push(handler); }
  onConnect(handler: () => void): void { this.connectHandlers.push(handler); }
  onDisconnect(handler: () => void): void { this.disconnectHandlers.push(handler); }

  isConnected(): boolean { return this.connected; }
  getRTT(): number { return this.rtt; }
  getPacketLoss(): number { return this.packetLoss; }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (!this.connected) return;
      this.lastPing = performance.now();
      const ping = new Uint8Array(4);
      ping[0] = 0xFF; ping[1] = 0xFF;
      this.ws?.send(ping);
    }, 1000);
  }

  private stopPing(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

export function createTransport(type: TransportType): NetTransport {
  switch (type) {
    case "websocket": return new WebSocketTransport();
    case "webrtc": return new WebRTCTransport();
    case "mock": return new MockTransport();
    default: return new MockTransport();
  }
}
