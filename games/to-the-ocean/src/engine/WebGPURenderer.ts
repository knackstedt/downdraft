// ============================================================================
// WebGPU Renderer — main rendering engine (thin orchestrator)
// Delegates input → RendererInputHandler, scene sync → RendererSceneSync,
// accessors → RendererAccessors
// ============================================================================

import { DEPTH_FORMAT, calculateViewProj as engineCalculateViewProj, GPUProfiler, GPUResourceTracker, LayoutEngine, MSAA_SAMPLE_COUNT, DebugOverlay as ProfilingOverlay, SkyDomePass, TelemetryCollector, TerrainPass, UIInputRouter, UIRenderer, UIRoot, UnderwaterFogPass, WaterPass } from "@downdraft/core";
import { TransformGizmo } from "@downdraft/plugin-devtools";
import { ModelRenderer } from "@downdraft/plugin-entities";
import { LightSystem } from "@downdraft/plugin-lighting";
import { PixelationSystem } from "@downdraft/plugin-postfx";
import { CloudSystem, COLLISION_RADIUS, MAX_VOXEL_FLOATS, ParticleSystem, type VoxelCollisionData } from "@downdraft/plugin-weatherfx";
import { generateIslandBlobs } from "@shared/TerrainGenerator";
import { BoatBufferReader } from "@shared/boat-buffer";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, ISLAND_DATA, PORT_DATA } from "@shared/constants";
import { InputBufferWriter } from "@shared/input-buffer";
import { ENT, PLR, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, EntityFlags, EntityType, PortSize, WeatherType } from "@shared/types";
import { WATER_GRID, WaterBufferReader } from "@shared/water-buffer";
import { useSceneStore, type GizmoMode } from "../stores/sceneStore";
import { CameraSystem, type CameraState } from "./CameraSystem";
import { CanvasResizeWatcher } from "./CanvasResizeWatcher";
import { DebugOverlay } from "./DebugOverlay";
import { DebugRaycast } from "./DebugRaycast";
import { EntityRenderer } from "./EntityRenderer";
import { GameCloudMeshProvider } from "./GameCloudProvider";
import { LabelOverlay } from "./LabelOverlay";
import { loadModel, type MaterialData, type MeshData, type ModelData } from "./ModelLoader";
import { PBRSystem } from "./PBRSystem";
import { PostProcessStack } from "./PostProcessStack";
import { RendererAccessors } from "./RendererAccessors";
import { RendererInputHandler } from "./RendererInputHandler";
import { RendererSceneSync } from "./RendererSceneSync";

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

export class WebGPURenderer {
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
  private particleSystem: ParticleSystem | null = null;
  private pixelationSystem: PixelationSystem | null = null;
  private postProcessStack: PostProcessStack | null = null;
  private underwaterFogPass: UnderwaterFogPass | null = null;
  private cloudSystem: CloudSystem | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private debugOverlay: DebugOverlay | null = null;
  private debugRaycast: DebugRaycast | null = null;

  private uiRenderer: UIRenderer | null = null;
  private uiRoot: UIRoot | null = null;
  private uiLayoutEngine: LayoutEngine | null = null;
  private uiInputRouter: UIInputRouter | null = null;

  private telemetryCollector: TelemetryCollector | null = null;
  private profilingOverlay: ProfilingOverlay | null = null;
  private frameDrawCalls: number = 0;
  private frameTriangles: number = 0;
  private gpuProfiler: GPUProfiler | null = null;
  private gpuResourceTracker: GPUResourceTracker | null = null;

  private skyPrevWeatherType: WeatherType = WeatherType.Clear;
  private skyDisplayedWeatherType: WeatherType = WeatherType.Clear;
  private skyWeatherBlend: number = 1.0;
  private skyLastTime: number = 0;
  private readonly skyWeatherTransitionDuration: number = 30.0;

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
  private pooledSkyCameraPos: [number, number, number] = [0, 0, 0];
  private pooledTerrainCameraPos: [number, number, number] = [0, 0, 0];
  private pooledWaterCameraPos: [number, number, number] = [0, 0, 0];
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
  private sceneSync: RendererSceneSync;
  private accessors: RendererAccessors;

  private deviceLost = false;
  private lastInvalidLog = 0;
  private simWasValid = false;

  private depthTextures = new Map<string, GPUTexture>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.inputHandler = new RendererInputHandler(canvas);
    this.sceneSync = new RendererSceneSync();
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
      console.error("WebGPU not supported — navigator.gpu is undefined");
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
      this.skyDomePass = new SkyDomePass(this.device, this.format);
      this.terrainPass = new TerrainPass(this.device, this.format);
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
      await this.entityRenderer.init(this.lightingSystem.getLightBindGroupLayout() ?? undefined, this.pbrSystem.getBindGroupLayout() ?? undefined);
      this.entityRenderer.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.entityRenderer.setPBRBindGroup(this.pbrSystem.getBindGroup()!);
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

      this.postProcessStack = new PostProcessStack(this.device, this.format);
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
      this.sceneSync.setCameraSystem(this.cameraSystem);
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
    this.sceneSync.setSimReader(this.simReader);
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
    if (!this.running || !this.device || !this.context) {
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

  // === PART2_MARKER ===
}
