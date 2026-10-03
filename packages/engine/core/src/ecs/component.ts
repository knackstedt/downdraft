export type ComponentId = number;

/** Union of all TypedArray types used by SoA columns. */
export type SoATypedArray =
  | Float32Array | Float64Array
  | Uint8Array | Int8Array
  | Uint16Array | Int16Array
  | Uint32Array | Int32Array;

let nextComponentId: ComponentId = 0;

const componentRegistry = new Map<string, ComponentId>();
const componentNameRegistry = new Map<ComponentId, string>();

export function getComponentId<T>(name: string): ComponentId {
  let id = componentRegistry.get(name);
  if (id === undefined) {
    id = nextComponentId++;
    componentRegistry.set(name, id);
    componentNameRegistry.set(id, name);
  }
  return id;
}

export function getComponentName(id: ComponentId): string {
  return componentNameRegistry.get(id) ?? `Unknown(${id})`;
}

export function isRegisteredComponentId(id: ComponentId): boolean {
  return componentNameRegistry.has(id);
}

export function isRegisteredComponentName(name: string): boolean {
  return componentRegistry.has(name);
}

/** All registered component names — used by editors and tooling. */
export function listComponentNames(): string[] {
  return [...componentRegistry.keys()];
}

/** All registered component definitions (only those created via
 *  `component()`/`soaComponent()` carry defaults + schemas). */
export function listComponentDefinitions(): ComponentDefinition[] {
  return [...componentDefRegistry.values()];
}

export interface IComponent {
  readonly __componentId?: ComponentId;
}

// --- SoA field type system ---

export type SoAFieldType = "f32" | "f64" | "u8" | "i8" | "u16" | "i16" | "u32" | "i32";

/** Maps a SoA field type string to the corresponding TypedArray constructor. */
export const SOA_TYPED_ARRAY_CTOR: Record<SoAFieldType, {
  new (length: number): SoATypedArray;
  BYTES_PER_ELEMENT: number;
}> = {
  f32: Float32Array,
  f64: Float64Array,
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
};

/** Default value for each SoA field type (ZAII — zero as initial). */
export const SOA_DEFAULT_VALUE: Record<SoAFieldType, number> = {
  f32: 0, f64: 0, u8: 0, i8: 0, u16: 0, i16: 0, u32: 0, i32: 0,
};

/** Schema describing the fields of a SoA component and their TypedArray types. */
export interface SoASchema {
  /** Ordered list of field names. */
  fields: string[];
  /** Map from field name → TypedArray type tag. */
  types: Record<string, SoAFieldType>;
}

export function component<T extends Record<string, unknown>>(
  name: string,
  defaults: T,
): ComponentDefinition<T> {
  const id = getComponentId(name);
  const def: ComponentDefinition<T> = {
    id,
    name,
    defaults,
    create: (overrides?: Partial<T>): T & IComponent => ({
      ...defaults,
      ...overrides,
      __componentId: id,
    } as T & IComponent),
  };
  componentDefRegistry.set(id, def as unknown as ComponentDefinition);
  return def;
}

export interface ComponentDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  id: ComponentId;
  name: string;
  defaults: T;
  create: (overrides?: Partial<T>) => T & IComponent;
  /** Present only for SoA components. */
  soa?: SoASchema;
}

// --- Component definition registry (for archetype column creation) ---

const componentDefRegistry = new Map<ComponentId, ComponentDefinition>();

export function getComponentDefinition(id: ComponentId): ComponentDefinition | undefined {
  return componentDefRegistry.get(id);
}

export function isSoAComponentDef(def: ComponentDefinition): boolean {
  return def.soa !== undefined;
}

// --- SoA component definition ---

/**
 * Create a SoA (Structure-of-Arrays) component definition.
 *
 * Each field is stored in its own TypedArray, indexed by entity row within the
 * archetype. This eliminates per-entity object allocation and GC pressure on
 * the hot path. Field access in systems uses `column.fieldName[row]`.
 *
 * The `create()` method returns a plain object (for compatibility with spawn
 * and the command buffer), which is then unpacked into the TypedArrays when
 * the entity is added to an archetype.
 *
 * @param name   Unique component name
 * @param schema Map of field name → TypedArray type tag
 */
export function soaComponent<S extends Record<string, SoAFieldType>>(
  name: string,
  schema: S,
): SoAComponentDefinition<S> {
  const id = getComponentId(name);
  const fields = Object.keys(schema);
  const soa: SoASchema = { fields, types: { ...schema } };

  // Build defaults object from schema (all zeros — ZAII)
  const defaults = {} as Record<string, number>;
  fields.forEach((f) => {
    defaults[f] = SOA_DEFAULT_VALUE[schema[f]!]!;
  });

  type Data = SoAComponentData<S>;

  const def: SoAComponentDefinition<S> = {
    id,
    name,
    defaults: defaults as unknown as Data,
    soa,
    create: (overrides?: Partial<Data>): Data & IComponent => ({
      ...defaults,
      ...overrides,
      __componentId: id,
    } as Data & IComponent),
  };
  componentDefRegistry.set(id, def as ComponentDefinition);
  return def;
}

/** Inferred data type for a SoA component (all fields are `number`). */
export type SoAComponentData<S extends Record<string, SoAFieldType>> = {
  [K in keyof S]: number;
};

export interface SoAComponentDefinition<S extends Record<string, SoAFieldType> = Record<string, SoAFieldType>>
  extends ComponentDefinition<SoAComponentData<S>> {
  soa: SoASchema;
  defaults: SoAComponentData<S>;
  create: (overrides?: Partial<SoAComponentData<S>>) => SoAComponentData<S> & IComponent;
}

export const Component = {
  register: <T extends Record<string, unknown>>(
    name: string,
    defaults: T,
  ): ComponentDefinition<T> => component(name, defaults),
};
