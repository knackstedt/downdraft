import type { World } from "../ecs/world.ts";
import type { Entity } from "../ecs/entity.ts";
import type { ComponentId } from "../ecs/component.ts";
import type { Hierarchy } from "../ecs/hierarchy.ts";
import { ROOT_ENTITY } from "../ecs/entity.ts";

export interface SceneTreeNode {
  entity: Entity;
  name: string;
  parentId: number;
  children: SceneTreeNode[];
  componentCount: number;
  depth: number;
  expanded: boolean;
  selected: boolean;
}

export interface SceneTreeState {
  nodes: SceneTreeNode[];
  selectedEntity: Entity | null;
  rootNodes: SceneTreeNode[];
}

export class SceneTreePanel {
  private world: World;
  private hierarchy: Hierarchy;
  private nodes: Map<number, SceneTreeNode> = new Map();
  private selectedEntity: Entity | null = null;
  private expanded: Set<number> = new Set();
  private nameOverrides: Map<number, string> = new Map();
  private onSelectionChange: ((entity: Entity | null) => void) | null = null;

  constructor(world: World, hierarchy: Hierarchy) {
    this.world = world;
    this.hierarchy = hierarchy;
  }

  setOnSelectionChange(fn: (entity: Entity | null) => void): void {
    this.onSelectionChange = fn;
  }

  setEntityName(entity: Entity, name: string): void {
    this.nameOverrides.set(entity.index, name);
  }

  getEntityName(entity: Entity): string {
    if (this.nameOverrides.has(entity.index)) {
      return this.nameOverrides.get(entity.index)!;
    }
    const transform = this.world.getComponent<{ name?: string }>(entity, 0);
    if (transform?.name) return transform.name;
    return `Entity_${entity.index}`;
  }

  rebuild(): void {
    this.nodes.clear();
    const allNodes: SceneTreeNode[] = [];

    for (let i = 0; i < this.world.entities.length; i++) {
      if (i === ROOT_ENTITY.index) continue;
      const meta = this.world.entities[i];
      if (!meta.alive) continue;

      const entity: Entity = { index: i, generation: meta.generation };
      const arch = this.world.archetypeById.get(meta.archetypeId);
      const componentCount = arch ? arch.componentIds.length : 0;
      const parent = this.hierarchy.getParent(entity);

      const node: SceneTreeNode = {
        entity,
        name: this.getEntityName(entity),
        parentId: parent.index,
        children: [],
        componentCount,
        depth: 0,
        expanded: this.expanded.has(i),
        selected: this.selectedEntity?.index === i,
      };

      this.nodes.set(i, node);
      allNodes.push(node);
    }

    for (const node of allNodes) {
      if (node.parentId >= 0 && node.parentId !== ROOT_ENTITY.index) {
        const parent = this.nodes.get(node.parentId);
        if (parent) {
          parent.children.push(node);
          node.depth = parent.depth + 1;
        }
      }
    }
  }

  select(entity: Entity | null): void {
    this.selectedEntity = entity;
    if (entity) {
      this.expanded.add(entity.index);
    }
    this.rebuild();
    if (this.onSelectionChange) this.onSelectionChange(entity);
  }

  toggleExpand(entity: Entity): void {
    if (this.expanded.has(entity.index)) {
      this.expanded.delete(entity.index);
    } else {
      this.expanded.add(entity.index);
    }
    this.rebuild();
  }

  expandAll(): void {
    for (let i = 0; i < this.world.entities.length; i++) {
      if (this.world.entities[i].alive) {
        this.expanded.add(i);
      }
    }
    this.rebuild();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.rebuild();
  }

  getRootNodes(): SceneTreeNode[] {
    return [...this.nodes.values()].filter((n) => n.parentId < 0);
  }

  getSelectedNode(): SceneTreeNode | null {
    if (!this.selectedEntity) return null;
    return this.nodes.get(this.selectedEntity.index) ?? null;
  }

  getState(): SceneTreeState {
    return {
      nodes: [...this.nodes.values()],
      selectedEntity: this.selectedEntity,
      rootNodes: this.getRootNodes(),
    };
  }

  getEntityCount(): number {
    return this.world.entityCount();
  }

  searchByName(query: string): SceneTreeNode[] {
    const results: SceneTreeNode[] = [];
    const lower = query.toLowerCase();
    for (const node of this.nodes.values()) {
      if (node.name.toLowerCase().includes(lower)) {
        results.push(node);
      }
    }
    return results;
  }
}
