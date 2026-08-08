import type { ComponentId } from "./component";
import type { Entity, EntityMeta } from "./entity";

export interface Archetype {
  id: number;
  componentIds: ComponentId[];
  componentSet: Set<ComponentId>;
  entities: Entity[];
  columns: Map<ComponentId, unknown[]>;
  entityRowMap: Map<number, number>;
}

let nextArchetypeId = 0;

export function createArchetype(componentIds: ComponentId[]): Archetype {
  const id = nextArchetypeId++;
  const columns = new Map<ComponentId, unknown[]>();
  for (const cid of componentIds) {
    columns.set(cid, []);
  }
  return {
    id,
    componentIds: [...componentIds],
    componentSet: new Set(componentIds),
    entities: [],
    columns,
    entityRowMap: new Map(),
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
  archetypes: Map<number, Archetype>,
  componentIds: ComponentId[],
): Archetype {
  // Sort only when needed; empty/single-component sets are already canonical.
  const sortedIds = componentIds.length > 1
    ? [...componentIds].sort((a, b) => a - b)
    : componentIds;
  const numericKey = archetypeNumericHash(sortedIds);
  let arch = archetypes.get(numericKey);
  if (!arch) {
    arch = createArchetype(sortedIds);
    archetypes.set(numericKey, arch);
  }
  return arch;
}

// Fast numeric hash for sorted component IDs — avoids string allocation on the hot path.
// Uses the same mixing constants as the spatial grid for good distribution.
// The initial seed (1) ensures empty component sets don't collide with [0].
function archetypeNumericHash(sortedIds: ComponentId[]): number {
  let hash = 1;
  for (let i = 0; i < sortedIds.length; i++) {
    hash = ((hash * 73856093) ^ (sortedIds[i]! * 19349663)) >>> 0;
  }
  return hash;
}

export function addEntityToArchetype(arch: Archetype, entity: Entity, components: Map<ComponentId, unknown>): void {
  const row = arch.entities.length;
  arch.entities.push(entity);
  arch.entityRowMap.set(entity.index, row);
  for (const cid of arch.componentIds) {
    const col = arch.columns.get(cid);
    if (!col) throw new Error(`Missing column for component ${cid}`);
    col.push(components.get(cid));
  }
}

export function removeEntityFromArchetype(arch: Archetype, entity: Entity): void {
  const row = findEntityRow(arch, entity);
  if (row < 0) return;
  const last = arch.entities.length - 1;
  if (row !== last) {
    arch.entities[row] = arch.entities[last];
    arch.entityRowMap.set(arch.entities[row].index, row);
    for (const col of arch.columns.values()) {
      col[row] = col[last];
    }
  }
  arch.entities.pop();
  arch.entityRowMap.delete(entity.index);
  for (const col of arch.columns.values()) {
    col.pop();
  }
}

export function getComponentColumn<T>(arch: Archetype, cid: ComponentId): T[] {
  return arch.columns.get(cid) as T[];
}

export function findEntityRow(arch: Archetype, entity: Entity): number {
  const row = arch.entityRowMap.get(entity.index);
  if (row === undefined) return -1;
  if (arch.entities[row].generation !== entity.generation) return -1;
  return row;
}

export function updateEntityMeta(entities: EntityMeta[], index: number, archetypeId: number): void {
  if (entities[index]) {
    entities[index].archetypeId = archetypeId;
  }
}
