import { component } from "./component";
import { World } from "./world";

const Position = component("Position", { x: 0, y: 0, z: 0 });
const Health = component("Health", { hp: 100 });

describe("World.clearAllEntities", () => {
  it("should despawn all alive entities", () => {
    const world = new World();

    world.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    world.spawn(new Map([[Health.id, { hp: 50 }]]));
    world.spawn(new Map([
      [Position.id, { x: 10, y: 20, z: 30 }],
      [Health.id, { hp: 75 }],
    ]));
    world.flushCommands();

    expect(world.entityCount()).toBe(4); // 3 spawned + ROOT

    world.clearAllEntities();

    expect(world.entityCount()).toBe(1); // ROOT only
  });

  it("should flush commands so entities are immediately gone", () => {
    const world = new World();

    world.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    world.flushCommands();

    world.clearAllEntities();

    expect(world.entityCount()).toBe(1); // ROOT only
  });

  it("should allow spawning new entities immediately after clear", () => {
    const world = new World();

    world.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    world.flushCommands();

    world.clearAllEntities();

    world.spawn(new Map([[Position.id, { x: 10, y: 20, z: 30 }]]));
    world.flushCommands();

    expect(world.entityCount()).toBe(2); // 1 spawned + ROOT
  });

  it("should handle empty world gracefully", () => {
    const world = new World();
    expect(() => world.clearAllEntities()).not.toThrow();
    expect(world.entityCount()).toBe(1); // ROOT only
  });

  it("should not despawn ROOT entity (index 0)", () => {
    const world = new World();
    world.clearAllEntities();
    expect(world.entities[0].alive).toBe(true);
  });
});
