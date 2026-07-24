import type { World } from "../ecs/world.ts";
import type { Scene } from "./scene.ts";
import type { Camera } from "./camera.ts";
import type { Plugin } from "../plugin/plugin.ts";
import { PluginHost } from "../plugin/host.ts";
import { PrefabRegistry, PrefabFactory } from "./prefab.ts";
import { Hierarchy } from "../ecs/hierarchy.ts";
import type { Entity } from "../ecs/entity.ts";

export interface WorldResources {
  camera?: Camera;
  time: number;
  dt: number;
}

export class GameWorld {
  scene: Scene;
  world: World;
  resources: WorldResources = { time: 0, dt: 0 };
  pluginHost: PluginHost;
  prefabRegistry: PrefabRegistry;
  prefabFactory: PrefabFactory;
  hierarchy: Hierarchy;

  constructor(scene: Scene) {
    this.scene = scene;
    this.world = scene.world;
    this.hierarchy = new Hierarchy();
    this.pluginHost = new PluginHost(this.world);
    this.prefabRegistry = new PrefabRegistry();
    this.prefabFactory = new PrefabFactory(this.world, this.prefabRegistry, this.hierarchy);
  }

  usePlugin(plugin: Plugin): void {
    this.pluginHost.registerPlugin(plugin);
  }

  async loadPlugin(pluginPath: string): Promise<void> {
    await this.pluginHost.loadPlugin(pluginPath);
  }

  unloadPlugin(name: string): void {
    this.pluginHost.unloadPlugin(name);
  }

  registerPrefab(name: string, components: Map<number, unknown>, tags?: string[]): void {
    const entries = [];
    for (const [componentId, data] of components) {
      entries.push({ componentId, data: data as Record<string, unknown> });
    }
    this.prefabRegistry.register({ name, components: entries, tags });
  }

  spawnPrefab(prefabName: string, parent?: Entity): Entity {
    return this.prefabFactory.spawn(prefabName, parent);
  }

  step(dt: number): void {
    this.resources.dt = dt;
    this.resources.time += dt;
    this.world.step(dt);
  }

  dispose(): void {
    this.pluginHost.disposeAll();
  }
}
