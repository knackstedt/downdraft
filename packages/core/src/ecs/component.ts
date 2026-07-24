export type ComponentId = number;

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

export interface Component {
  readonly __componentId?: ComponentId;
}

export function component<T extends Record<string, unknown>>(
  name: string,
  defaults: T,
): ComponentDefinition<T> {
  const id = getComponentId(name);
  return {
    id,
    name,
    defaults,
    create: (overrides?: Partial<T>): T & Component => ({
      ...defaults,
      ...overrides,
      __componentId: id,
    } as T & Component),
  };
}

export interface ComponentDefinition<T extends Record<string, unknown>> {
  id: ComponentId;
  name: string;
  defaults: T;
  create: (overrides?: Partial<T>) => T & Component;
}

export const Component = {
  register: <T extends Record<string, unknown>>(
    name: string,
    defaults: T,
  ): ComponentDefinition<T> => component(name, defaults),
};
