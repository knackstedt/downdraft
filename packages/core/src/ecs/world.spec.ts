import { World } from "../ecs/world";
import { getComponentId, component } from "../ecs/component";
import { ROOT_ENTITY } from "../ecs/entity";
import { Hierarchy } from "../ecs/hierarchy";
import { Stage, system } from "../ecs/system";
import { query, queryChanged } from "../ecs/query";
import { EventBus } from "../ecs/events";

const Transform = component("Transform", {
  pos: [0, 0, 0] as number[],
  rot: [0, 0, 0, 0] as number[],
  scale: 1,
  lastChanged: 0,
});

const Velocity = component("Velocity", {
  x: 0,
  y: 0,
  z: 0,
  lastChanged: 0,
});

const Health = component("Health", {
  current: 100,
  max: 100,
  lastChanged: 0,
});

describe("ECS World", () => {
  it("should spawn entities with components", () => {
    const world = new World();
    const components = new Map([
      [Transform.id, Transform.create({ pos: [1, 2, 3] })],
      [Velocity.id, Velocity.create({ x: 5 })],
    ]);
    const entity = world.spawn(components);

    expect(entity.index).toBeGreaterThan(0);
    expect(world.entityCount()).toBe(2); // root + spawned

    const t = world.getComponent<typeof Transform.defaults>(entity, Transform.id);
    expect(t).not.toBeNull();
    expect(t!.pos).toEqual([1, 2, 3]);
  });

  it("should despawn entities", () => {
    const world = new World();
    const entity = world.spawn(new Map([
      [Transform.id, Transform.create()],
    ]));

    expect(world.entityCount()).toBe(2);
    world.despawn(entity);
    world.flushCommands();
    expect(world.entityCount()).toBe(1);
  });

  it("should recycle entity slots with new generation", () => {
    const world = new World();
    const entity = world.spawn(new Map([
      [Transform.id, Transform.create()],
    ]));

    world.despawn(entity);
    world.flushCommands();

    const entity2 = world.spawn(new Map([
      [Transform.id, Transform.create()],
    ]));

    expect(entity2.index).toBe(entity.index);
    expect(entity2.generation).toBe(entity.generation + 1);
  });

  it("should add and remove components", () => {
    const world = new World();
    const entity = world.spawn(new Map([
      [Transform.id, Transform.create()],
    ]));

    expect(world.hasComponent(entity, Velocity.id)).toBe(false);

    world.addComponent(entity, Velocity.id, Velocity.create({ x: 10 }));
    world.flushCommands();

    expect(world.hasComponent(entity, Velocity.id)).toBe(true);
    const v = world.getComponent<typeof Velocity.defaults>(entity, Velocity.id);
    expect(v!.x).toBe(10);

    world.removeComponent(entity, Velocity.id);
    world.flushCommands();
    expect(world.hasComponent(entity, Velocity.id)).toBe(false);
  });

  it("should step the world and run systems", () => {
    const world = new World();
    let ran = false;

    const testSystem = system("test", Stage.Update, () => {
      ran = true;
    });

    world.schedule.add(testSystem);
    world.step(0.016);

    expect(ran).toBe(true);
  });

  it("should handle events with double buffering", () => {
    const bus = new EventBus();
    bus.send("collision", { a: 1, b: 2 });

    // Events sent this tick are not readable until swap
    expect(bus.read("collision").length).toBe(0);

    bus.swapAll();
    const events = bus.read("collision");
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ a: 1, b: 2 });
  });

  it("should not leak stale events across ticks after swap", () => {
    const bus = new EventBus();
    bus.send("collision", { a: 1, b: 2 });
    bus.swapAll();
    expect(bus.read("collision").length).toBe(1);

    // Swap again without sending — old events should be cleared
    bus.swapAll();
    expect(bus.read("collision").length).toBe(0);

    // Send a new event — should be the only one after swap
    bus.send("collision", { a: 3, b: 4 });
    bus.swapAll();
    const events = bus.read("collision");
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ a: 3, b: 4 });
  });

  it("should look up archetypes by ID after component add/remove", () => {
    const world = new World();

    // Spawn entity with Transform only → creates archetype id=1
    const e1 = world.spawn(new Map([[Transform.id, Transform.create()]]));
    // Spawn entity with Velocity only → creates archetype id=2
    const e2 = world.spawn(new Map([[Velocity.id, Velocity.create()]]));
    // Spawn entity with Health only → creates archetype id=3
    const e3 = world.spawn(new Map([[Health.id, Health.create()]]));

    // Now add Velocity to e1 → moves to archetype [Transform, Velocity] id=4
    world.addComponent(e1, Velocity.id, Velocity.create({ x: 5 }));
    world.flushCommands();

    // getComponent must still work — this tests archetypeById lookup
    const t = world.getComponent<typeof Transform.defaults>(e1, Transform.id);
    expect(t).not.toBeNull();
    const v = world.getComponent<typeof Velocity.defaults>(e1, Velocity.id);
    expect(v).not.toBeNull();
    expect(v!.x).toBe(5);

    // Remove Velocity from e1 → moves back to archetype [Transform] id=1
    world.removeComponent(e1, Velocity.id);
    world.flushCommands();

    const t2 = world.getComponent<typeof Transform.defaults>(e1, Transform.id);
    expect(t2).not.toBeNull();
    expect(world.hasComponent(e1, Velocity.id)).toBe(false);

    // All entities should still be accessible
    const v2 = world.getComponent<typeof Velocity.defaults>(e2, Velocity.id);
    expect(v2).not.toBeNull();
    const h = world.getComponent<typeof Health.defaults>(e3, Health.id);
    expect(h).not.toBeNull();
  });
});

describe("ECS Hierarchy", () => {
  it("should set parent and get children", () => {
    const world = new World();
    const hier = new Hierarchy();

    const parent = world.spawn(new Map([[Transform.id, Transform.create()]]));
    const child = world.spawn(new Map([[Transform.id, Transform.create()]]));

    hier.setParent(child, parent);

    expect(hier.getParent(child).index).toBe(parent.index);
    const children = hier.getChildren(parent);
    expect(children.length).toBe(1);
    expect(children[0].index).toBe(child.index);
  });

  it("should propagate dirty flags to children", () => {
    const world = new World();
    const hier = new Hierarchy();

    const parent = world.spawn(new Map([[Transform.id, Transform.create()]]));
    const child = world.spawn(new Map([[Transform.id, Transform.create()]]));

    hier.setParent(child, parent);
    expect(hier.isDirty(child)).toBe(true); // setParent marks dirty

    hier.clearDirty(child);
    hier.clearDirty(parent);
    expect(hier.isDirty(child)).toBe(false);

    hier.markDirty(parent);
    expect(hier.isDirty(parent)).toBe(true);
    expect(hier.isDirty(child)).toBe(true);
  });

  it("should traverse the hierarchy tree", () => {
    const world = new World();
    const hier = new Hierarchy();

    const parent = world.spawn(new Map([[Transform.id, Transform.create()]]));
    const child1 = world.spawn(new Map([[Transform.id, Transform.create()]]));
    const child2 = world.spawn(new Map([[Transform.id, Transform.create()]]));
    const grandchild = world.spawn(new Map([[Transform.id, Transform.create()]]));

    hier.setParent(child1, parent);
    hier.setParent(child2, parent);
    hier.setParent(grandchild, child1);

    const visited: number[] = [];
    hier.traverse(parent, (e) => visited.push(e.index));

    expect(visited).toContain(parent.index);
    expect(visited).toContain(child1.index);
    expect(visited).toContain(child2.index);
    expect(visited).toContain(grandchild.index);
  });
});

describe("ECS Queries", () => {
  it("should iterate matching entities", () => {
    const world = new World();

    const e1 = world.spawn(new Map([
      [Transform.id, Transform.create()],
      [Velocity.id, Velocity.create()],
    ]));
    const e2 = world.spawn(new Map([
      [Transform.id, Transform.create()],
      [Health.id, Health.create()],
    ]));

    const q = query(Transform.id, Velocity.id);
    q.updateArchetypes(world.allArchetypes);

    const matched: number[] = [];
    q.iterate(world.tick, (entity) => {
      matched.push(entity.index);
    });

    expect(matched).toContain(e1.index);
    expect(matched).not.toContain(e2.index);
  });

  it("should filter by changed components", () => {
    const world = new World();

    const e1 = world.spawn(new Map([
      [Transform.id, Transform.create()],
      [Velocity.id, Velocity.create({ x: 5 })],
    ]));

    world.step(0.016); // tick 1

    // Mark velocity as changed on tick 1
    const v = world.getComponent<typeof Velocity.defaults>(e1, Velocity.id);
    if (v) v.lastChanged = world.tick;

    const q = queryChanged([Transform.id], Velocity.id);
    q.updateArchetypes(world.allArchetypes);
    q.descriptor.lastReadTick = 0; // look for changes since tick 0

    let count = 0;
    q.iterate(world.tick, () => {
      count++;
    });

    expect(count).toBe(1);
  });
});
