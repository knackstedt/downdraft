import type {
    AnimationPlayer,
    AssetManager,
    AudioEngine,
    AudioListenerData,
    AudioSourceData,
    Camera,
    CheckpointManager,
    DebugDrawQueue,
    GameWorld,
    Hierarchy,
    Light,
    LODConfig,
    LODGenerator,
    MaterialHotReloader,
    MaterialLibrary,
    MeshData,
    PhysicsRealm,
    RaycastQuery,
    SaveSystem,
    Scene,
    ScriptingSystem,
    TelemetryCollector,
    TelemetryReporter,
    World
} from "@downdraft/core";

import {
    AssetManager as AssetManagerClass,
    AudioListener,
    AudioSource,
    BlendMode,
    Camera as CameraClass,
    CheckpointManager as CheckpointManagerClass,
    createAudioListener,
    createAudioSource,
    createDirectionalLight as createDirLight,
    createPointLight as createPtLight,
    CullMode,
    DebugDrawQueue as DebugDrawQueueClass,
    entityEqual,
    GameWorld as GameWorldClass,
    getComponentId,
    getComponentName,
    isAlive,
    LightType as LightTypeEnum,
    LODGenerator as LODGeneratorClass,
    Material as MaterialClass,
    MaterialHotReloader as MaterialHotReloaderClass,
    MaterialLibrary as MaterialLibraryClass,
    MeshBuilder as MeshBuilderClass,
    ROOT_ENTITY,
    SaveSystem as SaveSystemClass,
    Scene as SceneClass,
    ScriptingSystem as ScriptingSystemClass,
    TelemetryCollector as TelemetryCollectorClass,
    TelemetryReporter as TelemetryReporterClass,
    World as WorldClass
} from "@downdraft/core";

import type { Entity, PhysicsBody } from "@downdraft/core";

export interface EngineContextOptions {
  sceneName?: string;
  enableTelemetry?: boolean;
}

export interface EngineContextFromGameOptions {
  ecsWorld: World;
  scene: Scene;
  gameWorld: GameWorld;
  camera: Camera;
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
  bodyHandles: Map<string, PhysicsBody> = new Map();
  raycastQuery: RaycastQuery | null = null;
  debugVisualizeMode: string = "none";
  audioEngine: AudioEngine | null = null;
  animationPlayers: Map<string, AnimationPlayer> = new Map();
  materialHotReloader: MaterialHotReloader;
  lodConfigs: Map<string, LODConfig> = new Map();
  lodGenerator: LODGenerator;
  audioSources: Map<string, AudioSourceData> = new Map();
  audioListeners: Map<string, AudioListenerData> = new Map();
  cameraFollowEntity: Entity | null = null;

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
    this.materialHotReloader = new MaterialHotReloaderClass();
    this.lodGenerator = new LODGeneratorClass();
  }

  static fromGame(opts: EngineContextFromGameOptions): EngineContext {
    const ctx = new EngineContext({
      sceneName: opts.scene.name,
      enableTelemetry: opts.enableTelemetry,
    });
    ctx.ecsWorld = opts.ecsWorld;
    ctx.scene = opts.scene;
    ctx.world = opts.gameWorld;
    ctx.camera = opts.camera;
    ctx.hierarchy = opts.gameWorld.hierarchy;
    return ctx;
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
    AudioListener, AudioSource, BlendMode, createAudioListener, createAudioSource, createDirLight as createDirectionalLight,
    createPtLight as createPointLight, CullMode, entityEqual, LightTypeEnum as LightType, LODGeneratorClass as LODGenerator, MaterialClass as Material,
    MaterialHotReloaderClass as MaterialHotReloader, MeshBuilderClass as MeshBuilder, ROOT_ENTITY
};

