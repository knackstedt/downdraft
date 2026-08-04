import type { Query } from "./query";

export enum Stage {
  Input = 0,
  Update = 1,
  Physics = 2,
  PostUpdate = 3,
  Render = 4,
}

export interface SystemContext {
  world: import("./world").World;
  dt: number;
  tick: number;
}

export type SystemFn = (ctx: SystemContext) => void;

export interface System {
  name: string;
  stage: Stage;
  fn: SystemFn;
  queries: Query[];
  after?: string[];
  before?: string[];
  /** If true, this system can be dispatched to the JobScheduler for parallel execution. */
  parallelizable?: boolean;
}

export function system(
  name: string,
  stage: Stage,
  fn: SystemFn,
  opts: { queries?: Query[]; after?: string[]; before?: string[]; parallelizable?: boolean } = {},
): System {
  return {
    name,
    stage,
    fn,
    queries: opts.queries ?? [],
    after: opts.after,
    before: opts.before,
    parallelizable: opts.parallelizable,
  };
}
