import type { ComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, System, SystemFn } from "../ecs/system";

export interface SABChannel {
  name: string;
  buffer: SharedArrayBuffer;
}

/**
 * DevTools registration surface exposed on ModuleContext.
 * Plugins call `ctx.devtools.registerDataFeed(...)` etc. to self-register
 * debug data. The same interface works in both main and worker realms.
 *
 * The actual implementation is provided by @downdraft/engine/modules/devtools via
 * the `devtools` singleton. Core defines the interface; the host injects
 * the concrete object at construction time (see ModuleHost.setDevToolsAPI).
 */
export interface ModuleDevToolsAPI {
  registerDataFeed(name: string, fn: () => unknown, writeRateHz?: number): void;
  registerCommand(name: string, fn: (...args: unknown[]) => unknown): void;
  registerSABStat(name: string, offset: number, type: "u32" | "f32" | "i32"): void;
}

export interface ModuleContext {
  /**
   * Register a component name and return its ComponentId.
   * NOTE: `schema` is currently unused — the id is interned by name only
   * (no defaults/definition are registered; use `component()` from the ecs
   * barrel for a full definition). Reserved for future schema validation.
   */
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: SystemFn): void;
  /** Register a pre-built System object (with queries) to the world schedule. */
  registerSystemObject(system: System): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  /**
   * Provide a typed resource to the module graph. Other modules can
   * `inject()` it by the same token. In DOWNDRAFT_STRICT_DIAGNOSTICS mode, duplicate
   * provides of the same token throw a DiagnosticError.
   */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /**
   * Read a typed resource provided by another module. Throws if the token
   * has no provider (use `injectOptional` for safe reads).
   */
  inject<T>(token: ResourceToken<T>): T;
  /**
   * Read a typed resource, returning `undefined` if no module provides it.
   */
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void;
  onDispose(fn: () => void): void;
  /**
   * DevTools registration surface. Plugins self-register data feeds and
   * commands via `ctx.devtools.register*(...)`.
   * Works in both sim (worker) and renderer (main) plugin contexts.
   */
  readonly devtools: ModuleDevToolsAPI;
}

export interface Module {
  name: string;
  version: string;
  dependencies?: string[];
  /** Typed tokens this module provides to the graph. Validated at activation. */
  provides?: ResourceToken<unknown>[];
  /** Typed tokens this module requires from the graph. Validated at activation. */
  requires?: ResourceToken<unknown>[];
  register(ctx: ModuleContext): void;
}

