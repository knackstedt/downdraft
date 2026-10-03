import { isDebug } from "../sab/errors";
import { createLogger } from "../util/logger";
import {
    addEntityToArchetype,
    type Archetype,
    createArchetype,
    findEntityRow,
    getArchetypeForComponents,
    getColumnValue,
    removeArchetypeFromHashMap,
    removeEntityFromArchetype,
    setColumnValue
} from "./archetype";
import type { ComponentDefinition, ComponentId, IComponent } from "./component";
import type { Entity, EntityMeta } from "./entity";
import { ROOT_ENTITY } from "./entity";
import { EventBus } from "./events";
import type { ResourceToken } from "./resource";
import { Schedule, type SystemContext } from "./schedule";

const log = createLogger();

interface Command {
  (world: World): void;
}

export class World {
  entities: EntityMeta[] = [];
  // Unbounded on purpose: the free list can only ever hold ≤ peak-entity-count
  // entries, while capping it meant discarded indices were never recycled and
  // entities[] grew unboundedly under high spawn/despawn churn.
  private entityFreeList: number[] = [];
  archetypes: Map<number, Archetype> = new Map();
  allArchetypes: Archetype[] = [];
  archetypeById: Map<number, Archetype> = new Map();
  schedule: Schedule = new Schedule();
  events: EventBus = new EventBus();
  resources: Map<string, unknown> = new Map();
  tick: number = 0;
  archetypesDirty: boolean = false;

  private commands: Command[] = [];
  private emptyArchetype: Archetype;

  constructor() {
    this.emptyArchetype = createArchetype([]);
    this.allArchetypes.push(this.emptyArchetype);
    this.archetypeById.set(this.emptyArchetype.id, this.emptyArchetype);
    this.entities[0] = { generation: 0, alive: true, archetypeId: this.emptyArchetype.id };
  }

  private registerArchetype(arch: Archetype): void {
    if (!this.archetypeById.has(arch.id)) {
      this.allArchetypes.push(arch);
    }
    this.archetypeById.set(arch.id, arch);
  }

  spawn(components: Map<ComponentId, unknown>): Entity {
    const componentIds = [...components.keys()];
    const arch = componentIds.length === 0
      ? this.emptyArchetype
      : getArchetypeForComponents(this.archetypes, componentIds);

    this.registerArchetype(arch);

    let index: number;
    let generation: number;

    if (this.entityFreeList.length > 0) {
      index = this.entityFreeList.pop()!;
      generation = this.entities[index].generation;
      this.entities[index] = { generation, alive: true, archetypeId: arch.id };
    } else {
      index = this.entities.length;
      generation = 0;
      this.entities.push({ generation, alive: true, archetypeId: arch.id });
    }

    const entity: Entity = { index, generation };
    addEntityToArchetype(arch, entity, components);
    this.archetypesDirty = true;
    return entity;
  }

  despawn(entity: Entity): void {
    this.commands.push((w) => w._despawnImmediate(entity));
  }

  _despawnImmediate(entity: Entity): void {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return;

    const arch = this.findArchetypeById(meta.archetypeId);
    if (!arch) return;

    removeEntityFromArchetype(arch, entity);

    meta.alive = false;
    meta.generation++;
    this.entityFreeList.push(entity.index);
    this.archetypesDirty = true;
  }

  addComponent<T>(entity: Entity, componentId: ComponentId, data: T): void {
    this.commands.push((w) => w._addComponentImmediate(entity, componentId, data));
  }

  _addComponentImmediate<T>(entity: Entity, componentId: ComponentId, data: T): void {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return;

    const oldArch = this.findArchetypeById(meta.archetypeId);
    if (!oldArch || oldArch.componentSet.has(componentId)) return;

    const oldRow = findEntityRow(oldArch, entity);
    if (oldRow < 0) return;

    const existingComponents = new Map<ComponentId, unknown>();
    oldArch.componentIds.forEach((cid) => {
      existingComponents.set(cid, getColumnValue(oldArch.columns.get(cid), oldRow));
    });
    existingComponents.set(componentId, data);

    removeEntityFromArchetype(oldArch, entity);

    const newArch = getArchetypeForComponents(this.archetypes, [...existingComponents.keys()]);
    this.registerArchetype(newArch);

    addEntityToArchetype(newArch, entity, existingComponents);
    meta.archetypeId = newArch.id;
    this.archetypesDirty = true;
  }

  removeComponent(entity: Entity, componentId: ComponentId): void {
    this.commands.push((w) => w._removeComponentImmediate(entity, componentId));
  }

  _removeComponentImmediate(entity: Entity, componentId: ComponentId): void {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return;

    const oldArch = this.findArchetypeById(meta.archetypeId);
    if (!oldArch || !oldArch.componentSet.has(componentId)) return;

    const oldRow = findEntityRow(oldArch, entity);
    if (oldRow < 0) return;

    const existingComponents = new Map<ComponentId, unknown>();
    oldArch.componentIds.forEach((cid) => {
      if (cid !== componentId) {
        existingComponents.set(cid, getColumnValue(oldArch.columns.get(cid), oldRow));
      }
    });

    removeEntityFromArchetype(oldArch, entity);

    const newArch = existingComponents.size === 0
      ? this.emptyArchetype
      : getArchetypeForComponents(this.archetypes, [...existingComponents.keys()]);
    this.registerArchetype(newArch);

    addEntityToArchetype(newArch, entity, existingComponents);
    meta.archetypeId = newArch.id;
    this.archetypesDirty = true;
  }

  /**
   * In-place data update for a component the entity already has.
   * Unlike addComponent (which no-ops when the component is present), this
   * replaces the stored value without an archetype move.
   */
  setComponent<T>(entity: Entity, componentId: ComponentId, data: T): void {
    this.commands.push((w) => w._setComponentImmediate(entity, componentId, data));
  }

  _setComponentImmediate<T>(entity: Entity, componentId: ComponentId, data: T): void {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return;
    const arch = this.findArchetypeById(meta.archetypeId);
    if (!arch || !arch.componentSet.has(componentId)) return;
    const row = findEntityRow(arch, entity);
    if (row < 0) return;
    setColumnValue(arch.columns.get(componentId), row, data);
    this.archetypesDirty = true;
  }

  getArchetypeAndRow(entity: Entity): { arch: Archetype; row: number } | null {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return null;
    const arch = this.findArchetypeById(meta.archetypeId);
    if (!arch) return null;
    const row = findEntityRow(arch, entity);
    if (row < 0) return null;
    return { arch, row };
  }

  getComponent<T>(entity: Entity, componentId: ComponentId): T | null {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return null;

    const arch = this.findArchetypeById(meta.archetypeId);
    if (!arch || !arch.componentSet.has(componentId)) return null;

    const row = findEntityRow(arch, entity);
    if (row < 0) return null;

    return (getColumnValue(arch.columns.get(componentId), row) ?? null) as T | null;
  }

  hasComponent(entity: Entity, componentId: ComponentId): boolean {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return false;
    const arch = this.findArchetypeById(meta.archetypeId);
    return arch ? arch.componentSet.has(componentId) : false;
  }

  flushCommands(): void {
    for (let i = 0; i < this.commands.length; i++) {
      try {
        this.commands[i](this);
      } catch (err) {
        log.error("World", `Command at index ${i} threw: ${err}`);
        // In debug mode, re-throw to surface command errors immediately.
        // In production, log and continue for game-loop resilience.
        if (isDebug()) throw err;
      }
    }
    this.commands.length = 0;
    if (this.archetypesDirty) {
      this.pruneEmptyArchetypes();
      this.schedule.updateQueryArchetypes(this.allArchetypes);
      this.archetypesDirty = false;
    }
  }

  /**
   * Reclaim archetypes with no live entities. `allArchetypes` only ever grew —
   * a game that churns through many component combinations (spawn/despawn
   * variety) accumulated dead archetypes that `updateQueryArchetypes` rescanned
   * on every structural flush. Hysteresis: only prune when the list is large
   * AND mostly dead, so spawn/despawn oscillation between two archetypes
   * doesn't thrash destroy→recreate.
   */
  private pruneEmptyArchetypes(): void {
    const all = this.allArchetypes;
    if (all.length < 256) return;
    let dead = 0;
    all.forEach((a) => {
      if (a.entities.length === 0 && a !== this.emptyArchetype) dead++;
    });
    if (dead * 4 < all.length) return;
    const survivors: Archetype[] = [];
    all.forEach((a) => {
      if (a.entities.length === 0 && a !== this.emptyArchetype) {
        this.archetypeById.delete(a.id);
        removeArchetypeFromHashMap(this.archetypes, a);
      } else {
        survivors.push(a);
      }
    });
    this.allArchetypes = survivors;
  }

  step(dt: number): void {
    this.tick++;
    this.events.swapAll();

    // Update query archetypes before running systems so that entities
    // spawned/modified before this step are visible to queries during it.
    // flushCommands() at the end of step() will handle any structural
    // changes made by systems during this step.
    if (this.archetypesDirty) {
      this.schedule.updateQueryArchetypes(this.allArchetypes);
      this.archetypesDirty = false;
    }

    const ctx: SystemContext = { world: this, dt, tick: this.tick };
    this.schedule.runStage(0, ctx); // Input
    this.schedule.runStage(1, ctx); // Update
    this.schedule.runStage(2, ctx); // Physics
    this.schedule.runStage(3, ctx); // PostUpdate
    this.schedule.runStage(4, ctx); // Render (render-prep systems)
    this.flushCommands();
  }

  setResourceTyped<T>(token: ResourceToken<T>, value: T): void {
    this.resources.set(token.key, value);
  }

  getResourceTyped<T>(token: ResourceToken<T>): T | undefined {
    return this.resources.get(token.key) as T | undefined;
  }

  addComponentDef<T extends Record<string, unknown>>(
    entity: Entity,
    def: ComponentDefinition<T>,
    data: T & IComponent,
  ): void {
    this.addComponent(entity, def.id, data);
  }

  getComponentDef<T extends Record<string, unknown>>(
    entity: Entity,
    def: ComponentDefinition<T>,
  ): T | null {
    return this.getComponent<T>(entity, def.id);
  }

  hasComponentDef<T extends Record<string, unknown>>(
    entity: Entity,
    def: ComponentDefinition<T>,
  ): boolean {
    return this.hasComponent(entity, def.id);
  }

  clearAllEntities(): void {
    for (let i = 1; i < this.entities.length; i++) {
      const meta = this.entities[i];
      if (meta && meta.alive) {
        this.despawn({ index: i, generation: meta.generation });
      }
    }
    this.flushCommands();
  }

  entityCount(): number {
    let count = 0;
    for (let i = 0; i < this.entities.length; i++) {
      if (this.entities[i].alive) count++;
    }
    return count;
  }

  private findArchetypeById(id: number): Archetype | undefined {
    return this.archetypeById.get(id);
  }

  getArchetypeForEntity(entity: Entity): Archetype | null {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return null;
    return this.archetypeById.get(meta.archetypeId) ?? null;
  }
}

export { ROOT_ENTITY };
export type { Command };

