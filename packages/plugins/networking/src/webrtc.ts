import type { NetMessage, NetTransport, TransportType } from "./transport.ts";

export type SignalingMessageType = "offer" | "answer" | "ice-candidate" | "join" | "leave";

export interface SignalingMessage {
  type: SignalingMessageType;
  fromPeerId: string;
  toPeerId?: string;
  data?: string;
}

export interface SignalingClient {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: SignalingMessage): void;
  onMessage(cb: (msg: SignalingMessage) => void): void;
  onConnect(cb: () => void): void;
  onDisconnect(cb: () => void): void;
  getPeerId(): string | null;
}

export class WebSocketSignalingClient implements SignalingClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private peerId: string | null = null;
  private msgCbs: Array<(msg: SignalingMessage) => void> = [];
  private connectCbs: Array<() => void> = [];
  private disconnectCbs: Array<() => void> = [];

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        this.connectCbs.forEach((cb) => cb());
        resolve();
      };
      this.ws.onerror = (e) => {
        if (!this.connected) reject(e);
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.disconnectCbs.forEach((cb) => cb());
      };
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as SignalingMessage;
          if (msg.type === "join" && !this.peerId) {
            this.peerId = msg.fromPeerId;
          }
          this.msgCbs.forEach((cb) => cb(msg));
        } catch {
          // ignore malformed messages
        }
      };
    });
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.disconnectCbs.forEach((cb) => cb());
  }

  send(msg: SignalingMessage): void {
    if (!this.ws || !this.connected) return;
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: SignalingMessage) => void): void {
    this.msgCbs.push(cb);
  }

  onConnect(cb: () => void): void {
    this.connectCbs.push(cb);
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  getPeerId(): string | null {
    return this.peerId;
  }
}

export class WebRTCTransport implements NetTransport {
  type: TransportType = "webrtc";
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private connected = false;
  private msgHandlers: Array<(msg: NetMessage) => void> = [];
  private connectHandlers: Array<() => void> = [];
  private disconnectHandlers: Array<() => void> = [];
  private rtt = 0;
  private packetLoss = 0;
  private signaling: SignalingClient | null = null;
  private isInitiator = false;
  private lastPing = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(signaling?: SignalingClient) {
    this.signaling = signaling ?? null;
  }

  setSignaling(signaling: SignalingClient): void {
    this.signaling = signaling;
  }

  async connect(url: string): Promise<void> {
    if (!this.signaling) {
      throw new Error("WebRTCTransport requires a signaling client");
    }
    await this.signaling.connect(url);
    this.isInitiator = true;

    const config: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    this.pc = new RTCPeerConnection(config);

    this.dc = this.pc.createDataChannel("game", {
      ordered: false,
      maxRetransmits: 0,
    });

    this.setupDataChannel();

    this.signaling.onMessage((msg) => {
      if (msg.type === "answer" && this.pc) {
        this.pc.setRemoteDescription({ type: "answer", sdp: msg.data });
      } else if (msg.type === "ice-candidate" && this.pc && msg.data) {
        this.pc.addIceCandidate(JSON.parse(msg.data));
      }
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.signaling) {
        this.signaling.send({
          type: "ice-candidate",
          fromPeerId: this.signaling.getPeerId() ?? "",
          data: JSON.stringify(event.candidate.toJSON()),
        });
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.signaling.send({
      type: "offer",
      fromPeerId: this.signaling.getPeerId() ?? "",
      data: offer.sdp,
    });
  }

  async acceptConnection(pc: RTCPeerConnection): Promise<void> {
    this.pc = pc;
    this.isInitiator = false;

    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannel();
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.signaling) {
        this.signaling.send({
          type: "ice-candidate",
          fromPeerId: this.signaling.getPeerId() ?? "",
          data: JSON.stringify(event.candidate.toJSON()),
        });
      }
    };

    this.signaling?.onMessage((msg) => {
      if (msg.type === "offer" && this.pc) {
        this.pc.setRemoteDescription({ type: "offer", sdp: msg.data });
        this.pc.createAnswer().then((answer) => {
          this.pc!.setLocalDescription(answer);
          this.signaling!.send({
            type: "answer",
            fromPeerId: this.signaling!.getPeerId() ?? "",
            data: answer.sdp,
          });
        });
      } else if (msg.type === "ice-candidate" && this.pc && msg.data) {
        this.pc.addIceCandidate(JSON.parse(msg.data));
      }
    });
  }

  private setupDataChannel(): void {
    if (!this.dc) return;

    this.dc.onopen = () => {
      this.connected = true;
      this.connectHandlers.forEach((cb) => cb());
      this.startPing();
    };

    this.dc.onclose = () => {
      this.connected = false;
      this.disconnectHandlers.forEach((cb) => cb());
      this.stopPing();
    };

    this.dc.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 4) return;
      const type = (data[0] << 8) | data[1];
      const channel = data[2];
      const reliable = (data[3] & 1) !== 0;
      const ordered = (data[3] & 2) !== 0;
      const payload = data.slice(4);

      if (type === 0xFFFF) {
        this.rtt = performance.now() - this.lastPing;
        return;
      }

      this.msgHandlers.forEach((h) => h({ type, data: payload, reliable, ordered, channel }));
    };
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.connected = false;
    this.disconnectHandlers.forEach((cb) => cb());
    await this.signaling?.disconnect();
  }

  send(msg: NetMessage): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    const header = new Uint8Array(4);
    header[0] = (msg.type >> 8) & 0xFF;
    header[1] = msg.type & 0xFF;
    header[2] = msg.channel;
    header[3] = (msg.reliable ? 1 : 0) | (msg.ordered ? 2 : 0);
    const buf = new Uint8Array(4 + msg.data.length);
    buf.set(header, 0);
    buf.set(msg.data, 4);
    this.dc.send(buf);
  }

  onMessage(handler: (msg: NetMessage) => void): void {
    this.msgHandlers.push(handler);
  }

  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getRTT(): number {
    return this.rtt;
  }

  getPacketLoss(): number {
    return this.packetLoss;
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (!this.connected || !this.dc || this.dc.readyState !== "open") return;
      this.lastPing = performance.now();
      const ping = new Uint8Array(4);
      ping[0] = 0xFF; ping[1] = 0xFF;
      this.dc.send(ping);
    }, 1000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

export function createWebRTCTransport(signaling?: SignalingClient): WebRTCTransport {
  return new WebRTCTransport(signaling);
}
