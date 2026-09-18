import type { Entity } from "./entity";
import { ROOT_ENTITY } from "./entity";

interface HierarchyData {
  parent: Entity | null;
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
      parent: null,
      children: [],
      dirty: false,
    });
  }

  private getData(entity: Entity): HierarchyData | undefined {
    return this.data.get(entity.index);
  }

  private ensureData(entity: Entity | null): HierarchyData {
    if (!entity) return { parent: null, children: [], dirty: false };
    let d = this.data.get(entity.index);
    if (!d) {
      d = { parent: null, children: [], dirty: false };
      this.data.set(entity.index, d);
    }
    return d;
  }

  getParent(entity: Entity): Entity | null {
    const d = this.getData(entity);
    return d ? d.parent : null;
  }

  getChildren(entity: Entity): Entity[] {
    const d = this.getData(entity);
    return d ? d.children : [];
  }

  setParent(entity: Entity, newParent: Entity | null): void {
    const d = this.ensureData(entity);
    const oldParent = d.parent;

    if (oldParent && newParent && oldParent.index === newParent.index && oldParent.generation === newParent.generation) return;
    if (!oldParent && !newParent) return;

    if (oldParent) {
      const oldParentData = this.getData(oldParent);
      if (oldParentData) {
        const idx = oldParentData.children.findIndex(
          (c) => c.index === entity.index && c.generation === entity.generation,
        );
        if (idx >= 0) oldParentData.children.splice(idx, 1);
      }
    }

    d.parent = newParent;
    if (newParent) {
      const newParentData = this.ensureData(newParent);
      newParentData.children.push(entity);
    }

    this.markDirty(entity);
  }

  isDirty(entity: Entity): boolean {
    const d = this.getData(entity);
    return d ? d.dirty : false;
  }

  markDirty(entity: Entity): void {
    // Iterative (stack-based) to prevent stack overflow on deep hierarchies
    const stack: Entity[] = [entity];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const d = this.ensureData(current);
      if (d.dirty) continue;
      d.dirty = true;
      for (let i = 0; i < d.children.length; i++) {
        stack.push(d.children[i]);
      }
    }
  }

  clearDirty(entity: Entity): void {
    const d = this.getData(entity);
    if (d) d.dirty = false;
  }

  isRoot(entity: Entity): boolean {
    if (entity.index !== ROOT_ENTITY.index || entity.generation !== ROOT_ENTITY.generation) return false;
    const d = this.getData(entity);
    return !d || d.parent === null;
  }

  traverse(root: Entity, fn: (entity: Entity, depth: number) => void): void {
    // Iterative (stack-based) to prevent stack overflow on deep hierarchies
    const stack: Array<{ entity: Entity; depth: number }> = [{ entity: root, depth: 0 }];
    while (stack.length > 0) {
      const { entity, depth } = stack.pop()!;
      fn(entity, depth);
      const children = this.getChildren(entity);
      // Push in reverse order so children are visited left-to-right
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ entity: children[i], depth: depth + 1 });
      }
    }
  }

  getDescendants(entity: Entity): Entity[] {
    const result: Entity[] = [];
    this.traverse(entity, (e) => result.push(e));
    return result;
  }
}
