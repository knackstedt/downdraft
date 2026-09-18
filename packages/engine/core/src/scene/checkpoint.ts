import { findEntityRow, getColumnValue } from "../ecs/archetype";
import type { Entity } from "../ecs/entity";
import type { World } from "../ecs/world";

export interface CheckpointData {
  name: string;
  timestamp: number;
  entities: Array<{
    entity: Entity;
    components: Array<{ id: number; data: unknown }>;
  }>;
}

export class CheckpointManager {
  private checkpoints: Map<string, CheckpointData> = new Map();
  private history: string[] = [];
  private maxHistory: number = 50;

  create(name: string, world: World): CheckpointData {
    const entities: CheckpointData["entities"] = [];

    for (let i = 1; i < world.entities.length; i++) {
      const meta = world.entities[i];
      if (!meta.alive) continue;

      const arch = world.archetypeById.get(meta.archetypeId);
      if (!arch) continue;

      const entity: Entity = { index: i, generation: meta.generation };
      const components: Array<{ id: number; data: unknown }> = [];

      for (const [cid, col] of arch.columns) {
        const row = findEntityRow(arch, entity);
        if (row >= 0) {
          components.push({ id: cid, data: getColumnValue(col, row) });
        }
      }

      entities.push({ entity, components });
    }

    const cp: CheckpointData = {
      name,
      timestamp: Date.now(),
      entities,
    };

    this.checkpoints.set(name, cp);
    this.history.push(name);
    if (this.history.length > this.maxHistory) {
      const old = this.history.shift()!;
      this.checkpoints.delete(old);
    }

    return cp;
  }

  restore(name: string, world: World): boolean {
    const cp = this.checkpoints.get(name);
    if (!cp) return false;

    // Despawn all existing alive entities (including root) to prevent duplicates
    for (let i = 0; i < world.entities.length; i++) {
      const meta = world.entities[i];
      if (meta.alive) {
        const entity: Entity = { index: i, generation: meta.generation };
        world.despawn(entity);
      }
    }
    world.flushCommands();

    // Spawn entities from checkpoint
    for (let i = 0; i < cp.entities.length; i++) {
      const entry = cp.entities[i];
      const components = new Map<number, unknown>();
      for (let j = 0; j < entry.components.length; j++) {
        components.set(entry.components[j].id, entry.components[j].data);
      }
      world.spawn(components);
    }

    return true;
  }

  list(): CheckpointData[] {
    return [...this.checkpoints.values()];
  }

  diff(a: string, b: string): { added: string[]; removed: string[]; changed: string[] } | null {
    const cpA = this.checkpoints.get(a);
    const cpB = this.checkpoints.get(b);
    if (!cpA || !cpB) return null;

    const entitiesA = new Set(cpA.entities.map((e) => `${e.entity.index}.${e.entity.generation}`));
    const entitiesB = new Set(cpB.entities.map((e) => `${e.entity.index}.${e.entity.generation}`));

    const added: string[] = [];
    const removed: string[] = [];

    for (const id of entitiesB) {
      if (!entitiesA.has(id)) added.push(id);
    }
    for (const id of entitiesA) {
      if (!entitiesB.has(id)) removed.push(id);
    }

    return { added, removed, changed: [] };
  }
}
