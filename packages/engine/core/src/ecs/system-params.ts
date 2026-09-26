import type { ComponentDefinition } from "./component";
import type { Query } from "./query";
import { queryFromDefs } from "./query";
import type { ResourceToken } from "./resource";
import { Stage, type System, type SystemContext, type SystemFn } from "./system";
import type { World } from "./world";

export interface Res<T> {
  /** Live view of the resource — re-reads from the world on every access. */
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
  ...defs: ComponentDefinition<any>[]
): QueryParam {
  return { kind: "query", query: queryFromDefs(...defs) };
}

export type ResolvedParam = Res<unknown> | Query;

export function resolveParams(
  world: World,
  params: SystemParam[],
): ResolvedParam[] {
  const resolved: ResolvedParam[] = [];
  params.forEach((param) => {
    if (param.kind === "res") {
      // Live view: the getter reads from the world on every .value access,
      // so resource updates (including hot-reload) are reflected immediately.
      resolved.push({
        get value() {
          return world.getResourceTyped(param.token);
        },
      });
    } else {
      resolved.push(param.query);
    }
  });
  return resolved;
}

export type ParamSystemFn = (ctx: SystemContext, ...args: ResolvedParam[]) => void;

/** Maps a declared SystemParam to the value injected into the system fn. */
export type ResolvedParamFor<P> =
  P extends ResParam<infer T> ? Res<T>
  : P extends QueryParam ? Query
  : ResolvedParam;

/** Tuple-map: `q(...) → Query`, `res(Tok<T>) → Res<T>`, in declared order. */
export type ResolvedParamsFor<P extends readonly SystemParam[]> = {
  [K in keyof P]: ResolvedParamFor<P[K]>;
};

export function systemWithParams<P extends readonly SystemParam[]>(
  name: string,
  stage: Stage,
  params: P,
  fn: (ctx: SystemContext, ...args: ResolvedParamsFor<P>) => void,
  opts: { after?: string[]; before?: string[] } = {},
): System {
  let resolvedCache: ResolvedParam[] | null = null;

  const wrappedFn: SystemFn = (ctx: SystemContext) => {
    if (!resolvedCache) {
      resolvedCache = resolveParams(ctx.world, [...params]);
    }
    fn(ctx, ...(resolvedCache as unknown as ResolvedParamsFor<P>));
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
  };
}
