import type { ComponentDefinition, ComponentId } from "../ecs/component.ts";
import type { Entity } from "../ecs/entity.ts";
import { ROOT_ENTITY } from "../ecs/entity.ts";
import { Hierarchy } from "../ecs/hierarchy.ts";
import type { World } from "../ecs/world.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger();

export interface PrefabComponentEntry {
  componentId: ComponentId;
  data: Record<string, unknown>;
}

export interface PrefabChildEntry {
  prefab: string;
  localTransform?: { position?: [number, number, number]; rotation?: [number, number, number, number]; scale?: number };
  components?: PrefabComponentEntry[];
}

export interface Prefab {
  name: string;
  components: PrefabComponentEntry[];
  children?: PrefabChildEntry[];
  tags?: string[];
}

export class PrefabRegistry {
  private prefabs: Map<string, Prefab> = new Map();

  register(prefab: Prefab): void {
    if (this.prefabs.has(prefab.name)) {
      log.warn("PrefabRegistry", `Overwriting prefab "${prefab.name}"`);
    }
    this.prefabs.set(prefab.name, prefab);
  }

  unregister(name: string): void {
    this.prefabs.delete(name);
  }

  get(name: string): Prefab | undefined {
    return this.prefabs.get(name);
  }

  has(name: string): boolean {
    return this.prefabs.has(name);
  }

  list(): string[] {
    return [...this.prefabs.keys()];
  }

  clear(): void {
    this.prefabs.clear();
  }
}

export class PrefabFactory {
  private world: World;
  private registry: PrefabRegistry;
  private hierarchy: Hierarchy;

  constructor(world: World, registry: PrefabRegistry, hierarchy: Hierarchy) {
    this.world = world;
    this.registry = registry;
    this.hierarchy = hierarchy;
  }

  spawn(prefabName: string, parent?: Entity): Entity {
    const prefab = this.registry.get(prefabName);
    if (!prefab) throw new Error(`Prefab "${prefabName}" not found`);

    const components = new Map<ComponentId, unknown>();
    for (const entry of prefab.components) {
      components.set(entry.componentId, { ...entry.data });
    }

    const entity = this.world.spawn(components);
    this.hierarchy.setParent(entity, parent ?? ROOT_ENTITY);

    if (prefab.children) {
      for (const child of prefab.children) {
        this.spawnChild(child, entity);
      }
    }

    return entity;
  }

  private spawnChild(child: PrefabChildEntry, parent: Entity): Entity {
    const components = new Map<ComponentId, unknown>();

    if (child.components) {
      for (const entry of child.components) {
        components.set(entry.componentId, { ...entry.data });
      }
    }

    if (child.prefab) {
      const prefab = this.registry.get(child.prefab);
      if (prefab) {
        for (const entry of prefab.components) {
          if (!components.has(entry.componentId)) {
            components.set(entry.componentId, { ...entry.data });
          }
        }
      }
    }

    const entity = this.world.spawn(components);
    this.hierarchy.setParent(entity, parent);

    if (child.prefab) {
      const prefab = this.registry.get(child.prefab);
      if (prefab?.children) {
        for (const grandchild of prefab.children) {
          this.spawnChild(grandchild, entity);
        }
      }
    }

    return entity;
  }

  spawnMany(prefabName: string, count: number, parent?: Entity): Entity[] {
    const entities: Entity[] = [];
    for (let i = 0; i < count; i++) {
      entities.push(this.spawn(prefabName, parent));
    }
    return entities;
  }
}

export function createPrefabFromComponentDefs(
  name: string,
  defs: Array<{ def: ComponentDefinition<Record<string, unknown>>; overrides?: Partial<Record<string, unknown>> }>,
  tags?: string[],
): Prefab {
  const components: PrefabComponentEntry[] = defs.map(({ def, overrides }) => ({
    componentId: def.id,
    data: { ...def.defaults, ...overrides } as Record<string, unknown>,
  }));
  return { name, components, tags };
}
