import { batch, builderToPrefab, c, spawn } from "../scene/builder";
import { PrefabRegistry } from "../scene/prefab";
import { component } from "./component";
import { queryFromDefs } from "./query";
import { resourceToken } from "./resource";
import { Stage } from "./system";
import { q, res, systemWithParams } from "./system-params";
import { World } from "./world";

const Position = component("Position", { x: 0, y: 0 });
const Health = component("Health", { hp: 100, max: 100 });

describe("Typed resource tokens", () => {
  it("should set and get resources via typed tokens", () => {
    const world = new World();
    const CameraToken = resourceToken<{ fov: number }>("camera");

    world.setResourceTyped(CameraToken, { fov: 90 });
    const cam = world.getResourceTyped(CameraToken);

    expect(cam).toBeDefined();
    expect(cam!.fov).toBe(90);
  });

  it("should return undefined for unset tokens", () => {
    const world = new World();
    const Token = resourceToken<number>("missing");

    expect(world.getResourceTyped(Token)).toBeUndefined();
  });
});

describe("ComponentDefinition overloads", () => {
  it("should add/get/has components using ComponentDefinition", () => {
    const world = new World();
    const entity = world.spawn(new Map());

    world.addComponentDef(entity, Position, Position.create({ x: 5 }));
    world.flushCommands();

    expect(world.hasComponentDef(entity, Position)).toBe(true);
    expect(world.getComponentDef(entity, Position)?.x).toBe(5);
  });

  it("should return null for missing component", () => {
    const world = new World();
    const entity = world.spawn(new Map());

    expect(world.getComponentDef(entity, Health)).toBeNull();
  });
});

describe("queryFromDefs", () => {
  it("should create a query from ComponentDefinitions", () => {
    const q = queryFromDefs(Position, Health);
    expect(q.descriptor.required).toContain(Position.id);
    expect(q.descriptor.required).toContain(Health.id);
  });
});

describe("System parameter injection", () => {
  it("should inject resources and queries into system functions", () => {
    const world = new World();
    const GravityToken = resourceToken<number>("gravity");

    world.setResourceTyped(GravityToken, 9.81);

    // Spawn an entity with Position
    spawn(world, c(Position, { x: 1, y: 2 }));

    let appliedGravity = 0;
    let entityCount = 0;

    const gravitySystem = systemWithParams(
      "gravity",
      Stage.Update,
      [res(GravityToken), q(Position)],
      (ctx, gravity, entities) => {
        appliedGravity = gravity.value!;
        entities.iterate(ctx.tick, () => {
          entityCount++;
        });
      },
    );

    world.schedule.addSystem(gravitySystem);
    world.step(0.016);

    expect(appliedGravity).toBe(9.81);
    expect(entityCount).toBe(1);
  });
});

describe("Prefab builder DSL", () => {
  it("should spawn entities from component specs", () => {
    const world = new World();
    const entity = spawn(world, c(Position, { x: 3 }), c(Health, { hp: 50 }));

    expect(world.getComponentDef(entity, Position)?.x).toBe(3);
    expect(world.getComponentDef(entity, Health)?.hp).toBe(50);
  });

  it("should batch spawn entities", () => {
    const world = new World();
    const entities = batch(world, 5, (i) => [
      c(Position, { x: i }),
    ]);

    expect(entities.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(world.getComponentDef(entities[i], Position)?.x).toBe(i);
    }
  });

  it("should convert builder specs to prefab", () => {
    const prefab = builderToPrefab("enemy", [
      c(Position, { x: 10 }),
      c(Health, { hp: 30 }),
    ], ["hostile"]);

    expect(prefab.name).toBe("enemy");
    expect(prefab.tags).toContain("hostile");
    expect(prefab.components.length).toBe(2);

    const registry = new PrefabRegistry();
    registry.register(prefab);
    expect(registry.has("enemy")).toBe(true);
  });
});
