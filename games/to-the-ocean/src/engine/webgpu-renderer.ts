// ============================================================================
// WebGPU Renderer — main rendering engine (thin orchestrator)
// Delegates input → RendererInputHandler, scene sync → RendererSceneSync,
// accessors → RendererAccessors
// ============================================================================

import { CanvasResizeWatcher, DEPTH_FORMAT, calculateViewProjInto as engineCalculateViewProjInto, Frustum, GPUProfiler, GPUResourceTracker, IBLSystem, LayoutEngine, MSAA_SAMPLE_COUNT, PBRSystem, PostProcessStack, DebugOverlay as ProfilingOverlay, SkyDomePass, TelemetryCollector, TerrainPass, TrackedRenderPass, UIInputRouter, UIRenderer, UIRoot, UnderwaterFogPass, WaterPass, type IRendererStateProvider } from "@downdraft/core";
import { DebugOverlay, DebugRaycast, LabelOverlay, SceneSync, TransformGizmo, useSceneStore, type GizmoMode } from "@downdraft/plugin-devtools";
import { OSRManager, type CameraState as OSRCameraState, type OSRIPC } from "@downdraft/plugin-electron-osr";
import { ModelRenderer } from "@downdraft/plugin-entities";
import { LightSystem } from "@downdraft/plugin-lighting";
import { loadModel, type MaterialData, type MeshData, type ModelData } from "@downdraft/plugin-models";
import { PixelationSystem } from "@downdraft/plugin-postfx";
import { CloudSystem, COLLISION_RADIUS, MAX_VOXEL_FLOATS, ParticleSystem, type VoxelCollisionData } from "@downdraft/plugin-weatherfx";
import { BoatBufferReader } from "@shared/boat-buffer";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, ISLAND_DATA, PORT_DATA } from "@shared/constants";
import { InputBufferWriter } from "@shared/input-buffer";
import { ENT, PLR, SimBufferReader } from "@shared/sim-buffer";
import { generateIslandBlobs } from "@shared/terrain";
import { CameraMode, EntityFlags, EntityType, PortSize, WeatherType } from "@shared/types";
import { WATER_GRID, WaterBufferReader } from "@shared/water-buffer";
import { CameraSystem, type CameraState } from "./camera-system";
import { GameDebugOverlayData, GameLabelProvider, GameRaycastProvider, GameSceneSyncProvider, getRayDirection, getRayOrigin } from "./debug-providers";
import { EntityRenderer } from "./entity-renderer";
import { GameCloudMeshProvider } from "./game-cloud-provider";
import { RendererAccessors } from "./renderer-accessors";
import { RendererInputHandler } from "./renderer-input-handler";

// Player model asset — resolved by Vite at build time
const playerModelGlob = import.meta.glob(
  "../../assets/models/CHARACTER MALE LOW POLY/*.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Rigged character model — Mixamo skeleton FBX (direct animation matching)
const riggedCharacterGlob = import.meta.glob(
  "../../assets/models/character.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Bed model asset for boat builder furniture
const bedModelGlob = import.meta.glob(
  "../../assets/models/Low Poly Furniture/Beds/Bed Single.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

// Mixamo animation files
const animGlobs = import.meta.glob(
  "../../assets/animations/human/mixamo/*.fbx",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

export class WebGPURenderer implements IRendererStateProvider {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
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
  private cameraSystem: CameraSystem | null = null;
  private lightingSystem: LightSystem | null = null;
  private pbrSystem: PBRSystem | null = null;
  private iblSystem: IBLSystem | null = null;
  private particleSystem: ParticleSystem | null = null;
  private pixelationSystem: PixelationSystem | null = null;
  private postProcessStack: PostProcessStack | null = null;
  private underwaterFogPass: UnderwaterFogPass | null = null;
  private cloudSystem: CloudSystem | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private debugOverlay: DebugOverlay | null = null;
  private debugOverlayData: GameDebugOverlayData | null = null;
  private debugRaycast: DebugRaycast | null = null;

  private uiRenderer: UIRenderer | null = null;
  private uiRoot: UIRoot | null = null;
  private uiLayoutEngine: LayoutEngine | null = null;
  private uiInputRouter: UIInputRouter | null = null;

  private osrManager: OSRManager | null = null;
  private _osrCursorResetTimer: ReturnType<typeof setTimeout> | null = null;

  private telemetryCollector: TelemetryCollector | null = null;
  private profilingOverlay: ProfilingOverlay | null = null;
  private frameDrawCalls: number = 0;
  private frameTriangles: number = 0;
  private gpuProfiler: GPUProfiler | null = null;
  private gpuResourceTracker: GPUResourceTracker | null = null;

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

  private lastResourceStatsTime = 0;
  private static readonly RESOURCE_STATS_INTERVAL = 1000;

  onInputProcessed: (() => void) | null = null;

  private running = false;
  private lastTime = 0;
  private frameCount = 0;
  private fpsTimer = 0;
  private lastDebugLog = 0;
  private elapsedTime = 0;

  private wakeArray = new Float32Array(16 * 6);
  private shoreArray = new Float32Array(128 * 4);

  private pooledViewportPlayerPos = { x: 0, y: 0, z: 0 };
  private pooledFreecamPlayerPos = { x: 0, y: 0, z: 0 };
  private pooledEntPos = { x: 0, y: 0, z: 0 };
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

  private targetFrameTime = 0;
  private rafInterval = 0;
  private rafSum = 0;
  private rafCount = 0;
  private lastRafTime = 0;
  private frameAccum = 0;
  private limiterActive = false;

  private viewportCount = 1;
  private viewports: { x: number; y: number; w: number; h: number }[] = [];

  private resizeWatcher: CanvasResizeWatcher | null = null;

  private inputHandler: RendererInputHandler;
  private sceneSync: SceneSync;
  private accessors: RendererAccessors;

  private deviceLost = false;
  private lastInvalidLog = 0;
  private simWasValid = false;
  private lastSimSequence = 0;
  private frustum = new Frustum();

  private depthTextures = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  private cachedSurfaceView: GPUTextureView | null = null;
  private cachedSurfaceFrame = -1;
  private surfaceFrameCounter = 0;
  private pooledViewProj = new Float32Array(16);
  private boatEntityIdToSlot = new Map<number, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.inputHandler = new RendererInputHandler(canvas);
    this.sceneSync = new SceneSync();
    this.accessors = new RendererAccessors();
    this.updateViewports(1);
    this.resizeWatcher = new CanvasResizeWatcher(canvas, {
      onResize: (cssW, cssH, dpr) => {
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
          this.updateViewports(this.viewportCount);
          this.accessors.updateUIScreenSize();
        }
      },
    });
  }

  handleDprChange(scaleFactor: number): void {
    this.resizeWatcher?.setDpr(scaleFactor);
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) {
      console.error("[WebGPU] WebGPU not supported — this game requires WebGPU");
      return false;
    }

    try {
      let adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        console.warn("No high-performance GPU adapter, trying low-power...");
        adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
      }
      if (!adapter) {
        console.warn("No low-power adapter, trying any...");
        adapter = await navigator.gpu.requestAdapter({});
      }
      if (!adapter) {
        console.error("No GPU adapter found — check GPU drivers and /dev/dri permissions");
        console.error("Try: sudo usermod -aG video,render $USER && reboot");
        return false;
      }

      const requiredFeatures: GPUFeatureName[] = [];
      if (adapter.features.has("timestamp-query")) {
        requiredFeatures.push("timestamp-query");
      }
      if (adapter.features.has("chromium-experimental-timestamp-query-inside-passes" as GPUFeatureName)) {
        requiredFeatures.push("chromium-experimental-timestamp-query-inside-passes" as GPUFeatureName);
      }
      this.device = await adapter.requestDevice({ requiredFeatures });

      this.gpuResourceTracker = new GPUResourceTracker();
      this.gpuResourceTracker.wrapDevice(this.device);

      const adapterInfo = (adapter as any).info ?? null;
      this.context = this.canvas.getContext("webgpu")!;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.gpuProfiler = new GPUProfiler();
      this.gpuProfiler.init(this.device, adapterInfo, this.format, 16);
      console.log("[WebGPU] GPU timer pool supported:", this.gpuProfiler.isGpuTimerSupported(),
        "features:", Array.from(this.device.features));

      this.device.lost.then((info: any) => {
        this.deviceLost = true;
        console.error(`[RENDERER] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        setTimeout(() => {
          console.warn("[RENDERER] Attempting page reload for GPU recovery...");
          window.location.reload();
        }, 2000);
      });
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });

      this.waterPass = new WaterPass(this.device, this.format, DEPTH_FORMAT as GPUTextureFormat, MSAA_SAMPLE_COUNT);
      this.skyDomePass = new SkyDomePass(this.device, this.format, 1);
      this.terrainPass = new TerrainPass(this.device, this.format, 1);
      this.entityRenderer = new EntityRenderer(this.device, this.format);
      this.cameraSystem = new CameraSystem();
      this.lightingSystem = new LightSystem(this.device);
      this.particleSystem = new ParticleSystem(this.device, this.format);

      this.waterPass.prepare(this.device);
      this.skyDomePass.prepare(this.device);
      this.terrainPass.prepare(this.device);
      this.lightingSystem.init();
      this.pbrSystem = new PBRSystem(this.device);
      this.pbrSystem.init();
      this.iblSystem = new IBLSystem(this.device, { faceSize: 256, recaptureInterval: 120 });
      this.iblSystem.setBRDFLUT(this.pbrSystem.brdfLUT!);
      this.iblSystem.init();
      await this.entityRenderer.init(this.lightingSystem.getLightBindGroupLayout() ?? undefined, this.iblSystem.getBindGroupLayout() ?? undefined);
      this.entityRenderer.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.entityRenderer.setPBRBindGroup(this.iblSystem.getBindGroup() ?? this.pbrSystem.getBindGroup()!);
      this.waterPass.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.lightingSystem.initDebugGizmos(this.format);

      this.uiRenderer = new UIRenderer(this.format);
      this.uiRenderer.prepare(this.device);
      this.uiRenderer.setScreenSize(this.canvas.width, this.canvas.height);
      this.uiRoot = new UIRoot(this.canvas.width, this.canvas.height);
      this.uiLayoutEngine = new LayoutEngine();
      this.uiLayoutEngine.setTextCache(this.uiRenderer.getTextCache());
      this.uiInputRouter = new UIInputRouter();
      this.uiInputRouter.setRoot(this.uiRoot);

      this.telemetryCollector = new TelemetryCollector(true);
      const dpr = window.devicePixelRatio || 1;
      this.profilingOverlay = new ProfilingOverlay(this.telemetryCollector, {
        position: "top-left",
        updateIntervalMs: 100,
        fontSize: Math.round(16 * dpr),
        showGpuTime: false,
        showPercentiles: false,
      });
      this.profilingOverlay.setScreenSize(this.canvas.width, this.canvas.height);

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
          const modelData = loadModel(buffer, "character.fbx") as ModelData;
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
              const animData = loadModel(buffer, filename + ".fbx") as ModelData;
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
          const modelData = loadModel(buffer, "player.fbx");
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
          const modelData = loadModel(buffer, "Bed Single.fbx");
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

      this.pixelationSystem = new PixelationSystem(this.device, this.format);
      this.pixelationSystem.init();

      this.postProcessStack = new PostProcessStack(this.device, this.format, { depthFormat: DEPTH_FORMAT });
      this.postProcessStack.init();

      this.underwaterFogPass = new UnderwaterFogPass(this.device, this.format);
      this.underwaterFogPass.prepare(this.device);

      this.cloudSystem = new CloudSystem(this.device, this.format, new GameCloudMeshProvider());
      await this.cloudSystem.init();

      this.modelRenderer = new ModelRenderer(this.device, this.format);
      await this.modelRenderer.init();

      this.transformGizmo = new TransformGizmo(this.device, this.format);
      await this.transformGizmo.init();

      this.labelOverlay = new LabelOverlay(this.canvas);
      this.debugOverlay = new DebugOverlay(this.canvas);
      this.debugRaycast = new DebugRaycast(this.device, this.format);
      this.debugRaycast.init();

      this.transformGizmo.onTransformUpdate = (transform) => {
        const selectedId = useSceneStore.getState().selectedId;
        if (!selectedId) return;
        useSceneStore.getState().updateNodeTransform(selectedId, transform);
      };

      // Update module references
      this.inputHandler.setCameraSystem(this.cameraSystem);
      this.inputHandler.setUIInputRouter(this.uiInputRouter);
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
      pixelationSystem: this.pixelationSystem,
      postProcessStack: this.postProcessStack,
      boatReader: this.boatReader,
      canvas: this.canvas,
      viewports: this.viewports,
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
    this.updateViewports(count);
  }

  private updateViewports(count: number): void {
    this.viewportCount = count;
    this.viewports = [];
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (count === 1) {
      this.viewports.push({ x: 0, y: 0, w, h });
    } else if (count === 2) {
      this.viewports.push({ x: 0, y: 0, w: w / 2, h });
      this.viewports.push({ x: w / 2, y: 0, w: w / 2, h });
    } else if (count === 3) {
      this.viewports.push({ x: 0, y: 0, w, h: h / 2 });
      this.viewports.push({ x: 0, y: h / 2, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 });
    } else if (count >= 4) {
      this.viewports.push({ x: 0, y: 0, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: 0, w: w / 2, h: h / 2 });
      this.viewports.push({ x: 0, y: h / 2, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 });
    }
    this.updateAccessorReferences();
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    this.render();
  }

  stop(): void {
    this.running = false;
  }

  setFrameRateLimit(refreshRate: number): void {
    if (refreshRate > 0) {
      this.targetFrameTime = 1000 / refreshRate;
      this.updateLimiterState();
    } else {
      this.targetFrameTime = 0;
      this.limiterActive = false;
    }
  }

  private updateLimiterState(): void {
    if (this.targetFrameTime <= 0 || this.rafInterval <= 0) {
      this.limiterActive = this.targetFrameTime > 0;
      return;
    }
    this.limiterActive = this.rafInterval < this.targetFrameTime * 0.85;
    this.frameAccum = 0;
  }

  private render = (): void => {
    if (!this.running) {
      requestAnimationFrame(this.render);
      return;
    }
    if (!this.device) {
      requestAnimationFrame(this.render);
      return;
    }

    const rafNow = performance.now();
    if (this.lastRafTime > 0) {
      this.rafSum += rafNow - this.lastRafTime;
      this.rafCount++;
      if (this.rafCount >= 60) {
        this.rafInterval = this.rafSum / this.rafCount;
        this.rafSum = 0;
        this.rafCount = 0;
        this.updateLimiterState();
      }
    }
    this.lastRafTime = rafNow;

    if (this.deviceLost) return;

    try {
      this.renderFrame();
    } catch (err) {
      console.error(`[RENDERER] Render loop error: ${(err as Error).message}\n${(err as Error).stack}`);
      if (this.device?.lost) {
        this.device.lost.then((info: any) => {
          this.deviceLost = true;
          console.error(`[RENDERER] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        });
      }
      requestAnimationFrame(this.render);
    }
  };

  private renderFrame(): void {
    const now = performance.now();
    if (this.limiterActive && this.targetFrameTime > 0) {
      this.frameAccum += this.rafInterval / this.targetFrameTime;
      if (this.frameAccum < 1) { requestAnimationFrame(this.render); return; }
      this.frameAccum -= 1;
    }
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsedTime += dt;
    this.frameCount++;
    this.surfaceFrameCounter++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) { this.accessors.fps = this.frameCount; this.frameCount = 0; this.fpsTimer = 0; }
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
    this.inputHandler.processInput(this.viewportCount);
    this.onInputProcessed?.();
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
        dc.target[0] = cp[0]; dc.target[1] = cp[1]; dc.target[2] = cp[2] - 1; dc.aspect = this.canvas.width / this.canvas.height;
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
        if (this.device) {
          const ce = this.device.createCommandEncoder();
          this.particleSystem.tick(ce, dt, dc, wt, wd.x * ws, wd.z * ws, vd);
          this.device.queue.submit([ce.finish()]);
        }
      }
    }
    const usePix = this.pixelationSystem?.isEnabled() ?? false;
    const usePP = this.postProcessStack?.hasEnabledEffects() ?? false;
    if (usePix && this.device) {
      this.pixelationSystem!.ensureTargets(this.canvas.width, this.canvas.height);
      for (let v = 0; v < this.viewportCount; v++) { this.renderViewport(v, dt, "pixelation"); }
      const cv = this.context!.getCurrentTexture().createView();
      const pe = this.device!.createCommandEncoder();
      this.pixelationSystem!.applyPostprocess(pe, cv, this.canvas.width, this.canvas.height);
      this.device!.queue.submit([pe.finish()]);
    } else if (usePP && this.device) {
      this.postProcessStack!.ensureTargets(this.canvas.width, this.canvas.height);
      for (let v = 0; v < this.viewportCount; v++) { this.renderViewport(v, dt, "postprocess"); }
      const cv = this.context!.getCurrentTexture().createView();
      const pe = this.device!.createCommandEncoder();
      this.postProcessStack!.applyChain(pe, this.postProcessStack!.getSceneDepthView(), cv, this.canvas.width, this.canvas.height);
      this.device!.queue.submit([pe.finish()]);
    } else {
      for (let v = 0; v < this.viewportCount; v++) { this.renderViewport(v, dt, "none"); }
    }
    if (this.uiRenderer && this.uiRoot && this.device && this.context) {
      if (this.accessors.uiNeedsLayout && this.uiLayoutEngine) { this.uiLayoutEngine.layout(this.uiRoot); this.accessors.uiNeedsLayout = false; }
      const ds = this.uiRoot.getDrawable();
      if (ds.length > 0) {
        const cv = this.context.getCurrentTexture().createView();
        const ue = this.device.createCommandEncoder();
        const up = ue.beginRenderPass({ colorAttachments: [{ view: cv, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "load" as GPULoadOp, storeOp: "store" as GPUStoreOp }] });
        this.uiRenderer.render({ device: this.device, pass: new TrackedRenderPass(up) } as any, ds);
        up.end();
        this.device.queue.submit([ue.finish()]);
      }
    }
    if (this.telemetryCollector) {
      this.telemetryCollector.recordFrame(dt * 1000);
      this.telemetryCollector.recordDrawStats(this.frameDrawCalls, this.frameTriangles);
      this.telemetryCollector.recordGraphSample(dt * 1000);
      if (this.gpuProfiler) { for (const t of this.gpuProfiler.getPassTimings()) { this.telemetryCollector.recordPassTiming(t); } }
      if (this.gpuResourceTracker && now - this.lastResourceStatsTime > WebGPURenderer.RESOURCE_STATS_INTERVAL) {
        this.lastResourceStatsTime = now;
        const rs = this.gpuResourceTracker.getStats();
        this.telemetryCollector.recordResourceStats({ textureCount: rs.textureCount, bufferCount: rs.bufferCount, totalBytes: rs.totalBytes, textureBytes: rs.textureBytes, bufferBytes: rs.bufferBytes, resources: rs.resources.map(r => ({ id: r.id, type: r.type, label: r.label, size: r.size, callsite: r.callsite, width: r.width, height: r.height, format: r.format })) });
      }
      this.frameDrawCalls = 0; this.frameTriangles = 0;
    }
    requestAnimationFrame(this.render);
  }

  private renderViewport(viewportIdx: number, dt: number, offscreenMode: "none" | "pixelation" | "postprocess" = "none"): void {
    if (!this.simReader) return;
    if (!this.device) return;
    if (!this.simReader.isValid()) {
      if (this.simWasValid && viewportIdx === 0 && performance.now() - (this.lastInvalidLog ?? 0) > 2000) { this.lastInvalidLog = performance.now(); console.warn("[RENDERER] Sim buffer invalid — not rendering."); }
      return;
    }
    this.simWasValid = true;
    const origViewport = this.viewports[viewportIdx];
    if (!origViewport) return;
    const useOffscreen = offscreenMode !== "none";
    const viewport = offscreenMode === "pixelation" ? this.pixelationSystem!.scaleViewport(origViewport) : origViewport;
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
      console.log(`[Render] tick=${this.simReader.getTick()} ents=${this.simReader.getEntityCount()} players=${this.simReader.getPlayerCount()} pos=(${playerPos.x.toFixed(1)},${playerPos.y.toFixed(1)},${playerPos.z.toFixed(1)}) camMode=${cameraMode}`);
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
      // Uses a sphere centered at the entity position with radius = scale (conservative;
      // most entities fit within their scale radius). This avoids per-entity draw call
      // submission for off-screen entities.
      if (!this.frustum.intersectsSphere([ePos.x, ePos.y, ePos.z], scale)) continue;
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
        if (dsq > rd * rd) { if (shoreCount < 128) { const si = shoreCount * 4; this.shoreArray[si] = ePos.x; this.shoreArray[si + 1] = ePos.z; this.shoreArray[si + 2] = scale; this.shoreArray[si + 3] = 0.0; shoreCount++; } continue; }
        islandMeta = { chunkX: es.u32[ENT.CHUNK_X], chunkZ: es.u32[ENT.CHUNK_Z], biome: es.f32[ENT.DATA + ISLAND_DATA.BIOME], islandSize: es.f32[ENT.DATA + ISLAND_DATA.SIZE] };
      } else if (type === EntityType.Port) {
        const dx = ePos.x - camera.position[0]; const dz = ePos.z - camera.position[2]; const dsq = dx * dx + dz * dz; const rd = scale * 4 + 200;
        if (dsq <= rd * rd) { portMeta = { chunkX: es.u32[ENT.CHUNK_X], chunkZ: es.u32[ENT.CHUNK_Z], biome: es.f32[ENT.DATA + 5] }; }
      }
      if (EntityRenderer.isInstancedType(type)) {
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
    const encoder = this.device!.createCommandEncoder();
    this.entityRenderer!.dispatchSkinningCompute(encoder);
    const colorView = offscreenMode === "pixelation" ? this.pixelationSystem!.getOffscreenColorView() : offscreenMode === "postprocess" ? this.postProcessStack!.getSceneColorView() : this.getSurfaceView();
    const depthView = offscreenMode === "pixelation" ? this.pixelationSystem!.getOffscreenDepthView() : offscreenMode === "postprocess" ? this.postProcessStack!.getSceneDepthView() : this.createDepthTexture(origViewport.w, origViewport.h);
    const isFirst = viewportIdx === 0;
    const loadOp: GPULoadOp = useOffscreen && !isFirst ? "load" : "clear";
    const passEncoder: any = this.gpuProfiler!.wrapTrackedPass(encoder.beginRenderPass({ colorAttachments: [{ view: colorView, clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 }, loadOp, storeOp: "store" as GPUStoreOp }], depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: loadOp, depthStoreOp: "store" as GPUStoreOp } }));
    passEncoder.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
    passEncoder.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);
    if (viewportIdx === 0) { this.gpuProfiler!.beginFrame(); }
    // Sky
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Sky", passEncoder, viewportIdx); }
    if (weatherType !== this.skyDisplayedWeatherType) { this.skyPrevWeatherType = this.skyDisplayedWeatherType; this.skyDisplayedWeatherType = weatherType; this.skyWeatherBlend = 0.0; }
    if (this.skyWeatherBlend < 1.0) { const sd = this.skyLastTime > 0 ? Math.min(0.1, this.elapsedTime - this.skyLastTime) : 0; this.skyWeatherBlend = Math.min(1.0, this.skyWeatherBlend + sd / this.skyWeatherTransitionDuration); }
    this.skyLastTime = this.elapsedTime;
    const eb = this.skyWeatherBlend * this.skyWeatherBlend * (3 - 2 * this.skyWeatherBlend);
    const sa = timeOfDay * Math.PI * 2 - Math.PI / 2; const ca = Math.cos(sa); const sn = Math.sin(sa); const rz = 0.3; const sl = Math.sqrt(ca * ca + sn * sn + rz * rz);
    const su = this.pooledSkyUniforms;
    su.sunDir[0] = ca / sl; su.sunDir[1] = sn / sl; su.sunDir[2] = rz / sl;
    su.moonDir[0] = -su.sunDir[0]; su.moonDir[1] = -su.sunDir[1]; su.moonDir[2] = -su.sunDir[2];
    su.sunIntensity = Math.max(0, sn); su.moonIntensity = Math.max(0, -sn);
    su.viewProj = viewProj;
    su.cameraPos[0] = camera.position[0]; su.cameraPos[1] = camera.position[1]; su.cameraPos[2] = camera.position[2];
    su.timeOfDay = timeOfDay; su.weatherType = this.skyDisplayedWeatherType; su.time = this.elapsedTime; su.prevWeatherType = this.skyPrevWeatherType; su.weatherBlend = eb;
    this.skyDomePass!.setUniforms(su);
    this.skyDomePass!.execute({ device: this.device, pass: passEncoder } as any);
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
    this.terrainPass!.execute({ device: this.device, pass: passEncoder } as any);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Terrain", passEncoder, viewportIdx); }
    // Entities
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Entities", passEncoder, viewportIdx); }
    const _ed = this.frameDrawCalls;
    this.entityRenderer!.renderInstanced(passEncoder); this.frameDrawCalls++;
    for (let d = 0; d < drawEntityCount.length; d++) { this.entityRenderer!.render(passEncoder, d); this.frameDrawCalls++; }
    this.frameTriangles += this.entityRenderer!.getLastFrameTriangles();
    this.entityRenderer!.renderAnchors(passEncoder, this.simReader);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Entities", passEncoder, viewportIdx, this.frameDrawCalls - _ed, this.entityRenderer!.getLastFrameTriangles()); }
    // Clouds
    if (this.cloudSystem) {
      if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Clouds", passEncoder, viewportIdx); }
      this.cloudSystem.render(passEncoder, camera, timeOfDay, weatherType, windSpeed, windDir.x, windDir.z, this.elapsedTime, playerPos, lp.sunDir, lp.sunIntensity, lp.moonDir, lp.moonIntensity, lp.fogColor, 0.0008);
      if (viewportIdx === 0) { this.gpuProfiler!.endPass("Clouds", passEncoder, viewportIdx); }
    }
    // Water
    if (this.waterReader && this.waterReader.isValid()) {
      if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Water", passEncoder, viewportIdx); }
      const wvp = viewProj;
      const ps = this.waterReader.getPatchSize(); const hg = (256 * ps) / 2;
      const ox = Math.round((camera.position[0] - hg) / ps) * ps; const oz = Math.round((camera.position[2] - hg) / ps) * ps;
      this.waterPass!.setHeightData(this.waterReader.heights);
      this.waterPass!.setUniforms({ viewProj: wvp, cameraPos: camera.position, time: this.elapsedTime, gridSize: 256, patchSize: ps, originX: ox, originZ: oz, visibility, weatherType, timeOfDay, waveHeight: 2.0, windSpeed, windDirX: windDir.x, windDirZ: windDir.z, weatherIntensity, sunDir: lp.sunDir, sunIntensity: lp.sunIntensity, wakeCount: 0, shoreCount: 0 });
      this.waterPass!.execute({ device: this.device, pass: passEncoder } as any);
      if (viewportIdx === 0) { this.gpuProfiler!.endPass("Water", passEncoder, viewportIdx); }
    }
    // Debug
    if (viewportIdx === 0) { this.gpuProfiler!.beginPass("Debug", passEncoder, viewportIdx); }
    this.entityRenderer!.renderHitboxes(passEncoder); this.debugRaycast?.render(passEncoder);
    this.lightingSystem!.renderDebugGizmos(passEncoder, camera);
    if (viewportIdx === 0) { this.gpuProfiler!.endPass("Debug", passEncoder, viewportIdx); }
    // Scene sync (throttled) — skip when sim hasn't ticked since last frame
    if (viewportIdx === 0) {
      const seq = this.simReader.getSequence();
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
      this.modelRenderer.beginFrame(camera);
      const ss = useSceneStore.getState();
      for (const nid of ss.rootIds) { const n = ss.nodes[nid]; if (!n || !n.visible || n.type !== "model") continue; this.modelRenderer.render(passEncoder, n.id, n.position, n.rotation, n.scale); }
      this.gpuProfiler!.endPass("Models", passEncoder, viewportIdx);
    }
    // Holo preview
    if (this.boatReader && this.boatReader.isValid()) {
      this.gpuProfiler!.beginPass("Holo", passEncoder, viewportIdx);
      for (let i = 0; i < entityCount; i++) { const es2 = this.simReader.getEntitySlot(i); if (!es2) continue; if (es2.u32[ENT.TYPE] !== EntityType.Ship) continue; const sp = this.pooledShipPos; sp.x = es2.f32[ENT.POS_X]; sp.y = es2.f32[ENT.POS_Y]; sp.z = es2.f32[ENT.POS_Z]; const sr = this.pooledShipRot; sr.x = es2.f32[ENT.ROT_X]; sr.y = es2.f32[ENT.ROT_Y]; sr.z = es2.f32[ENT.ROT_Z]; sr.w = es2.f32[ENT.ROT_W]; this.entityRenderer!.renderHoloPreview(passEncoder, sp, sr); break; }
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
      this.underwaterFogPass!.setDepth(cd, this.elapsedTime);
      this.underwaterFogPass!.execute({ device: this.device, pass: passEncoder } as any);
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
        canvasWidth: this.canvas.clientWidth,
        canvasHeight: this.canvas.clientHeight,
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
            this.canvas.style.cursor = "default";
            this._osrCursorResetTimer = null;
          }, 100) as any;
        } else if (this._osrCursorResetTimer) {
          clearTimeout(this._osrCursorResetTimer);
          this._osrCursorResetTimer = null;
        }
      }
    }

    passEncoder.end();
    if (viewportIdx === 0) { this.gpuProfiler!.resolveGpuTimers(encoder); }
    this.device!.queue.submit([encoder.finish()]);
    if (viewportIdx === 0) { this.gpuProfiler!.readGpuTimers().then(() => {}).catch(() => {}); }
    if (viewportIdx === this.viewportCount - 1) { this.entityRenderer!.cleanupStaleDecorations(); this.entityRenderer!.cleanupStaleIslandMeshes(); }
  }

  private getSurfaceView(): GPUTextureView {
    const frame = this.surfaceFrameCounter;
    if (this.cachedSurfaceView && this.cachedSurfaceFrame === frame) {
      return this.cachedSurfaceView;
    }
    this.cachedSurfaceView = this.context!.getCurrentTexture().createView();
    this.cachedSurfaceFrame = frame;
    return this.cachedSurfaceView;
  }

  private createDepthTexture(w: number, h: number): GPUTextureView {
    if (!this.device) throw new Error("No device");
    const key = `${w}x${h}`;
    let entry = this.depthTextures.get(key);
    if (!entry) {
      const tex = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      entry = { texture: tex, view: tex.createView() };
      this.depthTextures.set(key, entry);
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
  updateUIScreenSize(): void { this.accessors.updateUIScreenSize(); }
  toggleProfilingOverlay(): void { this.accessors.toggleProfilingOverlay(); }
  isProfilingOverlayVisible(): boolean { return this.accessors.isProfilingOverlayVisible(); }
  getTelemetryCollector() { return this.accessors.getTelemetryCollector(); }
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
  setPostProcessEnabled(id: any, e: boolean): void { this.accessors.setPostProcessEnabled(id, e); }
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
    if (!this.device) return null;
    this.osrManager = new OSRManager(this.device, this.format, DEPTH_FORMAT as GPUTextureFormat);
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
      this.canvas.style.cursor = cursor;
    });
    return this.osrManager;
  }

  getOSRManager(): OSRManager | null {
    return this.osrManager;
  }

  destroy(): void {
    this.running = false;
    this.resizeWatcher?.destroy();
    this.resizeWatcher = null;
    this.inputHandler.destroy();
    this.osrManager?.destroy();
    this.osrManager = null;
    this.pixelationSystem?.destroy();
    this.postProcessStack?.destroy();
    this.modelRenderer?.destroy();
    this.transformGizmo?.destroy();
    this.labelOverlay?.destroy();
    this.debugOverlay?.destroy();
    this.debugRaycast?.destroy();
    this.iblSystem?.destroy();
    this.profilingOverlay?.destroy();
    this.profilingOverlay = null;
    this.gpuProfiler?.destroy();
    this.gpuProfiler = null;
    this.telemetryCollector = null;
    this.device = null;
    for (const entry of this.depthTextures.values()) { entry.texture.destroy(); }
    this.depthTextures.clear();
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
