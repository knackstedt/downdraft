import { MockPlatformAdapter, createMockPlatformAdapter } from "./platform-adapter.ts";
import { SessionManager } from "./session.ts";
import { LobbyManager } from "./lobby.ts";
import { ConnectionManager } from "./connection.ts";

describe("MockPlatformAdapter", () => {
  it("should init and provide local player", async () => {
    const adapter = createMockPlatformAdapter();
    await adapter.init();
    expect(adapter.isInitialized()).toBe(true);
    const player = adapter.getLocalPlayer();
    expect(player).not.toBeNull();
    expect(player?.platformId).toBe("mock");
  });

  it("should create and leave lobby", async () => {
    const adapter = createMockPlatformAdapter();
    await adapter.init();
    const lobby = await adapter.createLobby({ maxPlayers: 4, isHost: true, metadata: {} });
    expect(lobby.maxMembers).toBe(4);
    expect(lobby.members).toHaveLength(1);
    expect(adapter.getLobby()).not.toBeNull();
    await adapter.leaveLobby();
    expect(adapter.getLobby()).toBeNull();
  });

  it("should set and clear rich presence", async () => {
    const adapter = createMockPlatformAdapter();
    await adapter.init();
    adapter.setRichPresence("status", "in-game");
    expect(adapter.getRichPresence()["status"]).toBe("in-game");
    adapter.clearRichPresence();
    expect(Object.keys(adapter.getRichPresence())).toHaveLength(0);
  });

  it("should shutdown cleanly", async () => {
    const adapter = createMockPlatformAdapter();
    await adapter.init();
    await adapter.shutdown();
    expect(adapter.isInitialized()).toBe(false);
  });
});

describe("SessionManager", () => {
  it("should start as host and create lobby", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    expect(session.getState()).toBe("hosting");
    expect(session.getLobby()).not.toBeNull();
    expect(session.getLocalPlayer()).not.toBeNull();
  });

  it("should start as client in connecting state", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: false,
      platform,
    });
    await session.start();
    expect(session.getState()).toBe("connecting");
  });

  it("should join a lobby", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: false,
      platform,
    });
    await session.start();
    await session.join("test-lobby-123");
    expect(session.getState()).toBe("connected");
    expect(session.getLobby()?.lobbyId).toBe("test-lobby-123");
  });

  it("should stop and go offline", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    await session.stop();
    expect(session.getState()).toBe("offline");
    expect(session.getLobby()).toBeNull();
  });

  it("should fire state change callbacks", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    const states: string[] = [];
    session.onStateChange((s) => states.push(s));
    await session.start();
    expect(states).toContain("connecting");
    expect(states).toContain("hosting");
  });
});

describe("LobbyManager", () => {
  it("should create lobby in waiting state", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 6 });
    await lobby.create();
    expect(lobby.getState()).toBe("waiting");
    expect(lobby.getMemberCount()).toBe(1);
    expect(lobby.getMaxMembers()).toBe(6);
  });

  it("should join lobby in active state", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.join("lobby-xyz");
    expect(lobby.getState()).toBe("active");
    expect(lobby.getLobby()?.lobbyId).toBe("lobby-xyz");
  });

  it("should leave lobby", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.create();
    await lobby.leave();
    expect(lobby.getState()).toBe("closed");
    expect(lobby.getLobby()).toBeNull();
  });

  it("should start game from waiting", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.create();
    lobby.startGame();
    expect(lobby.getState()).toBe("active");
  });

  it("should not be full with 1 member", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.create();
    expect(lobby.isFull()).toBe(false);
    expect(lobby.isEmpty()).toBe(false);
  });
});

describe("ConnectionManager", () => {
  it("should start disconnected", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const conn = new ConnectionManager(platform);
    expect(conn.getState()).toBe("disconnected");
    expect(conn.getPeerCount()).toBe(0);
  });

  it("should track peers via callbacks", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const conn = new ConnectionManager(platform);
    const connected: string[] = [];
    conn.onPeerConnect((id) => connected.push(id));
    platform.onPeerConnect;
    const handler = (platform as unknown as { peerConnectCbs: Array<(id: string) => void> }).peerConnectCbs;
    if (handler) handler[0]("peer-1");
    expect(conn.getPeerInfo("peer-1")).toBeDefined();
    expect(conn.getPeerInfo("peer-1")?.connected).toBe(true);
  });

  it("should broadcast to all peers", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const conn = new ConnectionManager(platform);
    const handler = (platform as unknown as { peerConnectCbs: Array<(id: string) => void> }).peerConnectCbs;
    if (handler) {
      handler[0]("peer-1");
      handler[0]("peer-2");
    }
    expect(conn.getConnectedPeerCount()).toBe(2);
  });

  it("should disconnect all peers", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const conn = new ConnectionManager(platform);
    const handler = (platform as unknown as { peerConnectCbs: Array<(id: string) => void> }).peerConnectCbs;
    if (handler) handler[0]("peer-1");
    conn.disconnectAll();
    expect(conn.getState()).toBe("disconnected");
    expect(conn.getPeerCount()).toBe(0);
  });
});
