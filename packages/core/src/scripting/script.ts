import type { World } from "../ecs/world";
import type { Stage, SystemFn } from "../ecs/system";

export interface ScriptContext {
  world: World;
  registerSystem(stage: Stage, fn: SystemFn): void;
  getInput(): unknown;
  query: (entity: unknown) => unknown;
}

export interface ScriptHandle {
  name: string;
  dispose(): void;
}

export interface ScriptModule {
  init?(ctx: ScriptContext): void;
  tick?(ctx: ScriptContext, dt: number): void;
  dispose?(ctx: ScriptContext): void;
}

export class ScriptingSystem {
  private scripts: Map<string, { module: ScriptModule; handle: ScriptHandle; ctx: ScriptContext }> = new Map();
  private world: World;

  constructor(world: World) {
    this.world = world;
  }

  async load(name: string, modulePath: string): Promise<ScriptHandle> {
    const existing = this.scripts.get(name);
    if (existing) {
      existing.handle.dispose();
    }

    const mod = await import(modulePath) as ScriptModule;
    const systems: Array<{ stage: Stage; fn: SystemFn }> = [];

    const ctx: ScriptContext = {
      world: this.world,
      registerSystem: (stage: Stage, fn: SystemFn) => {
        systems.push({ stage, fn });
        this.world.schedule.add({
          name: `script:${name}:${systems.length}`,
          stage,
          fn,
          queries: [],
        });
      },
      getInput: () => this.world.getResource("input"),
      query: (entity: unknown) => entity,
    };

    const handle: ScriptHandle = {
      name,
      dispose: () => {
        for (let i = 0; i < systems.length; i++) {
          this.world.schedule.remove(`script:${name}:${i + 1}`);
        }
        if (mod.dispose) mod.dispose(ctx);
        this.scripts.delete(name);
      },
    };

    if (mod.init) mod.init(ctx);
    this.scripts.set(name, { module: mod, handle, ctx });
    return handle;
  }

  tick(dt: number): void {
    for (const { module, ctx } of this.scripts.values()) {
      if (module.tick) module.tick(ctx, dt);
    }
  }

  async hotReload(name: string, modulePath: string): Promise<ScriptHandle> {
    return this.load(name, modulePath);
  }

  getScriptNames(): string[] {
    return [...this.scripts.keys()];
  }
}
