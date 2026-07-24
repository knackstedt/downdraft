import { Stage, type System, type SystemFn, type SystemContext } from "./system.ts";
export type { SystemContext };
import type { Query } from "./query.ts";
import type { Archetype } from "./archetype.ts";

interface ScheduledSystem {
  system: System;
  order: number;
}

export class Schedule {
  private systems: Map<Stage, ScheduledSystem[]> = new Map();
  private ordered: Map<Stage, System[]> = new Map();
  private dirty: boolean = true;

  add(sys: System): this {
    const stage = sys.stage;
    let bucket = this.systems.get(stage);
    if (!bucket) {
      bucket = [];
      this.systems.set(stage, bucket);
    }
    bucket.push({ system: sys, order: bucket.length });
    this.dirty = true;
    return this;
  }

  remove(name: string): this {
    for (const [stage, bucket] of this.systems) {
      const idx = bucket.findIndex((s) => s.system.name === name);
      if (idx >= 0) {
        bucket.splice(idx, 1);
        this.dirty = true;
      }
    }
    return this;
  }

  getSystems(stage: Stage): System[] {
    if (this.dirty) {
      this.resolveOrder();
    }
    return this.ordered.get(stage) ?? [];
  }

  getAllSystems(): System[] {
    if (this.dirty) {
      this.resolveOrder();
    }
    const all: System[] = [];
    for (let s = 0; s <= 4; s++) {
      const stage = s as Stage;
      all.push(...(this.ordered.get(stage) ?? []));
    }
    return all;
  }

  getAllQueries(): Query[] {
    if (this.dirty) {
      this.resolveOrder();
    }
    const queries: Query[] = [];
    for (const systems of this.ordered.values()) {
      for (let i = 0; i < systems.length; i++) {
        for (let q = 0; q < systems[i].queries.length; q++) {
          queries.push(systems[i].queries[q]);
        }
      }
    }
    return queries;
  }

  updateQueryArchetypes(archetypes: Archetype[]): void {
    const queries = this.getAllQueries();
    for (let i = 0; i < queries.length; i++) {
      queries[i].updateArchetypes(archetypes);
    }
  }

  runStage(stage: Stage, ctx: SystemContext): void {
    if (this.dirty) {
      this.resolveOrder();
    }
    const systems = this.ordered.get(stage);
    if (!systems) return;
    for (let i = 0; i < systems.length; i++) {
      systems[i].fn(ctx);
    }
  }

  private resolveOrder(): void {
    for (const [stage, bucket] of this.systems) {
      const sorted = this.topologicalSort(bucket);
      this.ordered.set(stage, sorted);
    }
    this.dirty = false;
  }

  private topologicalSort(bucket: ScheduledSystem[]): System[] {
    const nameToSys = new Map<string, ScheduledSystem>();
    for (let i = 0; i < bucket.length; i++) {
      nameToSys.set(bucket[i].system.name, bucket[i]);
    }

    const visited = new Set<string>();
    const result: System[] = [];

    const visit = (name: string, path: Set<string>) => {
      if (visited.has(name)) return;
      if (path.has(name)) return; // cycle — skip
      const entry = nameToSys.get(name);
      if (!entry) return;

      path.add(name);

      if (entry.system.after) {
        for (let i = 0; i < entry.system.after.length; i++) {
          visit(entry.system.after[i], path);
        }
      }

      path.delete(name);
      visited.add(name);
      result.push(entry.system);
    };

    for (let i = 0; i < bucket.length; i++) {
      visit(bucket[i].system.name, new Set());
    }

    return result;
  }
}
