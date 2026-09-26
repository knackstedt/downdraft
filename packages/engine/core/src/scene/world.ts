import type { Entity } from "../ecs/entity";
import { Hierarchy } from "../ecs/hierarchy";
import type { World } from "../ecs/world";
import { ModuleHost } from "../module/host";
import type { Module } from "../module/module";
import type { Camera } from "./camera";
import { PrefabFactory, PrefabRegistry } from "./prefab";
import type { Scene } from "./scene";
import { SceneManager } from "./scene-manager";

export interface WorldResources {
  camera?: Camera;
  time: number;
  dt: number;
  /** Interpolation alpha (0.0–1.0) set by GameLoop for render interpolation. */
  alpha: number;
}

export class GameWorld {
  scene: Scene;
  sceneManager: SceneManager;
  world: World;
  resources: WorldResources = { time: 0, dt: 0, alpha: 0 };
  moduleHost: ModuleHost;
  prefabRegistry: PrefabRegistry;
  prefabFactory: PrefabFactory;
  hierarchy: Hierarchy;

  constructor(scene: Scene) {
    this.scene = scene;
    this.world = scene.world;
    this.sceneManager = new SceneManager(this.world);
    this.sceneManager.register(scene);
    this.hierarchy = new Hierarchy();
    this.moduleHost = new ModuleHost(this.world);
    this.prefabRegistry = new PrefabRegistry();
    this.prefabFactory = new PrefabFactory(this.world, this.prefabRegistry, this.hierarchy);
  }

  useModule(plugin: Module): void {
    this.moduleHost.registerModule(plugin);
  }

  /**
   * Register multiple plugins and activate them in dependency-resolved order.
   * Preferred over `useModule()` when registering multiple plugins with
   * interdependencies, as it activates them in topological order.
   */
  useModules(plugins: Module[]): void {
    for (let i = 0; i < plugins.length; i++) {
      this.moduleHost.registerModuleDeferred(plugins[i]);
    }
    this.moduleHost.activateAll();
  }

  async loadModule(pluginPath: string): Promise<void> {
    await this.moduleHost.loadModule(pluginPath);
  }

  unloadModule(name: string): void {
    this.moduleHost.unloadModule(name);
  }

  registerPrefab(name: string, components: Map<number, unknown>, tags?: string[]): void {
    const entries = [];
    for (const [componentId, data] of components.entries()) {
      entries.push({ componentId, data: data as Record<string, unknown> });
    }
    this.prefabRegistry.register({ name, components: entries, tags });
  }

  spawnPrefab(prefabName: string, parent?: Entity): Entity {
    return this.prefabFactory.spawn(prefabName, parent);
  }

  step(dt: number, alpha?: number): void {
    this.resources.dt = dt;
    this.resources.time += dt;
    if (alpha !== undefined) {
      this.resources.alpha = alpha;
    }
    this.world.step(dt);
  }

  dispose(): void {
    this.sceneManager.dispose();
    this.moduleHost.disposeAll();
  }
}
