import { createLogger } from "../util/logger";
import type { Archetype } from "./archetype";
import type { JobScheduler } from "./job-system";
import type { Query } from "./query";
import { Stage, type System, type SystemContext } from "./system";
export type { SystemContext };

const log = createLogger();

interface ScheduledSystem {
  system: System;
  order: number;
}

export class Schedule {
  private systems: Map<Stage, ScheduledSystem[]> = new Map();
  private ordered: Map<Stage, System[]> = new Map();
  private allQueries: Query[] = [];
  private dirty: boolean = true;

  add(sys: System): this {
    return this.addSystem(sys);
  }

  addSystem(sys: System): this {
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
    return this.removeSystem(name);
  }

  removeSystem(name: string): this {
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
    return this.allQueries;
  }

  updateQueryArchetypes(archetypes: Archetype[]): void {
    const queries = this.getAllQueries();
    for (let i = 0; i < queries.length; i++) {
      queries[i].updateArchetypes(archetypes);
    }
  }

  run(world: import("./world").World, dt: number, tick: number): void {
    const ctx: SystemContext = { world, dt, tick };
    for (let s = 0; s <= 4; s++) {
      this.runStage(s as Stage, ctx);
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

  /**
   * Run a stage with parallel execution of independent parallelizable systems.
   * Non-parallelizable systems and those with unresolved dependencies run inline.
   * Falls back to sequential execution if no scheduler is provided.
   */
  async runStageParallel(stage: Stage, ctx: SystemContext, scheduler: JobScheduler): Promise<void> {
    if (this.dirty) {
      this.resolveOrder();
    }
    const systems = this.ordered.get(stage);
    if (!systems) return;

    // Build dependency graph for this stage
    const nameToIdx = new Map<string, number>();
    for (let i = 0; i < systems.length; i++) {
      nameToIdx.set(systems[i].name, i);
    }

    // Build reverse edges from `before` declarations (same as topologicalSort)
    const implicitAfter = new Map<string, string[]>();
    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i];
      if (!sys.before) continue;
      for (let j = 0; j < sys.before.length; j++) {
        const target = sys.before[j];
        if (!nameToIdx.has(target)) continue;
        let list = implicitAfter.get(target);
        if (!list) { list = []; implicitAfter.set(target, list); }
        list.push(sys.name);
      }
    }

    // Track completion state. pendingJobs maps a system index to the promise
    // of its dispatched worker job — awaiting the promise guarantees the
    // completion flag was set (the flag flips inside the promise's own .then).
    const completed = new Array<boolean>(systems.length).fill(false);
    const pendingJobs = new Map<number, Promise<void>>();

    // Process systems in order, dispatching parallelizable ones to the scheduler
    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i];

      // Collect unmet `after` deps (explicit + implicit from `before`).
      // A dep that was dispatched in parallel is "unmet" until its job
      // resolves — running the dependent inline now would execute it
      // CONCURRENTLY with its dependency, violating the ordering contract.
      const unmetJobs: Promise<void>[] = [];
      let depsReady = true;
      const checkDep = (depName: string) => {
        const depIdx = nameToIdx.get(depName);
        if (depIdx === undefined) return;
        const job = pendingJobs.get(depIdx);
        if (job) {
          unmetJobs.push(job);
        } else if (!completed[depIdx]) {
          depsReady = false;
        }
      };
      if (sys.after) {
        for (let j = 0; j < sys.after.length; j++) checkDep(sys.after[j]);
      }
      const implicit = implicitAfter.get(sys.name);
      if (implicit) {
        for (let j = 0; j < implicit.length; j++) checkDep(implicit[j]);
      }

      // Wait for in-flight dependency jobs before running this system.
      if (unmetJobs.length > 0) {
        await Promise.all(unmetJobs);
      }

      if (!depsReady) {
        // Dep scheduled later in the array (shouldn't happen after the
        // topological sort) — sequential fallback.
        sys.fn(ctx);
        completed[i] = true;
        continue;
      }

      if (sys.parallelizable && scheduler.workerPool.hasIdleWorker()) {
        // Dispatch to worker pool — run system function on a worker
        // The system fn is registered with the pool under its name
        const job = scheduler.submit({
          fn: sys.name,
          args: [ctx],
          deps: [],
          priority: 0,
        }).then(() => {
          completed[i] = true;
        }).catch(() => {
          // Fallback to inline on error
          sys.fn(ctx);
          completed[i] = true;
        });
        pendingJobs.set(i, job);
      } else {
        // Run inline
        sys.fn(ctx);
        completed[i] = true;
      }
    }

    // Wait for all dispatched jobs to complete
    if (pendingJobs.size > 0) {
      await Promise.all(pendingJobs.values());
    }
    await scheduler.drain();
  }

  private resolveOrder(): void {
    for (const [stage, bucket] of this.systems) {
      const sorted = this.topologicalSort(bucket);
      this.ordered.set(stage, sorted);
    }

    this.allQueries.length = 0;
    for (const systems of this.ordered.values()) {
      for (let i = 0; i < systems.length; i++) {
        const queries = systems[i].queries;
        for (let q = 0; q < queries.length; q++) {
          this.allQueries.push(queries[q]);
        }
      }
    }
    this.dirty = false;
  }

  private topologicalSort(bucket: ScheduledSystem[]): System[] {
    const nameToSys = new Map<string, ScheduledSystem>();
    for (let i = 0; i < bucket.length; i++) {
      nameToSys.set(bucket[i].system.name, bucket[i]);
    }

    // Build reverse edges from `before` declarations:
    // if A declares `before: [B]`, then B must run after A.
    // We collect these as additional implicit `after` deps on B.
    const implicitAfter = new Map<string, string[]>();
    for (let i = 0; i < bucket.length; i++) {
      const sys = bucket[i].system;
      if (!sys.before) continue;
      for (let j = 0; j < sys.before.length; j++) {
        const target = sys.before[j];
        if (!nameToSys.has(target)) continue; // skip unknown systems
        let list = implicitAfter.get(target);
        if (!list) { list = []; implicitAfter.set(target, list); }
        list.push(sys.name);
      }
    }

    const visited = new Set<string>();
    const result: System[] = [];

    const visit = (name: string, path: Set<string>) => {
      if (visited.has(name)) return;
      if (path.has(name)) {
        log.warn("Schedule", `System dependency cycle detected involving "${name}" — skipping`);
        return;
      }
      const entry = nameToSys.get(name);
      if (!entry) return;

      path.add(name);

      // Process explicit `after` deps
      if (entry.system.after) {
        for (let i = 0; i < entry.system.after.length; i++) {
          visit(entry.system.after[i], path);
        }
      }
      // Process implicit `after` deps (from other systems' `before` declarations)
      const implicit = implicitAfter.get(name);
      if (implicit) {
        for (let i = 0; i < implicit.length; i++) {
          visit(implicit[i], path);
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
