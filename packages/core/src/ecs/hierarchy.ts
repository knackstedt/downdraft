import type { Entity } from "./entity.ts";
import { ROOT_ENTITY } from "./entity.ts";

interface HierarchyData {
  parent: Entity;
  children: Entity[];
  dirty: boolean;
}

export class Hierarchy {
  private data: Map<number, HierarchyData> = new Map();

  constructor() {
    this.setRoot();
  }

  private setRoot(): void {
    this.data.set(ROOT_ENTITY.index, {
      parent: ROOT_ENTITY,
      children: [],
      dirty: false,
    });
  }

  private getData(entity: Entity): HierarchyData | undefined {
    return this.data.get(entity.index);
  }

  private ensureData(entity: Entity): HierarchyData {
    let d = this.data.get(entity.index);
    if (!d) {
      d = { parent: ROOT_ENTITY, children: [], dirty: false };
      this.data.set(entity.index, d);
    }
    return d;
  }

  getParent(entity: Entity): Entity {
    const d = this.getData(entity);
    return d ? d.parent : ROOT_ENTITY;
  }

  getChildren(entity: Entity): Entity[] {
    const d = this.getData(entity);
    return d ? d.children : [];
  }

  setParent(entity: Entity, newParent: Entity): void {
    const d = this.ensureData(entity);
    const oldParent = d.parent;

    if (oldParent.index === newParent.index && oldParent.generation === newParent.generation) return;

    const oldParentData = this.getData(oldParent);
    if (oldParentData) {
      const idx = oldParentData.children.findIndex(
        (c) => c.index === entity.index && c.generation === entity.generation,
      );
      if (idx >= 0) oldParentData.children.splice(idx, 1);
    }

    d.parent = newParent;
    const newParentData = this.ensureData(newParent);
    newParentData.children.push(entity);

    this.markDirty(entity);
  }

  isDirty(entity: Entity): boolean {
    const d = this.getData(entity);
    return d ? d.dirty : false;
  }

  markDirty(entity: Entity): void {
    const d = this.ensureData(entity);
    if (d.dirty) return;
    d.dirty = true;
    for (let i = 0; i < d.children.length; i++) {
      this.markDirty(d.children[i]);
    }
  }

  clearDirty(entity: Entity): void {
    const d = this.getData(entity);
    if (d) d.dirty = false;
  }

  isRoot(entity: Entity): boolean {
    return entity.index === ROOT_ENTITY.index && entity.generation === ROOT_ENTITY.generation;
  }

  traverse(root: Entity, fn: (entity: Entity, depth: number) => void): void {
    const visit = (entity: Entity, depth: number) => {
      fn(entity, depth);
      const children = this.getChildren(entity);
      for (let i = 0; i < children.length; i++) {
        visit(children[i], depth + 1);
      }
    };
    visit(root, 0);
  }

  getDescendants(entity: Entity): Entity[] {
    const result: Entity[] = [];
    this.traverse(entity, (e) => result.push(e));
    return result;
  }
}
