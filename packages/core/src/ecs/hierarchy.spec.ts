import { Hierarchy } from "./hierarchy.ts";
import { ROOT_ENTITY, type Entity } from "./entity.ts";

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

describe("Hierarchy", () => {
  it("should initialize with root entity having no parent", () => {
    const h = new Hierarchy();
    expect(h.getParent(ROOT_ENTITY)).toBeNull();
    expect(h.getChildren(ROOT_ENTITY)).toEqual([]);
  });

  it("should set parent-child relationship", () => {
    const h = new Hierarchy();
    const child = makeEntity(1);

    h.setParent(child, ROOT_ENTITY);

    expect(h.getParent(child)).toEqual(ROOT_ENTITY);
    expect(h.getChildren(ROOT_ENTITY)).toContain(child);
  });

  it("should set multiple children on root", () => {
    const h = new Hierarchy();
    const c1 = makeEntity(1);
    const c2 = makeEntity(2);
    const c3 = makeEntity(3);

    h.setParent(c1, ROOT_ENTITY);
    h.setParent(c2, ROOT_ENTITY);
    h.setParent(c3, ROOT_ENTITY);

    expect(h.getChildren(ROOT_ENTITY).length).toBe(3);
  });

  it("should move child from one parent to another", () => {
    const h = new Hierarchy();
    const parent1 = makeEntity(1);
    const parent2 = makeEntity(2);
    const child = makeEntity(3);

    h.setParent(parent1, ROOT_ENTITY);
    h.setParent(parent2, ROOT_ENTITY);
    h.setParent(child, parent1);

    expect(h.getChildren(parent1)).toContain(child);
    expect(h.getChildren(parent2)).not.toContain(child);

    h.setParent(child, parent2);

    expect(h.getChildren(parent1)).not.toContain(child);
    expect(h.getChildren(parent2)).toContain(child);
    expect(h.getParent(child)).toEqual(parent2);
  });

  it("should mark entity as dirty", () => {
    const h = new Hierarchy();
    const e = makeEntity(1);

    h.markDirty(e);
    expect(h.isDirty(e)).toBe(true);
  });

  it("should clear dirty flag", () => {
    const h = new Hierarchy();
    const e = makeEntity(1);

    h.markDirty(e);
    h.clearDirty(e);
    expect(h.isDirty(e)).toBe(false);
  });

  it("should propagate dirty to children", () => {
    const h = new Hierarchy();
    const parent = makeEntity(1);
    const child = makeEntity(2);
    const grandchild = makeEntity(3);

    h.setParent(parent, ROOT_ENTITY);
    h.setParent(child, parent);
    h.setParent(grandchild, child);

    h.markDirty(parent);
    expect(h.isDirty(parent)).toBe(true);
    expect(h.isDirty(child)).toBe(true);
    expect(h.isDirty(grandchild)).toBe(true);
  });

  it("should traverse tree in order", () => {
    const h = new Hierarchy();
    const a = makeEntity(1);
    const b = makeEntity(2);
    const c = makeEntity(3);

    h.setParent(a, ROOT_ENTITY);
    h.setParent(b, a);
    h.setParent(c, a);

    const visited: number[] = [];
    h.traverse(ROOT_ENTITY, (entity) => {
      visited.push(entity.index);
    });

    expect(visited).toContain(1);
    expect(visited).toContain(2);
    expect(visited).toContain(3);
  });

  it("should handle setting parent to null (orphaning)", () => {
    const h = new Hierarchy();
    const child = makeEntity(1);

    h.setParent(child, ROOT_ENTITY);
    h.setParent(child, null as any);

    expect(h.getParent(child)).toBeNull();
    expect(h.getChildren(ROOT_ENTITY)).not.toContain(child);
  });

  it("should not crash when getting children of leaf entity", () => {
    const h = new Hierarchy();
    const e = makeEntity(1);
    h.setParent(e, ROOT_ENTITY);
    expect(h.getChildren(e)).toEqual([]);
  });
});
