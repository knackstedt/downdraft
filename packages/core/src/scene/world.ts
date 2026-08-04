import type { Entity } from "../ecs/entity";
import { Hierarchy } from "../ecs/hierarchy";
import type { World } from "../ecs/world";
import { PluginHost } from "../plugin/host";
import type { Plugin } from "../plugin/plugin";
import type { Camera } from "./camera";
import { PrefabFactory, PrefabRegistry } from "./prefab";
import { SceneManager } from "./scene-manager";
import type { Scene } from "./scene";

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
  pluginHost: PluginHost;
  prefabRegistry: PrefabRegistry;
  prefabFactory: PrefabFactory;
  hierarchy: Hierarchy;

  constructor(scene: Scene) {
    this.scene = scene;
    this.world = scene.world;
    this.sceneManager = new SceneManager(this.world);
    this.sceneManager.register(scene);
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
    this.pluginHost.disposeAll();
  }
}
