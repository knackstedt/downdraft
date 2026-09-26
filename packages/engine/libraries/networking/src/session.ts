import type { PlatformAdapter, PlatformLobbyData, PlatformPlayerInfo } from "./platform-adapter";
import type { NetTransport } from "./transport";

export type SessionState = "offline" | "hosting" | "connected" | "connecting" | "error";

export interface SessionConfig {
  maxPlayers: number;
  isHost: boolean;
  platform: PlatformAdapter;
  transport?: NetTransport;
  metadata?: Record<string, string>;
}

export interface SessionInfo {
  state: SessionState;
  lobbyId: string | null;
  localPlayer: PlatformPlayerInfo | null;
  players: PlatformPlayerInfo[];
  tick: number;
}

export class SessionManager {
  private platform: PlatformAdapter;
  private transport: NetTransport | null;
  private state: SessionState = "offline";
  private lobby: PlatformLobbyData | null = null;
  private localPlayer: PlatformPlayerInfo | null = null;
  private players: PlatformPlayerInfo[] = [];
  private tick: number = 0;
  private maxPlayers: number;
  private isHost: boolean;
  private stateChangeCbs: Array<(state: SessionState) => void> = [];
  private playerJoinCbs: Array<(player: PlatformPlayerInfo) => void> = [];
  private playerLeaveCbs: Array<(player: PlatformPlayerInfo) => void> = [];

  constructor(config: SessionConfig) {
    this.platform = config.platform;
    this.transport = config.transport ?? null;
    this.maxPlayers = config.maxPlayers;
    this.isHost = config.isHost;
  }

  async start(): Promise<void> {
    await this.platform.init();
    this.localPlayer = this.platform.getLocalPlayer();

    this.platform.onLobbyUpdate((lobby) => {
      this.lobby = lobby;
      this.updatePlayers(lobby.members);
    });

    this.platform.onPeerConnect((peerId) => {
      const player: PlatformPlayerInfo = {
        platformId: this.platform.platformId,
        platformPlayerId: peerId,
        displayName: peerId,
      };
      this.playerJoinCbs.forEach((cb) => cb(player));
    });

    this.platform.onPeerDisconnect((peerId) => {
      const player = this.players.find((p) => p.platformPlayerId === peerId);
      if (player) {
        this.playerLeaveCbs.forEach((cb) => cb(player));
      }
    });

    if (this.isHost) {
      this.setState("connecting");
      this.lobby = await this.platform.createLobby({
        maxPlayers: this.maxPlayers,
        isHost: true,
        metadata: this.metadata,
      });
      this.setState("hosting");
    } else {
      this.setState("connecting");
    }
  }

  async join(lobbyId: string): Promise<void> {
    this.setState("connecting");
    this.lobby = await this.platform.joinLobby(lobbyId);
    this.updatePlayers(this.lobby.members);
    this.setState("connected");
  }

  async stop(): Promise<void> {
    await this.platform.leaveLobby();
    await this.platform.shutdown();
    this.lobby = null;
    this.players = [];
    this.setState("offline");
  }

  tick_(dt: number): void {
    this.tick++;
  }

  getState(): SessionState {
    return this.state;
  }

  getLobby(): PlatformLobbyData | null {
    return this.lobby;
  }

  getLocalPlayer(): PlatformPlayerInfo | null {
    return this.localPlayer;
  }

  getPlayers(): PlatformPlayerInfo[] {
    return this.players;
  }

  getMaxPlayers(): number {
    return this.maxPlayers;
  }

  isHosting(): boolean {
    return this.isHost;
  }

  getInfo(): SessionInfo {
    return {
      state: this.state,
      lobbyId: this.lobby?.lobbyId ?? null,
      localPlayer: this.localPlayer,
      players: this.players,
      tick: this.tick,
    };
  }

  onStateChange(cb: (state: SessionState) => void): void {
    this.stateChangeCbs.push(cb);
  }

  onPlayerJoin(cb: (player: PlatformPlayerInfo) => void): void {
    this.playerJoinCbs.push(cb);
  }

  onPlayerLeave(cb: (player: PlatformPlayerInfo) => void): void {
    this.playerLeaveCbs.push(cb);
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.stateChangeCbs.forEach((cb) => cb(state));
  }

  private updatePlayers(members: PlatformPlayerInfo[]): void {
    const oldIds = new Set(this.players.map((p) => p.platformPlayerId));
    const newIds = new Set(members.map((p) => p.platformPlayerId));

    members.forEach((p) => {
      if (!oldIds.has(p.platformPlayerId)) {
        this.playerJoinCbs.forEach((cb) => cb(p));
      }
    });
    this.players.forEach((p) => {
      if (!newIds.has(p.platformPlayerId)) {
        this.playerLeaveCbs.forEach((cb) => cb(p));
      }
    });
    this.players = [...members];
  }

  private metadata: Record<string, string> = {};

  setMetadata(key: string, value: string): void {
    this.metadata[key] = value;
  }
}
