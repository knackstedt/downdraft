import type { ComponentId } from "../ecs/component.ts";
import type { Stage, SystemFn } from "../ecs/system.ts";

export interface SABChannel {
  name: string;
  buffer: SharedArrayBuffer;
}

export interface PluginContext {
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: SystemFn): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  registerResource<T>(name: string, value: T): void;
  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void;
  onDispose(fn: () => void): void;
}

export interface Plugin {
  name: string;
  version: string;
  dependencies?: string[];
  register(ctx: PluginContext): void;
}
