import type { ComponentDefinition } from "../ecs/component";
import type { Entity } from "../ecs/entity";
import type { Hierarchy } from "../ecs/hierarchy";
import type { World } from "../ecs/world";
import type { Prefab, PrefabComponentEntry } from "./prefab";

export interface ComponentSpec<T extends Record<string, unknown>> {
  def: ComponentDefinition<T>;
  overrides?: Partial<T>;
}

export function c<T extends Record<string, unknown>>(
  def: ComponentDefinition<T>,
  overrides?: Partial<T>,
): ComponentSpec<T> {
  return { def, overrides };
}

export function spawn(
  world: World,
  ...specs: ComponentSpec<any>[]
): Entity {
  const components = new Map<number, unknown>();
  specs.forEach((spec) => {
    const data = spec.def.create(spec.overrides);
    components.set(spec.def.id, data);
  });
  return world.spawn(components);
}

export function spawnChild(
  world: World,
  hierarchy: Hierarchy,
  parent: Entity,
  ...specs: ComponentSpec<any>[]
): Entity {
  const entity = spawn(world, ...specs);
  hierarchy.setParent(entity, parent);
  return entity;
}

export function batch(
  world: World,
  count: number,
  factory: (i: number) => ComponentSpec<any>[],
): Entity[] {
  const entities: Entity[] = [];
  for (let i = 0; i < count; i++) {
    const specs = factory(i);
    entities.push(spawn(world, ...specs));
  }
  return entities;
}

export function builderToPrefab(
  name: string,
  specs: ComponentSpec<any>[],
  tags?: string[],
): Prefab {
  const components: PrefabComponentEntry[] = specs.map((spec) => ({
    componentId: spec.def.id,
    data: { ...spec.def.defaults, ...spec.overrides } as Record<string, unknown>,
  }));
  return { name, components, tags };
}
