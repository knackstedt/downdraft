import { Serializer, type SaveData } from "./serializer";
import { SchemaRegistry } from "./schema";
import { World } from "../ecs/world";
import { component } from "../ecs/component";

const Position = component("Position", { x: 0, y: 0, z: 0 });
const Health = component("Health", { hp: 100 });

describe("Serializer", () => {
  it("should serialize world state to SaveData", () => {
    const world = new World();
    const serializer = new Serializer();

    world.spawn(new Map([
      [Position.id, { x: 1, y: 2, z: 3 }],
      [Health.id, { hp: 50 }],
    ]));
    world.flushCommands();

    const data = serializer.serialize(world, "test-scene");

    expect(data.schemaVersion).toBe(1);
    expect(data.scene.name).toBe("test-scene");
    expect(data.scene.entities.length).toBe(1);
    expect(data.scene.entities[0].components.length).toBe(2);
  });

  it("should serialize multiple entities", () => {
    const world = new World();
    const serializer = new Serializer();

    for (let i = 0; i < 5; i++) {
      world.spawn(new Map([
        [Position.id, { x: i, y: 0, z: 0 }],
      ]));
    }
    world.flushCommands();

    const data = serializer.serialize(world, "multi");
    expect(data.scene.entities.length).toBe(5);
  });

  it("should handle empty world", () => {
    const world = new World();
    const serializer = new Serializer();

    const data = serializer.serialize(world, "empty");
    expect(data.scene.entities.length).toBe(0);
  });

  it("should deserialize into a new world", () => {
    const world = new World();
    const serializer = new Serializer();
    const schema = new SchemaRegistry();

    world.spawn(new Map([
      [Position.id, { x: 10, y: 20, z: 30 }],
      [Health.id, { hp: 75 }],
    ]));
    world.flushCommands();

    const data = serializer.serialize(world, "test");

    const newWorld = new World();
    serializer.deserialize(data, newWorld, schema);
    newWorld.flushCommands();

    let aliveCount = 0;
    newWorld.entities.forEach((meta) => {
      if (meta.alive) aliveCount++;
    });
    expect(aliveCount).toBe(1);
  });

  it("should serialize binary data as blob references", () => {
    const world = new World();
    const serializer = new Serializer();

    const buf = new ArrayBuffer(16);
    const view = new Float32Array(buf);
    view[0] = 1.0;
    view[1] = 2.0;
    view[2] = 3.0;
    view[3] = 4.0;

    world.spawn(new Map([
      [Position.id, { x: 0, y: 0, z: 0 }],
    ]));
    world.flushCommands();

    const data = serializer.serialize(world, "binary-test");
    expect(data.scene.entities.length).toBe(1);
  });

  it("should round-trip through JSON", () => {
    const world = new World();
    const serializer = new Serializer();

    world.spawn(new Map([
      [Position.id, { x: 5, y: 10, z: 15 }],
      [Health.id, { hp: 42 }],
    ]));
    world.flushCommands();

    const data = serializer.serialize(world, "json-test");
    const json = serializer.toJSON(data);
    const restored = serializer.fromJSON(json);

    expect(restored.scene.name).toBe("json-test");
    expect(restored.scene.entities.length).toBe(1);
    expect(restored.schemaVersion).toBe(1);
  });

  it("should round-trip through binary", () => {
    const world = new World();
    const serializer = new Serializer();

    world.spawn(new Map([
      [Position.id, { x: 1, y: 2, z: 3 }],
    ]));
    world.flushCommands();

    const data = serializer.serialize(world, "binary-test");
    const binary = serializer.toBinary(data);
    const restored = serializer.fromBinary(binary);

    expect(restored.scene.name).toBe("binary-test");
    expect(restored.scene.entities.length).toBe(1);
  });

  it("should handle binary blobs in JSON round-trip", () => {
    const serializer = new Serializer();
    const data: SaveData = {
      schemaVersion: 1,
      scene: { name: "blob-test", entities: [] },
      binaryBlobs: {
        test_blob: new ArrayBuffer(8),
      },
    };

    const json = serializer.toJSON(data);
    const restored = serializer.fromJSON(json);

    expect(restored.binaryBlobs).toBeDefined();
    expect(restored.binaryBlobs!.test_blob).toBeInstanceOf(ArrayBuffer);
  });
});
