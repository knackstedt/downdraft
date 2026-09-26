import { CheckpointManager } from "./checkpoint";
import { World } from "../ecs/world";
import { component } from "../ecs/component";

const Position = component("Position", { x: 0, y: 0, z: 0 });
const Health = component("Health", { hp: 100 });

describe("CheckpointManager", () => {
  it("should create a checkpoint from world state", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    world.spawn(new Map([
      [Position.id, { x: 1, y: 2, z: 3 }],
      [Health.id, { hp: 50 }],
    ]));
    world.flushCommands();

    const cp = mgr.create("save1", world);

    expect(cp.name).toBe("save1");
    expect(cp.entities.length).toBe(1);
    expect(cp.entities[0].components.length).toBe(2);
  });

  it("should restore world state from checkpoint", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    world.spawn(new Map([
      [Position.id, { x: 5, y: 10, z: 15 }],
      [Health.id, { hp: 75 }],
    ]));
    world.flushCommands();

    mgr.create("save1", world);

    world.spawn(new Map([
      [Position.id, { x: 0, y: 0, z: 0 }],
    ]));
    world.flushCommands();

    mgr.restore("save1", world);
    world.flushCommands();

    let count = 0;
    world.entities.forEach((meta) => {
      if (meta.alive) count++;
    });
    expect(count).toBe(1);
  });

  it("should return false for non-existent checkpoint", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    expect(mgr.restore("nonexistent", world)).toBe(false);
  });

  it("should list all checkpoints", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    mgr.create("cp1", world);
    mgr.create("cp2", world);
    mgr.create("cp3", world);

    const list = mgr.list();
    expect(list.length).toBe(3);
    expect(list.map((c) => c.name)).toContain("cp1");
    expect(list.map((c) => c.name)).toContain("cp2");
    expect(list.map((c) => c.name)).toContain("cp3");
  });

  it("should diff two checkpoints", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    const e1 = world.spawn(new Map([
      [Position.id, { x: 1, y: 0, z: 0 }],
    ]));
    world.flushCommands();

    mgr.create("cp_a", world);

    world.spawn(new Map([
      [Position.id, { x: 2, y: 0, z: 0 }],
    ]));
    world.flushCommands();

    mgr.create("cp_b", world);

    const diff = mgr.diff("cp_a", "cp_b");
    expect(diff).not.toBeNull();
    expect(diff!.added.length).toBe(1);
    expect(diff!.removed.length).toBe(0);
  });

  it("should return null for diff with non-existent checkpoints", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    expect(mgr.diff("a", "b")).toBeNull();
  });

  it("should handle empty world checkpoint", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    const cp = mgr.create("empty", world);
    expect(cp.entities.length).toBe(0);
  });

  it("should handle multiple entities in checkpoint", () => {
    const world = new World();
    const mgr = new CheckpointManager();

    for (let i = 0; i < 5; i++) {
      world.spawn(new Map([
        [Position.id, { x: i, y: 0, z: 0 }],
        [Health.id, { hp: 100 - i * 10 }],
      ]));
    }
    world.flushCommands();

    const cp = mgr.create("multi", world);
    expect(cp.entities.length).toBe(5);
  });
});
