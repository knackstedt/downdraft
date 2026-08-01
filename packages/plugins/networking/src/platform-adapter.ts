export type PlatformId = "steam" | "epic" | "rcs" | "mock";

export interface PlatformPlayerInfo {
  platformId: PlatformId;
  platformPlayerId: string;
  displayName: string;
  avatarUrl?: string;
}

export interface PlatformLobbyData {
  lobbyId: string;
  ownerId: string;
  members: PlatformPlayerInfo[];
  maxMembers: number;
  metadata: Record<string, string>;
}

export interface PlatformSessionConfig {
  maxPlayers: number;
  isHost: boolean;
  metadata: Record<string, string>;
}

export type PlatformConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface PlatformAdapter {
  readonly platformId: PlatformId;

  init(): Promise<void>;
  isInitialized(): boolean;
  shutdown(): Promise<void>;

  getLocalPlayer(): PlatformPlayerInfo | null;

  createLobby(config: PlatformSessionConfig): Promise<PlatformLobbyData>;
  joinLobby(lobbyId: string): Promise<PlatformLobbyData>;
  leaveLobby(): Promise<void>;
  getLobby(): PlatformLobbyData | null;
  onLobbyUpdate(cb: (lobby: PlatformLobbyData) => void): void;

  sendToPeer(peerId: string, data: Uint8Array, reliable: boolean): void;
  onPeerMessage(cb: (peerId: string, data: Uint8Array) => void): void;
  onPeerConnect(cb: (peerId: string) => void): void;
  onPeerDisconnect(cb: (peerId: string) => void): void;

  getConnectionState(): PlatformConnectionState;
  getRTT(peerId: string): number;

  setRichPresence(key: string, value: string): void;
  clearRichPresence(): void;
}

export class MockPlatformAdapter implements PlatformAdapter {
  readonly platformId: PlatformId = "mock";
  private initialized = false;
  private localPlayer: PlatformPlayerInfo | null = null;
  private lobby: PlatformLobbyData | null = null;
  private connectionState: PlatformConnectionState = "disconnected";
  private lobbyUpdateCbs: Array<(lobby: PlatformLobbyData) => void> = [];
  private peerMessageCbs: Array<(peerId: string, data: Uint8Array) => void> = [];
  private peerConnectCbs: Array<(peerId: string) => void> = [];
  private peerDisconnectCbs: Array<(peerId: string) => void> = [];
  private richPresence: Record<string, string> = {};

  async init(): Promise<void> {
    this.initialized = true;
    this.localPlayer = {
      platformId: "mock",
      platformPlayerId: "mock-local",
      displayName: "MockPlayer",
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
      lobbyId: `mock-lobby-${Date.now()}`,
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
      ownerId: "remote-host",
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

  getRichPresence(): Record<string, string> {
    return this.richPresence;
  }
}

export function createMockPlatformAdapter(): MockPlatformAdapter {
  return new MockPlatformAdapter();
}
