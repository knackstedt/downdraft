import type { ComponentId } from "../ecs/component";
import { entityEqual, isAlive, type Entity } from "../ecs/entity";
import type { World } from "../ecs/world";
import { createLogger } from "../util/logger";

const log = createLogger();

export type SceneState = "unloaded" | "loading" | "loaded" | "active" | "inactive";

export type SceneSetup = (scene: Scene) => void | Promise<void>;
export type SceneTeardown = (scene: Scene) => void;

export interface SerializedScene {
  name: string;
  state: SceneState;
  persistent: boolean;
  entities: Array<{
    index: number;
    generation: number;
    components: Array<{ id: number; data: unknown }>;
  }>;
}

export class Scene {
  name: string;
  world: World;
  state: SceneState = "unloaded";
  persistent = false;

  private _entities: Entity[] = [];
  private _entitySet: Set<string> = new Set();
  private _setup: SceneSetup | null;
  private _teardown: SceneTeardown | null;

  constructor(name: string, world: World, setup?: SceneSetup) {
    this.name = name;
    this.world = world;
    this._setup = setup ?? null;
    this._teardown = null;
  }

  setSetup(fn: SceneSetup): void {
    this._setup = fn;
  }

  setTeardown(fn: SceneTeardown): void {
    this._teardown = fn;
  }

  // ── Entity Management (synced with World) ──────────────────────

  spawn(components: Map<ComponentId, unknown>): Entity {
    const entity = this.world.spawn(components);
    this.trackEntity(entity);
    return entity;
  }

  despawn(entity: Entity): void {
    this.world.despawn(entity);
    this.untrackEntity(entity);
  }

  trackEntity(entity: Entity): void {
    const key = `${entity.index}:${entity.generation}`;
    if (this._entitySet.has(key)) return;
    this._entitySet.add(key);
    this._entities.push(entity);
  }

  untrackEntity(entity: Entity): void {
    const key = `${entity.index}:${entity.generation}`;
    if (!this._entitySet.delete(key)) return;
    const idx = this._entities.findIndex((e) => entityEqual(e, entity));
    if (idx >= 0) this._entities.splice(idx, 1);
  }

  addEntity(entity: Entity): void {
    this.trackEntity(entity);
  }

  removeEntity(entity: Entity): void {
    this.untrackEntity(entity);
  }

  getEntities(): Entity[] {
    return this._entities.filter((e) => isAlive(this.world.entities, e));
  }

  getEntityCount(): number {
    return this._entities.length;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async load(): Promise<void> {
    if (this.state !== "unloaded") {
      log.warn("Scene", `Cannot load "${this.name}" — current state: ${this.state}`);
      return;
    }
    this.state = "loading";

    if (this._setup) {
      await this._setup(this);
    }

    this.state = "loaded";
    log.info("Scene", `Loaded "${this.name}" (${this._entities.length} entities)`);
  }

  unload(): void {
    if (this.state === "unloaded") return;

    if (this._teardown) {
      this._teardown(this);
    }

    for (const entity of this._entities) {
      this.world._despawnImmediate(entity);
    }

    this._entities = [];
    this._entitySet.clear();
    this.state = "unloaded";
    log.info("Scene", `Unloaded "${this.name}"`);
  }

  activate(): void {
    if (this.state === "unloaded" || this.state === "loading") {
      log.warn("Scene", `Cannot activate "${this.name}" — not loaded`);
      return;
    }
    this.state = "active";
  }

  deactivate(): void {
    if (this.state !== "active") return;
    this.state = "inactive";
  }

  isActive(): boolean {
    return this.state === "active";
  }

  isLoaded(): boolean {
    return this.state === "loaded" || this.state === "active" || this.state === "inactive";
  }

  // ── Serialization ──────────────────────────────────────────────

  serialize(): SerializedScene {
    const entities: SerializedScene["entities"] = [];

    for (const entity of this._entities) {
      if (!isAlive(this.world.entities, entity)) continue;
      const arch = this.world.getArchetypeForEntity(entity);
      if (!arch) continue;

      const components: Array<{ id: number; data: unknown }> = [];
      for (const [cid, col] of arch.columns) {
        const row = arch.entities.findIndex((e) => entityEqual(e, entity));
        if (row >= 0) {
          components.push({ id: cid, data: col[row] });
        }
      }
      entities.push({ index: entity.index, generation: entity.generation, components });
    }

    return { name: this.name, state: this.state, persistent: this.persistent, entities };
  }

  deserialize(data: SerializedScene): void {
    this.unload();

    this.name = data.name;
    this.persistent = data.persistent ?? false;

    for (const entry of data.entities) {
      const components = new Map<ComponentId, unknown>();
      for (const comp of entry.components) {
        components.set(comp.id, comp.data);
      }
      const entity = this.world.spawn(components);
      this.trackEntity(entity);
    }

    this.state = data.state === "active" ? "active" : "loaded";
  }
}
