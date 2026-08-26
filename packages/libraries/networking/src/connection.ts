import type { PlatformAdapter } from "./platform-adapter";
import type { NetTransport } from "./transport";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface PeerInfo {
  peerId: string;
  connected: boolean;
  rtt: number;
  lastSeen: number;
}

export class ConnectionManager {
  private platform: PlatformAdapter;
  private transport: NetTransport | null;
  private state: ConnectionState = "disconnected";
  private peers: Map<string, PeerInfo> = new Map();
  private stateChangeCbs: Array<(state: ConnectionState) => void> = [];
  private peerConnectCbs: Array<(peerId: string) => void> = [];
  private peerDisconnectCbs: Array<(peerId: string) => void> = [];
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(platform: PlatformAdapter, transport?: NetTransport) {
    this.platform = platform;
    this.transport = transport ?? null;

    this.platform.onPeerConnect((peerId) => {
      this.peers.set(peerId, {
        peerId,
        connected: true,
        rtt: this.platform.getRTT(peerId),
        lastSeen: Date.now(),
      });
      this.peerConnectCbs.forEach((cb) => cb(peerId));
      if (this.state === "connecting" || this.state === "reconnecting") {
        this.setState("connected");
      }
    });

    this.platform.onPeerDisconnect((peerId) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.connected = false;
      }
      this.peerDisconnectCbs.forEach((cb) => cb(peerId));
      if (this.peers.size === 0 || ![...this.peers.values()].some((p) => p.connected)) {
        this.setState("reconnecting");
      }
    });
  }

  send(peerId: string, data: Uint8Array, reliable: boolean = true): void {
    this.platform.sendToPeer(peerId, data, reliable);
  }

  broadcast(data: Uint8Array, reliable: boolean = true): void {
    for (const [peerId] of this.peers) {
      this.platform.sendToPeer(peerId, data, reliable);
    }
  }

  getConnectedPeers(): string[] {
    return [...this.peers.values()].filter((p) => p.connected).map((p) => p.peerId);
  }

  getPeerInfo(peerId: string): PeerInfo | undefined {
    return this.peers.get(peerId);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getConnectedPeerCount(): number {
    return [...this.peers.values()].filter((p) => p.connected).length;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getAverageRTT(): number {
    const connected = [...this.peers.values()].filter((p) => p.connected);
    if (connected.length === 0) return 0;
    return connected.reduce((sum, p) => sum + p.rtt, 0) / connected.length;
  }

  updatePeerRTTs(): void {
    for (const [peerId, peer] of this.peers) {
      peer.rtt = this.platform.getRTT(peerId);
      peer.lastSeen = Date.now();
    }
  }

  shouldReconnect(): boolean {
    return this.state === "reconnecting" && this.reconnectAttempts < this.maxReconnectAttempts;
  }

  getReconnectDelay(): number {
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    return delay;
  }

  incrementReconnectAttempt(): void {
    this.reconnectAttempts++;
  }

  resetReconnect(): void {
    this.reconnectAttempts = 0;
  }

  setState(state: ConnectionState): void {
    this.state = state;
    this.stateChangeCbs.forEach((cb) => cb(state));
  }

  onStateChange(cb: (state: ConnectionState) => void): void {
    this.stateChangeCbs.push(cb);
  }

  onPeerConnect(cb: (peerId: string) => void): void {
    this.peerConnectCbs.push(cb);
  }

  onPeerDisconnect(cb: (peerId: string) => void): void {
    this.peerDisconnectCbs.push(cb);
  }

  disconnectAll(): void {
    for (const peer of this.peers.values()) {
      peer.connected = false;
    }
    this.peers.clear();
    this.setState("disconnected");
  }
}
