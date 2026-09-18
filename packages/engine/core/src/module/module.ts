import type { ComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, System, SystemFn } from "../ecs/system";

export interface SABChannel {
  name: string;
  buffer: SharedArrayBuffer;
}

/**
 * DevTools registration surface exposed on ModuleContext.
 * Plugins call `ctx.devtools.registerPanel(...)` etc. to self-register
 * debug screens. The same interface works in both main and worker realms.
 *
 * The actual implementation is provided by @downdraft/engine/modules/devtools via
 * the `devtools` singleton. Core defines the interface; the host injects
 * the concrete object at construction time (see ModuleHost.setDevToolsAPI).
 */
export interface ModuleDevToolsAPI {
  registerPanel(ext: any): void;
  registerOverlayToggle(toggle: any): void;
  registerDataFeed(name: string, fn: () => any, writeRateHz?: number): void;
  registerCommand(name: string, fn: (...args: any[]) => any): void;
  registerSABStat(name: string, offset: number, type: "u32" | "f32" | "i32"): void;
}

export interface ModuleContext {
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: SystemFn): void;
  /** Register a pre-built System object (with queries) to the world schedule. */
  registerSystemObject(system: System): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  /**
   * Provide a typed resource to the plugin graph. Other plugins can
   * `inject()` it by the same token. In DOWNDRAFT_STRICT mode, duplicate
   * provides of the same token throw a DiagnosticError.
   */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /**
   * Read a typed resource provided by another plugin. Throws if the token
   * has no provider (use `injectOptional` for safe reads).
   */
  inject<T>(token: ResourceToken<T>): T;
  /**
   * Read a typed resource, returning `undefined` if no plugin provides it.
   */
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void;
  onDispose(fn: () => void): void;
  /**
   * DevTools registration surface. Plugins self-register debug panels,
   * data feeds, and commands via `ctx.devtools.register*(...)`.
   * Works in both sim (worker) and renderer (main) plugin contexts.
   */
  readonly devtools: ModuleDevToolsAPI;
}

export interface Module {
  name: string;
  version: string;
  dependencies?: string[];
  /** Typed tokens this plugin provides to the graph. Validated at activation. */
  provides?: ResourceToken<unknown>[];
  /** Typed tokens this plugin requires from the graph. Validated at activation. */
  requires?: ResourceToken<unknown>[];
  register(ctx: ModuleContext): void;
}

