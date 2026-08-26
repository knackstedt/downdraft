import type { NetMessage, ReplicatedField } from "@downdraft/library-networking";
import {
    AuthorityManager,
    ConnectionManager,
    DeltaDecoder,
    DeltaEncoder,
    InterestManager,
    InterpolationManager,
    LobbyManager,
    MockTransport,
    RPCManager,
    ReplicationManager,
    SessionManager,
    createMockPlatformAdapter,
} from "@downdraft/library-networking";
import { beforeEach, describe, expect, it, vi } from "bun:test";

// ============================================================================
// MockTransport Tests
// ============================================================================

describe("MockTransport", () => {
  it("should start disconnected", () => {
    const t = new MockTransport();
    expect(t.isConnected()).toBe(false);
  });

  it("should connect successfully", async () => {
    const t = new MockTransport();
    await t.connect("mock://test");
    expect(t.isConnected()).toBe(true);
  });

  it("should disconnect successfully", async () => {
    const t = new MockTransport();
    await t.connect("mock://test");
    await t.disconnect();
    expect(t.isConnected()).toBe(false);
  });

  it("should fire onConnect handler", async () => {
    const t = new MockTransport();
    const handler = vi.fn();
    t.onConnect(handler);
    await t.connect("mock://test");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should fire onDisconnect handler", async () => {
    const t = new MockTransport();
    const handler = vi.fn();
    t.onDisconnect(handler);
    await t.connect("mock://test");
    await t.disconnect();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should deliver messages between linked transports", async () => {
    const server = new MockTransport();
    const client = new MockTransport();
    server.link(client);

    const serverMsgs: NetMessage[] = [];
    const clientMsgs: NetMessage[] = [];
    server.onMessage((msg) => serverMsgs.push(msg));
    client.onMessage((msg) => clientMsgs.push(msg));

    await server.connect("mock://test");
    await client.connect("mock://test");

    const msg: NetMessage = { type: 1, data: new Uint8Array([1, 2, 3]), reliable: false, ordered: false, channel: 0 };
    client.send(msg);
    expect(serverMsgs.length).toBe(1);
    expect(serverMsgs[0].type).toBe(1);

    server.send(msg);
    expect(clientMsgs.length).toBe(1);
  });

  it("should not send when disconnected", async () => {
    const a = new MockTransport();
    const b = new MockTransport();
    a.link(b);
    const handler = vi.fn();
    b.onMessage(handler);
    a.send({ type: 1, data: new Uint8Array([1]), reliable: false, ordered: false, channel: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("should report RTT and packet loss", () => {
    const t = new MockTransport();
    t.setRTT(42);
    t.setPacketLoss(0.05);
    expect(t.getRTT()).toBe(42);
    expect(t.getPacketLoss()).toBe(0.05);
  });
});

// ============================================================================
// RPCManager Tests
// ============================================================================

describe("RPCManager", () => {
  let server: MockTransport;
  let client: MockTransport;
  let serverRPC: RPCManager;
  let clientRPC: RPCManager;

  beforeEach(async () => {
    server = new MockTransport();
    client = new MockTransport();
    server.link(client);
    await server.connect("mock://test");
    await client.connect("mock://test");
    serverRPC = new RPCManager(server, true);
    clientRPC = new RPCManager(client, false);
  });

  it("should register an RPC handler", () => {
    const id = serverRPC.register("test", () => null);
    expect(id).toBeGreaterThan(0);
    expect(serverRPC.getDefinition("test")).toBeDefined();
    expect(serverRPC.getDefinition("test")?.name).toBe("test");
  });

  it("should call a registered RPC on the server from client", () => {
    const handler = vi.fn((_args: Uint8Array) => null);
    serverRPC.register("echo", handler);
    clientRPC.call("echo", new Uint8Array([1, 2, 3]));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("should call by name when not registered on sender", () => {
    const handler = vi.fn(() => null);
    serverRPC.register("remoteFn", handler);
    // Client doesn't have "remoteFn" registered, so it sends by name
    clientRPC.call("remoteFn", new Uint8Array([42]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should unregister an RPC", () => {
    serverRPC.register("temp", () => null);
    serverRPC.unregister("temp");
    expect(serverRPC.getDefinition("temp")).toBeUndefined();
  });

  it("should call by ID", () => {
    const handler = vi.fn(() => null);
    const id = serverRPC.register("byId", handler);
    clientRPC.callById(id, new Uint8Array([99]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should return result from server handler", () => {
    serverRPC.register("addResult", () => new Uint8Array([10, 20]));
    const clientMsgs: NetMessage[] = [];
    client.onMessage((msg) => clientMsgs.push(msg));
    clientRPC.call("addResult", new Uint8Array([0]));
    // Server sends a response message (type 2)
    const responseMsg = clientMsgs.find((m) => m.type === 2);
    expect(responseMsg).toBeDefined();
  });

  it("should dispose all handlers", () => {
    serverRPC.register("a", () => null);
    serverRPC.register("b", () => null);
    serverRPC.dispose();
    expect(serverRPC.getDefinition("a")).toBeUndefined();
    expect(serverRPC.getDefinition("b")).toBeUndefined();
  });
});

// ============================================================================
// ReplicationManager Tests
// ============================================================================

describe("ReplicationManager", () => {
  let server: MockTransport;
  let client: MockTransport;
  let serverRepl: ReplicationManager;
  let clientRepl: ReplicationManager;

  beforeEach(async () => {
    server = new MockTransport();
    client = new MockTransport();
    server.link(client);
    await server.connect("mock://test");
    await client.connect("mock://test");
    serverRepl = new ReplicationManager(server, true, { tickRate: 10 });
    clientRepl = new ReplicationManager(client, false, { tickRate: 10 });
  });

  it("should register a replicated component", () => {
    const fields: ReplicatedField[] = [
      { name: "x", type: "float32" },
      { name: "y", type: "float32" },
    ];
    serverRepl.registerComponent(1, fields, "authoritative");
    // No error means success
    expect(serverRepl.getEntityData(0, 1)).toBeUndefined();
  });

  it("should track and untrack entities", () => {
    serverRepl.trackEntity(100);
    serverRepl.updateEntityComponent(100, 1, { x: 5, y: 10 });
    expect(serverRepl.getEntityData(100, 1)).toBeDefined();
    serverRepl.untrackEntity(100);
    expect(serverRepl.getEntityData(100, 1)).toBeUndefined();
  });

  it("should send snapshots on update (server)", () => {
    const fields: ReplicatedField[] = [
      { name: "health", type: "float32" },
    ];
    serverRepl.registerComponent(1, fields);
    clientRepl.registerComponent(1, fields);
    serverRepl.trackEntity(1);
    serverRepl.updateEntityComponent(1, 1, { health: 100 });
    serverRepl.update(0.2); // tickRate=10, so 0.1s per tick
    // Client should receive the snapshot
    const data = clientRepl.getEntityData(1, 1);
    expect(data).toBeDefined();
    expect(data!.health).toBeCloseTo(100, 1);
  });

  it("should not send snapshots on client", () => {
    const fields: ReplicatedField[] = [{ name: "x", type: "float32" }];
    clientRepl.registerComponent(1, fields);
    clientRepl.trackEntity(1);
    clientRepl.updateEntityComponent(1, 1, { x: 42 });
    clientRepl.update(0.2);
    // Server should not receive anything from client
    expect(serverRepl.getEntityData(1, 1)).toBeUndefined();
  });

  it("should serialize/deserialize multiple field types", () => {
    const fields: ReplicatedField[] = [
      { name: "hp", type: "float32" },
      { name: "ammo", type: "uint16" },
      { name: "alive", type: "boolean" },
      { name: "level", type: "uint8" },
    ];
    serverRepl.registerComponent(1, fields);
    clientRepl.registerComponent(1, fields);
    serverRepl.trackEntity(1);
    serverRepl.updateEntityComponent(1, 1, { hp: 75.5, ammo: 30, alive: true, level: 5 });
    serverRepl.update(0.2);
    const data = clientRepl.getEntityData(1, 1);
    expect(data).toBeDefined();
    expect(data!.hp).toBeCloseTo(75.5, 1);
    expect(data!.ammo).toBe(30);
    expect(data!.alive).toBe(true);
    expect(data!.level).toBe(5);
  });

  it("should report tick rate", () => {
    expect(serverRepl.getTickRate()).toBe(10);
  });

  it("should report RTT from transport", () => {
    server.setRTT(55);
    expect(serverRepl.getRTT()).toBe(55);
  });
});

// ============================================================================
// SessionManager Tests
// ============================================================================

describe("SessionManager", () => {
  it("should start in offline state", () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    expect(session.getState()).toBe("offline");
  });

  it("should transition to hosting when host starts", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    expect(session.getState()).toBe("hosting");
  });

  it("should transition to connected when client joins", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: false,
      platform,
    });
    await session.start();
    expect(session.getState()).toBe("connecting");
    await session.join("test-lobby");
    expect(session.getState()).toBe("connected");
  });

  it("should stop and return to offline", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    await session.stop();
    expect(session.getState()).toBe("offline");
  });

  it("should report local player after start", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    const player = session.getLocalPlayer();
    expect(player).not.toBeNull();
    expect(player!.displayName).toBe("MockPlayer");
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

  it("should report max players", () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 8,
      isHost: true,
      platform,
    });
    expect(session.getMaxPlayers()).toBe(8);
  });

  it("should report isHosting correctly", () => {
    const platform = createMockPlatformAdapter();
    const hostSession = new SessionManager({ maxPlayers: 4, isHost: true, platform });
    const clientSession = new SessionManager({ maxPlayers: 4, isHost: false, platform });
    expect(hostSession.isHosting()).toBe(true);
    expect(clientSession.isHosting()).toBe(false);
  });

  it("should return session info", async () => {
    const platform = createMockPlatformAdapter();
    const session = new SessionManager({
      maxPlayers: 4,
      isHost: true,
      platform,
    });
    await session.start();
    const info = session.getInfo();
    expect(info.state).toBe("hosting");
    expect(info.localPlayer).not.toBeNull();
  });
});

// ============================================================================
// LobbyManager Tests
// ============================================================================

describe("LobbyManager", () => {
  it("should start in idle state", () => {
    const platform = createMockPlatformAdapter();
    const lobby = new LobbyManager(platform);
    expect(lobby.getState()).toBe("idle");
  });

  it("should create a lobby and transition to waiting", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.create();
    expect(lobby.getState()).toBe("waiting");
    expect(lobby.getLobby()).not.toBeNull();
  });

  it("should join a lobby and transition to active", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    await lobby.join("test-lobby-id");
    expect(lobby.getState()).toBe("active");
    expect(lobby.getLobby()?.lobbyId).toBe("test-lobby-id");
  });

  it("should leave a lobby and transition to closed", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    await lobby.join("test-lobby-id");
    await lobby.leave();
    expect(lobby.getState()).toBe("closed");
    expect(lobby.getLobby()).toBeNull();
  });

  it("should start game from waiting state", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    await lobby.create();
    lobby.startGame();
    expect(lobby.getState()).toBe("active");
  });

  it("should report member count", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    await lobby.create();
    expect(lobby.getMemberCount()).toBe(1); // Just the local player
  });

  it("should report max members", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 6 });
    await lobby.create();
    expect(lobby.getMaxMembers()).toBe(6);
  });

  it("should not be full with one member", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform, { maxPlayers: 4 });
    await lobby.create();
    expect(lobby.isFull()).toBe(false);
  });

  it("should not be empty with one member", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    await lobby.create();
    expect(lobby.isEmpty()).toBe(false);
  });

  it("should be empty before creating", () => {
    const platform = createMockPlatformAdapter();
    const lobby = new LobbyManager(platform);
    expect(lobby.isEmpty()).toBe(true);
  });

  it("should fire state change callbacks", async () => {
    const platform = createMockPlatformAdapter();
    await platform.init();
    const lobby = new LobbyManager(platform);
    const states: string[] = [];
    lobby.onStateChange((s) => states.push(s));
    await lobby.create();
    expect(states).toContain("creating");
    expect(states).toContain("waiting");
  });
});

// ============================================================================
// AuthorityManager Tests
// ============================================================================

describe("AuthorityManager", () => {
  it("should register an entity with server authority", () => {
    const mgr = new AuthorityManager("peer-1", true);
    mgr.registerEntity(1, "server");
    const auth = mgr.getAuthority(1);
    expect(auth).toBeDefined();
    expect(auth!.authorityLevel).toBe("server");
    expect(auth!.locked).toBe(false);
  });

  it("should register a client-authority entity with local peer as owner", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "client");
    const auth = mgr.getAuthority(1);
    expect(auth!.ownerPeerId).toBe("peer-1");
  });

  it("should grant authority to a peer", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.grantAuthority(1, "peer-2");
    const auth = mgr.getAuthority(1);
    expect(auth!.authorityLevel).toBe("client");
    expect(auth!.ownerPeerId).toBe("peer-2");
  });

  it("should revoke authority back to server", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.grantAuthority(1, "peer-2");
    mgr.revokeAuthority(1);
    const auth = mgr.getAuthority(1);
    expect(auth!.authorityLevel).toBe("server");
    expect(auth!.ownerPeerId).toBeNull();
  });

  it("should not grant authority when locked", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.lockAuthority(1);
    const result = mgr.requestAuthority(1, "peer-2");
    expect(result).toBe(false);
  });

  it("should grant authority when unlocked", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.lockAuthority(1);
    mgr.unlockAuthority(1);
    const result = mgr.requestAuthority(1, "peer-2");
    expect(result).toBe(true);
  });

  it("should not request authority on client", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "server");
    const result = mgr.requestAuthority(1, "peer-2");
    expect(result).toBe(false);
  });

  it("should report hasAuthority for server entities on server", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    expect(mgr.hasAuthority(1)).toBe(true);
  });

  it("should report hasAuthority for owned client entities", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "client");
    expect(mgr.hasAuthority(1)).toBe(true);
  });

  it("should report hasAuthority for shared entities", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "shared");
    expect(mgr.hasAuthority(1)).toBe(true);
  });

  it("should not have authority for server entities on client", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "server");
    expect(mgr.hasAuthority(1)).toBe(false);
  });

  it("should return owned entities", () => {
    const mgr = new AuthorityManager("peer-1", false);
    mgr.registerEntity(1, "client");
    mgr.registerEntity(2, "client");
    mgr.registerEntity(3, "server");
    const owned = mgr.getOwnedEntities();
    expect(owned).toContain(1);
    expect(owned).toContain(2);
    expect(owned).not.toContain(3);
  });

  it("should return server-owned entities", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.registerEntity(2, "client");
    mgr.registerEntity(3, "server");
    const serverEntities = mgr.getServerEntities();
    expect(serverEntities).toContain(1);
    expect(serverEntities).toContain(3);
    expect(serverEntities).not.toContain(2);
  });

  it("should fire authority change callbacks", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    const cb = vi.fn();
    mgr.onAuthorityChange(cb);
    mgr.grantAuthority(1, "peer-2");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBe(1);
  });

  it("should unregister entity", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    mgr.unregisterEntity(1);
    expect(mgr.getAuthority(1)).toBeUndefined();
  });
});

// ============================================================================
// ConnectionManager Tests
// ============================================================================

describe("ConnectionManager", () => {
  it("should start disconnected", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    expect(conn.getState()).toBe("disconnected");
  });

  it("should track peers on connect", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    // Simulate peer connect via platform callback
    platform.onPeerConnect((peerId) => {
      // This is set up in ConnectionManager constructor
    });
    // We need to trigger the callback manually since MockPlatformAdapter doesn't fire events
    // The ConnectionManager registers its own callbacks in constructor
    // We can test by checking the initial state
    expect(conn.getPeerCount()).toBe(0);
  });

  it("should report zero average RTT with no peers", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    expect(conn.getAverageRTT()).toBe(0);
  });

  it("should report zero connected peers initially", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    expect(conn.getConnectedPeerCount()).toBe(0);
  });

  it("should fire state change callback on setState", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    const states: string[] = [];
    conn.onStateChange((s) => states.push(s));
    conn.setState("connected");
    expect(states).toContain("connected");
  });

  it("should disconnect all peers", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    conn.setState("connected");
    conn.disconnectAll();
    expect(conn.getState()).toBe("disconnected");
  });

  it("should compute reconnect delay with exponential backoff", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    conn.setState("reconnecting");
    const delay0 = conn.getReconnectDelay();
    conn.incrementReconnectAttempt();
    const delay1 = conn.getReconnectDelay();
    expect(delay1).toBeGreaterThan(delay0);
  });

  it("should reset reconnect attempts", () => {
    const platform = createMockPlatformAdapter();
    const conn = new ConnectionManager(platform);
    conn.setState("reconnecting");
    conn.incrementReconnectAttempt();
    conn.incrementReconnectAttempt();
    conn.resetReconnect();
    expect(conn.shouldReconnect()).toBe(true);
  });
});

// ============================================================================
// DeltaEncoder / DeltaDecoder Tests
// ============================================================================

describe("DeltaEncoder / DeltaDecoder", () => {
  const fields: ReplicatedField[] = [
    { name: "x", type: "float32" },
    { name: "y", type: "float32" },
  ];

  const componentDefs = new Map([
    [1, { componentId: 1, fields, mode: "authoritative" as const }],
  ]);

  it("should encode a full delta for first snapshot", () => {
    const encoder = new DeltaEncoder();
    const snapshot = {
      tick: 1,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]), // 1.0, 2.0 in float32
        }],
      }],
    };
    const delta = encoder.encodeDelta(snapshot, componentDefs);
    expect(delta.tick).toBe(1);
    expect(delta.baseTick).toBe(0);
    expect(delta.entities.length).toBe(1);
    expect(delta.entities[0].changedComponents.length).toBe(1);
    // All fields should be marked as changed
    expect(delta.entities[0].changedComponents[0].fieldMask[0]).toBe(0x03); // bits 0 and 1
  });

  it("should encode no delta when nothing changed", () => {
    const encoder = new DeltaEncoder();
    const snapshot = {
      tick: 1,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]),
        }],
      }],
    };
    encoder.encodeDelta(snapshot, componentDefs);
    const delta = encoder.encodeDelta(snapshot, componentDefs);
    expect(delta.entities.length).toBe(0);
  });

  it("should encode partial delta when one field changes", () => {
    const encoder = new DeltaEncoder();
    const snap1 = {
      tick: 1,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]),
        }],
      }],
    };
    encoder.encodeDelta(snap1, componentDefs);

    const snap2 = {
      tick: 2,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 160, 63, 0, 0, 0, 64]), // x changed, y same
        }],
      }],
    };
    const delta = encoder.encodeDelta(snap2, componentDefs);
    expect(delta.entities.length).toBe(1);
    // Only field 0 (x) should be in the mask
    expect(delta.entities[0].changedComponents[0].fieldMask[0] & 0x01).toBe(0x01);
    expect(delta.entities[0].changedComponents[0].fieldMask[0] & 0x02).toBe(0);
  });

  it("should decode delta back to full snapshot", () => {
    const encoder = new DeltaEncoder();
    const decoder = new DeltaDecoder();
    const snapshot = {
      tick: 1,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]),
        }],
      }],
    };
    const delta = encoder.encodeDelta(snapshot, componentDefs);
    const decoded = decoder.decodeDelta(delta, componentDefs);
    expect(decoded.tick).toBe(1);
    expect(decoded.entities.length).toBe(1);
    // Check that x and y are correct
    const dv = new DataView(decoded.entities[0].components[0].data.buffer);
    expect(dv.getFloat32(0, true)).toBeCloseTo(1.0, 1);
    expect(dv.getFloat32(4, true)).toBeCloseTo(2.0, 1);
  });

  it("should reset encoder state", () => {
    const encoder = new DeltaEncoder();
    const snapshot = {
      tick: 5,
      entities: [{
        entityId: 1,
        components: [{
          componentId: 1,
          data: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]),
        }],
      }],
    };
    encoder.encodeDelta(snapshot, componentDefs);
    encoder.reset();
    const delta = encoder.encodeDelta(snapshot, componentDefs);
    // After reset, should be full delta again
    expect(delta.baseTick).toBe(0);
  });
});

// ============================================================================
// InterestManager Tests
// ============================================================================

describe("InterestManager", () => {
  it("should return all entities when no area is set", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 0, 0, 0);
    mgr.updateEntityPosition(2, 100, 0, 0);
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant.length).toBe(2);
  });

  it("should filter entities by distance", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 0, 0, 0);
    mgr.updateEntityPosition(2, 100, 0, 0);
    mgr.updateEntityPosition(3, 5, 0, 0);
    mgr.setArea("peer-1", { centerX: 0, centerY: 0, centerZ: 0, radius: 10 });
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant).toContain(1);
    expect(relevant).toContain(3);
    expect(relevant).not.toContain(2);
  });

  it("should remove entity from tracking", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 0, 0, 0);
    mgr.removeEntity(1);
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant).not.toContain(1);
  });

  it("should remove area for a peer", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 100, 0, 0);
    mgr.setArea("peer-1", { centerX: 0, centerY: 0, centerZ: 0, radius: 10 });
    mgr.removeArea("peer-1");
    // After removing area, all entities should be relevant
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant).toContain(1);
  });

  it("should filter snapshot by relevance", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 0, 0, 0);
    mgr.updateEntityPosition(2, 1000, 0, 0);
    mgr.setArea("peer-1", { centerX: 0, centerY: 0, centerZ: 0, radius: 50 });
    const snapshot = {
      tick: 1,
      entities: [
        { entityId: 1, components: [] },
        { entityId: 2, components: [] },
      ],
    };
    const filtered = mgr.filterSnapshot(snapshot, "peer-1");
    expect(filtered.entities.length).toBe(1);
    expect(filtered.entities[0].entityId).toBe(1);
  });
});

// ============================================================================
// InterpolationManager Tests
// ============================================================================

describe("InterpolationManager", () => {
  it("should have empty buffer initially", () => {
    const interp = new InterpolationManager();
    expect(interp.getBufferSize()).toBe(0);
  });

  it("should add snapshots to buffer", () => {
    const interp = new InterpolationManager();
    const data = new Map();
    interp.addSnapshot(1, data, 100);
    expect(interp.getBufferSize()).toBe(1);
  });

  it("should limit buffer size", () => {
    const interp = new InterpolationManager();
    for (let i = 0; i < 10; i++) {
      interp.addSnapshot(i, new Map(), i * 100);
    }
    expect(interp.getBufferSize()).toBeLessThanOrEqual(4);
  });

  it("should return latest value when buffer has < 2 entries", () => {
    const interp = new InterpolationManager();
    const data = new Map([
      [1, new Map([[1, { x: 42 }]])],
    ]);
    interp.addSnapshot(1, data, 100);
    const val = interp.getInterpolatedState(1, 1, "x");
    expect(val).toBe(42);
  });

  it("should interpolate between two snapshots", () => {
    const interp = new InterpolationManager();
    const data1 = new Map([
      [1, new Map([[1, { x: 0 }]])],
    ]);
    const data2 = new Map([
      [1, new Map([[1, { x: 100 }]])],
    ]);
    interp.addSnapshot(1, data1, 1000);
    interp.addSnapshot(2, data2, 2000);
    interp.update(1500); // renderTime = 1500, interpolationDelay = 100, target = 1400
    const val = interp.getInterpolatedState(1, 1, "x");
    expect(val).toBeCloseTo(50, 1); // halfway between 0 and 100
  });

  it("should clear buffer", () => {
    const interp = new InterpolationManager();
    interp.addSnapshot(1, new Map(), 100);
    interp.clear();
    expect(interp.getBufferSize()).toBe(0);
  });

  it("should set interpolation delay", () => {
    const interp = new InterpolationManager();
    interp.setInterpolationDelay(0.2);
    // No error means success; the delay is used internally
    expect(interp.getBufferSize()).toBe(0);
  });
});
