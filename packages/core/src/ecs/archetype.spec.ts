import {
    addEntityToArchetype,
    archetypeMatches,
    createArchetype,
    findEntityRow,
    getComponentColumn,
    removeEntityFromArchetype,
} from "./archetype";
import { component } from "./component";
import type { Entity } from "./entity";

const Position = component("Position", { x: 0, y: 0 });
const Velocity = component("Velocity", { vx: 0, vy: 0 });
const Health = component("Health", { hp: 100 });

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

describe("Archetype", () => {
  it("should create archetype with component IDs", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    expect(arch.componentIds).toEqual([Position.id, Velocity.id]);
    expect(arch.componentSet.has(Position.id)).toBe(true);
    expect(arch.componentSet.has(Velocity.id)).toBe(true);
    expect(arch.entities).toEqual([]);
  });

  it("archetypeMatches should return true for matching required components", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    expect(archetypeMatches(arch, [Position.id, Velocity.id], [])).toBe(true);
  });

  it("archetypeMatches should return true for superset of required", () => {
    const arch = createArchetype([Position.id, Velocity.id, Health.id]);
    expect(archetypeMatches(arch, [Position.id, Velocity.id], [])).toBe(true);
  });

  it("archetypeMatches should return false for missing required", () => {
    const arch = createArchetype([Position.id]);
    expect(archetypeMatches(arch, [Position.id, Velocity.id], [])).toBe(false);
  });

  it("archetypeMatches should return false for excluded components present", () => {
    const arch = createArchetype([Position.id, Velocity.id]);
    expect(archetypeMatches(arch, [Position.id], [Velocity.id])).toBe(false);
  });

  it("archetypeMatches should return true when excluded not present", () => {
    const arch = createArchetype([Position.id]);
    expect(archetypeMatches(arch, [Position.id], [Velocity.id])).toBe(true);
  });

  it("addEntityToArchetype should add entity and store component data", () => {
    const arch = createArchetype([Position.id]);
    const e = makeEntity(1);

    addEntityToArchetype(arch, e, new Map([
      [Position.id, { x: 5, y: 10 }],
    ]));

    expect(arch.entities).toContain(e);
  });

  it("addEntityToArchetype should create component columns", () => {
    const arch = createArchetype([Position.id]);
    const e = makeEntity(1);

    addEntityToArchetype(arch, e, new Map([
      [Position.id, { x: 5, y: 10 }],
    ]));

    const col = getComponentColumn(arch, Position.id);
    expect(col).toBeDefined();
    expect(col![0]).toEqual({ x: 5, y: 10 });
  });

  it("removeEntityFromArchetype should remove entity", () => {
    const arch = createArchetype([Position.id]);
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);

    addEntityToArchetype(arch, e1, new Map([[Position.id, { x: 1, y: 0 }]]));
    addEntityToArchetype(arch, e2, new Map([[Position.id, { x: 2, y: 0 }]]));

    removeEntityFromArchetype(arch, e1);

    expect(arch.entities).not.toContain(e1);
    expect(arch.entities).toContain(e2);
  });

  it("getComponentColumn should return undefined for non-existent component", () => {
    const arch = createArchetype([Position.id]);
    expect(getComponentColumn(arch, Velocity.id)).toBeUndefined();
  });

  it("should handle multiple entities in archetype", () => {
    const arch = createArchetype([Position.id, Velocity.id]);

    for (let i = 0; i < 10; i++) {
      addEntityToArchetype(arch, makeEntity(i), new Map([
        [Position.id, { x: i, y: 0 }],
        [Velocity.id, { vx: i * 2, vy: 0 }],
      ]));
    }

    expect(arch.entities.length).toBe(10);
  });

  it("removeEntityFromArchetype should not crash on empty archetype", () => {
    const arch = createArchetype([Position.id]);
    expect(() => removeEntityFromArchetype(arch, makeEntity(999))).not.toThrow();
  });

  it("findEntityRow should return correct row after swap-and-pop removal", () => {
    const arch = createArchetype([Position.id]);
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const e3 = makeEntity(3);

    addEntityToArchetype(arch, e1, new Map([[Position.id, { x: 1, y: 0 }]]));
    addEntityToArchetype(arch, e2, new Map([[Position.id, { x: 2, y: 0 }]]));
    addEntityToArchetype(arch, e3, new Map([[Position.id, { x: 3, y: 0 }]]));

    // Remove e2 — triggers swap-and-pop: e3 moves from row 2 to row 1
    removeEntityFromArchetype(arch, e2);

    // e1 should still be at row 0
    expect(findEntityRow(arch, e1)).toBe(0);
    // e3 should now be at row 1 (swapped from row 2)
    expect(findEntityRow(arch, e3)).toBe(1);
    // e2 should not be found
    expect(findEntityRow(arch, e2)).toBe(-1);

    // Component data should reflect the swap
    const col = getComponentColumn<typeof Position.defaults>(arch, Position.id);
    expect(col[0].x).toBe(1);
    expect(col[1].x).toBe(3);
  });

  it("findEntityRow should return -1 for stale generation", () => {
    const arch = createArchetype([Position.id]);
    const e = makeEntity(5, 0);

    addEntityToArchetype(arch, e, new Map([[Position.id, { x: 0, y: 0 }]]));

    // Same index but different generation — should not match
    expect(findEntityRow(arch, makeEntity(5, 1))).toBe(-1);
  });
});
