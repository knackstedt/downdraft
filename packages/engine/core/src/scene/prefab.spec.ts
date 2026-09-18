import { PrefabRegistry, PrefabFactory, createPrefabFromComponentDefs, type Prefab } from "./prefab";
import { World } from "../ecs/world";
import { Hierarchy } from "../ecs/hierarchy";
import { component } from "../ecs/component";
import { ROOT_ENTITY } from "../ecs/entity";

const Position = component("Position", { x: 0, y: 0, z: 0 });
const Health = component("Health", { hp: 100 });
const Tag = component("Tag", { name: "" });

describe("PrefabRegistry", () => {
  it("should register and get prefabs", () => {
    const reg = new PrefabRegistry();
    const prefab: Prefab = {
      name: "enemy",
      components: [{ componentId: Health.id, data: { hp: 50 } }],
    };
    reg.register(prefab);

    expect(reg.get("enemy")).toBe(prefab);
    expect(reg.has("enemy")).toBe(true);
  });

  it("should unregister prefabs", () => {
    const reg = new PrefabRegistry();
    reg.register({ name: "enemy", components: [] });
    reg.unregister("enemy");

    expect(reg.has("enemy")).toBe(false);
  });

  it("should list registered prefab names", () => {
    const reg = new PrefabRegistry();
    reg.register({ name: "a", components: [] });
    reg.register({ name: "b", components: [] });

    expect(reg.list()).toEqual(["a", "b"]);
  });

  it("should clear all prefabs", () => {
    const reg = new PrefabRegistry();
    reg.register({ name: "a", components: [] });
    reg.clear();

    expect(reg.list().length).toBe(0);
  });
});

describe("PrefabFactory", () => {
  it("should spawn entity from prefab", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    reg.register({
      name: "enemy",
      components: [
        { componentId: Health.id, data: { hp: 50 } },
        { componentId: Position.id, data: { x: 1, y: 2, z: 3 } },
      ],
    });

    const entity = factory.spawn("enemy");

    expect(world.hasComponent(entity, Health.id)).toBe(true);
    expect(world.hasComponent(entity, Position.id)).toBe(true);
    const hp = world.getComponent(entity, Health.id) as { hp: number };
    expect(hp.hp).toBe(50);
  });

  it("should attach spawned entity to root by default", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    reg.register({ name: "simple", components: [{ componentId: Health.id, data: { hp: 10 } }] });
    const entity = factory.spawn("simple");

    expect(hierarchy.getParent(entity)).toEqual(ROOT_ENTITY);
  });

  it("should spawn children from prefab", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    reg.register({
      name: "parent",
      components: [{ componentId: Health.id, data: { hp: 100 } }],
      children: [
        { prefab: "child", components: [{ componentId: Tag.id, data: { name: "kid" } }] },
      ],
    });
    reg.register({
      name: "child",
      components: [{ componentId: Position.id, data: { x: 0, y: 0, z: 0 } }],
    });

    const parent = factory.spawn("parent");
    const children = hierarchy.getChildren(parent);

    expect(children.length).toBe(1);
    expect(world.hasComponent(children[0], Tag.id)).toBe(true);
    expect(world.hasComponent(children[0], Position.id)).toBe(true);
  });

  it("should spawn many entities", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    reg.register({ name: "unit", components: [{ componentId: Health.id, data: { hp: 10 } }] });
    const entities = factory.spawnMany("unit", 5);

    expect(entities.length).toBe(5);
  });

  it("should throw for unknown prefab", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    expect(() => factory.spawn("nonexistent")).toThrow();
  });

  it("should override child components from prefab base", () => {
    const world = new World();
    const hierarchy = new Hierarchy();
    const reg = new PrefabRegistry();
    const factory = new PrefabFactory(world, reg, hierarchy);

    reg.register({
      name: "base",
      components: [
        { componentId: Health.id, data: { hp: 100 } },
        { componentId: Position.id, data: { x: 0, y: 0, z: 0 } },
      ],
    });
    reg.register({
      name: "derived",
      components: [{ componentId: Tag.id, data: { name: "derived" } }],
      children: [
        { prefab: "base", components: [{ componentId: Health.id, data: { hp: 50 } }] },
      ],
    });

    const entity = factory.spawn("derived");
    const child = hierarchy.getChildren(entity)[0];
    const hp = world.getComponent(child, Health.id) as { hp: number };
    expect(hp.hp).toBe(50);
  });
});

describe("createPrefabFromComponentDefs", () => {
  it("should create prefab from component definitions", () => {
    const prefab = createPrefabFromComponentDefs("test", [
      { def: Health, overrides: { hp: 42 } },
      { def: Position, overrides: { x: 1, y: 2, z: 3 } },
    ]);

    expect(prefab.name).toBe("test");
    expect(prefab.components.length).toBe(2);
    expect(prefab.components[0].data.hp).toBe(42);
  });

  it("should use defaults when no overrides", () => {
    const prefab = createPrefabFromComponentDefs("test", [
      { def: Health },
    ]);

    expect(prefab.components[0].data.hp).toBe(100);
  });

  it("should include tags", () => {
    const prefab = createPrefabFromComponentDefs("test", [{ def: Health }], ["enemy", "boss"]);
    expect(prefab.tags).toEqual(["enemy", "boss"]);
  });
});
