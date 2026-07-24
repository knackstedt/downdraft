import { SchemaRegistry, CURRENT_SCHEMA_VERSION } from "./schema.ts";
import { Serializer, type SaveData } from "./serializer.ts";
import { SaveSystem } from "./migrate.ts";
import { World } from "../ecs/world.ts";
import { component } from "../ecs/component.ts";

const Health = component("Health", { hp: 100 });
const Name = component("Name", { name: "entity" });

describe("SchemaRegistry", () => {
  it("should return current schema version", () => {
    const reg = new SchemaRegistry();
    expect(reg.getCurrentVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("should register and detect migrations", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => ({ ...data, migrated: true }));
    expect(reg.hasMigration(0)).toBe(true);
    expect(reg.hasMigration(1)).toBe(false);
  });

  it("should migrate data through multiple versions", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => ({ ...data, v1: true }));
    reg.registerMigration(1, (data) => ({ ...data, v2: true }));

    const result = reg.migrate({ original: true }, 0, 2);
    expect((result as any).original).toBe(true);
    expect((result as any).v1).toBe(true);
    expect((result as any).v2).toBe(true);
  });

  it("should skip missing migrations gracefully", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(1, (data) => ({ ...data, v2: true }));

    const result = reg.migrate({ original: true }, 0, 2);
    expect((result as any).original).toBe(true);
    expect((result as any).v2).toBe(true);
  });
});

describe("Serializer", () => {
  it("should serialize world entities", () => {
    const world = new World();
    world.spawn(new Map([[Health.id, { hp: 50 }]]));
    world.spawn(new Map([[Name.id, { name: "hero" }]]));
    world.flushCommands();

    const serializer = new Serializer();
    const data = serializer.serialize(world, "test-scene");

    expect(data.schemaVersion).toBe(1);
    expect(data.scene.name).toBe("test-scene");
    // ROOT_ENTITY + 2 spawned = 3 total
    expect(data.scene.entities.length).toBe(3);
  });

  it("should round-trip serialize → deserialize", () => {
    const world = new World();
    world.spawn(new Map([[Health.id, { hp: 75 }]]));
    world.flushCommands();

    const serializer = new Serializer();
    const reg = new SchemaRegistry();
    const data = serializer.serialize(world, "round-trip");

    const newWorld = new World();
    serializer.deserialize(data, newWorld, reg);

    // ROOT_ENTITY + 1 from original + 1 from deserialize = 3
    expect(newWorld.entityCount()).toBe(3);
  });

  it("should convert to and from JSON", () => {
    const data: SaveData = {
      schemaVersion: 1,
      scene: {
        name: "json-test",
        entities: [
          { index: 0, generation: 0, components: [{ id: 1, data: { hp: 100 } }] },
        ],
      },
    };

    const serializer = new Serializer();
    const json = serializer.toJSON(data);
    const parsed = serializer.fromJSON(json);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scene.name).toBe("json-test");
    expect(parsed.scene.entities.length).toBe(1);
  });
});

describe("SaveSystem", () => {
  it("should save and load world state", () => {
    const world = new World();
    world.spawn(new Map([[Health.id, { hp: 42 }]]));
    world.flushCommands();

    const save = new SaveSystem();
    const data = save.save(world, "save-test");

    const newWorld = new World();
    save.load(data, newWorld);

    expect(newWorld.entityCount()).toBe(3);
  });

  it("should expose schema registry for migrations", () => {
    const save = new SaveSystem();
    const reg = save.getSchemaRegistry();
    expect(reg).toBeInstanceOf(SchemaRegistry);
  });

  it("should register migrations through save system", () => {
    const save = new SaveSystem();
    save.registerMigration(0, (data) => ({ ...data, migrated: true }));
    expect(save.getSchemaRegistry().hasMigration(0)).toBe(true);
  });
});
