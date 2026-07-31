import { component, type ComponentDefinition } from "../ecs/component.ts";
import { World } from "../ecs/world.ts";
import { SceneManager } from "./scene-manager.ts";
import { Scene } from "./scene.ts";

interface PositionData { x: number; y: number; z: number }
const Position: ComponentDefinition<PositionData> = component<PositionData>("Position", { x: 0, y: 0, z: 0 });

describe("Scene", () => {
  function makeWorld(): World {
    return new World();
  }

  it("should start in unloaded state", () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    expect(scene.state).toBe("unloaded");
    expect(scene.isActive()).toBe(false);
    expect(scene.isLoaded()).toBe(false);
  });

  it("should load and call setup function", async () => {
    const world = makeWorld();
    let setupCalled = false;
    const scene = new Scene("test", world, (s) => {
      setupCalled = true;
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });

    await scene.load();
    expect(setupCalled).toBe(true);
    expect(scene.state).toBe("loaded");
    expect(scene.isLoaded()).toBe(true);
    expect(scene.getEntityCount()).toBe(1);
  });

  it("should activate and deactivate", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    await scene.load();

    scene.activate();
    expect(scene.isActive()).toBe(true);
    expect(scene.state).toBe("active");

    scene.deactivate();
    expect(scene.isActive()).toBe(false);
    expect(scene.state).toBe("inactive");
  });

  it("should not activate when unloaded", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    scene.activate();
    expect(scene.state).toBe("unloaded");
  });

  it("should unload and despawn all tracked entities", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world, (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await scene.load();
    expect(scene.getEntityCount()).toBe(2);
    expect(world.entityCount()).toBe(3); // root + 2 spawned

    scene.unload();
    expect(scene.state).toBe("unloaded");
    expect(scene.getEntityCount()).toBe(0);
    expect(world.entityCount()).toBe(1); // only root remains
  });

  it("should track entities spawned via scene.spawn", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    await scene.load();

    const e1 = scene.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    const e2 = scene.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));

    expect(scene.getEntityCount()).toBe(2);
    expect(scene.getEntities()).toHaveLength(2);

    scene.despawn(e1);
    expect(scene.getEntityCount()).toBe(1);

    scene.untrackEntity(e2);
    expect(scene.getEntityCount()).toBe(0);
  });

  it("should not double-track entities", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    await scene.load();

    const e = scene.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    scene.trackEntity(e);
    scene.trackEntity(e);

    expect(scene.getEntityCount()).toBe(1);
  });

  it("should serialize and deserialize", async () => {
    const world = makeWorld();
    const scene = new Scene("test", world, (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });
    await scene.load();
    scene.activate();

    const data = scene.serialize();
    expect(data.name).toBe("test");
    expect(data.state).toBe("active");
    expect(data.entities).toHaveLength(2);
    expect(data.entities[0].components).toHaveLength(1);
    expect(data.entities[0].components[0].id).toBe(Position.id);

    // Deserialize into a fresh scene
    const world2 = makeWorld();
    const scene2 = new Scene("fresh", world2);
    scene2.deserialize(data);

    expect(scene2.name).toBe("test");
    expect(scene2.getEntityCount()).toBe(2);
    expect(scene2.state).toBe("active");

    const entities = scene2.getEntities();
    expect(entities).toHaveLength(2);
    const pos = world2.getComponent<PositionData>(entities[0], Position.id);
    expect(pos).not.toBeNull();
    expect(pos!.x).toBe(1);
  });

  it("should call teardown on unload", async () => {
    const world = makeWorld();
    let teardownCalled = false;
    const scene = new Scene("test", world);
    scene.setSetup((s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    scene.setTeardown(() => {
      teardownCalled = true;
    });

    await scene.load();
    scene.unload();
    expect(teardownCalled).toBe(true);
  });

  it("should support persistent flag", () => {
    const world = makeWorld();
    const scene = new Scene("test", world);
    expect(scene.persistent).toBe(false);
    scene.persistent = true;
    expect(scene.persistent).toBe(true);
  });
});

describe("SceneManager", () => {
  function makeWorld(): World {
    return new World();
  }

  it("should register and retrieve scenes", () => {
    const world = makeWorld();
    const manager = new SceneManager(world);
    const scene = manager.create("level1");

    expect(manager.has("level1")).toBe(true);
    expect(manager.get("level1")).toBe(scene);
    expect(manager.list()).toHaveLength(1);
  });

  it("should load and activate scenes", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);
    const scene = manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });

    await manager.load("level1");
    expect(scene.state).toBe("loaded");

    manager.activate("level1");
    expect(scene.isActive()).toBe(true);
    expect(manager.getCurrentScene()).toBe(scene);
  });

  it("should transition between scenes", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    const scene1 = manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    const scene2 = manager.create("level2", (s) => {
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");
    expect(manager.getCurrentScene()).toBe(scene1);
    expect(world.entityCount()).toBe(2); // root + 1 spawned

    await manager.transition("level2");
    expect(manager.getCurrentScene()).toBe(scene2);
    expect(scene2.isActive()).toBe(true);
    // scene1 should be unloaded (not persistent)
    expect(scene1.state).toBe("unloaded");
    expect(world.entityCount()).toBe(2); // root + 1 from scene2
  });

  it("should keep persistent scenes on transition", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    const scene1 = manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    scene1.persistent = true;
    const scene2 = manager.create("level2", (s) => {
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");

    await manager.transition("level2");
    expect(scene1.state).toBe("inactive");
    expect(scene2.isActive()).toBe(true);
    expect(world.entityCount()).toBe(3); // root + 1 from each scene
  });

  it("should support additive loading", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    const scene1 = manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    const scene2 = manager.create("level2", (s) => {
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");

    await manager.loadAdditive("level2");
    expect(scene2.isActive()).toBe(true);
    expect(world.entityCount()).toBe(3); // root + 1 from each
    expect(manager.listActive()).toHaveLength(2);
  });

  it("should unload additive scenes", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    const scene1 = manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    const scene2 = manager.create("level2", (s) => {
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");
    await manager.loadAdditive("level2");

    expect(world.entityCount()).toBe(3); // root + 1 from each
    manager.unloadAdditive("level2");
    expect(scene2.state).toBe("unloaded");
    expect(world.entityCount()).toBe(2); // root + 1 from scene1
  });

  it("should unload all scenes", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });
    manager.create("level2", (s) => {
      s.spawn(new Map([[Position.id, { x: 4, y: 5, z: 6 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");
    await manager.loadAdditive("level2");

    expect(world.entityCount()).toBe(3); // root + 1 from each
    manager.unloadAll();
    expect(world.entityCount()).toBe(1); // only root remains
    expect(manager.getCurrentScene()).toBeNull();
  });

  it("should unregister scenes", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);
    manager.create("level1", (s) => {
      s.spawn(new Map([[Position.id, { x: 1, y: 2, z: 3 }]]));
    });

    await manager.load("level1");
    manager.activate("level1");

    manager.unregister("level1");
    expect(manager.has("level1")).toBe(false);
    expect(world.entityCount()).toBe(1); // only root remains
  });

  it("should throw on unknown scene operations", async () => {
    const world = makeWorld();
    const manager = new SceneManager(world);

    await expect(manager.load("unknown")).rejects.toThrow();
    expect(() => manager.activate("unknown")).toThrow();
    await expect(manager.transition("unknown")).rejects.toThrow();
    await expect(manager.loadAdditive("unknown")).rejects.toThrow();
  });
});
