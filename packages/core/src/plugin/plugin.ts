import type { ComponentId } from "../ecs/component";
import type { Stage, System, SystemFn } from "../ecs/system";

export interface SABChannel {
  name: string;
  buffer: SharedArrayBuffer;
}

/**
 * DevTools registration surface exposed on PluginContext.
 * Plugins call `ctx.devtools.registerPanel(...)` etc. to self-register
 * debug screens. The same interface works in both main and worker realms.
 *
 * The actual implementation is provided by @downdraft/plugin-devtools via
 * the `devtools` singleton. Core defines the interface; the host injects
 * the concrete object at construction time (see PluginHost.setDevToolsAPI).
 */
export interface PluginDevToolsAPI {
  registerPanel(ext: any): void;
  registerOverlayToggle(toggle: any): void;
  registerDataFeed(name: string, fn: () => any, writeRateHz?: number): void;
  registerCommand(name: string, fn: (...args: any[]) => any): void;
  registerSABStat(name: string, offset: number, type: "u32" | "f32" | "i32"): void;
}

export interface PluginContext {
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: SystemFn): void;
  /** Register a pre-built System object (with queries) to the world schedule. */
  registerSystemObject(system: System): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  registerResource<T>(name: string, value: T): void;
  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void;
  onDispose(fn: () => void): void;
  /**
   * DevTools registration surface. Plugins self-register debug panels,
   * data feeds, and commands via `ctx.devtools.register*(...)`.
   * Works in both sim (worker) and renderer (main) plugin contexts.
   */
  readonly devtools: PluginDevToolsAPI;
}

export interface Plugin {
  name: string;
  version: string;
  dependencies?: string[];
  register(ctx: PluginContext): void;
}
