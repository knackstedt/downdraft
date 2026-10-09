import type { World } from "../ecs/world";
import { createLogger } from "../util/logger";
import type { Scene, SceneSetup } from "./scene";
import { Scene as SceneClass } from "./scene";

const log = createLogger();

export class SceneManager {
  private scenes: Map<string, Scene> = new Map();
  private activeScenes: Set<string> = new Set();
  private world: World;
  private _currentScene: Scene | null = null;

  constructor(world: World) {
    this.world = world;
  }

  register(scene: Scene): void {
    if (this.scenes.has(scene.name)) {
      log.warn("scene-manager", `Overwriting scene "${scene.name}"`);
    }
    this.scenes.set(scene.name, scene);
  }

  create(name: string, setup?: SceneSetup): Scene {
    const scene = new SceneClass(name, this.world, setup);
    this.register(scene);
    return scene;
  }

  unregister(name: string): void {
    const scene = this.scenes.get(name);
    if (!scene) return;
    scene.unload();
    this.scenes.delete(name);
    this.activeScenes.delete(name);
    if (this._currentScene === scene) this._currentScene = null;
  }

  get(name: string): Scene | undefined {
    return this.scenes.get(name);
  }

  has(name: string): boolean {
    return this.scenes.has(name);
  }

  list(): Scene[] {
    return [...this.scenes.values()];
  }

  listActive(): Scene[] {
    return [...this.activeScenes].map((n) => this.scenes.get(n)!).filter(Boolean);
  }

  getCurrentScene(): Scene | null {
    return this._currentScene;
  }

  // ── Single-Scene Operations ────────────────────────────────────

  async load(name: string): Promise<void> {
    const scene = this.scenes.get(name);
    if (!scene) throw new Error(`Scene "${name}" not found`);
    await scene.load();
  }

  unload(name: string): void {
    const scene = this.scenes.get(name);
    if (!scene) return;
    scene.unload();
    this.activeScenes.delete(name);
    if (this._currentScene === scene) this._currentScene = null;
  }

  activate(name: string): void {
    const scene = this.scenes.get(name);
    if (!scene) throw new Error(`Scene "${name}" not found`);
    scene.activate();
    this.activeScenes.add(name);
    this._currentScene = scene;
  }

  deactivate(name: string): void {
    const scene = this.scenes.get(name);
    if (!scene) return;
    scene.deactivate();
    this.activeScenes.delete(name);
    if (this._currentScene === scene) this._currentScene = null;
  }

  // ── Transition ─────────────────────────────────────────────────

  async transition(name: string): Promise<void> {
    const next = this.scenes.get(name);
    if (!next) throw new Error(`Scene "${name}" not found`);

    if (this._currentScene) {
      this._currentScene.deactivate();
      if (!this._currentScene.persistent) {
        this._currentScene.unload();
      }
    }

    if (!next.isLoaded()) {
      await next.load();
    }
    next.activate();
    this.activeScenes.add(name);
    this._currentScene = next;
    log.info("scene-manager", `Transitioned to "${name}"`);
  }

  // ── Additive Loading ───────────────────────────────────────────

  async loadAdditive(name: string, activate = true): Promise<void> {
    const scene = this.scenes.get(name);
    if (!scene) throw new Error(`Scene "${name}" not found`);

    if (!scene.isLoaded()) {
      await scene.load();
    }
    if (activate) {
      scene.activate();
      this.activeScenes.add(name);
      if (!this._currentScene) this._currentScene = scene;
    }
  }

  unloadAdditive(name: string): void {
    const scene = this.scenes.get(name);
    if (!scene) return;
    if (scene.persistent) return;
    scene.deactivate();
    scene.unload();
    this.activeScenes.delete(name);
    if (this._currentScene === scene) {
      const remaining = this.listActive();
      this._currentScene = remaining.length > 0 ? remaining[0] : null;
    }
  }

  // ── Bulk Operations ────────────────────────────────────────────

  unloadAll(): void {
    for (const scene of this.scenes.values()) {
      scene.unload();
    }
    this.activeScenes.clear();
    this._currentScene = null;
  }

  dispose(): void {
    this.unloadAll();
    this.scenes.clear();
  }
}
