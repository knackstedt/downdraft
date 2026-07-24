import { ReplicationManager, type ReplicatedField } from "./replication.ts";
import { MockTransport } from "./transport.ts";

async function makeLinkedPair(): Promise<{ server: MockTransport; client: MockTransport }> {
  const server = new MockTransport();
  const client = new MockTransport();
  client.link(server);
  await server.connect("mock://s");
  await client.connect("mock://c");
  return { server, client };
}

const POSITION_FIELDS: ReplicatedField[] = [
  { name: "x", type: "float32" },
  { name: "y", type: "float32" },
  { name: "z", type: "float32" },
];

const HEALTH_FIELDS: ReplicatedField[] = [
  { name: "hp", type: "float32" },
  { name: "alive", type: "boolean" },
];

describe("ReplicationManager", () => {
  it("should construct with default config", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    expect(mgr.getTickRate()).toBe(20);
  });

  it("should construct with custom tick rate", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true, { tickRate: 60 });
    expect(mgr.getTickRate()).toBe(60);
  });

  it("should register components for replication", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    mgr.registerComponent(1, POSITION_FIELDS, "authoritative");
    expect(mgr.config.components.has(1)).toBe(true);
  });

  it("should track and untrack entities", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    mgr.trackEntity(42);
    mgr.updateEntityComponent(42, 1, { x: 1, y: 2, z: 3 });
    expect(mgr.getEntityData(42, 1)).toBeDefined();

    mgr.untrackEntity(42);
    expect(mgr.getEntityData(42, 1)).toBeUndefined();
  });

  it("should update entity component data", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    mgr.trackEntity(1);
    mgr.updateEntityComponent(1, 1, { x: 10, y: 20, z: 30 });
    const data = mgr.getEntityData(1, 1);
    expect(data).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("should auto-track entity on updateEntityComponent", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    mgr.updateEntityComponent(99, 1, { x: 1, y: 2, z: 3 });
    expect(mgr.getEntityData(99, 1)).toBeDefined();
  });

  it("should send snapshots from server to client", async () => {
    const { server, client } = await makeLinkedPair();
    const serverMgr = new ReplicationManager(server, true, { tickRate: 100 });
    const clientMgr = new ReplicationManager(client, false, { tickRate: 100 });

    serverMgr.registerComponent(1, POSITION_FIELDS);
    clientMgr.registerComponent(1, POSITION_FIELDS);

    serverMgr.trackEntity(1);
    serverMgr.updateEntityComponent(1, 1, { x: 5, y: 10, z: 15 });

    serverMgr.update(0.02);

    await new Promise((r) => setTimeout(r, 10));

    const data = clientMgr.getEntityData(1, 1);
    expect(data).toBeDefined();
    expect(data!.x).toBeCloseTo(5, 4);
    expect(data!.y).toBeCloseTo(10, 4);
    expect(data!.z).toBeCloseTo(15, 4);
  });

  it("should not send snapshots from client", async () => {
    const { server, client } = await makeLinkedPair();
    const serverMgr = new ReplicationManager(server, true, { tickRate: 100 });
    const clientMgr = new ReplicationManager(client, false, { tickRate: 100 });

    serverMgr.registerComponent(1, POSITION_FIELDS);
    clientMgr.registerComponent(1, POSITION_FIELDS);

    clientMgr.trackEntity(1);
    clientMgr.updateEntityComponent(1, 1, { x: 99, y: 99, z: 99 });

    clientMgr.update(0.02);

    await new Promise((r) => setTimeout(r, 10));

    expect(serverMgr.getEntityData(1, 1)).toBeUndefined();
  });

  it("should serialize and deserialize boolean fields", async () => {
    const { server, client } = await makeLinkedPair();
    const serverMgr = new ReplicationManager(server, true, { tickRate: 100 });
    const clientMgr = new ReplicationManager(client, false, { tickRate: 100 });

    serverMgr.registerComponent(2, HEALTH_FIELDS);
    clientMgr.registerComponent(2, HEALTH_FIELDS);

    serverMgr.trackEntity(1);
    serverMgr.updateEntityComponent(1, 2, { hp: 75.5, alive: true });

    serverMgr.update(0.02);

    await new Promise((r) => setTimeout(r, 10));

    const data = clientMgr.getEntityData(1, 2);
    expect(data).toBeDefined();
    expect(data!.hp).toBeCloseTo(75.5, 4);
    expect(data!.alive).toBe(true);
  });

  it("should respect maxEntitiesPerPacket", async () => {
    const { server, client } = await makeLinkedPair();
    const serverMgr = new ReplicationManager(server, true, { tickRate: 100, maxEntitiesPerPacket: 2 });
    const clientMgr = new ReplicationManager(client, false, { tickRate: 100, maxEntitiesPerPacket: 2 });

    serverMgr.registerComponent(1, POSITION_FIELDS);
    clientMgr.registerComponent(1, POSITION_FIELDS);

    for (let i = 0; i < 5; i++) {
      serverMgr.trackEntity(i);
      serverMgr.updateEntityComponent(i, 1, { x: i, y: 0, z: 0 });
    }

    serverMgr.update(0.02);
    await new Promise((r) => setTimeout(r, 10));

    let receivedCount = 0;
    for (let i = 0; i < 5; i++) {
      if (clientMgr.getEntityData(i, 1)) receivedCount++;
    }
    expect(receivedCount).toBeLessThanOrEqual(2);
  });

  it("should report RTT and packet loss from transport", () => {
    const transport = new MockTransport();
    transport.setRTT(42);
    transport.setPacketLoss(0.1);
    const mgr = new ReplicationManager(transport, true);
    expect(mgr.getRTT()).toBe(42);
    expect(mgr.getPacketLoss()).toBe(0.1);
  });

  it("should expose RPC manager", () => {
    const transport = new MockTransport();
    const mgr = new ReplicationManager(transport, true);
    expect(mgr.rpc).toBeDefined();
    expect(mgr.rpc.getDefinition).toBeDefined();
  });
});
