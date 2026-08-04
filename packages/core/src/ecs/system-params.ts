import type { ComponentDefinition } from "./component";
import type { Query } from "./query";
import { queryFromDefs } from "./query";
import type { ResourceToken } from "./resource";
import { Stage, type System, type SystemContext, type SystemFn } from "./system";
import type { World } from "./world";

export interface Res<T> {
  readonly value: T | undefined;
}

export interface ResParam<T> {
  readonly kind: "res";
  readonly token: ResourceToken<T>;
}

export interface QueryParam {
  readonly kind: "query";
  readonly query: Query;
}

export type SystemParam = ResParam<unknown> | QueryParam;

export function res<T>(token: ResourceToken<T>): ResParam<T> {
  return { kind: "res", token };
}

export function q(
  ...defs: ComponentDefinition<Record<string, unknown>>[]
): QueryParam {
  return { kind: "query", query: queryFromDefs(...defs) };
}

export type ResolvedParam = Res<unknown> | Query;

export function resolveParams(
  world: World,
  params: SystemParam[],
): ResolvedParam[] {
  const resolved: ResolvedParam[] = [];
  for (const param of params) {
    if (param.kind === "res") {
      resolved.push({ value: world.getResourceTyped(param.token) });
    } else {
      resolved.push(param.query);
    }
  }
  return resolved;
}

export type ParamSystemFn = (ctx: SystemContext, ...args: ResolvedParam[]) => void;

export function systemWithParams(
  name: string,
  stage: Stage,
  params: SystemParam[],
  fn: ParamSystemFn,
  opts: { after?: string[]; before?: string[]; parallelizable?: boolean } = {},
): System {
  let resolvedCache: ResolvedParam[] | null = null;

  const wrappedFn: SystemFn = (ctx: SystemContext) => {
    if (!resolvedCache) {
      resolvedCache = resolveParams(ctx.world, params);
    }
    fn(ctx, ...resolvedCache);
  };

  const queries = params
    .filter((p): p is QueryParam => p.kind === "query")
    .map((p) => p.query);

  return {
    name,
    stage,
    fn: wrappedFn,
    queries,
    after: opts.after,
    before: opts.before,
    parallelizable: opts.parallelizable,
  };
}
