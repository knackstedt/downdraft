import type { Query } from "./query.ts";

export enum Stage {
  Input = 0,
  Update = 1,
  Physics = 2,
  PostUpdate = 3,
  Render = 4,
}

export interface SystemContext {
  world: import("./world.ts").World;
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
}

export function system(
  name: string,
  stage: Stage,
  fn: SystemFn,
  opts: { queries?: Query[]; after?: string[]; before?: string[] } = {},
): System {
  return { name, stage, fn, queries: opts.queries ?? [], after: opts.after, before: opts.before };
}
