import type { ComponentId } from "../ecs/component.ts";
import type { Entity } from "../ecs/entity.ts";
import type { World } from "../ecs/world.ts";
import type { Archetype } from "../ecs/archetype.ts";
import { findEntityRow } from "../ecs/archetype.ts";

export class ChangeTracker {
  private world: World;

  constructor(world: World) {
    this.world = world;
  }

  write<T extends { lastChanged?: number }>(
    entity: Entity,
    componentId: ComponentId,
    mutator: (data: T) => void,
  ): void {
    const data = this.world.getComponent<T>(entity, componentId);
    if (!data) return;
    mutator(data);
    data.lastChanged = this.world.tick;
  }

  wasChanged(
    entity: Entity,
    componentId: ComponentId,
    sinceTick: number,
  ): boolean {
    const data = this.world.getComponent<{ lastChanged?: number }>(entity, componentId);
    if (!data) return false;
    return (data.lastChanged ?? 0) >= sinceTick;
  }

  static writeToColumn<T extends { lastChanged?: number }>(
    arch: Archetype,
    row: number,
    componentId: ComponentId,
    tick: number,
    mutator: (data: T) => void,
  ): void {
    const col = arch.columns.get(componentId) as T[];
    if (!col || row >= col.length) return;
    mutator(col[row]);
    col[row].lastChanged = tick;
  }
}
