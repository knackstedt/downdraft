import { component } from "./component";
import { Schedule } from "./schedule";
import { Stage, system, type SystemFn } from "./system";
import type { World } from "./world";

const A = component("A", { value: 0 });
const B = component("B", { value: 0 });

describe("Schedule", () => {
  function makeMockWorld(): World {
    return {
      archetypes: [],
      queries: [],
      step: () => {},
      spawn: () => ({ index: 0, generation: 0 }),
      despawn: () => {},
      addComponent: () => {},
      removeComponent: () => {},
      getComponent: () => undefined,
      hasComponent: () => false,
      flushCommands: () => {},
      getEventBus: () => ({ swapAll: () => {}, clearAll: () => {}, channel: () => ({ send: () => {}, read: () => [] }) }),
      getResource: () => undefined,
      setResource: () => {},
      getTick: () => 0,
    } as unknown as World;
  }

  it("should add systems to stages", () => {
    const s = new Schedule();
    const fn: SystemFn = () => {};
    const sys = system("test", Stage.Update, fn);

    s.addSystem(sys);

    const systems = s.getSystems(Stage.Update);
    expect(systems.length).toBe(1);
    expect(systems[0].name).toBe("test");
  });

  it("should remove systems", () => {
    const s = new Schedule();
    const fn: SystemFn = () => {};
    const sys = system("test", Stage.Update, fn);

    s.addSystem(sys);
    s.removeSystem("test");

    expect(s.getSystems(Stage.Update).length).toBe(0);
  });

  it("should run systems in stage order", () => {
    const s = new Schedule();
    const order: string[] = [];

    s.addSystem(system("input", Stage.Input, () => { order.push("input"); }));
    s.addSystem(system("render", Stage.Render, () => { order.push("render"); }));
    s.addSystem(system("update", Stage.Update, () => { order.push("update"); }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(order).toEqual(["input", "update", "render"]);
  });

  it("should respect after dependencies", () => {
    const s = new Schedule();
    const order: string[] = [];

    s.addSystem(system("b", Stage.Update, () => { order.push("b"); }, { after: ["a"] }));
    s.addSystem(system("a", Stage.Update, () => { order.push("a"); }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });

  it("should respect before dependencies", () => {
    const s = new Schedule();
    const order: string[] = [];

    // "a" declares `before: ["b"]` — a must run before b
    s.addSystem(system("a", Stage.Update, () => { order.push("a"); }, { before: ["b"] }));
    s.addSystem(system("b", Stage.Update, () => { order.push("b"); }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });

  it("should handle before and after dependencies together", () => {
    const s = new Schedule();
    const order: string[] = [];

    // a → b → c chain: a has before:[b], c has after:[b]
    s.addSystem(system("c", Stage.Update, () => { order.push("c"); }, { after: ["b"] }));
    s.addSystem(system("a", Stage.Update, () => { order.push("a"); }, { before: ["b"] }));
    s.addSystem(system("b", Stage.Update, () => { order.push("b"); }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("should handle multiple stages with dependencies", () => {
    const s = new Schedule();
    const order: string[] = [];

    s.addSystem(system("physics", Stage.Physics, () => { order.push("physics"); }));
    s.addSystem(system("post", Stage.PostUpdate, () => { order.push("post"); }, { after: ["physics"] }));
    s.addSystem(system("input", Stage.Input, () => { order.push("input"); }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(order).toEqual(["input", "physics", "post"]);
  });

  it("should pass SystemContext to system function", () => {
    const s = new Schedule();
    let receivedDt = 0;
    let receivedTick = 0;

    s.addSystem(system("ctx", Stage.Update, (ctx) => {
      receivedDt = ctx.dt;
      receivedTick = ctx.tick;
    }));

    const world = makeMockWorld();
    s.run(world, 0.033, 42);

    expect(receivedDt).toBe(0.033);
    expect(receivedTick).toBe(42);
  });

  it("should run systems with queries", () => {
    const s = new Schedule();
    let ran = false;

    const q = { descriptor: { required: [A.id], excluded: [], lastReadTick: 0 }, matchesArchetype: () => true, updateArchetypes: () => {}, iterate: () => {}, count: () => 0 } as any;

    s.addSystem(system("qsys", Stage.Update, () => { ran = true; }, { queries: [q] }));

    const world = makeMockWorld();
    s.run(world, 0.016, 1);

    expect(ran).toBe(true);
  });

  it("should handle empty schedule", () => {
    const s = new Schedule();
    const world = makeMockWorld();
    expect(() => s.run(world, 0.016, 1)).not.toThrow();
  });
});
