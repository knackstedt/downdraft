import type {
  GameWorld,
  Camera,
  Hierarchy,
  World,
  Scene,
  AssetManager,
  MaterialLibrary,
  Material,
  CheckpointManager,
  TelemetryCollector,
  TelemetryReporter,
  DebugDrawQueue,
  ScriptingSystem,
  SaveSystem,
  MeshBuilder,
  MeshData,
  Light,
  PhysicsRealm,
  RaycastQuery,
} from "@downdraft/core";

import {
  GameWorld as GameWorldClass,
  Scene as SceneClass,
  Camera as CameraClass,
  Hierarchy as HierarchyClass,
  AssetManager as AssetManagerClass,
  MaterialLibrary as MaterialLibraryClass,
  Material as MaterialClass,
  BlendMode,
  CullMode,
  CheckpointManager as CheckpointManagerClass,
  TelemetryCollector as TelemetryCollectorClass,
  TelemetryReporter as TelemetryReporterClass,
  DebugDrawQueue as DebugDrawQueueClass,
  ScriptingSystem as ScriptingSystemClass,
  SaveSystem as SaveSystemClass,
  MeshBuilder as MeshBuilderClass,
  LightType as LightTypeEnum,
  createDirectionalLight as createDirLight,
  createPointLight as createPtLight,
  World as WorldClass,
  getComponentId,
  getComponentName,
  ROOT_ENTITY,
  entityEqual,
  isAlive,
} from "@downdraft/core";

import type { Entity } from "@downdraft/core";
import type { RigidBodyHandle, ColliderShape, BodyType } from "@downdraft/core";

export interface EngineContextOptions {
  sceneName?: string;
  enableTelemetry?: boolean;
}

export class EngineContext {
  world: GameWorld;
  ecsWorld: World;
  scene: Scene;
  camera: Camera;
  hierarchy: Hierarchy;
  assetManager: AssetManager;
  materialLibrary: MaterialLibrary;
  checkpointManager: CheckpointManager;
  telemetryCollector: TelemetryCollector;
  telemetryReporter: TelemetryReporter;
  debugDraw: DebugDrawQueue;
  scriptingSystem: ScriptingSystem;
  saveSystem: SaveSystem;
  lights: Light[] = [];
  meshes: Map<string, MeshData> = new Map();
  entityMeshes: Map<string, string> = new Map();
  entityMaterials: Map<string, string> = new Map();
  physicsRealms: Map<string, PhysicsRealm> = new Map();
  bodyHandles: Map<string, RigidBodyHandle> = new Map();
  raycastQuery: RaycastQuery | null = null;
  debugVisualizeMode: string = "none";

  constructor(opts: EngineContextOptions = {}) {
    const ecsWorld = new WorldClass();
    this.ecsWorld = ecsWorld;
    this.scene = new SceneClass(opts.sceneName ?? "main", ecsWorld);
    this.world = new GameWorldClass(this.scene);
    this.camera = new CameraClass();
    this.hierarchy = this.world.hierarchy;
    this.assetManager = new AssetManagerClass();
    this.materialLibrary = new MaterialLibraryClass();
    this.checkpointManager = new CheckpointManagerClass();
    this.telemetryCollector = new TelemetryCollectorClass(opts.enableTelemetry ?? true);
    this.telemetryReporter = new TelemetryReporterClass(this.telemetryCollector);
    this.debugDraw = new DebugDrawQueueClass();
    this.scriptingSystem = new ScriptingSystemClass(ecsWorld);
    this.saveSystem = new SaveSystemClass();
  }

  getEntityKey(e: Entity): string {
    return `${e.index}.${e.generation}`;
  }

  parseEntityKey(key: string): Entity | null {
    const parts = key.split(".");
    if (parts.length !== 2) return null;
    const index = parseInt(parts[0], 10);
    const generation = parseInt(parts[1], 10);
    if (isNaN(index) || isNaN(generation)) return null;
    return { index, generation };
  }

  isEntityAlive(e: Entity): boolean {
    return isAlive(this.ecsWorld.entities, e);
  }

  getAllAliveEntities(): Entity[] {
    const result: Entity[] = [];
    for (let i = 0; i < this.ecsWorld.entities.length; i++) {
      const meta = this.ecsWorld.entities[i];
      if (meta.alive) {
        result.push({ index: i, generation: meta.generation });
      }
    }
    return result;
  }

  getComponentNameById(id: number): string {
    return getComponentName(id);
  }

  getComponentIdByName(name: string): number {
    return getComponentId(name);
  }

  step(dt: number): void {
    this.world.step(dt);
    this.telemetryCollector.recordFrame(dt * 1000);
  }
}

export {
  BlendMode,
  CullMode,
  LightTypeEnum as LightType,
  createDirLight as createDirectionalLight,
  createPtLight as createPointLight,
  MeshBuilderClass as MeshBuilder,
  MaterialClass as Material,
  ROOT_ENTITY,
  entityEqual,
};
