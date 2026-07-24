import type { ComponentId } from "./component.ts";
import type { Entity, EntityMeta } from "./entity.ts";

export interface Archetype {
  id: number;
  componentIds: ComponentId[];
  componentSet: Set<ComponentId>;
  entities: Entity[];
  columns: Map<ComponentId, unknown[]>;
}

let nextArchetypeId = 0;

export function createArchetype(componentIds: ComponentId[]): Archetype {
  const id = nextArchetypeId++;
  const sortedIds = [...componentIds].sort((a, b) => a - b);
  const columns = new Map<ComponentId, unknown[]>();
  for (const cid of sortedIds) {
    columns.set(cid, []);
  }
  return {
    id,
    componentIds: sortedIds,
    componentSet: new Set(sortedIds),
    entities: [],
    columns,
  };
}

export function archetypeMatches(arch: Archetype, required: ComponentId[], excluded: ComponentId[] = []): boolean {
  for (const cid of required) {
    if (!arch.componentSet.has(cid)) return false;
  }
  for (const cid of excluded) {
    if (arch.componentSet.has(cid)) return false;
  }
  return true;
}

export function getArchetypeForComponents(
  archetypes: Map<string, Archetype>,
  componentIds: ComponentId[],
): Archetype {
  const key = [...componentIds].sort((a, b) => a - b).join(",");
  let arch = archetypes.get(key);
  if (!arch) {
    arch = createArchetype(componentIds);
    archetypes.set(key, arch);
  }
  return arch;
}

export function addEntityToArchetype(arch: Archetype, entity: Entity, components: Map<ComponentId, unknown>): void {
  const row = arch.entities.length;
  arch.entities.push(entity);
  for (const cid of arch.componentIds) {
    arch.columns.get(cid)!.push(components.get(cid));
  }
}

export function removeEntityFromArchetype(arch: Archetype, row: number): void {
  const last = arch.entities.length - 1;
  if (row !== last) {
    arch.entities[row] = arch.entities[last];
    for (const col of arch.columns.values()) {
      col[row] = col[last];
    }
  }
  arch.entities.pop();
  for (const col of arch.columns.values()) {
    col.pop();
  }
}

export function getComponentColumn<T>(arch: Archetype, cid: ComponentId): T[] {
  return arch.columns.get(cid) as T[];
}

export function findEntityRow(arch: Archetype, entity: Entity): number {
  for (let i = 0; i < arch.entities.length; i++) {
    if (arch.entities[i].index === entity.index && arch.entities[i].generation === entity.generation) {
      return i;
    }
  }
  return -1;
}

export function updateEntityMeta(entities: EntityMeta[], index: number, archetypeId: number): void {
  if (entities[index]) {
    entities[index].archetypeId = archetypeId;
  }
}
