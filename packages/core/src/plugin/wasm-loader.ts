import type { Plugin } from "./plugin.ts";
import { PluginRegistry } from "./registry.ts";
import { promises as fs } from "node:fs";

export interface WASMABIExports {
  register: (ctxPtr: number) => void;
  dispose: () => void;
}

export interface WASMABIImports {
  get_component: (entityIndex: number, componentId: number) => number;
  set_component: (entityIndex: number, componentId: number, dataPtr: number) => void;
  allocate_sab: (namePtr: number, size: number) => number;
  register_system: (stage: number, callbackPtr: number) => void;
  subscribe_event: (namePtr: number, callbackPtr: number) => void;
}

export class WASMPluginLoader {
  private registry: PluginRegistry;
  private instances: Map<string, WebAssembly.Instance> = new Map();

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  async load(wasmPath: string, imports: Partial<WASMABIImports>): Promise<Plugin> {
    const wasmBytes = await fs.readFile(wasmPath);
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, { env: imports });

    const name = wasmPath.split("/").pop()?.replace(".wasm", "") ?? "unknown";
    this.instances.set(name, instance);

    const plugin: Plugin = {
      name,
      version: "0.1.0",
      register: () => {
        const exports = instance.exports as unknown as WASMABIExports;
        if (exports.register) exports.register(0);
      },
    };

    this.registry.register(plugin);
    return plugin;
  }

  dispose(name: string): void {
    const instance = this.instances.get(name);
    if (instance) {
      const exports = instance.exports as unknown as WASMABIExports;
      if (exports.dispose) exports.dispose();
      this.instances.delete(name);
    }
  }
}
