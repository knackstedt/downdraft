// ECS sub-barrel — re-exports all ECS-related items.
export { archetypeMatches, createArchetype, getArchetypeForComponents } from "./archetype";
export type { Archetype } from "./archetype";
export { Component, component, getComponentId, getComponentName, isRegisteredComponentId } from "./component";
export type { ComponentDefinition, ComponentId, IComponent } from "./component";
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
export { JobScheduler, parallelMap, WorkerPool } from "./job-system";
export type { BatchOptions, Job, JobResult, JobSchedulerOptions, WorkerPoolOptions } from "./job-system";
