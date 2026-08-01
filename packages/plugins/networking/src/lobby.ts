import type { PlatformAdapter, PlatformLobbyData, PlatformPlayerInfo } from "./platform-adapter.ts";

export type LobbyState = "idle" | "creating" | "waiting" | "joining" | "active" | "closed";

export interface LobbyConfig {
  maxPlayers: number;
  publicLobby: boolean;
  metadata: Record<string, string>;
}

export class LobbyManager {
  private platform: PlatformAdapter;
  private state: LobbyState = "idle";
  private lobby: PlatformLobbyData | null = null;
  private config: LobbyConfig;
  private stateChangeCbs: Array<(state: LobbyState) => void> = [];
  private memberChangeCbs: Array<(members: PlatformPlayerInfo[]) => void> = [];

  constructor(platform: PlatformAdapter, config: Partial<LobbyConfig> = {}) {
    this.platform = platform;
    this.config = {
      maxPlayers: config.maxPlayers ?? 8,
      publicLobby: config.publicLobby ?? true,
      metadata: config.metadata ?? {},
    };
  }

  async create(): Promise<PlatformLobbyData> {
    this.setState("creating");
    this.lobby = await this.platform.createLobby({
      maxPlayers: this.config.maxPlayers,
      isHost: true,
      metadata: this.config.metadata,
    });
    this.setState("waiting");
    return this.lobby;
  }

  async join(lobbyId: string): Promise<PlatformLobbyData> {
    this.setState("joining");
    this.lobby = await this.platform.joinLobby(lobbyId);
    this.setState("active");
    return this.lobby;
  }

  async leave(): Promise<void> {
    await this.platform.leaveLobby();
    this.lobby = null;
    this.setState("closed");
  }

  startGame(): void {
    if (this.state === "waiting" || this.state === "active") {
      this.setState("active");
    }
  }

  getState(): LobbyState {
    return this.state;
  }

  getLobby(): PlatformLobbyData | null {
    return this.lobby;
  }

  getMembers(): PlatformPlayerInfo[] {
    return this.lobby?.members ?? [];
  }

  isFull(): boolean {
    if (!this.lobby) return false;
    return this.lobby.members.length >= this.lobby.maxMembers;
  }

  isEmpty(): boolean {
    if (!this.lobby) return true;
    return this.lobby.members.length === 0;
  }

  getMemberCount(): number {
    return this.lobby?.members.length ?? 0;
  }

  getMaxMembers(): number {
    return this.lobby?.maxMembers ?? this.config.maxPlayers;
  }

  setMetadata(key: string, value: string): void {
    this.config.metadata[key] = value;
  }

  onStateChange(cb: (state: LobbyState) => void): void {
    this.stateChangeCbs.push(cb);
  }

  onMemberChange(cb: (members: PlatformPlayerInfo[]) => void): void {
    this.memberChangeCbs.push(cb);
    this.platform.onLobbyUpdate((lobby) => {
      this.lobby = lobby;
      this.memberChangeCbs.forEach((c) => c(lobby.members));
    });
  }

  private setState(state: LobbyState): void {
    this.state = state;
    this.stateChangeCbs.forEach((cb) => cb(state));
  }
}
