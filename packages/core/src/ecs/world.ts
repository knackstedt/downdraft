import type { Entity, EntityMeta } from "./entity.ts";
import { ROOT_ENTITY } from "./entity.ts";
import type { ComponentId, ComponentDefinition } from "./component.ts";
import {
  type Archetype,
  createArchetype,
  getArchetypeForComponents,
  addEntityToArchetype,
  removeEntityFromArchetype,
  findEntityRow,
} from "./archetype.ts";
import { Schedule, type SystemContext } from "./schedule.ts";
import { EventBus } from "./events.ts";
import type { Query } from "./query.ts";

interface Command {
  (world: World): void;
}

export class World {
  entities: EntityMeta[] = [];
  private entityFreeList: number[] = [];
  archetypes: Map<string, Archetype> = new Map();
  allArchetypes: Archetype[] = [];
  archetypeById: Map<number, Archetype> = new Map();
  schedule: Schedule = new Schedule();
  events: EventBus = new EventBus();
  resources: Map<string, unknown> = new Map();
  tick: number = 0;

  private commands: Command[] = [];
  private emptyArchetype: Archetype;

  constructor() {
    this.emptyArchetype = createArchetype([]);
    this.allArchetypes.push(this.emptyArchetype);
    this.archetypeById.set(this.emptyArchetype.id, this.emptyArchetype);
    this.entities[0] = { generation: 0, alive: true, archetypeId: this.emptyArchetype.id };
  }

  private registerArchetype(arch: Archetype): void {
    if (!this.allArchetypes.includes(arch)) {
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
    this.schedule.updateQueryArchetypes(this.allArchetypes);
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

    const row = findEntityRow(arch, entity);
    if (row >= 0) {
      removeEntityFromArchetype(arch, row);
    }

    meta.alive = false;
    meta.generation++;
    this.entityFreeList.push(entity.index);
    this.schedule.updateQueryArchetypes(this.allArchetypes);
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
    for (const cid of oldArch.componentIds) {
      existingComponents.set(cid, oldArch.columns.get(cid)![oldRow]);
    }
    existingComponents.set(componentId, data);

    removeEntityFromArchetype(oldArch, oldRow);

    const newArch = getArchetypeForComponents(this.archetypes, [...existingComponents.keys()]);
    this.registerArchetype(newArch);

    addEntityToArchetype(newArch, entity, existingComponents);
    meta.archetypeId = newArch.id;
    this.schedule.updateQueryArchetypes(this.allArchetypes);
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
    for (const cid of oldArch.componentIds) {
      if (cid !== componentId) {
        existingComponents.set(cid, oldArch.columns.get(cid)![oldRow]);
      }
    }

    removeEntityFromArchetype(oldArch, oldRow);

    const newArch = existingComponents.size === 0
      ? this.emptyArchetype
      : getArchetypeForComponents(this.archetypes, [...existingComponents.keys()]);
    this.registerArchetype(newArch);

    addEntityToArchetype(newArch, entity, existingComponents);
    meta.archetypeId = newArch.id;
    this.schedule.updateQueryArchetypes(this.allArchetypes);
  }

  getComponent<T>(entity: Entity, componentId: ComponentId): T | null {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return null;

    const arch = this.findArchetypeById(meta.archetypeId);
    if (!arch || !arch.componentSet.has(componentId)) return null;

    const row = findEntityRow(arch, entity);
    if (row < 0) return null;

    return arch.columns.get(componentId)![row] as T;
  }

  hasComponent(entity: Entity, componentId: ComponentId): boolean {
    const meta = this.entities[entity.index];
    if (!meta || meta.generation !== entity.generation || !meta.alive) return false;
    const arch = this.findArchetypeById(meta.archetypeId);
    return arch ? arch.componentSet.has(componentId) : false;
  }

  flushCommands(): void {
    for (let i = 0; i < this.commands.length; i++) {
      this.commands[i](this);
    }
    this.commands.length = 0;
  }

  step(dt: number): void {
    this.tick++;
    this.events.swapAll();

    const ctx: SystemContext = { world: this, dt, tick: this.tick };
    this.schedule.runStage(0, ctx); // Input
    this.schedule.runStage(1, ctx); // Update
    this.schedule.runStage(2, ctx); // Physics
    this.schedule.runStage(3, ctx); // PostUpdate
    this.flushCommands();
  }

  setResource<T>(name: string, value: T): void {
    this.resources.set(name, value);
  }

  getResource<T>(name: string): T | undefined {
    return this.resources.get(name) as T | undefined;
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

export type { Command };
export { ROOT_ENTITY };
