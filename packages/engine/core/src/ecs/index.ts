// ECS sub-barrel — re-exports all ECS-related items.
export { archetypeMatches, createArchetype, getArchetypeForComponents, getColumnValue, isSoAColumn, reconstructSoAObject, removeArchetypeFromHashMap, setColumnValue } from "./archetype";
export type { Archetype, Column, SoAColumn } from "./archetype";
export { Component, component, getComponentDefinition, getComponentId, getComponentName, isRegisteredComponentId, isRegisteredComponentName, isSoAComponentDef, listComponentDefinitions, listComponentNames, SOA_DEFAULT_VALUE, SOA_TYPED_ARRAY_CTOR, soaComponent } from "./component";
export type { ComponentDefinition, ComponentId, IComponent, SoAComponentData, SoAComponentDefinition, SoAFieldType, SoASchema, SoATypedArray } from "./component";
export { entityEqual, entityToString, isAlive, ROOT_ENTITY } from "./entity";
export type { Entity, EntityMeta } from "./entity";
export { createEventChannel, EventBus } from "./events";
export type { EventChannel } from "./events";
export { Hierarchy } from "./hierarchy";
export { clearHmrSwaps, hmrSwap, registerHmrSwap, unregisterHmrSwap } from "./hmr-swap-registry";
export { Query, query, queryChanged, queryExcluded, queryFromDefs } from "./query";
export type { QueryDescriptor } from "./query";
export { resourceToken } from "./resource";
export type { ResourceToken } from "./resource";
export { Schedule } from "./schedule";
export { Stage, system } from "./system";
export type { System, SystemContext, SystemFn } from "./system";
export { q, res, systemWithParams } from "./system-params";
export type { ParamSystemFn, QueryParam, Res, ResolvedParam, ResParam, SystemParam } from "./system-params";
export { World } from "./world";

// Job System (lives under ecs/)


