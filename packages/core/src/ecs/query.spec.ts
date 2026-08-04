import { addEntityToArchetype, createArchetype } from "./archetype";
import { component } from "./component";
import type { Entity } from "./entity";
import { Query, query, queryChanged, queryExcluded } from "./query";

const Position = component("Position", { x: 0, y: 0, lastChanged: 0 });
const Velocity = component("Velocity", { vx: 0, vy: 0, lastChanged: 0 });
const Health = component("Health", { hp: 100, lastChanged: 0 });

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

describe("Query", () => {
  it("should construct with required components", () => {
    const q = new Query([Position.id, Velocity.id]);
    expect(q.descriptor.required).toEqual([Position.id, Velocity.id]);
    expect(q.descriptor.excluded).toEqual([]);
    expect(q.descriptor.changedFilter).toBeUndefined();
    expect(q.descriptor.lastReadTick).toBe(0);
  });

  it("should construct with excluded components", () => {
    const q = new Query([Position.id], [Velocity.id]);
    expect(q.descriptor.excluded).toEqual([Velocity.id]);
  });

  it("should construct with changed filter", () => {
    const q = new Query([Position.id], [], Velocity.id);
    expect(q.descriptor.changedFilter).toBe(Velocity.id);
  });

  it("query() factory should create query with required only", () => {
    const q = query(Position.id, Velocity.id);
    expect(q.descriptor.required).toEqual([Position.id, Velocity.id]);
    expect(q.descriptor.excluded).toEqual([]);
  });

  it("queryExcluded() factory should create query with exclusion", () => {
    const q = queryExcluded([Position.id], [Velocity.id]);
    expect(q.descriptor.required).toEqual([Position.id]);
    expect(q.descriptor.excluded).toEqual([Velocity.id]);
  });

  it("queryChanged() factory should create query with changed filter", () => {
    const q = queryChanged([Position.id], Velocity.id);
    expect(q.descriptor.required).toEqual([Position.id]);
    expect(q.descriptor.changedFilter).toBe(Velocity.id);
  });

  it("updateArchetypes should match correct archetypes", () => {
    const arch1 = createArchetype([Position.id, Velocity.id]);
    const arch2 = createArchetype([Position.id, Health.id]);
    const arch3 = createArchetype([Position.id, Velocity.id, Health.id]);

    const q = query(Position.id, Velocity.id);
    q.updateArchetypes([arch1, arch2, arch3]);

    expect(q.matchesArchetype(arch1)).toBe(true);
    expect(q.matchesArchetype(arch2)).toBe(false);
    expect(q.matchesArchetype(arch3)).toBe(true);
  });

  it("updateArchetypes with excluded should not match archetypes containing excluded", () => {
    const arch1 = createArchetype([Position.id, Velocity.id]);
    const arch2 = createArchetype([Position.id, Velocity.id, Health.id]);

    const q = queryExcluded([Position.id, Velocity.id], [Health.id]);
    q.updateArchetypes([arch1, arch2]);

    expect(q.matchesArchetype(arch1)).toBe(true);
    expect(q.matchesArchetype(arch2)).toBe(false);
  });

  it("iterate should visit all matching entities", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);

    addEntityToArchetype(arch, e1, new Map([
      [Position.id, { x: 10, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 1, vy: 0, lastChanged: 0 }],
    ]));
    addEntityToArchetype(arch, e2, new Map([
      [Position.id, { x: 20, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 2, vy: 0, lastChanged: 0 }],
    ]));

    const q = query(Position.id, Velocity.id);
    q.updateArchetypes([arch]);

    const visited: number[] = [];
    q.iterate(1, (entity) => {
      visited.push(entity.index);
    });

    expect(visited).toContain(1);
    expect(visited).toContain(2);
    expect(visited.length).toBe(2);
  });

  it("iterate should provide component data", () => {
    const arch = createArchetype([Position.id]);
    const e1 = makeEntity(1);

    addEntityToArchetype(arch, e1, new Map([
      [Position.id, { x: 42, y: 99, lastChanged: 0 }],
    ]));

    const q = query(Position.id);
    q.updateArchetypes([arch]);

    q.iterate(1, (_entity, comps) => {
      const pos = comps[0] as { x: number; y: number };
      expect(pos.x).toBe(42);
      expect(pos.y).toBe(99);
    });
  });

  it("iterate with changedFilter should only visit changed entities", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);

    addEntityToArchetype(arch, e1, new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 1, vy: 0, lastChanged: 5 }],
    ]));
    addEntityToArchetype(arch, e2, new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 2, vy: 0, lastChanged: 0 }],
    ]));

    const q = queryChanged([Position.id], Velocity.id);
    q.updateArchetypes([arch]);
    q.descriptor.lastReadTick = 3;

    let count = 0;
    q.iterate(10, () => {
      count++;
    });

    expect(count).toBe(1);
  });

  it("iterate should provide correct component data for each entity across multiple iterations", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const e3 = makeEntity(3);

    addEntityToArchetype(arch, e1, new Map([
      [Position.id, { x: 10, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 100, vy: 0, lastChanged: 0 }],
    ]));
    addEntityToArchetype(arch, e2, new Map([
      [Position.id, { x: 20, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 200, vy: 0, lastChanged: 0 }],
    ]));
    addEntityToArchetype(arch, e3, new Map([
      [Position.id, { x: 30, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 300, vy: 0, lastChanged: 0 }],
    ]));

    const q = query(Position.id, Velocity.id);
    q.updateArchetypes([arch]);

    const results: Array<{ entityIndex: number; posX: number; velX: number }> = [];
    q.iterate(1, (entity, comps) => {
      const pos = comps[0] as { x: number; y: number };
      const vel = comps[1] as { vx: number; vy: number };
      results.push({ entityIndex: entity.index, posX: pos.x, velX: vel.vx });
    });

    expect(results).toEqual([
      { entityIndex: 1, posX: 10, velX: 100 },
      { entityIndex: 2, posX: 20, velX: 200 },
      { entityIndex: 3, posX: 30, velX: 300 },
    ]);
  });

  it("iterate should update lastReadTick", () => {
    const arch = createArchetype([Position.id]);
    addEntityToArchetype(arch, makeEntity(1), new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
    ]));

    const q = query(Position.id);
    q.updateArchetypes([arch]);
    q.iterate(7, () => {});

    expect(q.descriptor.lastReadTick).toBe(7);
  });

  it("count should return total entities across all matching archetypes", () => {
    const arch1 = createArchetype([Position.id, Velocity.id]);
    const arch2 = createArchetype([Position.id, Velocity.id, Health.id]);

    addEntityToArchetype(arch1, makeEntity(1), new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 0, vy: 0, lastChanged: 0 }],
    ]));
    addEntityToArchetype(arch1, makeEntity(2), new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 0, vy: 0, lastChanged: 0 }],
    ]));
    addEntityToArchetype(arch2, makeEntity(3), new Map([
      [Position.id, { x: 0, y: 0, lastChanged: 0 }],
      [Velocity.id, { vx: 0, vy: 0, lastChanged: 0 }],
      [Health.id, { hp: 100, lastChanged: 0 }],
    ]));

    const q = query(Position.id, Velocity.id);
    q.updateArchetypes([arch1, arch2]);

    expect(q.count()).toBe(3);
  });

  it("count should return 0 for no matching archetypes", () => {
    const q = query(Position.id);
    q.updateArchetypes([]);

    expect(q.count()).toBe(0);
  });
});
