import {
    getComponentDefinition,
    SOA_DEFAULT_VALUE,
    SOA_TYPED_ARRAY_CTOR,
    type ComponentId,
    type SoASchema,
    type SoATypedArray,
} from "./component";
import type { Entity, EntityMeta } from "./entity";

// --- Column types ---

/**
 * SoA column — stores component data in per-field TypedArrays, indexed by row.
 * The same column object is reused across all rows in an archetype; systems
 * access fields via `column.arrays.fieldName[row]`.
 */
export interface SoAColumn {
  /** Discriminator — always `true` for SoA columns. */
  readonly __soa: true;
  /** Active entity count (same as archetype.entities.length). */
  length: number;
  /** Allocated TypedArray capacity. */
  capacity: number;
  /** Per-field TypedArrays, keyed by field name. */
  arrays: Record<string, SoATypedArray>;
  /** Ordered field names (from the component schema). */
  fieldNames: string[];
  /** The SoA schema (field types) for this column. */
  schema: SoASchema;
}

/** A column is either AoS (regular array of objects) or SoA (TypedArray-backed). */
export type Column = unknown[] | SoAColumn;

/** Type guard for SoA columns. */
export function isSoAColumn(col: Column | undefined | null): col is SoAColumn {
  return col !== null && col !== undefined && (col as SoAColumn).__soa === true;
}

// --- Archetype ---

export interface Archetype {
  id: number;
  componentIds: ComponentId[];
  componentSet: Set<ComponentId>;
  entities: Entity[];
  columns: Map<ComponentId, Column>;
  entityRowMap: Map<number, number>;
  /** Collision chain — next archetype sharing this one's numeric hash bucket.
   *  Set when two different component sets collide on `archetypeNumericHash`. */
  hashNext?: Archetype;
}

let nextArchetypeId = 0;

export function createArchetype(componentIds: ComponentId[]): Archetype {
  const id = nextArchetypeId++;
  const columns = new Map<ComponentId, Column>();
  componentIds.forEach((cid) => {
    const def = getComponentDefinition(cid);
    if (def?.soa) {
      columns.set(cid, createSoAColumn(def.soa));
    } else {
      columns.set(cid, []);
    }
  });
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
  for (let _i = 0, _it = required, _n = _it.length; _i < _n; _i++) { const cid = _it[_i];
    if (!arch.componentSet.has(cid)) return false;
  }
  for (let _i = 0, _it = excluded, _n = _it.length; _i < _n; _i++) { const cid = _it[_i];
    if (arch.componentSet.has(cid)) return false;
  }
  return true;
}

function sameComponentIds(a: ComponentId[], b: ComponentId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
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
  // Walk the collision chain — a 32-bit hash is not injective, so a hit on the
  // bucket is not proof of a match. Without this check, two distinct component
  // sets with colliding hashes silently shared an archetype (entities would get
  // undefined components and queries would match the wrong entity sets).
  let head = archetypes.get(numericKey);
  for (let arch = head; arch; arch = arch.hashNext) {
    if (sameComponentIds(arch.componentIds, sortedIds)) return arch;
  }
  const arch = createArchetype(sortedIds);
  if (head) {
    // Collision — prepend to the bucket chain.
    arch.hashNext = head;
  }
  archetypes.set(numericKey, arch);
  return arch;
}

/** Remove an archetype from the hash-keyed map (used by empty-archetype
 *  pruning). Handles both bucket heads and chained collision entries. */
export function removeArchetypeFromHashMap(archetypes: Map<number, Archetype>, arch: Archetype): void {
  const key = archetypeNumericHash(arch.componentIds);
  const head = archetypes.get(key);
  if (head === arch) {
    if (arch.hashNext) archetypes.set(key, arch.hashNext);
    else archetypes.delete(key);
  } else {
    for (let cur = head; cur; cur = cur.hashNext) {
      if (cur.hashNext === arch) {
        cur.hashNext = arch.hashNext;
        break;
      }
    }
  }
  arch.hashNext = undefined;
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

// --- SoA column operations ---

const SOA_INITIAL_CAPACITY = 16;

/** Create a new SoA column from a schema, with initial capacity. */
function createSoAColumn(schema: SoASchema): SoAColumn {
  const arrays: Record<string, SoATypedArray> = {};
  schema.fields.forEach((field) => {
    const type = schema.types[field]!;
    arrays[field] = new SOA_TYPED_ARRAY_CTOR[type]!(SOA_INITIAL_CAPACITY);
  });
  return {
    __soa: true,
    length: 0,
    capacity: SOA_INITIAL_CAPACITY,
    arrays,
    fieldNames: schema.fields,
    schema,
  };
}

/** Double the capacity of a SoA column's TypedArrays, preserving existing data. */
function growSoAColumn(col: SoAColumn): void {
  const newCapacity = col.capacity * 2;
  col.fieldNames.forEach((field) => {
    const type = col.schema.types[field]!;
    const oldArr = col.arrays[field]!;
    const newArr = new SOA_TYPED_ARRAY_CTOR[type]!(newCapacity);
    newArr.set(oldArr);
    col.arrays[field] = newArr;
  });
  col.capacity = newCapacity;
}

/** Push a component's field values into a SoA column at the next row. */
function soaColumnPush(col: SoAColumn, data: Record<string, unknown>): void {
  if (col.length >= col.capacity) {
    growSoAColumn(col);
  }
  const row = col.length;
  col.fieldNames.forEach((field) => {
    const val = data[field];
    col.arrays[field]![row] = typeof val === "number" ? val : SOA_DEFAULT_VALUE[col.schema.types[field]!]!;
  });
  col.length++;
}

/** Swap-and-pop removal: move last row's data to the removed row, then shrink. */
function soaColumnSwapRemove(col: SoAColumn, row: number): void {
  const last = col.length - 1;
  if (row !== last) {
    col.fieldNames.forEach((field) => {
      const arr = col.arrays[field]!;
      arr[row] = arr[last]!;
    });
  }
  // Zero out the last row (ZAII — keep TypedArrays clean for future reuse)
  col.fieldNames.forEach((field) => {
    col.arrays[field]![last] = 0;
  });
  col.length--;
}

/**
 * Reconstruct a plain object from a SoA column at a given row.
 * Used by non-hot-path consumers (getComponent, serializer, MCP devtools).
 * Allocates a new object per call — do NOT use in per-tick loops.
 */
export function reconstructSoAObject(col: SoAColumn, row: number): Record<string, number> {
  const obj: Record<string, number> = {};
  col.fieldNames.forEach((field) => {
    obj[field] = col.arrays[field]![row]!;
  });
  return obj;
}

/**
 * Get a component value from a column at a given row.
 * - AoS column: returns the object at `col[row]`
 * - SoA column: reconstructs a plain object from the TypedArrays
 *
 * For hot-path code, use `isSoAColumn()` + direct TypedArray access instead.
 */
export function getColumnValue<T = unknown>(col: Column | undefined, row: number): T | undefined {
  if (col === undefined || col === null) return undefined;
  if (isSoAColumn(col)) {
    return reconstructSoAObject(col, row) as unknown as T;
  }
  return (col as unknown[])[row] as T;
}

/**
 * Write a component value into a column at a given row.
 * - AoS column: replaces the stored object at `col[row]`
 * - SoA column: writes each declared field into the TypedArrays
 */
export function setColumnValue<T = unknown>(col: Column | undefined, row: number, value: T): void {
  if (col === undefined || col === null) return;
  if (isSoAColumn(col)) {
    const data = (value ?? {}) as Record<string, unknown>;
    col.fieldNames.forEach((field) => {
      const val = data[field];
      col.arrays[field]![row] = typeof val === "number" ? val : SOA_DEFAULT_VALUE[col.schema.types[field]!]!;
    });
    return;
  }
  (col as unknown[])[row] = value;
}

// --- Entity add/remove (handle both AoS and SoA columns) ---

export function addEntityToArchetype(arch: Archetype, entity: Entity, components: Map<ComponentId, unknown>): void {
  const row = arch.entities.length;
  arch.entities.push(entity);
  arch.entityRowMap.set(entity.index, row);
  arch.componentIds.forEach((cid) => {
    const col = arch.columns.get(cid);
    if (col === undefined) throw new Error(`Missing column for component ${cid}`);
    if (isSoAColumn(col)) {
      const data = components.get(cid) as Record<string, unknown> | undefined;
      soaColumnPush(col, data ?? {});
    } else {
      (col as unknown[]).push(components.get(cid));
    }
  });
}

export function removeEntityFromArchetype(arch: Archetype, entity: Entity): void {
  const row = findEntityRow(arch, entity);
  if (row < 0) return;
  const last = arch.entities.length - 1;
  if (row !== last) {
    arch.entities[row] = arch.entities[last];
    arch.entityRowMap.set(arch.entities[row].index, row);
    for (const col of arch.columns.values()) {
      if (isSoAColumn(col)) {
        soaColumnSwapRemove(col, row);
      } else {
        (col as unknown[])[row] = (col as unknown[])[last];
      }
    }
  } else {
    // Removing the last row — no swap needed, just pop
    for (const col of arch.columns.values()) {
      if (isSoAColumn(col)) {
        soaColumnSwapRemove(col, row);
      }
    }
  }
  arch.entities.pop();
  arch.entityRowMap.delete(entity.index);
  for (const col of arch.columns.values()) {
    if (!isSoAColumn(col)) {
      (col as unknown[]).pop();
    }
  }
}

export function getComponentColumn<T = unknown>(arch: Archetype, cid: ComponentId): Column | undefined {
  return arch.columns.get(cid) as Column | undefined;
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
