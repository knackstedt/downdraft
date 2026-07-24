import type { World } from "../ecs/world.ts";
import type { Scene } from "./scene.ts";
import type { Camera } from "./camera.ts";

export interface WorldResources {
  camera?: Camera;
  time: number;
  dt: number;
}

export class GameWorld {
  scene: Scene;
  world: World;
  resources: WorldResources = { time: 0, dt: 0 };
  private plugins: string[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
    this.world = scene.world;
  }

  addPlugin(name: string): void {
    this.plugins.push(name);
  }

  getPlugins(): string[] {
    return this.plugins;
  }

  step(dt: number): void {
    this.resources.dt = dt;
    this.resources.time += dt;
    this.world.step(dt);
  }
}
