import type { World } from "../ecs/world.ts";
import type { Entity } from "../ecs/entity.ts";

export class Scene {
  name: string;
  world: World;
  entities: Entity[] = [];

  constructor(name: string, world: World) {
    this.name = name;
    this.world = world;
  }

  addEntity(entity: Entity): void {
    this.entities.push(entity);
  }

  removeEntity(entity: Entity): void {
    const idx = this.entities.findIndex(
      (e) => e.index === entity.index && e.generation === entity.generation,
    );
    if (idx >= 0) this.entities.splice(idx, 1);
  }

  getEntities(): Entity[] {
    return this.entities;
  }
}
