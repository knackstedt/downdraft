// ============================================================================
// WebGPU Renderer — main rendering engine (thin orchestrator)
// Delegates input → RendererInputHandler, scene sync → RendererSceneSync,
// accessors → RendererAccessors
// ============================================================================

import type { TextureHandle } from "@downdraft/core";
import { BindlessFrameBindings, BindlessMaterialManager, BindlessTextureRegistry, DEPTH_FORMAT, calculateViewProjInto as engineCalculateViewProjInto, ENT, Frustum, GameRenderer, GCController, GPUProfiler, IBLSystem, InputBufferWriter, MSAA_SAMPLE_COUNT, PassType, PBRSystem, PLR, RenderPass, SimBufferReader, SkyDomePass, TerrainPass, TrackedRenderPass, UnderwaterFogPass, WaterPass, type FrameGraphBuilder, type GCControllerConfig, type GCControllerStats, type IRendererStateProvider, type RenderContext } from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { LightSystem } from "@downdraft/library-lighting";
import { loadModel, type MaterialData, type MeshData, type ModelData } from "@downdraft/library-models";
import { PostProcessStack, type EffectId } from "@downdraft/library-postfx";
import { WATER_GRID_SAB as WATER_GRID, WaterBufferReader } from "@downdraft/library-water";
import { CloudSystem, COLLISION_RADIUS, MAX_VOXEL_FLOATS, ParticleSystem, type VoxelCollisionData } from "@downdraft/library-weatherfx";
import { DebugOverlay, DebugRaycast, LabelOverlay, SceneSync, TransformGizmo, useSceneStore, type GizmoMode } from "@downdraft/module-devtools";
import { OSRManager, type CameraState as OSRCameraState, type OSRIPC } from "@downdraft/module-electron-osr";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, ISLAND_DATA, PORT_DATA } from "@shared/constants";
import { getCropByEncodedHash } from "@shared/data/crops";
import { generateIslandBlobs } from "@shared/terrain";
import { CameraMode, EntityFlags, EntityType, PortSize, WeatherType } from "@shared/types";
import { PLANT_DATA } from "@sim/farming/plant-system";
import { BoatBufferReader } from "@to-the-ocean/library-boats/boat-sab";
import { CameraSystem, type CameraState } from "./camera-system";
import { GameDebugOverlayData, GameLabelProvider, GameRaycastProvider, GameSceneSyncProvider, getRayDirection, getRayOrigin } from "./debug-providers";
import { EntityRenderer } from "./entity-renderer";
import { GameCloudMeshProvider } from "./game-cloud-provider";
import { RendererAccessors } from "./renderer-accessors";
import { RendererInputHandler } from "./renderer-input-handler";
import { TerrainMeshPool } from "./terrain-mesh-pool";

// ── Asset glob: Vite (import.meta.glob) or Bun-native (createGlob) ──
// In Vite, import.meta.glob is a compile-time feature. In Bun-native mode,
// we fall back to a filesystem-based glob.
const _glob = (import.meta as any).glob ?? ((pattern: string) => {
  // Bun-native fallback: use filesystem glob
  try {
    const { createGlob } = require("@downdraft/core/platform/glob-polyfill");
    const modDir = typeof __dirname !== "undefined" ? __dirname : (import.meta as any).dir ?? ".";
    return createGlob(modDir)(pattern, { query: "?url", eager: true });
  } catch { return {} as Record<string, string>; }
});

// Player model asset — resolved by Vite at build time
const playerModelGlob = _glob(
  "../../assets/models/CHARACTER MALE LOW POLY/*.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Rigged character model — Mixamo skeleton FBX (direct animation matching)
const riggedCharacterGlob = _glob(
  "../../assets/models/character.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Bed model asset for boat builder furniture
const bedModelGlob = _glob(
  "../../assets/models/Low Poly Furniture/Beds/Bed Single.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Mixamo animation files
const animGlobs = _glob(
  "../../assets/animations/human/mixamo/*.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

/** Lighting parameters returned by `LightingSystem.getLightingParams()`. */
interface LightingParams {
  sunDir: [number, number, number];
  sunIntensity: number;
  sunBrightness: number;
  moonDir: [number, number, number];
  moonIntensity: number;
  ambient: number;
  fogDensity: number;
  wetness: number;
  fogColor: [number, number, number];
}

export class WebGPURenderer extends GameRenderer implements IRendererStateProvider {
  private simReader: SimBufferReader | null = null;
  private waterReader: WaterBufferReader | null = null;
  private inputWriter: InputBufferWriter | null = null;
  private boatReader: BoatBufferReader | null = null;
  private boatSAB: SharedArrayBuffer | null = null;
  private boatDesigns = new Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }>();

  private waterPass: WaterPass | null = null;
  private skyDomePass: SkyDomePass | null = null;
  private terrainPass: TerrainPass | null = null;
  private entityRenderer: EntityRenderer | null = null;
  private terrainMeshPool: TerrainMeshPool | null = null;
  private cameraSystem: CameraSystem | null = null;
  private lightingSystem: LightSystem | null = null;
  private pbrSystem: PBRSystem | null = null;
  private iblSystem: IBLSystem | null = null;
  private particleSystem: ParticleSystem | null = null;
  private postProcessStack: PostProcessStack | null = null;
  /** When true, the pixi-ui overlay fully covers the canvas — skip 3D + postfx. */
  private fullyOccluded = false;
  private underwaterFogPass: UnderwaterFogPass | null = null;
  private cloudSystem: CloudSystem | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessFrameBindings: BindlessFrameBindings | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private debugOverlay: DebugOverlay | null = null;
  private debugOverlayData: GameDebugOverlayData | null = null;
  private debugRaycast: DebugRaycast | null = null;

  private osrManager: OSRManager | null = null;
  private _osrCursorResetTimer: ReturnType<typeof setTimeout> | null = null;

  private gcController: GCController | null = null;
  private _frameDrawCalls: number = 0;
  private _frameTriangles: number = 0;

  // Frame graph — single orchestration path for the per-viewport render passes.
  private graphColorHandle: TextureHandle | null = null;
  private graphDepthHandle: TextureHandle | null = null;
  private _graphCompiled = false;

  private preBakeDone: boolean = false;

  private cachedVoxelData: VoxelCollisionData | null = null;
  private cachedVoxelCamX = NaN;
  private cachedVoxelCamY = NaN;
  private cachedVoxelCamZ = NaN;
  private static readonly VOXEL_CACHE_THRESHOLD = 5.0;

  private skyPrevWeatherType: WeatherType = WeatherType.Clear;
  private skyDisplayedWeatherType: WeatherType = WeatherType.Clear;
  private skyWeatherBlend: number = 1.0;
  private skyLastTime: number = 0;
  private readonly skyWeatherTransitionDuration: number = 30.0;

  private _lastResourceStatsTime = 0;
  private static readonly RES_STATS_INTERVAL = 1000;

  onInputProcessed: (() => void) | null = null;

  private _running = false;
  /** When true, drawFrame() skips surface present (for screenshot capture). */
  public suppressPresent = false;
  /** When true, skip the IMUI overlay pass (native mode has no UI). */
  public skipUI = false;
  /**
   * Native PixiJS UI host. When set, the renderer drives PixiJS each frame
   * (host.render() submits the UI into a GPUTexture) and composites that
   * texture over the frame via the host's blit pass — no Chromium/worker.
   */
  public nativePixiUi: { render(): void; getUiTextureView(): GPUTextureView | null; blitPass: { execute(enc: GPUCommandEncoder, target: GPUTextureView, ui: GPUTextureView): void } } | null = null;
  /** Callback invoked during drawFrame() to encode a screenshot copy before submit. */
  public screenshotCallback: ((encoder: GPUCommandEncoder) => void) | null = null;
  private rafHandle = 0;
  private _lastTime = 0;
  /** FPS limit for test mode (0 = unlimited, uses rAF). When > 0, uses setTimeout. */
  private targetFPS = 0;
  private renderTimer = 0;
  private _frameCount = 0;
  private _fpsTimer = 0;
  private lastDebugLog = 0;
  private _elapsedTime = 0;

  private wakeArray = new Float32Array(16 * 6);
  private shoreArray = new Float32Array(128 * 4);

  private pooledViewportPlayerPos = { x: 0, y: 0, z: 0 };
  private pooledFreecamPlayerPos = { x: 0, y: 0, z: 0 };
  private pooledEntPos = { x: 0, y: 0, z: 0 };
  private pooledCullCenter = new Float32Array(3);
  private pooledEntRot = { x: 0, y: 0, z: 0, w: 1 };
  private pooledShipPos = { x: 0, y: 0, z: 0 };
  private pooledShipRot = { x: 0, y: 0, z: 0, w: 1 };
  private pooledDrawEntityCount: number[] = [];
  private pooledPrevPlayerPos: { x: number; y: number; z: number }[] = [];
  private pooledTerrainCameraPos: [number, number, number] = [0, 0, 0];
  private pooledSkyUniforms: {
    viewProj: Float32Array;
    cameraPos: [number, number, number];
    timeOfDay: number;
    weatherType: number;
    sunDir: [number, number, number];
    sunIntensity: number;
    moonDir: [number, number, number];
    moonIntensity: number;
    time: number;
    prevWeatherType: number;
    weatherBlend: number;
  } = {
    viewProj: new Float32Array(16),
    cameraPos: [0, 0, 0],
    timeOfDay: 0,
    weatherType: 0,
    sunDir: [0, 0, 0],
    sunIntensity: 0,
    moonDir: [0, 0, 0],
    moonIntensity: 0,
    time: 0,
    prevWeatherType: 0,
    weatherBlend: 0,
  };
  private pooledDummyCamPos: [number, number, number] = [0, 10, 0];
  private pooledDummyCamTarget: [number, number, number] = [0, 10, -1];
  private pooledDummyCamera: CameraState = {
    position: this.pooledDummyCamPos,
    target: this.pooledDummyCamTarget,
    up: [0, 1, 0],
    fov: 60,
    near: 0.1,
    far: 4096,
    aspect: 1,
  };

  private _targetFrameTime = 0;
  private _rafInterval = 0;
  private _rafSum = 0;
  private _rafCount = 0;
  private _lastRafTime = 0;
  private _frameAccum = 0;
  private _limiterActive = false;

  private inputHandler: RendererInputHandler;
  private sceneSync: SceneSync;
  private accessors: RendererAccessors;

  private _deviceLost = false;
  private lastInvalidLog = 0;
  private simWasValid = false;
  private lastSimSequence = 0;
  private frustum = new Frustum();

  private _depthTextures = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  private cachedSurfaceView: GPUTextureView | null = null;
  private cachedSurfaceFrame = -1;
  private surfaceFrameCounter = 0;
  private pooledViewProj = new Float32Array(16);
  private boatEntityIdToSlot = new Map<number, number>();

  constructor(canvas: HTMLCanvasElement) {
    super(canvas, { mode: "3d", enableProfilingOverlay: true });
    this.inputHandler = new RendererInputHandler(canvas);
    this.sceneSync = new SceneSync();
    this.accessors = new RendererAccessors();
  }

  onResize(cssWidth: number, cssHeight: number, dpr: number): void {
    super.onResize(cssWidth, cssHeight, dpr);
    // Destroy stale depth textures so the cache doesn't leak VRAM on resize.
    for (const entry of this._depthTextures.values()) { entry.texture.destroy(); }
    this._depthTextures.clear();
    this.cachedSurfaceView = null;
    this.updateAccessorReferences();
  }

  handleDprChange(scaleFactor: number): void {
    // Trigger a resize with the new DPR — GameRenderer's onResize will update
    // canvas dimensions and viewport layout.
    const canvas = this.getCanvas();
    this.onResize(canvas.clientWidth, canvas.clientHeight, scaleFactor);
  }

  async init(): Promise<boolean> {
    const ok = await super.init();
    if (!ok) return false;

    try {
      const device = this.getDevice()!;
      const format = this.getFormat();
      const canvas = this.getCanvas();

      // Track device loss for our own render loop (GameRenderer also handles
      // this and reloads the page, but we need to stop rendering immediately).
      device.lost.then(() => { this._deviceLost = true; });

      this.waterPass = new WaterPass(device, format, DEPTH_FORMAT as GPUTextureFormat, MSAA_SAMPLE_COUNT);
      this.skyDomePass = new SkyDomePass(device, format, 1);
      this.terrainPass = new TerrainPass(device, format, 1);
      this.entityRenderer = new EntityRenderer(device, format);
      this.cameraSystem = new CameraSystem();
      this.lightingSystem = new LightSystem(device);
      this.particleSystem = new ParticleSystem(device, format);

      this.waterPass.prepare(device);
      this.skyDomePass.prepare(device);
      this.terrainPass.prepare(device);
      this.lightingSystem.init();
      this.pbrSystem = new PBRSystem(device);
      this.pbrSystem.init();
      this.iblSystem = new IBLSystem(device, { faceSize: 256, recaptureInterval: 120 });
      this.iblSystem.setBRDFLUT(this.pbrSystem.brdfLUT!);
      this.iblSystem.init();

      // Bindless material binding model — shared texture array registry +
      // material SSBO + one bind group set once per frame. Must be created
      // before entityRenderer.init() so the bindless bind group layout can be
      // included in the entity pipeline layouts (@group(3)).
      this.bindlessRegistry = new BindlessTextureRegistry(device);
      this.bindlessMaterialManager = new BindlessMaterialManager(device);
      this.bindlessFrameBindings = new BindlessFrameBindings(
        device,
        this.bindlessRegistry,
        this.bindlessMaterialManager,
      );

      await this.entityRenderer.init(
        this.lightingSystem.getLightBindGroupLayout() ?? undefined,
        this.iblSystem.getBindGroupLayout() ?? undefined,
        this.bindlessFrameBindings.getBindGroupLayout(),
      );
      this.entityRenderer.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.entityRenderer.setPBRBindGroup(this.iblSystem.getBindGroup() ?? this.pbrSystem.getBindGroup()!);
      // Wire bindless deps into the entity renderer so sub-renderers (e.g.
      // PlayerMeshRenderer) can register textures/materials and sample via @group(3).
      this.entityRenderer.setBindlessDeps(
        this.bindlessRegistry,
        this.bindlessMaterialManager,
        this.bindlessFrameBindings?.getBindGroup() ?? null,
      );

      // Initialize terrain mesh worker pool for offloading CPU-heavy mesh generation
      this.terrainMeshPool = new TerrainMeshPool();
      await this.terrainMeshPool.init();
      this.entityRenderer.setTerrainMeshPool(this.terrainMeshPool);
      this.waterPass.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.lightingSystem.initDebugGizmos(format);

      // UI system, telemetry, profiling overlay, and GPU profiler are managed
      // by GameRenderer (super.init()). Wire the inherited UI input router
      // into the game's input handler.
      this.gcController = new GCController("renderer");

      if (this.boatReader) {
        this.entityRenderer.setBoatBufferReader(this.boatReader);
      }

      const riggedCharacterUrl = Object.values(riggedCharacterGlob)[0];
      const playerModelUrl = Object.values(playerModelGlob)[0];

      {
        const texSize = 4;
        const canvas = document.createElement("canvas");
        canvas.width = texSize;
        canvas.height = texSize;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#cccccc";
        ctx.fillRect(0, 0, texSize, texSize);
        const imageBitmap = await createImageBitmap(canvas);
        this.entityRenderer.setPlayerTexture(imageBitmap);
      }

      let riggedLoaded = false;
      if (riggedCharacterUrl) {
        try {
          const resp = await fetch(riggedCharacterUrl);
          const buffer = await resp.arrayBuffer();
          const modelData = await loadModel(buffer, "character.fbx") as ModelData;
          if (modelData.meshes.length > 0 && modelData.skin) {
            this.entityRenderer.setSkinnedPlayerMesh(modelData);
            console.log("[WebGPU] Rigged player model loaded:", modelData.meshes.length, "meshes,", modelData.skin.bones.length, "bones");
            riggedLoaded = true;
          } else if (modelData.meshes.length > 0) {
            console.warn("[WebGPU] character.fbx has no skin data, falling back to static mesh");
          } else {
            console.warn("[WebGPU] character.fbx has no meshes");
          }
        } catch (e) {
          console.warn("[WebGPU] Failed to load rigged character model:", e);
        }
      }

      if (riggedLoaded) {
        const animator = this.entityRenderer.getSkeletonAnimator();
        if (animator) {
          const fileToState: Record<string, string> = {
            "x bot@idle": "Idle",
            "x bot@walking": "Walk",
            "x bot@fast run": "Run",
            "x bot@swimming": "Swim",
          };
          let loadedCount = 0;
          for (const [path, url] of Object.entries(animGlobs)) {
            const filename = path.split("/").pop()!.replace(/\.fbx$/i, "").toLowerCase();
            const stateName = fileToState[filename];
            if (!stateName) continue;
            try {
              const resp = await fetch(url);
              const buffer = await resp.arrayBuffer();
              const animData = await loadModel(buffer, filename + ".fbx") as ModelData;
              if (animData.animations && animData.animations.length > 0) {
                animator.registerRetargetedAnimations(animData.animations, stateName);
                loadedCount++;
                console.log(`[WebGPU] Animation loaded: ${stateName} (${animData.animations[0].channels.length} channels, ${animData.animations[0].duration.toFixed(2)}s)`);
              }
            } catch (e) {
              console.warn(`[WebGPU] Failed to load animation ${filename}:`, e);
            }
          }
          if (loadedCount === 0) {
            console.warn("[WebGPU] No Mixamo animations loaded");
          }
        }
      }

      if (!riggedLoaded && playerModelUrl) {
        try {
          const resp = await fetch(playerModelUrl);
          const buffer = await resp.arrayBuffer();
          const modelData = await loadModel(buffer, "player.fbx");
          if (modelData.meshes.length > 0) {
            this.entityRenderer.setPlayerMesh(modelData.meshes);
            console.log("[WebGPU] Static player model loaded:", modelData.meshes.length, "meshes");
          } else {
            console.warn("[WebGPU] Player model has no meshes");
          }
        } catch (e) {
          console.warn("[WebGPU] Failed to load static player model:", e);
        }
      }

      const bedModelUrl = Object.values(bedModelGlob)[0];
      if (bedModelUrl) {
        try {
          const resp = await fetch(bedModelUrl);
          const buffer = await resp.arrayBuffer();
          const modelData = await loadModel(buffer, "Bed Single.fbx");
          if (modelData.meshes.length > 0) {
            this.entityRenderer.setBedMesh(modelData.meshes);
            console.log("[WebGPU] Bed model loaded:", modelData.meshes.length, "meshes");
          } else {
            console.warn("[WebGPU] Bed model has no meshes");
          }
        } catch (e) {
          console.warn("[WebGPU] Failed to load bed model:", e);
        }
      } else {
        console.warn("[WebGPU] Bed model FBX not found in assets");
      }

      await this.particleSystem.init();

      this.postProcessStack = new PostProcessStack(device, format, { depthFormat: DEPTH_FORMAT });
      this.postProcessStack.init();

      this.underwaterFogPass = new UnderwaterFogPass(device, format);
      this.underwaterFogPass.prepare(device);

      this.cloudSystem = new CloudSystem(device, format, new GameCloudMeshProvider());
      await this.cloudSystem.init();

      this.modelRenderer = new ModelRenderer(device, format);
      this.modelRenderer.setBindlessDeps({
        registry: this.bindlessRegistry,
        materialManager: this.bindlessMaterialManager,
        bindGroupLayout: this.bindlessFrameBindings.getBindGroupLayout(),
      });
      await this.modelRenderer.init();

      this.transformGizmo = new TransformGizmo(device, format);
      await this.transformGizmo.init();

      this.labelOverlay = new LabelOverlay(canvas);
      this.debugOverlay = new DebugOverlay(canvas);
      this.debugRaycast = new DebugRaycast(device, format);
      this.debugRaycast.init();

      this.transformGizmo.onTransformUpdate = (transform) => {
        const selectedId = useSceneStore.getState().selectedId;
        if (!selectedId) return;
        useSceneStore.getState().updateNodeTransform(selectedId, transform);
      };

      // Update module references
      this.inputHandler.setCameraSystem(this.cameraSystem);
      this.inputHandler.setUIInputRouter(this.uiInputRouter!);
      this.sceneSync.setTransformGizmo(this.transformGizmo);
      this.updateAccessorReferences();

      console.log("[WebGPU] Renderer initialized");
      return true;
    } catch (err) {
      console.error("[WebGPU] Init failed:", err);
      return false;
    }
  }

  private updateAccessorReferences(): void {
    this.accessors.setReferences({
      simReader: this.simReader,
      waterReader: this.waterReader,
      entityRenderer: this.entityRenderer,
      uiRoot: this.uiRoot,
      uiInputRouter: this.uiInputRouter,
      telemetryCollector: this.telemetryCollector,
      gpuProfiler: this.gpuProfiler,
      gpuResourceTracker: this.gpuResourceTracker,
      postProcessStack: this.postProcessStack,
      boatReader: this.boatReader,
      canvas: this.getCanvas(),
      viewports: this.getViewports(),
      debugRaycast: this.debugRaycast,
      debugOverlay: this.debugOverlay,
      profilingOverlay: this.profilingOverlay,
      particleSystem: this.particleSystem,
      cameraSystem: this.cameraSystem,
      modelRenderer: this.modelRenderer,
      transformGizmo: this.transformGizmo,
      lightingSystem: this.lightingSystem,
      pbrSystem: this.pbrSystem,
      uiRenderer: this.uiRenderer,
      uiLayoutEngine: this.uiLayoutEngine,
    });
  }

  setBuffers(simBuffer: SharedArrayBuffer, waterBuffer: SharedArrayBuffer, inputBuffer: SharedArrayBuffer, boatBuffer?: SharedArrayBuffer): void {
    this.simReader = new SimBufferReader(simBuffer);
    this.waterReader = new WaterBufferReader(waterBuffer);
    this.inputWriter = new InputBufferWriter(inputBuffer);
    this.inputWriter.init();
    if (boatBuffer) {
      this.boatSAB = boatBuffer;
      this.boatReader = new BoatBufferReader(boatBuffer);
      this.entityRenderer?.setBoatBufferReader(this.boatReader);
    }
    this.inputHandler.setBuffers(this.inputWriter, this.simReader);
    this.sceneSync.setProvider(new GameSceneSyncProvider(this.simReader));
    // Set up debug overlay providers with game-specific data
    if (this.debugOverlay) {
      this.debugOverlayData = new GameDebugOverlayData(this.simReader);
    }
    if (this.debugRaycast) {
      this.debugRaycast.setProvider(new GameRaycastProvider(this.simReader, this.boatReader));
    }
    if (this.labelOverlay) {
      this.labelOverlay.setProvider(new GameLabelProvider(this.simReader));
    }
    this.updateAccessorReferences();
  }

  setBoatBuffer(boatBuffer: SharedArrayBuffer): void {
    this.boatSAB = boatBuffer;
    this.boatReader = new BoatBufferReader(boatBuffer);
    this.entityRenderer?.setBoatBufferReader(this.boatReader);
    this.updateAccessorReferences();
  }

  setBoatDesign(entityId: number, designJson: string): void {
    try {
      const design = JSON.parse(designJson) as BoatDesign;
      this.boatDesigns.set(entityId, { design, geometry: new RuntimeBoatGeometry(design) });
      this.entityRenderer?.setBoatDesignReader?.(this.boatDesigns);
    } catch (e) {
      console.error("[WebGPU] Failed to parse boat design JSON", e);
    }
  }

  removeBoatDesign(entityId: number): void {
    this.boatDesigns.delete(entityId);
    this.entityRenderer?.setBoatDesignReader?.(this.boatDesigns);
  }

  getBoatDesigns(): Map<number, { design: BoatDesign; geometry: RuntimeBoatGeometry }> {
    return this.boatDesigns;
  }

  setViewportCount(count: number): void {
    super.setViewportCount(count);
    this.updateAccessorReferences();
  }

  start(): void {
    this._running = true;
    this._lastTime = performance.now();
    this.scheduleRaf();
  }

  stop(): void {
    this._running = false;
    this.cancelRafLoop();
  }

  /** Set a target FPS limit for test mode. 0 = unlimited (uses rAF). */
  setTargetFPS(fps: number): void {
    this.targetFPS = Math.max(0, fps);
    if (this._running) {
      this.cancelRafLoop();
      this.scheduleRaf();
    }
  }

  private scheduleRaf(): void {
    if (this.targetFPS > 0) {
      if (this.renderTimer) return;
      const interval = 1000 / this.targetFPS;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = 0;
        this.rafHandle = requestAnimationFrame(this.frameLoop);
      }, interval) as unknown as number;
    } else {
      if (this.rafHandle) return;
      this.rafHandle = requestAnimationFrame(this.frameLoop);
    }
  }

  private cancelRafLoop(): void {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = 0;
    }
  }

  /** Render a single frame on demand. Used in test/headless mode where the
   *  continuous render loop is paused to save CPU. */
  renderOneFrame(): void {
    if (!this.getDevice()) return;
    try {
      this.drawFrame();
    } catch (err) {
      console.error(`[RENDERER] renderOneFrame error: ${(err as Error).message}`);
    }
  }

  /** Whether the continuous render loop is currently running. */
  isRunning(): boolean {
    return this._running;
  }

  setFrameRateLimit(refreshRate: number): void {
    if (refreshRate > 0) {
      this._targetFrameTime = 1000 / refreshRate;
      this.updateLimiter();
    } else {
      this._targetFrameTime = 0;
      this._limiterActive = false;
    }
  }

  private updateLimiter(): void {
    if (this._targetFrameTime <= 0 || this._rafInterval <= 0) {
      this._limiterActive = false;
      return;
    }
    this._limiterActive = this._rafInterval < this._targetFrameTime * 0.85;
    this._frameAccum = 0;
  }

  private frameLoop = (): void => {
    this.rafHandle = 0;
    if (!this._running) return;
    if (!this.getDevice()) {
      this.scheduleRaf();
      return;
    }

    const rafNow = performance.now();
    if (this._lastRafTime > 0) {
      this._rafSum += rafNow - this._lastRafTime;
      this._rafCount++;
      if (this._rafCount >= 60) {
        this._rafInterval = this._rafSum / this._rafCount;
        this._rafSum = 0;
        this._rafCount = 0;
        this.updateLimiter();
      }
    }
    this._lastRafTime = rafNow;

    if (this._deviceLost) return;

    try {
      this.drawFrame();
    } catch (err) {
      console.error(`[RENDERER] Render loop error: ${(err as Error).message}\n${(err as Error).stack}`);
      const dev = this.getDevice();
      if (dev?.lost) {
        dev.lost.then((info: GPUDeviceLostInfo) => {
          this._deviceLost = true;
          console.error(`[RENDERER] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        });
      }
      this.scheduleRaf();
    }
  };

  private drawFrame(): void {
    const now = performance.now();
    if (this._limiterActive && this._targetFrameTime > 0) {
      this._frameAccum += this._rafInterval / this._targetFrameTime;
      if (this._frameAccum < 1) {
        // Idle frame — offer headroom to GC controller for proactive collection
        if (this.gcController) {
          const headroom = this._targetFrameTime - (performance.now() - now);
          this.gcController.maybeCollect(Math.max(0, headroom), this._targetFrameTime);
        }
        this.scheduleRaf();
        return;
      }
      this._frameAccum -= 1;
    }
    const dt = Math.min(0.1, (now - this._lastTime) / 1000);
    this._lastTime = now;
    this._elapsedTime += dt;
    this._frameCount++;
    this.surfaceFrameCounter++;
    this._fpsTimer += dt;
    if (this._fpsTimer >= 1) { this.accessors.fps = this._frameCount; this._frameCount = 0; this._fpsTimer = 0; }
    if (this.profilingOverlay) { this.profilingOverlay.update(dt); }
    if (this.cameraSystem && this.simReader && this.simReader.isValid()) {
      const ps0 = this.simReader.getPlayerSlot(0);
      if (ps0) {
        const camMode = ps0.u32[PLR.CAMERA_MODE] as CameraMode;
        const hdg = ps0.f32[PLR.HEADING];
        const pch = ps0.f32[PLR.PITCH] ?? 0;
        if (camMode === CameraMode.FreeCam) {
          const pp = this.pooledFreecamPlayerPos;
          pp.x = ps0.f32[PLR.POS_X]; pp.y = ps0.f32[PLR.POS_Y]; pp.z = ps0.f32[PLR.POS_Z];
          if (this.inputHandler.prevCameraMode !== CameraMode.FreeCam) { this.cameraSystem.resetFreecam(pp, hdg, pch); }
          this.inputHandler.prevCameraMode = camMode;
          this.cameraSystem.updateFreecam(this.inputHandler.keysDown, this.inputHandler.mouseDelta, dt, pp, hdg, pch);
        } else {
          if (this.inputHandler.prevCameraMode === CameraMode.FreeCam) { this.cameraSystem.clearFreecam(); this.cameraSystem.resetLook(hdg, pch); }
          else if (this.inputHandler.prevCameraMode !== camMode) { this.cameraSystem.resetLook(hdg, pch); }
          this.inputHandler.prevCameraMode = camMode;
          this.cameraSystem.updateLook(this.inputHandler.mouseDelta, this.simReader.getTick(), hdg, pch, camMode);
        }
      }
    }
    this.inputHandler.processInput(this.getViewportCount());
    this.onInputProcessed?.();

    const device = this.getDevice()!;
    const context = this.getContext()!;
    const canvas = this.getCanvas();
    const commandEncoder = device.createCommandEncoder();

    if (this.particleSystem && this.simReader && this.simReader.isValid()) {
      const wt = this.simReader.getWeatherType() as WeatherType;
      if (wt === WeatherType.Rain || wt === WeatherType.Storm || wt === WeatherType.HellStorm || wt === WeatherType.Snow) {
        const ws = this.simReader.getWindSpeed();
        const wd = this.simReader.getWindDir();
        const ps0 = this.simReader.getPlayerSlot(0);
        const cp = this.pooledDummyCamPos;
        if (ps0) { cp[0] = ps0.f32[PLR.POS_X]; cp[1] = ps0.f32[PLR.POS_Y]; cp[2] = ps0.f32[PLR.POS_Z]; }
        else { cp[0] = 0; cp[1] = 10; cp[2] = 0; }
        const dc = this.pooledDummyCamera;
        dc.target[0] = cp[0]; dc.target[1] = cp[1]; dc.target[2] = cp[2] - 1; dc.aspect = canvas.width / canvas.height;
        let vd: VoxelCollisionData | null = null;
        if (this.entityRenderer) {
          const dx = cp[0] - this.cachedVoxelCamX;
          const dy = cp[1] - this.cachedVoxelCamY;
          const dz = cp[2] - this.cachedVoxelCamZ;
          if (this.cachedVoxelData && (dx * dx + dy * dy + dz * dz) < WebGPURenderer.VOXEL_CACHE_THRESHOLD * WebGPURenderer.VOXEL_CACHE_THRESHOLD) {
            vd = this.cachedVoxelData;
          } else {
            const raw = this.entityRenderer.getNearbyVoxelData(cp[0], cp[1], cp[2], COLLISION_RADIUS, MAX_VOXEL_FLOATS);
            if (raw) {
              vd = { data: raw.data, originX: raw.originX, originY: raw.originY, originZ: raw.originZ, voxelSize: raw.voxelSize, dimX: raw.dimX, dimY: raw.dimY, dimZ: raw.dimZ, isoLevel: raw.isoLevel };
              this.cachedVoxelData = vd;
              this.cachedVoxelCamX = cp[0]; this.cachedVoxelCamY = cp[1]; this.cachedVoxelCamZ = cp[2];
            } else {
              this.cachedVoxelData = null;
            }
          }
        }
        this.particleSystem.tick(commandEncoder, dt, dc, wt, wd.x * ws, wd.z * ws, vd);
      }
    }
    const usePP = this.postProcessStack?.hasEnabledEffects() ?? false;
    const vpCount = this.getViewportCount();
    if (this.fullyOccluded) {
      // The pixi-ui overlay fully covers the canvas — skip the entire 3D
      // pipeline + postfx. Just clear the canvas to black (the overlay
      // composites on top, so the clear color is never seen).
      const cv = context.getCurrentTexture().createView();
      const clearPass = commandEncoder.beginRenderPass({
        colorAttachments: [{ view: cv, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp }],
      });
      clearPass.end();
    } else if (usePP) {
      this.postProcessStack!.ensureTargets(canvas.width, canvas.height);
      for (let v = 0; v < vpCount; v++) { this.drawViewport(v, dt, "postprocess", commandEncoder); }
      const cv = context.getCurrentTexture().createView();
      this.postProcessStack!.applyChain(commandEncoder, this.postProcessStack!.getSceneDepthView(), cv, canvas.width, canvas.height);
    } else {
      for (let v = 0; v < vpCount; v++) { this.drawViewport(v, dt, "none", commandEncoder); }
    }
    if (this.uiRenderer && this.uiRoot && !this.skipUI && !this.nativePixiUi) {
      if (this.accessors.uiNeedsLayout && this.uiLayoutEngine) { this.uiLayoutEngine.layout(this.uiRoot); this.accessors.uiNeedsLayout = false; }
      const ds = this.uiRoot.getDrawable();
      if (ds.length > 0) {
        const cv = context.getCurrentTexture().createView();
        const up = commandEncoder.beginRenderPass({ colorAttachments: [{ view: cv, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "load" as GPULoadOp, storeOp: "store" as GPUStoreOp }] });
        this.uiRenderer.render({ device, pass: new TrackedRenderPass(up) } as unknown as RenderContext, ds);
        up.end();
      }
    }
    // ── Native PixiJS UI compositing ──
    // Drive PixiJS to render the UI into its GPUTexture (this submits PixiJS's
    // own command encoder to the shared queue), then blit that texture over
    // the frame. The write is ordered before the read on the shared queue.
    if (this.nativePixiUi) {
      this.nativePixiUi.render();
      const uiView = this.nativePixiUi.getUiTextureView();
      if (uiView) {
        const cv = context.getCurrentTexture().createView();
        this.nativePixiUi.blitPass.execute(commandEncoder, cv, uiView);
      }
    }
    if (this.gpuProfiler) {
      this.gpuProfiler.resolveGpuTimers(commandEncoder);
    }
    // If a screenshot capture callback is set, encode the copy before submit
    if (this.screenshotCallback) {
      this.screenshotCallback(commandEncoder);
      this.screenshotCallback = null;
    }
    device.queue.submit([commandEncoder.finish()]);
    // Present the surface (native wgpu requires explicit presentation;
    // in browsers this is automatic at the end of the frame).
    // Skip if suppressPresent is set (e.g. for screenshot capture).
    if (!this.suppressPresent) {
      const ctx = this.getContext();
      if (ctx && (ctx as any).present) (ctx as any).present();
    }
    this.iblSystem?.endFrame();
    if (this.gpuProfiler) { this.gpuProfiler.readGpuTimers().then(() => {}).catch(() => {}); }
    if (this.telemetryCollector) {
      this.telemetryCollector.recordFrame(dt * 1000);
      this.telemetryCollector.recordDrawStats(this._frameDrawCalls, this._frameTriangles);
      this.telemetryCollector.recordGraphSample(dt * 1000);
      if (this.gpuProfiler) { for (const t of this.gpuProfiler.getPassTimings()) { this.telemetryCollector.recordPassTiming(t); } }
      if (this.gpuResourceTracker && now - this._lastResourceStatsTime > WebGPURenderer.RES_STATS_INTERVAL) {
        this._lastResourceStatsTime = now;
        const rs = this.gpuResourceTracker.getStats();
        this.telemetryCollector.recordResourceStats({ textureCount: rs.textureCount, bufferCount: rs.bufferCount, totalBytes: rs.totalBytes, textureBytes: rs.textureBytes, bufferBytes: rs.bufferBytes, resources: rs.resources.map(r => ({ id: r.id, type: r.type, label: r.label, size: r.size, callsite: r.callsite, width: r.width, height: r.height, format: r.format })) });
      }
      this._frameDrawCalls = 0; this._frameTriangles = 0;
    }
    this.scheduleRaf();
  }

  private drawViewport(viewportIdx: number, dt: number, offscreenMode: "none" | "postprocess" = "none", encoder: GPUCommandEncoder): void {
    if (!this.simReader) return;
    if (!this.getDevice()) return;
    if (!this.simReader.isValid()) {
      if (this.simWasValid && viewportIdx === 0 && performance.now() - (this.lastInvalidLog ?? 0) > 2000) { this.lastInvalidLog = performance.now(); console.warn("[RENDERER] Sim buffer invalid — not rendering."); }
      return;
    }
    this.simWasValid = true;
    const origViewport = this.getViewports()[viewportIdx];
    if (!origViewport) return;
    const useOffscreen = offscreenMode !== "none";
    const viewport = origViewport;
    const playerSlot = this.simReader.getPlayerSlot(viewportIdx);
    if (!playerSlot) {
      if (this.accessors.debugMode && performance.now() - (this.lastDebugLog ?? 0) > 1000) { console.log("[Render] No player slot for viewport", viewportIdx); this.lastDebugLog = performance.now(); }
      return;
    }
    const pf32 = playerSlot.f32; const pu32 = playerSlot.u32;
    const playerPos = this.pooledViewportPlayerPos;
    playerPos.x = Number.isFinite(pf32[PLR.POS_X]) ? pf32[PLR.POS_X] : 0;
    playerPos.y = Number.isFinite(pf32[PLR.POS_Y]) ? pf32[PLR.POS_Y] : 0;
    playerPos.z = Number.isFinite(pf32[PLR.POS_Z]) ? pf32[PLR.POS_Z] : 0;
    const heading = Number.isFinite(pf32[PLR.HEADING]) ? pf32[PLR.HEADING] : 0;
    const pitch = Number.isFinite(pf32[PLR.PITCH] ?? NaN) ? pf32[PLR.PITCH] : 0;
    const cameraMode = pu32[PLR.CAMERA_MODE] as CameraMode;
    if (this.cameraSystem) { this.cameraSystem.setThirdPersonDistance(pf32[PLR.THIRD_PERSON_DISTANCE] ?? 12); }
    if (cameraMode === CameraMode.ThirdPerson && this.cameraSystem) {
      const zs = 100 * dt;
      if (this.inputHandler.keysDown.has(187)) { this.cameraSystem.setThirdPersonDistance(this.cameraSystem.getThirdPersonDistance() - zs); }
      if (this.inputHandler.keysDown.has(189)) { this.cameraSystem.setThirdPersonDistance(this.cameraSystem.getThirdPersonDistance() + zs); }
    }
    const aspect = viewport.w / viewport.h;
    const camera = this.cameraSystem!.calculateCamera(playerPos, heading, pitch, cameraMode, viewportIdx, dt, aspect);
    if (this.debugRaycast && cameraMode !== CameraMode.FirstPerson && this.simReader) {
      const rayOrigin = getRayOrigin(this.simReader);
      if (rayOrigin) {
        const rayDir = getRayDirection(this.cameraSystem!.getLookHeading(), this.cameraSystem!.getLookPitch());
        this.debugRaycast.update(camera, rayOrigin, rayDir);
      }
    }
    if (this.accessors.debugMode && performance.now() - (this.lastDebugLog ?? 0) > 1000) {
      // console.log(`[Render] tick=${this.simReader.getTick()} ents=${this.simReader.getEntityCount()} players=${this.simReader.getPlayerCount()} pos=(${playerPos.x.toFixed(1)},${playerPos.y.toFixed(1)},${playerPos.z.toFixed(1)}) camMode=${cameraMode}`);
      this.lastDebugLog = performance.now();
    }
    const weatherType = this.simReader.getWeatherType() as WeatherType;
    const timeOfDay = this.simReader.getTimeOfDay();
    const visibility = this.simReader.getVisibility();
    const windSpeed = this.simReader.getWindSpeed();
    const windDir = this.simReader.getWindDir();
    const weatherIntensity = this.simReader.getWeatherIntensity();
    if (viewportIdx === 0) { this.lightingSystem!.updateWeatherBlend(weatherType, dt); }
    const entityCount = this.simReader.getEntityCount();
    const playerId = pu32[PLR.ENTITY_ID];
    const lp = this.lightingSystem!.getLightingParams(timeOfDay, weatherType, visibility);
    this.entityRenderer!.beginFrame(camera, viewport.w, viewport.h, { sunDir: lp.sunDir, sunIntensity: lp.sunBrightness, ambient: lp.ambient, fogColor: lp.fogColor, wetness: lp.wetness });
    // Refresh the bindless bind group for the entity renderer each frame.
    // This must happen AFTER beginFrame so the player-mesh-renderer gets the
    // fresh bind group (beginFrame reads ctx.bindlessBindGroup which is updated here).
    if (this.bindlessFrameBindings) {
      const bg = this.bindlessFrameBindings.prepareFrame();
      this.entityRenderer!.setBindlessDeps(
        this.bindlessRegistry,
        this.bindlessMaterialManager,
        bg,
      );
      // Re-push the fresh bind group to the player-mesh-renderer.
      this.entityRenderer!.pushBindlessBindGroup(bg);
    }
    this.lightingSystem!.beginFrame();
    // Compute view-projection matrix once per viewport
    const viewProj = this.pooledViewProj;
    engineCalculateViewProjInto(camera, viewProj);
    // Extract frustum planes for entity culling (computed once per viewport)
    this.frustum.extractFromViewProj(viewProj);
    // Build boat entityId→slot map once per viewport for O(1) lookups
    const boatMap = this.boatEntityIdToSlot;
    boatMap.clear();
    if (this.boatReader && this.boatReader.isValid()) {
      const bc = this.boatReader.getBoatCount();
      for (let bs = 0; bs < bc; bs++) { boatMap.set(this.boatReader.getBoatEntityId(bs), bs); }
    }
    if (this.accessors.flashlightOn) {
      const ld: [number, number, number] = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]];
      const ll = Math.sqrt(ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2);
      if (ll > 0.001) { this.lightingSystem!.addSpotLight([camera.position[0], camera.position[1], camera.position[2]], [ld[0] / ll, ld[1] / ll, ld[2] / ll], [1.0, 0.95, 0.8], 1.5, 25.0, Math.cos(Math.PI / 10), Math.cos(Math.PI / 8)); }
    }
    const animator = this.entityRenderer!.getSkeletonAnimator();
    if (animator) {
      const pf = pu32[PLR.FLAGS] ?? 0;
      const pp = this.pooledPrevPlayerPos[viewportIdx] ?? (this.pooledPrevPlayerPos[viewportIdx] = { x: playerPos.x, y: playerPos.y, z: playerPos.z });
      const vx = (playerPos.x - pp.x) / dt; const vz = (playerPos.z - pp.z) / dt;
      pp.x = playerPos.x; pp.y = playerPos.y; pp.z = playerPos.z;
      animator.update(dt, pf, Math.sqrt(vx * vx + vz * vz));
      this.entityRenderer!.updateBoneLocalTransforms();
    }
    const drawEntityCount = this.pooledDrawEntityCount;
    drawEntityCount.length = 0;
    let drawIdx = 0; let wakeCount = 0; let shoreCount = 0;
    for (let i = 0; i < entityCount; i++) {
      const es = this.simReader.getEntitySlot(i); if (!es) continue;
      const eid = es.u32[ENT.ID]; if (eid === playerId && cameraMode === CameraMode.FirstPerson) continue;
      const type = es.u32[ENT.TYPE] as EntityType;
      const ePos = this.pooledEntPos;
      ePos.x = Number.isFinite(es.f32[ENT.POS_X]) ? es.f32[ENT.POS_X] : 0;
      ePos.y = Number.isFinite(es.f32[ENT.POS_Y]) ? es.f32[ENT.POS_Y] : 0;
      ePos.z = Number.isFinite(es.f32[ENT.POS_Z]) ? es.f32[ENT.POS_Z] : 0;
      const scale = Number.isFinite(es.f32[ENT.SCALE]) ? es.f32[ENT.SCALE] : 1;
      // Frustum cull: skip entities whose bounding sphere is outside the camera frustum.
      // Ships have scale=1 but their actual mesh (from boat cells) extends much further,
      // so use a generous radius for ship types. Islands/ports use scale as their actual
      // radius. Wildlife/decorations use scale as their approximate size.
      // NOTE: Islands and ports are excluded from frustum culling because they have
      // side effects (mesh generation, chunk streaming, active-key tracking). Culling
      // them would cause cleanupStaleIslandMeshes to delete their meshes, triggering
      // expensive regeneration when they come back into view.
      const isTerrain = type === EntityType.Island || type === EntityType.Port;
      if (!isTerrain) {
        const cullRadius = (type === EntityType.Ship || type === EntityType.SmallCraft || type === EntityType.PirateShip) ? 60 : scale;
        const cc = this.pooledCullCenter;
        cc[0] = ePos.x; cc[1] = ePos.y; cc[2] = ePos.z;
        if (!this.frustum.intersectsSphere(cc, cullRadius)) continue;
      }
      const eRot = this.pooledEntRot;
      eRot.x = Number.isFinite(es.f32[ENT.ROT_X]) ? es.f32[ENT.ROT_X] : 0;
      eRot.y = Number.isFinite(es.f32[ENT.ROT_Y]) ? es.f32[ENT.ROT_Y] : 0;
      eRot.z = Number.isFinite(es.f32[ENT.ROT_Z]) ? es.f32[ENT.ROT_Z] : 0;
      eRot.w = Number.isFinite(es.f32[ENT.ROT_W]) ? es.f32[ENT.ROT_W] : 1;
      let boatSlot = -1;
      if ((type === EntityType.Ship || type === EntityType.SmallCraft) && this.boatReader && this.boatReader.isValid()) {
        boatSlot = boatMap.get(eid) ?? -1;
      }
      const lt = performance.now() / 1000; const ef = es.u32[ENT.FLAGS];
      if (boatSlot >= 0 && this.boatReader) {
        const cells = this.boatReader.getBoatCells(boatSlot);
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci]; if (cell.type !== BoatCellType.LANTERN) continue;
          const lx = cell.gridX * BOAT_CELL_WORLD_SIZE; const ly = cell.gridY * BOAT_LAYER_HEIGHT + 0.5; const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
          const qx = eRot.x, qy = eRot.y, qz = eRot.z, qw = eRot.w;
          const tx = (1 - 2 * (qy * qy + qz * qz)) * lx + 2 * (qx * qy - qw * qz) * lz + 2 * (qx * qz + qw * qy) * ly;
          const ty = 2 * (qx * qy + qw * qz) * lx + (1 - 2 * (qx * qx + qz * qz)) * ly + 2 * (qy * qz - qw * qx) * lz;
          const tz = 2 * (qx * qz - qw * qy) * lx + 2 * (qy * qz + qw * qx) * ly + (1 - 2 * (qx * qx + qy * qy)) * lz;
          const fs = cell.gridX * 12.9898 + cell.gridZ * 78.233;
          const fl = 0.85 + 0.1 * Math.sin(lt * 12.0 + fs) + 0.05 * Math.sin(lt * 27.0 + fs * 2.0);
          this.lightingSystem!.addPointLight([ePos.x + tx, ePos.y + ty, ePos.z + tz], [1.0, 0.8, 0.4], 2.5 * fl, 25.0);
        }
      }
      if (ef & EntityFlags.Bioluminescent) {
        const dw = type === EntityType.Jellyfish || type === EntityType.Eel || type === EntityType.DevilShrimp || type === EntityType.Coral || type === EntityType.Reef;
        const ni = timeOfDay < 0.25 || timeOfDay > 0.75;
        if (dw || ni) { const ps = eid * 0.1; const pu = 0.7 + 0.3 * Math.sin(lt * 2.0 + ps); this.lightingSystem!.addPointLight([ePos.x, ePos.y, ePos.z], [0.2, 0.8, 1.0], 3.0 * pu, 20.0); }
      }
      if (type === EntityType.Port) {
        const ps = es.f32[ENT.DATA + PORT_DATA.SIZE] ?? 0;
        const pf = 0.9 + 0.1 * Math.sin(lt * 8.0 + eid * 0.7);
        this.lightingSystem!.addPointLight([ePos.x, ePos.y + scale * 0.3, ePos.z], [1.0, 0.85, 0.5], 2.0 * pf, scale * 1.5);
        if (ps >= PortSize.Medium) { this.lightingSystem!.addPointLight([ePos.x, ePos.y + scale * 0.15, ePos.z + scale * 0.6], [1.0, 0.8, 0.4], 1.5 * pf, scale * 0.8); }
        if (ps >= PortSize.Large) { const sa = lt * 0.5; this.lightingSystem!.addPointLight([ePos.x + Math.cos(sa) * scale * 0.27, ePos.y + scale * 1.2, ePos.z + Math.sin(sa) * scale * 0.27], [0.9, 0.95, 1.0], 4.0, scale * 3.0); }
      }
      let islandMeta: { chunkX: number; chunkZ: number; biome: number; islandSize: number } | undefined;
      let portMeta: { chunkX: number; chunkZ: number; biome: number } | undefined;
      if (type === EntityType.Island) {
        const dx = ePos.x - camera.position[0]; const dz = ePos.z - camera.position[2]; const dsq = dx * dx + dz * dz; const rd = scale * 4 + 200;
        if (dsq > rd * rd) {
          if (shoreCount < 128) { const si = shoreCount * 4; this.shoreArray[si] = ePos.x; this.shoreArray[si + 1] = ePos.z; this.shoreArray[si + 2] = scale; this.shoreArray[si + 3] = 0.0; shoreCount++; } continue;
        }
        islandMeta = { chunkX: es.u32[ENT.CHUNK_X], chunkZ: es.u32[ENT.CHUNK_Z], biome: es.f32[ENT.DATA + ISLAND_DATA.BIOME], islandSize: es.f32[ENT.DATA + ISLAND_DATA.SIZE] };
      } else if (type === EntityType.Port) {
        const dx = ePos.x - camera.position[0]; const dz = ePos.z - camera.position[2]; const dsq = dx * dx + dz * dz; const rd = scale * 4 + 200;
        if (dsq <= rd * rd) { portMeta = { chunkX: es.u32[ENT.CHUNK_X], chunkZ: es.u32[ENT.CHUNK_Z], biome: es.f32[ENT.DATA + 5] }; }
      }
      if (EntityRenderer.isInstancedType(type)) {
        // Plants: derive a visual scale from the crop's growth-stage height so
        // the instanced cube grows from a seed nub to a mature plant. Dead
        // plants (alive=0) are skipped so they vanish promptly.
        if (type === EntityType.Plant) {
          const alive = es.f32[ENT.DATA + PLANT_DATA.ALIVE] ?? 1;
          if (alive <= 0) continue;
          const stage = Math.min(3, Math.max(0, Math.floor(es.f32[ENT.DATA + PLANT_DATA.STAGE] ?? 0)));
          const encodedCrop = es.f32[ENT.DATA + PLANT_DATA.CROP_ID] ?? 0;
          const crop = getCropByEncodedHash(encodedCrop);
          const stress = Math.min(1, Math.max(0, es.f32[ENT.DATA + PLANT_DATA.STRESS] ?? 0));
          if (crop) {
            const vis = crop.visuals[stage];
            // Scale the unit cube to the plant's bounding box (height x foliage).
            // Use the larger of height and 2*foliageRadius so the cube encloses the plant.
            const plantScale = Math.max(vis.height, vis.foliageRadius * 2) * 0.5;
            // Wilting: shrink slightly with stress.
            const wilt = 1 - stress * 0.3;
            this.entityRenderer!.writeInstanceData(ePos, plantScale * wilt, eRot, type, ef);
            if (this.entityRenderer!.isHitboxVisible()) { this.entityRenderer!.writeInstancedHitbox(ePos, plantScale, eRot); }
            continue;
          }
        }
        this.entityRenderer!.writeInstanceData(ePos, scale, eRot, type, ef);
        if (this.entityRenderer!.isHitboxVisible()) { this.entityRenderer!.writeInstancedHitbox(ePos, scale, eRot); }
      } else {
        this.entityRenderer!.writeEntityUniforms(drawIdx, type, ePos, scale, eRot, boatSlot, islandMeta, portMeta, ef);
        drawEntityCount.push(i); drawIdx++;
      }
      if (wakeCount < 16 && (type === EntityType.Ship || type === EntityType.SmallCraft || type === EntityType.PirateShip)) {
        const vx = es.f32[ENT.VEL_X] || 0; const vz = es.f32[ENT.VEL_Z] || 0; const sp = Math.sqrt(vx * vx + vz * vz);
        if (sp > 0.5) { const qx = eRot.x, qy = eRot.y, qz = eRot.z, qw = eRot.w; const yaw = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz)); const wi = wakeCount * 6; this.wakeArray[wi] = ePos.x; this.wakeArray[wi + 1] = ePos.z; this.wakeArray[wi + 2] = Math.cos(yaw); this.wakeArray[wi + 3] = Math.sin(yaw); this.wakeArray[wi + 4] = sp; this.wakeArray[wi + 5] = 0; wakeCount++; }
      }
      if (shoreCount < 128 && (type === EntityType.Island || type === EntityType.Port)) {
        const si = shoreCount * 4; this.shoreArray[si] = ePos.x; this.shoreArray[si + 1] = ePos.z; this.shoreArray[si + 2] = scale; this.shoreArray[si + 3] = type === EntityType.Port ? scale * 0.25 : 0.0; shoreCount++;
        if (type === EntityType.Island) { const blobs = generateIslandBlobs(es.u32[ENT.CHUNK_X], es.u32[ENT.CHUNK_Z]); for (let b = 0; b < blobs.length; b++) { if (shoreCount >= 128) break; const blob = blobs[b]; if (blob.heightMul <= 0.1) continue; const bi = shoreCount * 4; this.shoreArray[bi] = blob.x * scale + ePos.x; this.shoreArray[bi + 1] = blob.z * scale + ePos.z; this.shoreArray[bi + 2] = 0.0; this.shoreArray[bi + 3] = blob.radius * scale; shoreCount++; } }
      }
    }
    if (viewportIdx === 0) { this.waterPass!.updateDynamics(this.wakeArray, wakeCount, this.shoreArray, shoreCount); }
    if (viewportIdx === 0) {
      this.entityRenderer!.processPendingDeformations();
      if (!this.preBakeDone) {
        this.entityRenderer!.preBakeAllChunks(camera.position[0], camera.position[2]);
        this.preBakeDone = true;
      } else {
        this.entityRenderer!.processIslandChunkStream(camera.position[0], camera.position[2]);
      }
    }
    if (viewportIdx === 0 && this.cloudSystem) { this.cloudSystem.update(dt, playerPos, windDir.x, windDir.z, windSpeed, weatherType); }
    this.lightingSystem!.upload([camera.position[0], camera.position[1], camera.position[2]]);
    this.entityRenderer!.uploadInstanceData();
    // --- GPU render pass ---
    this.entityRenderer!.dispatchSkinningCompute(encoder);
    const colorView = offscreenMode === "postprocess" ? this.postProcessStack!.getSceneColorView() : this.getSurfaceView();
    const depthView = offscreenMode === "postprocess" ? this.postProcessStack!.getSceneDepthView() : this.createDepthTextureView(origViewport.w, origViewport.h);
    const isFirst = viewportIdx === 0;
    const loadOp: GPULoadOp = useOffscreen && !isFirst ? "load" : "clear";

    // Drive the per-viewport render pass through the FrameGraph.
    // The graph owns the render pass encoder + attachments; the scene's
    // sub-draws (sky, terrain, entities, clouds, water, etc.) execute inside
    // a single graph pass's execute() via drawScene().
    const graph = this.getGraph();
    if (!this.graphColorHandle) {
      this.graphColorHandle = graph.importTextureView("color", null);
      this.graphDepthHandle = graph.importTextureView("depth", null);
      graph.markDirty();
    }
    graph.setImportedTextureView(this.graphColorHandle!, colorView);
    graph.setImportedTextureView(this.graphDepthHandle!, depthView);

    if (viewportIdx === 0) { this.gpuProfiler!.beginFrame(); }

    // Build per-viewport scene state for the graph pass.
    const sceneState: ScenePassState = {
      viewportIdx,
      viewport,
      origViewport,
      camera,
      viewProj,
      weatherType,
      timeOfDay,
      visibility,
      windSpeed,
      windDir,
      weatherIntensity,
      entityCount,
      playerId,
      lp,
      drawEntityCount,
      playerPos,
      useOffscreen,
      offscreenMode,
      loadOp,
      isFirst,
    };

    // Register/rebuild the scene pass each frame (it depends on per-viewport state).
    graph.markDirty();
    graph.clearPasses();
    const scenePass = new SceneRenderPass(
      "Scene",
      this.graphColorHandle!,
      this.graphDepthHandle!,
      loadOp,
      sceneState,
      (passEncoder: GPURenderPassEncoder, state: ScenePassState) => this.drawScene(passEncoder, state, encoder),
    );
    graph.addPass(scenePass);
    const device = this.getDevice()!;
    const canvas = this.getCanvas();
    graph.compile(device, canvas.width, canvas.height);
    this._graphCompiled = true;

    const vpCount = this.getViewportCount();
    const ctx: RenderContext = {
      device,
      encoder,
      pass: null,
      camera,
      viewport,
      viewportIdx,
      viewportCount: vpCount,
      dt,
      elapsedTime: this._elapsedTime,
      isFirstViewport: isFirst,
      isLastViewport: viewportIdx === vpCount - 1,
      width: viewport.w,
      height: viewport.h,
      viewProj,
      invViewProj: undefined,
      prevViewProj: undefined,
      cameraPos: camera.position,
      lightData: null,
      lightViewProj: undefined,
      mesh: null,
      modelMatrix: undefined,
      shadowsEnabled: false,
      bloomEnabled: false,
      shadowSampler: null,
      debugQueue: null,
      opaqueVertexBuffer: null,
      opaqueIndexBuffer: null,
      opaqueIndexCount: 0,
      opaqueIndexFormat: "uint32",
      getView: (h: TextureHandle) => graph.getTextureView(h),
      getTexture: (h: TextureHandle) => graph.getTexture(h),
      addDrawCalls: (n: number) => { this._frameDrawCalls += n; },
      addTriangles: (n: number) => { this._frameTriangles += n; },
    };
    graph.execute(ctx);

    if (viewportIdx === vpCount - 1) { this.entityRenderer!.cleanupStaleDecorations(); this.entityRenderer!.cleanupStaleIslandMeshes(); }
  }

  /**
   * Draw the entire scene (sky, terrain, entities, clouds, water, debug, etc.)
   * into the given render pass encoder. Called by the FrameGraph's SceneRenderPass.
   */
  private drawScene(passEncoder: GPURenderPassEncoder, state: ScenePassState, encoder: GPUCommandEncoder): void {
    const { viewportIdx, viewport, camera, viewProj, weatherType, timeOfDay, visibility, windSpeed, windDir, weatherIntensity, entityCount, playerId, lp, drawEntityCount, playerPos, isFirst } = state;
    passEncoder.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
    passEncoder.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);
    // Sky
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Sky", passEncoder, viewportIdx); }
    if (weatherType !== this.skyDisplayedWeatherType) { this.skyPrevWeatherType = this.skyDisplayedWeatherType; this.skyDisplayedWeatherType = weatherType; this.skyWeatherBlend = 0.0; }
    if (this.skyWeatherBlend < 1.0) { const sd = this.skyLastTime > 0 ? Math.min(0.1, this._elapsedTime - this.skyLastTime) : 0; this.skyWeatherBlend = Math.min(1.0, this.skyWeatherBlend + sd / this.skyWeatherTransitionDuration); }
    this.skyLastTime = this._elapsedTime;
    const eb = this.skyWeatherBlend * this.skyWeatherBlend * (3 - 2 * this.skyWeatherBlend);
    const sa = timeOfDay * Math.PI * 2 - Math.PI / 2; const ca = Math.cos(sa); const sn = Math.sin(sa); const rz = 0.3; const sl = Math.sqrt(ca * ca + sn * sn + rz * rz);
    const su = this.pooledSkyUniforms;
    su.sunDir[0] = ca / sl; su.sunDir[1] = sn / sl; su.sunDir[2] = rz / sl;
    su.moonDir[0] = -su.sunDir[0]; su.moonDir[1] = -su.sunDir[1]; su.moonDir[2] = -su.sunDir[2];
    su.sunIntensity = Math.max(0, sn); su.moonIntensity = Math.max(0, -sn);
    su.viewProj = viewProj;
    su.cameraPos[0] = camera.position[0]; su.cameraPos[1] = camera.position[1]; su.cameraPos[2] = camera.position[2];
    su.timeOfDay = timeOfDay; su.weatherType = this.skyDisplayedWeatherType; su.time = this._elapsedTime; su.prevWeatherType = this.skyPrevWeatherType; su.weatherBlend = eb;
    this.skyDomePass!.setUniforms(su);
    this.skyDomePass!.execute({ device: this.getDevice()!, pass: passEncoder } as unknown as RenderContext);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Sky", passEncoder, viewportIdx); }
    // IBL — recapture environment from sky dome (throttled by IBLSystem)
    if (viewportIdx === 0 && this.iblSystem) {
      this.iblSystem.updateFromSkyDome({
        timeOfDay: su.timeOfDay,
        weatherType: su.weatherType,
        sunDir: su.sunDir,
        sunIntensity: su.sunIntensity,
        moonDir: su.moonDir,
        moonIntensity: su.moonIntensity,
        time: su.time,
        prevWeatherType: su.prevWeatherType,
        weatherBlend: su.weatherBlend,
      }, timeOfDay);
      if (this.iblSystem.isReady() && this.entityRenderer) {
        const iblBg = this.iblSystem.getBindGroup();
        if (iblBg) { this.entityRenderer.setPBRBindGroup(iblBg); }
      }
    }
    // Terrain
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Terrain", passEncoder, viewportIdx); }
    const tvp = viewProj;
    const tc = this.pooledTerrainCameraPos; tc[0] = camera.position[0]; tc[1] = camera.position[1]; tc[2] = camera.position[2];
    this.terrainPass!.setUniforms({ viewProj: tvp, cameraPos: tc, time: performance.now() / 1000, patchSize: 512, originX: Math.round((playerPos.x - 256) / 4.0) * 4.0, originZ: Math.round((playerPos.z - 256) / 4.0) * 4.0, sunDir: lp.sunDir, sunIntensity: lp.sunIntensity, timeOfDay });
    this.terrainPass!.execute({ device: this.getDevice()!, pass: passEncoder } as unknown as RenderContext);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Terrain", passEncoder, viewportIdx); }
    // Entities
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Entities", passEncoder, viewportIdx); }
    const _ed = this._frameDrawCalls;
    this.entityRenderer!.renderInstanced(passEncoder); this._frameDrawCalls++;
    for (let d = 0; d < drawEntityCount.length; d++) { this.entityRenderer!.render(passEncoder, d); this._frameDrawCalls++; }
    this._frameTriangles += this.entityRenderer!.getLastFrameTriangles();
    this.entityRenderer!.renderAnchors(passEncoder, this.simReader!);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Entities", passEncoder, viewportIdx, this._frameDrawCalls - _ed, this.entityRenderer!.getLastFrameTriangles()); }
    // Clouds
    if (this.cloudSystem) {
      if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Clouds", passEncoder, viewportIdx); }
      this.cloudSystem.render(passEncoder, camera, timeOfDay, weatherType, windSpeed, windDir.x, windDir.z, this._elapsedTime, playerPos, lp.sunDir, lp.sunIntensity, lp.moonDir, lp.moonIntensity, lp.fogColor, 0.0008);
      if (viewportIdx === 0) { this.gpuProfiler!.endPass("Clouds", passEncoder, viewportIdx); }
    }
    // Water
    if (this.waterReader && this.waterReader.isValid()) {
      if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Water", passEncoder, viewportIdx); }
      const wvp = viewProj;
      const ps = this.waterReader.getPatchSize(); const hg = (256 * ps) / 2;
      const ox = Math.round((camera.position[0] - hg) / ps) * ps; const oz = Math.round((camera.position[2] - hg) / ps) * ps;
      this.waterPass!.setHeightData(this.waterReader.heights);
      this.waterPass!.setUniforms({ viewProj: wvp, cameraPos: camera.position, time: this._elapsedTime, gridSize: 256, patchSize: ps, originX: ox, originZ: oz, visibility, weatherType, timeOfDay, waveHeight: 2.0, windSpeed, windDirX: windDir.x, windDirZ: windDir.z, weatherIntensity, sunDir: lp.sunDir, sunIntensity: lp.sunIntensity, wakeCount: 0, shoreCount: 0 });
      this.waterPass!.execute({ device: this.getDevice()!, pass: passEncoder } as unknown as RenderContext);
      if (viewportIdx === 0) { this.gpuProfiler!.endPass("Water", passEncoder, viewportIdx); }
    }
    // Debug
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Debug", passEncoder, viewportIdx); }
    this.entityRenderer!.renderHitboxes(passEncoder); this.debugRaycast?.render(passEncoder);
    this.lightingSystem!.renderDebugGizmos(passEncoder, camera);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Debug", passEncoder, viewportIdx); }
    // Scene sync (throttled) — skip when sim hasn't ticked since last frame
    if (viewportIdx === 0) {
      const seq = this.simReader!.getSequence();
      if (seq !== this.lastSimSequence) {
        this.lastSimSequence = seq;
        this.sceneSync.maybeSync(500);
      }
    }
    // Label overlay
    if (this.labelOverlay && viewportIdx === 0) {
      const ss = useSceneStore.getState();
      if (ss.showLabels !== this.labelOverlay.isActive()) { this.labelOverlay.setActive(ss.showLabels); }
      if (ss.showLabels) { this.labelOverlay.update(camera); }
    }
    // Debug overlay
    if (this.debugOverlay && viewportIdx === 0 && this.debugOverlayData) { this.debugOverlay.update(camera, this.debugOverlayData); }
    // Models
    if (this.modelRenderer && viewportIdx === 0) {
      this.gpuProfiler!.beginPass("Models", passEncoder, viewportIdx);
      // Prepare the bindless bind group once per frame (flushes material SSBO).
      if (this.bindlessFrameBindings) {
        this.modelRenderer.setBindlessBindGroup(this.bindlessFrameBindings.prepareFrame());
      }
      this.modelRenderer.beginFrame(camera);
      const ss = useSceneStore.getState();
      for (const nid of ss.rootIds) { const n = ss.nodes[nid]; if (!n || !n.visible || n.type !== "model") continue; this.modelRenderer.render(passEncoder, n.id, n.position, n.rotation, n.scale); }
      this.gpuProfiler!.endPass("Models", passEncoder, viewportIdx);
    }
    // Holo preview
    if (this.boatReader && this.boatReader.isValid()) {
      this.gpuProfiler!.beginPass("Holo", passEncoder, viewportIdx);
      for (let i = 0; i < entityCount; i++) { const es2 = this.simReader!.getEntitySlot(i); if (!es2) continue; if (es2.u32[ENT.TYPE] !== EntityType.Ship) continue; const sp = this.pooledShipPos; sp.x = es2.f32[ENT.POS_X]; sp.y = es2.f32[ENT.POS_Y]; sp.z = es2.f32[ENT.POS_Z]; const sr = this.pooledShipRot; sr.x = es2.f32[ENT.ROT_X]; sr.y = es2.f32[ENT.ROT_Y]; sr.z = es2.f32[ENT.ROT_Z]; sr.w = es2.f32[ENT.ROT_W]; this.entityRenderer!.renderHoloPreview(passEncoder, sp, sr); break; }
      this.gpuProfiler!.endPass("Holo", passEncoder, viewportIdx);
    }
    // Particles
    if (weatherType === WeatherType.Rain || weatherType === WeatherType.Storm || weatherType === WeatherType.HellStorm || weatherType === WeatherType.Snow) {
      this.gpuProfiler!.beginPass("Particles", passEncoder, viewportIdx);
      this.particleSystem!.render(passEncoder, camera, weatherType, timeOfDay);
      this.gpuProfiler!.endPass("Particles", passEncoder, viewportIdx);
    }
    // Gizmo
    if (this.transformGizmo && this.transformGizmo.isVisible() && viewportIdx === 0) {
      this.gpuProfiler!.beginPass("Gizmo", passEncoder, viewportIdx);
      this.transformGizmo.render(passEncoder, camera);
      this.gpuProfiler!.endPass("Gizmo", passEncoder, viewportIdx);
    }
    // Underwater fog
    const cwh = this.sampleWaterHeightAt(camera.position[0], camera.position[2]);
    const cd = cwh - camera.position[1];
    if (cd > 0) {
      this.gpuProfiler!.beginPass("UnderwaterFog", passEncoder, viewportIdx);
      this.underwaterFogPass!.setDepth(cd, this._elapsedTime);
      this.underwaterFogPass!.execute({ device: this.getDevice()!, pass: passEncoder } as unknown as RenderContext);
      this.gpuProfiler!.endPass("UnderwaterFog", passEncoder, viewportIdx);
    }

    // World-space UI (Electron OSR)
    if (this.osrManager) {
      const osrViewProj = viewProj;
      const cx = camera.target[0] - camera.position[0];
      const cy = camera.target[1] - camera.position[1];
      const cz = camera.target[2] - camera.position[2];
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
      const fx = cx / cl, fy = cy / cl, fz = cz / cl;
      const r0 = fy * camera.up[2] - fz * camera.up[1];
      const r1 = fz * camera.up[0] - fx * camera.up[2];
      const r2 = fx * camera.up[1] - fy * camera.up[0];
      const rl = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2) || 1;
      const osrCam: OSRCameraState = {
        viewProj: osrViewProj,
        cameraRight: [r0 / rl, r1 / rl, r2 / rl],
        cameraUp: [camera.up[0], camera.up[1], camera.up[2]],
        cameraPosition: [camera.position[0], camera.position[1], camera.position[2]],
        canvasWidth: this.getCanvas().clientWidth,
        canvasHeight: this.getCanvas().clientHeight,
      };
      this.osrManager.render(osrCam, passEncoder);

      // Forward mouse/keyboard input to OSR billboards
      // When forced focus is active, forward even when pointer-locked
      const osrForward = this.inputHandler && viewportIdx === 0 &&
        (!this.inputHandler.pointerLocked || this.osrManager.isForcedFocus());
      if (osrForward) {
        const ms = this.inputHandler.mouseState;
        const buttons = (ms.left ? 1 : 0) | (ms.right ? 2 : 0);
        this.osrManager.handleInput(osrCam, {
          x: ms.x,
          y: ms.y,
          buttons,
          deltaX: 0,
          deltaY: 0,
          wheelDeltaX: 0,
          wheelDeltaY: ms.wheel,
        });
        // Reset cursor when not hovering any OSR billboard
        // Use a small timeout to allow async cursor style callback to arrive
        if (!this.osrManager.isHoveringBillboard() && !this.osrManager.isForcedFocus()) {
          if (this._osrCursorResetTimer) { clearTimeout(this._osrCursorResetTimer); }
          this._osrCursorResetTimer = setTimeout(() => {
            this.getCanvas().style.cursor = "default";
            this._osrCursorResetTimer = null;
          }, 100);
        } else if (this._osrCursorResetTimer) {
          clearTimeout(this._osrCursorResetTimer);
          this._osrCursorResetTimer = null;
        }
      }
    }

    // passEncoder.end() is called by the FrameGraph after this method returns.
  }

  private getSurfaceView(): GPUTextureView {
    const frame = this.surfaceFrameCounter;
    if (this.cachedSurfaceView && this.cachedSurfaceFrame === frame) {
      return this.cachedSurfaceView;
    }
    this.cachedSurfaceView = this.getContext()!.getCurrentTexture().createView();
    this.cachedSurfaceFrame = frame;
    return this.cachedSurfaceView;
  }

  private createDepthTextureView(w: number, h: number): GPUTextureView {
    const device = this.getDevice();
    if (!device) throw new Error("No device");
    const key = `${w}x${h}`;
    let entry = this._depthTextures.get(key);
    if (!entry) {
      const tex = device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      entry = { texture: tex, view: tex.createView() };
      this._depthTextures.set(key, entry);
    }
    return entry.view;
  }

  private sampleWaterHeightAt(x: number, z: number): number {
    if (!this.waterReader || !this.waterReader.isValid()) return 0;
    const ps = this.waterReader.getPatchSize() || 4;
    const o = this.waterReader.getOrigin();
    const gx = ((x - o.x) / ps % WATER_GRID + WATER_GRID) % WATER_GRID;
    const gz = ((z - o.z) / ps % WATER_GRID + WATER_GRID) % WATER_GRID;
    return this.waterReader.sampleHeight(gx, gz);
  }

  // --- Delegated accessor methods ---
  lockPointer(): void { this.inputHandler.lockPointer(); }
  setupInputListeners(): void { this.inputHandler.setupInputListeners(); }
  setOSRForcedFocus(active: boolean): void { this.inputHandler.setOSRForcedFocus(active); }
  getInputHandler(): RendererInputHandler { return this.inputHandler; }
  getCanvas(): HTMLCanvasElement { return super.getCanvas(); }

  /**
   * Set opaque UI panel rects (UV space, 0-1, top-left origin) reported by the
   * pixi-ui overlay. The postfx shaders discard fragments inside these rects
   * to skip work where the output is invisible (the overlay composites on top).
   * When a single rect covers ≥95% of the screen, the entire 3D + postfx
   * pipeline is skipped for the frame (full-frame skip for modal screens).
   */
  setOccluderRects(rects: { x: number; y: number; w: number; h: number }[]): void {
    this.postProcessStack?.setOccluderRects(rects);
    this.fullyOccluded = rects.some(r => r.w * r.h >= 0.95);
  }

  /** Capture the current canvas contents as a PNG blob. If the render loop
   *  is paused (test/headless mode), render a single frame first so the
   *  screenshot reflects current simulation state. */
  async captureScreenshot(): Promise<Blob | null> {
    if (!this._running) {
      this.renderOneFrame();
    }
    return new Promise((resolve) => {
      this.getCanvas().toBlob((blob) => resolve(blob), "image/png");
    });
  }
  getFPS(): number { return this.accessors.getFPS(); }
  setDebugMode(e: boolean): void { this.accessors.setDebugMode(e); }
  setShowHitboxes(s: boolean): void { this.accessors.setShowHitboxes(s); }
  getShowHitboxes(): boolean { return this.accessors.getEntityRenderer()?.isHitboxVisible() ?? false; }
  setShowLightGizmos(s: boolean): void { this.accessors.setShowLightGizmos(s); }
  setShowRaycast(s: boolean): void { this.accessors.setShowRaycast(s); }
  getEntityRenderer() { return this.accessors.getEntityRenderer(); }
  getUIRoot() { return this.accessors.getUIRoot(); }
  getUIInputRouter() { return this.accessors.getUIInputRouter(); }
  markUILayoutDirty(): void { this.accessors.markUILayoutDirty(); }
  refreshUIScreenSize(): void { this.accessors.updateUIScreenSize(); }
  toggleProfilingOverlay(): void { this.accessors.toggleProfilingOverlay(); }
  isProfilingOverlayVisible(): boolean { return this.accessors.isProfilingOverlayVisible(); }
  getTelemetryCollector() { return this.accessors.getTelemetryCollector(); }
  getGCController(): GCController | null { return this.gcController; }
  getGCStats(): GCControllerStats | null { return this.gcController?.getStats() ?? null; }
  setGCConfig(config: Partial<GCControllerConfig>): void { this.gcController?.setConfig(config); }
  forceMajorGC(): void { this.gcController?.forceMajor(); }
  getAdapterInfo() { return this.accessors.getAdapterInfo(); }
  getGPUErrors() { return this.accessors.getGPUErrors(); }
  clearGPUErrors(): void { this.accessors.clearGPUErrors(); }
  getGPUResourceTracker() { return this.accessors.getGPUResourceTracker(); }
  getGPUProfiler() { return this.accessors.getGPUProfiler(); }
  getGPUInfo() { return this.accessors.getGPUInfo(); }
  getFrameTelemetry() { return this.accessors.getFrameTelemetry(); }
  getPostProcessInfo() { return this.accessors.getPostProcessInfo(); }
  getFrameGraph() {
    const profiler = this.accessors.getGPUProfiler();
    if (!profiler) return null;
    const passTimings = profiler.getPassTimings();
    const ppInfo = this.accessors.getPostProcessInfo();
    const passNames = passTimings.map(t => t.name);
    const alwaysOn = ["Sky", "Terrain", "Entities", "Clouds", "Water"];
    return GPUProfiler.buildFrameGraphData(passTimings, ppInfo, passNames, alwaysOn);
  }
  setPixelationEnabled(e: boolean): void { this.accessors.setPixelationEnabled(e); }
  setPixelSize(s: number): void { this.accessors.setPixelSize(s); }
  setDepthEdgeStrength(s: number): void { this.accessors.setDepthEdgeStrength(s); }
  setPostProcessEnabled(id: EffectId, e: boolean): void { this.accessors.setPostProcessEnabled(id, e); }
  setDOFFocusDist(v: number): void { this.accessors.setDOFFocusDist(v); }
  setDOFFocusRange(v: number): void { this.accessors.setDOFFocusRange(v); }
  setDOFMaxBlur(v: number): void { this.accessors.setDOFMaxBlur(v); }
  setAfterimageDamp(v: number): void { this.accessors.setAfterimageDamp(v); }
  setBloomThreshold(v: number): void { this.accessors.setBloomThreshold(v); }
  setBloomStrength(v: number): void { this.accessors.setBloomStrength(v); }
  setASCIICellSize(v: number): void { this.accessors.setASCIICellSize(v); }
  setASCIIUseColor(v: boolean): void { this.accessors.setASCIIUseColor(v); }
  setParticleDensity(d: number): void { this.accessors.setParticleDensity(d); }
  setParticleCullDistance(d: number): void { this.accessors.setParticleCullDistance(d); }
  setFirstPersonSensitivity(v: number): void { this.accessors.setFirstPersonSensitivity(v); }
  setThirdPersonSensitivity(v: number): void { this.accessors.setThirdPersonSensitivity(v); }
  setFreecamSensitivity(v: number): void { this.accessors.setFreecamSensitivity(v); }
  getLUTReady(): Promise<void> { return this.accessors.getLUTReady(); }
  setHitboxLineWidth(w: number): void { this.accessors.setHitboxLineWidth(w); }
  getHitboxLineWidth(): number { return this.accessors.getHitboxLineWidth(); }
  setShowChunkGrid(s: boolean): void { this.accessors.setShowChunkGrid(s); }
  isChunkGridVisible(): boolean { return this.accessors.isChunkGridVisible(); }
  setShowVelocityArrows(s: boolean): void { this.accessors.setShowVelocityArrows(s); }
  isVelocityArrowsVisible(): boolean { return this.accessors.isVelocityArrowsVisible(); }
  getSimReader() { return this.accessors.getSimReader(); }
  getWaterReader() { return this.accessors.getWaterReader(); }
  getCanvasWidth(): number { return this.accessors.getCanvasWidth(); }
  getCanvasHeight(): number { return this.accessors.getCanvasHeight(); }
  getViewportWidth(i: number): number { return this.accessors.getViewportWidth(i); }
  getViewportHeight(i: number): number { return this.accessors.getViewportHeight(i); }
  getBoatReader() { return this.accessors.getBoatReader(); }
  toggleFlashlight(): void { this.accessors.toggleFlashlight(); }
  isFlashlightOn(): boolean { return this.accessors.isFlashlightOn(); }
  uploadModel(id: string, m: MeshData[], mat?: MaterialData[]): void { this.accessors.uploadModel(id, m, mat); }
  removeModel(id: string): void { this.accessors.removeModel(id); }
  setGizmoMode(m: GizmoMode): void { this.accessors.setGizmoMode(m); }
  setGizmoVisible(v: boolean): void { this.accessors.setGizmoVisible(v); }
  setGizmoPosition(p: [number, number, number]): void { this.accessors.setGizmoPosition(p); }
  getPlayerWorldPos(i: number) { return this.accessors.getPlayerWorldPos(i); }
  handleGizmoMouseDown(x: number, y: number, w: number, h: number): boolean { return this.sceneSync.handleGizmoMouseDown(x, y, w, h, (pos, heading, pitch, camMode, _mx, _my, aspect) => this.cameraSystem!.calculateCamera(pos, heading, pitch, camMode, 0, 0, aspect)); }
  handleGizmoMouseMove(x: number, y: number, w: number, h: number): void { this.sceneSync.handleGizmoMouseMove(x, y, w, h, (pos, heading, pitch, camMode, _mx, _my, aspect) => this.cameraSystem!.calculateCamera(pos, heading, pitch, camMode, 0, 0, aspect)); }
  handleGizmoMouseUp(): void { this.sceneSync.handleGizmoMouseUp(); }
  isGizmoDragging(): boolean { return this.sceneSync.isGizmoDragging(); }

  initOSR(ipc: OSRIPC): OSRManager | null {
    const device = this.getDevice();
    if (!device) return null;
    this.osrManager = new OSRManager(device, this.getFormat(), DEPTH_FORMAT as GPUTextureFormat);
    this.osrManager.init(ipc);
    this.inputHandler.onOSRKey = (type, keyCode, modifiers) => {
      this.osrManager?.handleKey(type, String(keyCode), modifiers);
    };
    this.inputHandler.onOSRFocus = () => {
      const id = this.osrManager?.focusBillboard();
      if (id) console.log(`[OSR] Manually focused billboard renderer: ${id}`);
      else console.log(`[OSR] No available billboard to focus`);
    };
    // Apply cursor style changes from OSR billboards to the game canvas
    const osrMgr = this.osrManager;
    osrMgr.onCursorStyleChange((cursor: string) => {
      console.log(`[OSR] Applying cursor style: ${cursor}`);
      this.getCanvas().style.cursor = cursor;
    });
    return this.osrManager;
  }

  getOSRManager(): OSRManager | null {
    return this.osrManager;
  }

  destroy(): void {
    this._running = false;
    this.cancelRafLoop();
    this.inputHandler.destroy();
    this.osrManager?.destroy();
    this.osrManager = null;
    this.postProcessStack?.destroy();
    this.modelRenderer?.destroy();
    this.bindlessFrameBindings?.destroy();
    this.bindlessMaterialManager?.destroy();
    this.bindlessRegistry?.destroy();
    this.transformGizmo?.destroy();
    this.labelOverlay?.destroy();
    this.debugOverlay?.destroy();
    this.debugRaycast?.destroy();
    this.iblSystem?.destroy();
    this.gcController?.dispose();
    this.gcController = null;
    this.terrainMeshPool?.destroy();
    this.terrainMeshPool = null;
    for (const entry of this._depthTextures.values()) { entry.texture.destroy(); }
    this._depthTextures.clear();
    // GameRenderer.destroy() handles: resize watcher, input manager, profiling
    // overlay, gpu profiler, telemetry collector, device cleanup, depth textures.
    super.destroy();
  }

  // --- IRendererStateProvider ---

  serializeRendererMeta(): Record<string, unknown> {
    return {
      debugMode: this.accessors.debugMode,
      flashlightOn: this.accessors.flashlightOn,
      showChunkGrid: this.accessors.isChunkGridVisible(),
      showVelocityArrows: this.accessors.isVelocityArrowsVisible(),
      postProcess: this.accessors.getPostProcessInfo(),
    };
  }

  restoreRendererMeta(meta: Record<string, unknown>): void {
    if (meta.debugMode !== undefined) this.accessors.setDebugMode(meta.debugMode as boolean);
    if (meta.flashlightOn !== undefined && meta.flashlightOn !== this.accessors.flashlightOn) {
      this.accessors.toggleFlashlight();
    }
    if (meta.showChunkGrid !== undefined) this.accessors.setShowChunkGrid(meta.showChunkGrid as boolean);
    if (meta.showVelocityArrows !== undefined) this.accessors.setShowVelocityArrows(meta.showVelocityArrows as boolean);
    if (meta.postProcess && typeof meta.postProcess === "object") {
      const pp = meta.postProcess as { pixelationEnabled?: boolean; pixelSize?: number };
      if (pp.pixelationEnabled !== undefined) this.accessors.setPixelationEnabled(pp.pixelationEnabled);
      if (pp.pixelSize !== undefined) this.accessors.setPixelSize(pp.pixelSize);
    }
  }
}

// ─── FrameGraph integration ────────────────────────────────────────────────

interface ScenePassState {
  viewportIdx: number;
  viewport: { x: number; y: number; w: number; h: number };
  origViewport: { x: number; y: number; w: number; h: number };
  camera: CameraState;
  viewProj: Float32Array;
  weatherType: WeatherType;
  timeOfDay: number;
  visibility: number;
  windSpeed: number;
  windDir: { x: number; z: number };
  weatherIntensity: number;
  entityCount: number;
  playerId: number;
  lp: LightingParams;
  drawEntityCount: number[];
  playerPos: { x: number; y: number; z: number };
  useOffscreen: boolean;
  offscreenMode: "none" | "pixelation" | "postprocess";
  loadOp: GPULoadOp;
  isFirst: boolean;
}

/**
 * SceneRenderPass — a single FrameGraph pass that owns the per-viewport
 * color+depth attachments and delegates the scene's sub-draws to the
 * WebGPURenderer.drawScene() callback. This makes the FrameGraph the single
 * orchestration path: it creates the render pass encoder, manages attachments,
 * and calls execute() which invokes drawScene().
 */
class SceneRenderPass extends RenderPass {
  name = "Scene";
  passType = PassType.Render;
  private colorHandle: TextureHandle;
  private depthHandle: TextureHandle;
  private loadOp: GPULoadOp;
  private state: ScenePassState;
  private drawFn: (passEncoder: GPURenderPassEncoder, state: ScenePassState) => void;

  constructor(
    name: string,
    colorHandle: TextureHandle,
    depthHandle: TextureHandle,
    loadOp: GPULoadOp,
    state: ScenePassState,
    drawFn: (passEncoder: GPURenderPassEncoder, state: ScenePassState) => void,
  ) {
    super();
    this.name = name;
    this.colorHandle = colorHandle;
    this.depthHandle = depthHandle;
    this.loadOp = loadOp;
    this.state = state;
    this.drawFn = drawFn;
  }

  setup(builder: FrameGraphBuilder): void {
    builder.colorAttachment({
      handle: this.colorHandle,
      loadOp: this.loadOp,
      storeOp: "store",
      clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 },
    });
    builder.depthAttachment({
      handle: this.depthHandle,
      depthLoadOp: this.loadOp,
      depthStoreOp: "store",
      depthClearValue: 1.0,
    });
  }

  prepare(): void {}

  execute(ctx: RenderContext): void {
    if (!ctx.pass) return;
    const rawEncoder = ctx.pass.getRawPass() as GPURenderPassEncoder;
    this.drawFn(rawEncoder, this.state);
  }
}
