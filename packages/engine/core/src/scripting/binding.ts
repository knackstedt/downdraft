import type { ComponentId } from "../ecs/component";
import { getComponentId } from "../ecs/component";
import type { Entity } from "../ecs/entity";
import type { Query } from "../ecs/query";
import { query, queryChanged, queryExcluded } from "../ecs/query";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, SystemFn } from "../ecs/system";
import type { World } from "../ecs/world";

export type { ScriptContext, ScriptHandle, ScriptModule } from "./script";

export interface ScriptBinding {
  registerSystem(stage: Stage, fn: SystemFn): void;
  registerEventHandler(eventName: string, handler: (event: unknown) => void): void;
  query(...componentNames: string[]): Query;
  queryExcluded(required: string[], excluded: string[]): Query;
  queryChanged(required: string[], changedComponent: string): Query;
  getComponent<T>(entity: Entity, componentName: string): T | null;
  setComponent<T>(entity: Entity, componentName: string, data: T): void;
  hasComponent(entity: Entity, componentName: string): boolean;
  spawn(components: Map<string, unknown>): Entity;
  despawn(entity: Entity): void;
  getResource<T>(token: ResourceToken<T>): T | undefined;
  setResource<T>(token: ResourceToken<T>, value: T): void;
  sendEvent<T>(eventName: string, event: T): void;
  readEvents<T>(eventName: string): T[];
}

export function createScriptBinding(
  world: World,
  scriptName: string,
  systems: Array<{ stage: Stage; fn: SystemFn }>,
): ScriptBinding {
  const binding: ScriptBinding = {
    registerSystem(stage: Stage, fn: SystemFn): void {
      systems.push({ stage, fn });
      world.schedule.add({
        name: `script:${scriptName}:${systems.length}`,
        stage,
        fn,
        queries: [],
      });
    },

    registerEventHandler(eventName: string, handler: (event: unknown) => void): void {
      const systemFn: SystemFn = () => {
        const events = world.events.read<unknown>(eventName);
        for (let i = 0; i < events.length; i++) {
          handler(events[i]);
        }
      };
      systems.push({ stage: 1, fn: systemFn });
      world.schedule.add({
        name: `script:${scriptName}:event_${eventName}:${systems.length}`,
        stage: 1,
        fn: systemFn,
        queries: [],
      });
    },

    query(...componentNames: string[]): Query {
      const ids = componentNames.map((n) => getComponentId(n));
      const q = query(...ids);
      q.updateArchetypes(world.allArchetypes);
      return q;
    },

    queryExcluded(required: string[], excluded: string[]): Query {
      const reqIds = required.map((n) => getComponentId(n));
      const excIds = excluded.map((n) => getComponentId(n));
      const q = queryExcluded(reqIds, excIds);
      q.updateArchetypes(world.allArchetypes);
      return q;
    },

    queryChanged(required: string[], changedComponent: string): Query {
      const reqIds = required.map((n) => getComponentId(n));
      const changedId = getComponentId(changedComponent);
      const q = queryChanged(reqIds, changedId);
      q.updateArchetypes(world.allArchetypes);
      return q;
    },

    getComponent<T>(entity: Entity, componentName: string): T | null {
      const cid = getComponentId(componentName);
      return world.getComponent<T>(entity, cid);
    },

    setComponent<T>(entity: Entity, componentName: string, data: T): void {
      const cid = getComponentId(componentName);
      world.addComponent(entity, cid, data);
    },

    hasComponent(entity: Entity, componentName: string): boolean {
      const cid = getComponentId(componentName);
      return world.hasComponent(entity, cid);
    },

    spawn(components: Map<string, unknown>): Entity {
      const idMap = new Map<ComponentId, unknown>();
      for (const [name, data] of components) {
        idMap.set(getComponentId(name), data);
      }
      return world.spawn(idMap);
    },

    despawn(entity: Entity): void {
      world.despawn(entity);
    },

    getResource<T>(token: ResourceToken<T>): T | undefined {
      return world.getResourceTyped<T>(token);
    },

    setResource<T>(token: ResourceToken<T>, value: T): void {
      world.setResourceTyped(token, value);
    },

    sendEvent<T>(eventName: string, event: T): void {
      world.events.send(eventName, event);
    },

    readEvents<T>(eventName: string): T[] {
      return world.events.read<T>(eventName);
    },
  };

  return binding;
}
