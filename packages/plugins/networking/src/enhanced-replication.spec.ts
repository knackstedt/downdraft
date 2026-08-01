import { AuthorityManager } from "./authority.ts";
import { DeltaDecoder, DeltaEncoder, InterestManager, InterpolationManager } from "./enhanced-replication.ts";
import type { ReplicatedComponent } from "./replication.ts";
import { ReplicationManager } from "./replication.ts";
import { MockTransport } from "./transport.ts";

describe("ReplicationManager basic", () => {
  it("should register and track entities", () => {
    const transport = new MockTransport();
    const repl = new ReplicationManager(transport, true, { tickRate: 20 });
    repl.registerComponent(1, [
      { name: "x", type: "float32" },
      { name: "y", type: "float32" },
    ]);
    repl.trackEntity(42);
    repl.updateEntityComponent(42, 1, { x: 10.5, y: 20.5 });

    const data = repl.getEntityData(42, 1);
    expect(data).toBeDefined();
    expect(data?.x).toBe(10.5);
  });

  it("should send snapshots on tick", async () => {
    const server = new MockTransport();
    const client = new MockTransport();
    client.link(server);
    await server.connect("mock://s");
    await client.connect("mock://c");

    const repl = new ReplicationManager(server, true, { tickRate: 20 });
    repl.registerComponent(1, [{ name: "health", type: "float32" }]);
    repl.trackEntity(1);
    repl.updateEntityComponent(1, 1, { health: 100 });

    const sent: number[] = [];
    client.onMessage((msg) => sent.push(msg.type));

    repl.update(0.06);
    expect(sent).toContain(1);
  });

  it("should not send snapshots as client", () => {
    const transport = new MockTransport();
    const repl = new ReplicationManager(transport, false, { tickRate: 20 });
    repl.registerComponent(1, [{ name: "x", type: "float32" }]);
    repl.trackEntity(1);
    repl.updateEntityComponent(1, 1, { x: 5 });

    const sent: number[] = [];
    transport.onMessage((msg) => sent.push(msg.type));

    repl.update(0.06);
    expect(sent).toHaveLength(0);
  });
});

describe("DeltaEncoder/Decoder", () => {
  const componentDefs = new Map<number, ReplicatedComponent>([
    [1, {
      componentId: 1,
      fields: [
        { name: "x", type: "float32" },
        { name: "y", type: "float32" },
        { name: "hp", type: "uint16" },
      ],
      mode: "authoritative",
    }],
  ]);

  function makeSnapshot(tick: number, entityId: number, x: number, y: number, hp: number) {
    const dv = new DataView(new ArrayBuffer(10));
    dv.setFloat32(0, x);
    dv.setFloat32(4, y);
    dv.setUint16(8, hp);
    return {
      tick,
      entities: [{
        entityId,
        components: [{ componentId: 1, data: new Uint8Array(dv.buffer) }],
      }],
    };
  }

  it("should encode full snapshot as delta on first send", () => {
    const encoder = new DeltaEncoder();
    const snap = makeSnapshot(1, 100, 10, 20, 50);
    const delta = encoder.encodeDelta(snap, componentDefs);
    expect(delta.tick).toBe(1);
    expect(delta.entities).toHaveLength(1);
    expect(delta.entities[0].changedComponents).toHaveLength(1);
    const mask = delta.entities[0].changedComponents[0].fieldMask;
    expect(mask[0] & 0b001).toBe(1);
    expect(mask[0] & 0b010).toBe(2);
    expect(mask[0] & 0b100).toBe(4);
  });

  it("should only encode changed fields in subsequent snapshots", () => {
    const encoder = new DeltaEncoder();
    encoder.encodeDelta(makeSnapshot(1, 100, 10, 20, 50), componentDefs);
    const delta = encoder.encodeDelta(makeSnapshot(2, 100, 15, 20, 50), componentDefs);

    expect(delta.entities).toHaveLength(1);
    const mask = delta.entities[0].changedComponents[0].fieldMask;
    expect(mask[0] & 0b001).toBe(1);
    expect(mask[0] & 0b010).toBe(0);
    expect(mask[0] & 0b100).toBe(0);
  });

  it("should decode delta back to full snapshot", () => {
    const encoder = new DeltaEncoder();
    const decoder = new DeltaDecoder();

    const snap1 = makeSnapshot(1, 100, 10, 20, 50);
    const delta1 = encoder.encodeDelta(snap1, componentDefs);
    const decoded1 = decoder.decodeDelta(delta1, componentDefs);
    expect(decoded1.entities).toHaveLength(1);

    const dv1 = new DataView(decoded1.entities[0].components[0].data.buffer);
    expect(dv1.getFloat32(0)).toBeCloseTo(10);
    expect(dv1.getFloat32(4)).toBeCloseTo(20);
    expect(dv1.getUint16(8)).toBe(50);

    const snap2 = makeSnapshot(2, 100, 15, 20, 50);
    const delta2 = encoder.encodeDelta(snap2, componentDefs);
    const decoded2 = decoder.decodeDelta(delta2, componentDefs);

    const dv2 = new DataView(decoded2.entities[0].components[0].data.buffer);
    expect(dv2.getFloat32(0)).toBeCloseTo(15);
    expect(dv2.getFloat32(4)).toBeCloseTo(20);
    expect(dv2.getUint16(8)).toBe(50);
  });

  it("should produce empty delta when nothing changed", () => {
    const encoder = new DeltaEncoder();
    encoder.encodeDelta(makeSnapshot(1, 100, 10, 20, 50), componentDefs);
    const delta = encoder.encodeDelta(makeSnapshot(2, 100, 10, 20, 50), componentDefs);
    expect(delta.entities).toHaveLength(0);
  });
});

describe("InterestManager", () => {
  it("should return all entities when no area is set", () => {
    const mgr = new InterestManager();
    mgr.updateEntityPosition(1, 0, 0, 0);
    mgr.updateEntityPosition(2, 100, 100, 100);
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant).toHaveLength(2);
  });

  it("should filter entities by distance", () => {
    const mgr = new InterestManager();
    mgr.setArea("peer-1", { centerX: 0, centerY: 0, centerZ: 0, radius: 10 });
    mgr.updateEntityPosition(1, 5, 0, 0);
    mgr.updateEntityPosition(2, 100, 0, 0);
    const relevant = mgr.getRelevantEntities("peer-1");
    expect(relevant).toContain(1);
    expect(relevant).not.toContain(2);
  });

  it("should filter snapshots by relevance", () => {
    const mgr = new InterestManager();
    mgr.setArea("peer-1", { centerX: 0, centerY: 0, centerZ: 0, radius: 10 });
    mgr.updateEntityPosition(1, 5, 0, 0);
    mgr.updateEntityPosition(2, 100, 0, 0);
    const snap = {
      tick: 1,
      entities: [
        { entityId: 1, components: [] },
        { entityId: 2, components: [] },
      ],
    };
    const filtered = mgr.filterSnapshot(snap, "peer-1");
    expect(filtered.entities).toHaveLength(1);
    expect(filtered.entities[0].entityId).toBe(1);
  });
});

describe("InterpolationManager", () => {
  it("should return latest value with insufficient buffer", () => {
    const interp = new InterpolationManager();
    const data = new Map([[1, new Map([[1, { x: 10 }]])]]);
    interp.addSnapshot(1, data, 0);
    interp.update(0.5);
    expect(interp.getInterpolatedState(1, 1, "x")).toBe(10);
  });

  it("should interpolate between two snapshots", () => {
    const interp = new InterpolationManager();
    interp.setInterpolationDelay(0);

    const data1 = new Map([[1, new Map([[1, { x: 0 }]])]]);
    const data2 = new Map([[1, new Map([[1, { x: 100 }]])]]);
    interp.addSnapshot(1, data1, 0);
    interp.addSnapshot(2, data2, 1);

    interp.update(0.5);
    const val = interp.getInterpolatedState(1, 1, "x");
    expect(val).toBeCloseTo(50);
  });

  it("should clamp interpolation alpha", () => {
    const interp = new InterpolationManager();
    interp.setInterpolationDelay(0);

    const data1 = new Map([[1, new Map([[1, { x: 0 }]])]]);
    const data2 = new Map([[1, new Map([[1, { x: 100 }]])]]);
    interp.addSnapshot(1, data1, 0);
    interp.addSnapshot(2, data2, 1);

    interp.update(2);
    const val = interp.getInterpolatedState(1, 1, "x");
    expect(val).toBe(100);
  });

  it("should return non-numeric values from latest", () => {
    const interp = new InterpolationManager();
    interp.setInterpolationDelay(0);

    const data1 = new Map([[1, new Map([[1, { name: "alpha" }]])]]);
    const data2 = new Map([[1, new Map([[1, { name: "beta" }]])]]);
    interp.addSnapshot(1, data1, 0);
    interp.addSnapshot(2, data2, 1);

    interp.update(0.5);
    const val = interp.getInterpolatedState(1, 1, "name");
    expect(val).toBe("beta");
  });
});

describe("AuthorityManager", () => {
  it("should give server authority by default on server", () => {
    const mgr = new AuthorityManager("server", true);
    mgr.registerEntity(1, "server");
    expect(mgr.hasAuthority(1)).toBe(true);
    expect(mgr.canModify(1)).toBe(true);
  });

  it("should not give client authority over server entities", () => {
    const mgr = new AuthorityManager("client-1", false);
    mgr.registerEntity(1, "server");
    expect(mgr.hasAuthority(1)).toBe(false);
  });

  it("should grant authority to client", () => {
    const mgr = new AuthorityManager("client-1", false);
    mgr.registerEntity(1, "client");
    expect(mgr.hasAuthority(1)).toBe(true);
  });

  it("should request authority on server", () => {
    const server = new AuthorityManager("server", true);
    server.registerEntity(1, "server");
    const granted = server.requestAuthority(1, "client-1");
    expect(granted).toBe(true);
    expect(server.getAuthority(1)?.ownerPeerId).toBe("client-1");
  });

  it("should not request authority as client", () => {
    const client = new AuthorityManager("client-1", false);
    client.registerEntity(1, "server");
    const granted = client.requestAuthority(1, "client-2");
    expect(granted).toBe(false);
  });

  it("should lock entity authority", () => {
    const server = new AuthorityManager("server", true);
    server.registerEntity(1, "server");
    server.lockAuthority(1);
    expect(server.requestAuthority(1, "client-1")).toBe(false);
    server.unlockAuthority(1);
    expect(server.requestAuthority(1, "client-1")).toBe(true);
  });

  it("should fire authority change callbacks", () => {
    const server = new AuthorityManager("server", true);
    server.registerEntity(1, "server");
    const changes: number[] = [];
    server.onAuthorityChange((entityId) => changes.push(entityId));
    server.grantAuthority(1, "client-1");
    expect(changes).toContain(1);
  });

  it("should get owned entities", () => {
    const mgr = new AuthorityManager("client-1", false);
    mgr.registerEntity(1, "client");
    mgr.registerEntity(2, "server");
    mgr.registerEntity(3, "client");
    const owned = mgr.getOwnedEntities();
    expect(owned).toContain(1);
    expect(owned).toContain(3);
    expect(owned).not.toContain(2);
  });

  it("should support shared authority", () => {
    const mgr = new AuthorityManager("client-1", false);
    mgr.registerEntity(1, "shared");
    expect(mgr.hasAuthority(1)).toBe(true);
  });
});
