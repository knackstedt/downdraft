import type { PlatformAdapter, PlatformConnectionState, PlatformLobbyData, PlatformPlayerInfo, PlatformSessionConfig } from "./platform-adapter.ts";

export interface RCSConfig {
  apiKey: string;
  projectId: string;
  region: string;
}

export class RCSAdapter implements PlatformAdapter {
  readonly platformId = "rcs" as const;
  private initialized = false;
  private localPlayer: PlatformPlayerInfo | null = null;
  private lobby: PlatformLobbyData | null = null;
  private connectionState: PlatformConnectionState = "disconnected";
  private config: RCSConfig;
  private lobbyUpdateCbs: Array<(lobby: PlatformLobbyData) => void> = [];
  private peerMessageCbs: Array<(peerId: string, data: Uint8Array) => void> = [];
  private peerConnectCbs: Array<(peerId: string) => void> = [];
  private peerDisconnectCbs: Array<(peerId: string) => void> = [];
  private richPresence: Record<string, string> = {};

  constructor(config: Partial<RCSConfig> = {}) {
    this.config = {
      apiKey: config.apiKey ?? "",
      projectId: config.projectId ?? "",
      region: config.region ?? "us-east-1",
    };
  }

  async init(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("RCSAdapter requires apiKey");
    }
    this.initialized = true;
    this.localPlayer = {
      platformId: "rcs",
      platformPlayerId: "rcs-local-stub",
      displayName: "RCSPlayer",
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.localPlayer = null;
    this.lobby = null;
    this.connectionState = "disconnected";
  }

  getLocalPlayer(): PlatformPlayerInfo | null {
    return this.localPlayer;
  }

  async createLobby(config: PlatformSessionConfig): Promise<PlatformLobbyData> {
    this.lobby = {
      lobbyId: `rcs-lobby-${Date.now()}`,
      ownerId: this.localPlayer?.platformPlayerId ?? "unknown",
      members: this.localPlayer ? [this.localPlayer] : [],
      maxMembers: config.maxPlayers,
      metadata: { ...config.metadata },
    };
    this.connectionState = "connected";
    return this.lobby;
  }

  async joinLobby(lobbyId: string): Promise<PlatformLobbyData> {
    this.lobby = {
      lobbyId,
      ownerId: "rcs-host",
      members: this.localPlayer ? [this.localPlayer] : [],
      maxMembers: 8,
      metadata: {},
    };
    this.connectionState = "connected";
    return this.lobby;
  }

  async leaveLobby(): Promise<void> {
    this.lobby = null;
    this.connectionState = "disconnected";
  }

  getLobby(): PlatformLobbyData | null {
    return this.lobby;
  }

  onLobbyUpdate(cb: (lobby: PlatformLobbyData) => void): void {
    this.lobbyUpdateCbs.push(cb);
  }

  sendToPeer(_peerId: string, _data: Uint8Array, _reliable: boolean): void {}

  onPeerMessage(cb: (peerId: string, data: Uint8Array) => void): void {
    this.peerMessageCbs.push(cb);
  }

  onPeerConnect(cb: (peerId: string) => void): void {
    this.peerConnectCbs.push(cb);
  }

  onPeerDisconnect(cb: (peerId: string) => void): void {
    this.peerDisconnectCbs.push(cb);
  }

  getConnectionState(): PlatformConnectionState {
    return this.connectionState;
  }

  getRTT(_peerId: string): number {
    return 0;
  }

  setRichPresence(key: string, value: string): void {
    this.richPresence[key] = value;
  }

  clearRichPresence(): void {
    this.richPresence = {};
  }
}

export function createRCSAdapter(config?: Partial<RCSConfig>): RCSAdapter {
  return new RCSAdapter(config);
}
