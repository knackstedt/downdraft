// ============================================================================
// WebGPU Renderer — main rendering engine
// ============================================================================

import { generateIslandBlobs } from "@shared/TerrainGenerator";
import { BoatBufferReader } from "@shared/boat-buffer";
import { RuntimeBoatGeometry, type BoatDesign } from "@shared/boat-design";
import { BOAT_CELL_WORLD_SIZE, BOAT_LAYER_HEIGHT, BoatCellType, ISLAND_DATA, PORT_DATA } from "@shared/constants";
import { InputBufferWriter, KEY } from "@shared/input-buffer";
import { ENT, PLR, PLR_FLAG, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, EntityFlags, EntityType, EntityTypeNames, PortSize, WeatherType } from "@shared/types";
import { WATER_GRID, WaterBufferReader } from "@shared/water-buffer";
import { useGameStore } from "../stores/gameStore";
import { useSceneStore, type GizmoMode } from "../stores/sceneStore";
import { CameraSystem, type CameraState } from "./CameraSystem";
import { CanvasResizeWatcher } from "./CanvasResizeWatcher";
import { CloudSystem } from "./CloudSystem";
import { DebugOverlay } from "./DebugOverlay";
import { DebugRaycast } from "./DebugRaycast";
import { EntityRenderer } from "./EntityRenderer";
import { LabelOverlay } from "./LabelOverlay";
import { LightSystem } from "./LightSystem";
import { loadModel, type MaterialData, type MeshData, type ModelData } from "./ModelLoader";
import { ModelRenderer } from "./ModelRenderer";
import { PBRSystem } from "./PBRSystem";
import { ParticleSystem } from "./ParticleSystem";
import { PixelationSystem } from "./PixelationSystem";
import { PostProcessStack } from "./PostProcessStack";
import { SkySystem } from "./SkySystem";
import { TerrainSystem } from "./TerrainSystem";
import { TransformGizmo } from "./TransformGizmo";
import { UnderwaterFogSystem } from "./UnderwaterFogSystem";
import { WaterSystem } from "./WaterSystem";

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

  private waterSystem: WaterSystem | null = null;
  private skySystem: SkySystem | null = null;
  private terrainSystem: TerrainSystem | null = null;
  private entityRenderer: EntityRenderer | null = null;
  private cameraSystem: CameraSystem | null = null;
  private lightingSystem: LightSystem | null = null;
  private pbrSystem: PBRSystem | null = null;
  private particleSystem: ParticleSystem | null = null;
  private pixelationSystem: PixelationSystem | null = null;
  private postProcessStack: PostProcessStack | null = null;
  private underwaterFogSystem: UnderwaterFogSystem | null = null;
  private cloudSystem: CloudSystem | null = null;
  private modelRenderer: ModelRenderer | null = null;
  private transformGizmo: TransformGizmo | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private debugOverlay: DebugOverlay | null = null;
  private debugRaycast: DebugRaycast | null = null;

  // Flashlight toggle state
  private flashlightOn = false;

  // Scene inspector state
  private gizmoEnabled = false;
  private gizmoMode: GizmoMode = "translate";
  private gizmoDragging = false;
  private lastSceneSyncVersion = -1;

  // Callback fired after input is processed (for IPC input sync)
  onInputProcessed: (() => void) | null = null;

  private running = false;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;
  private lastDebugLog = 0;
  private elapsedTime = 0;
  private debugMode = false;
  private lastSceneSyncTime = 0;

  // Reusable arrays for dynamic wave sources (avoids per-frame allocation)
  private wakeArray = new Float32Array(16 * 6); // MAX_WAKES * WAKE_FLOATS
  private shoreArray = new Float32Array(128 * 4); // MAX_SHORES * SHORE_FLOATS

  // Reusable objects for per-frame camera/player data (avoids GC pressure)
  private pooledViewportPlayerPos = { x: 0, y: 0, z: 0 };
  private pooledFreecamPlayerPos = { x: 0, y: 0, z: 0 };
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

  // Frame rate limiter (fallback for X11 multi-monitor vsync issue where
  // requestAnimationFrame fires at the fastest monitor's refresh rate)
  private targetFrameTime = 0; // 0 = unlimited (use vsync)

  // Split-screen
  private viewportCount = 1;
  private viewports: { x: number; y: number; w: number; h: number }[] = [];

  // Canvas resize handling
  private resizeWatcher: CanvasResizeWatcher | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.updateViewports(1);
    this.resizeWatcher = new CanvasResizeWatcher(canvas, {
      onResize: (cssW, cssH, dpr) => {
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
          this.updateViewports(this.viewportCount);
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
      // Try high-performance first, then fallback to any adapter
      let adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance",
      });
      if (!adapter) {
        console.warn("No high-performance GPU adapter, trying low-power...");
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: "low-power",
        });
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

      this.device = await adapter.requestDevice();

      // Capture silent WebGPU validation errors — without this, GPU errors
      // (e.g. from NaN/Infinity in uniforms) go completely unreported.
      this.device.onuncapturederror = function(ev: GPUUncapturedErrorEvent) {
        console.error(`[RENDERER] ${this.label} WebGPU uncaptured error: ${ev.error.message}`);
      };

      this.device.lost.then((info: any) => {
        this.deviceLost = true;
        console.error(`[RENDERER] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        // Attempt recovery by reloading the page after a short delay.
        // Full GPU resource recreation is too complex for inline recovery.
        setTimeout(() => {
          console.warn("[RENDERER] Attempting page reload for GPU recovery...");
          window.location.reload();
        }, 2000);
      });
      this.context = this.canvas.getContext("webgpu")!;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });

      // Initialize subsystems
      this.waterSystem = new WaterSystem(this.device, this.format);
      this.skySystem = new SkySystem(this.device, this.format);
      this.terrainSystem = new TerrainSystem(this.device, this.format);
      this.entityRenderer = new EntityRenderer(this.device, this.format);
      this.cameraSystem = new CameraSystem();
      this.lightingSystem = new LightSystem(this.device);
      this.particleSystem = new ParticleSystem(this.device, this.format);

      await this.waterSystem.init();
      await this.skySystem.init();
      await this.terrainSystem.init();
      this.lightingSystem.init();
      this.pbrSystem = new PBRSystem(this.device);
      this.pbrSystem.init();
      await this.entityRenderer.init(this.lightingSystem.getLightBindGroupLayout() ?? undefined, this.pbrSystem.getBindGroupLayout() ?? undefined);
      this.entityRenderer.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.entityRenderer.setPBRBindGroup(this.pbrSystem.getBindGroup()!);
      this.waterSystem.setLightBindGroup(this.lightingSystem.getLightBindGroup()!);
      this.lightingSystem.initDebugGizmos(this.format);
      if (this.boatReader) {
        this.entityRenderer.setBoatBufferReader(this.boatReader);
      }

      // Load player model — Mixamo rigged FBX, fall back to static model
      const riggedCharacterUrl = Object.values(riggedCharacterGlob)[0];
      const playerModelUrl = Object.values(playerModelGlob)[0];

      // Use white texture for character (FBX may have embedded textures or materials)
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

      // Load Mixamo animations and register with skeleton animator
      if (riggedLoaded) {
        const animator = this.entityRenderer.getSkeletonAnimator();
        if (animator) {
          // Map filenames to animation state names
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

      // Fall back to static player model if rigged loading failed
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
      // Load bed model for boat builder
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

      this.underwaterFogSystem = new UnderwaterFogSystem(this.device, this.format);
      this.underwaterFogSystem.init();

      // Cloud system — 3D volumetric cloud meshes (semi-transparent, wind-drifting)
      this.cloudSystem = new CloudSystem(this.device, this.format);
      await this.cloudSystem.init();

      // Model renderer for imported 3D models
      this.modelRenderer = new ModelRenderer(this.device, this.format);
      await this.modelRenderer.init();

      // Transform gizmo for scene editing
      this.transformGizmo = new TransformGizmo(this.device, this.format);
      await this.transformGizmo.init();

      // Label overlay for dev mode billboard labels
      this.labelOverlay = new LabelOverlay(this.canvas);

      // Debug overlay for chunk grid + velocity arrows
      this.debugOverlay = new DebugOverlay(this.canvas);

      // Debug raycast visualization (3D aim line + target highlight)
      this.debugRaycast = new DebugRaycast(this.device, this.format);
      this.debugRaycast.init();

      // Set up gizmo transform callback
      this.transformGizmo.onTransformUpdate = (transform) => {
        const selectedId = useSceneStore.getState().selectedId;
        if (!selectedId) return;
        useSceneStore.getState().updateNodeTransform(selectedId, transform);
      };

      console.log("[WebGPU] Renderer initialized");
      return true;
    } catch (err) {
      console.error("[WebGPU] Init failed:", err);
      return false;
    }
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
  }

  setBoatBuffer(boatBuffer: SharedArrayBuffer): void {
    this.boatSAB = boatBuffer;
    this.boatReader = new BoatBufferReader(boatBuffer);
    this.entityRenderer?.setBoatBufferReader(this.boatReader);
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
    } else {
      this.targetFrameTime = 0;
    }
  }

  private deviceLost = false;
  private lastInvalidLog = 0;
  private simWasValid = false;

  // Previous player positions for velocity computation (per viewport)
  private prevPlayerPos: { x: number; y: number; z: number }[] = [];

  private render = (): void => {
    if (!this.running || !this.device || !this.context) {
      requestAnimationFrame(this.render);
      return;
    }

    if (this.deviceLost) {
      // Device is gone — don't spin the CPU, reload is scheduled by device.lost handler
      return;
    }

    try {
      this.renderFrame();
    } catch (err) {
      console.error(`[RENDERER] Render loop error: ${(err as Error).message}\n${(err as Error).stack}`);
      // Check if device was lost
      if (this.device?.lost) {
        this.device.lost.then((info: any) => {
          this.deviceLost = true;
          console.error(`[RENDERER] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        });
      }
      // Schedule next frame on error to prevent permanent freeze
      requestAnimationFrame(this.render);
    }
  };

  private renderFrame(): void {

    const now = performance.now();

    // Frame rate limiter: skip this frame if not enough time has passed since
    // the last rendered frame. This caps GPU work when vsync is tied to the
    // fastest monitor (X11 multi-monitor issue).
    if (this.targetFrameTime > 0 && (now - this.lastTime) < this.targetFrameTime) {
      requestAnimationFrame(this.render);
      return;
    }
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsedTime += dt;

    // FPS counter
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // Update camera mouse look before processInput zeroes mouseDelta
    if (this.cameraSystem && this.simReader && this.simReader.isValid()) {
      const playerSlot0 = this.simReader.getPlayerSlot(0);
      if (playerSlot0) {
        const cameraMode = playerSlot0.u32[PLR.CAMERA_MODE] as CameraMode;
        const heading = playerSlot0.f32[PLR.HEADING];
        const pitch = playerSlot0.f32[PLR.PITCH] ?? 0;

        if (cameraMode === CameraMode.FreeCam) {
          const playerPos = this.pooledFreecamPlayerPos;
          playerPos.x = playerSlot0.f32[PLR.POS_X];
          playerPos.y = playerSlot0.f32[PLR.POS_Y];
          playerPos.z = playerSlot0.f32[PLR.POS_Z];

          // Handle mode transitions
          if (this.prevCameraMode !== CameraMode.FreeCam) {
            this.cameraSystem.resetFreecam(playerPos, heading, pitch);
          }
          this.prevCameraMode = cameraMode;

          this.cameraSystem.updateFreecam(
            this.keysDown,
            this.mouseDelta,
            dt,
            playerPos,
            heading,
            pitch,
          );
        } else {
          if (this.prevCameraMode === CameraMode.FreeCam) {
            this.cameraSystem.clearFreecam();
            // Reset look to SAB heading/pitch when leaving freecam
            this.cameraSystem.resetLook(heading, pitch);
          } else if (this.prevCameraMode !== cameraMode) {
            // Mode changed between 1st/3rd person — reset look
            this.cameraSystem.resetLook(heading, pitch);
          }
          this.prevCameraMode = cameraMode;

          // Renderer-side mouse look for 1st/3rd person (smooth full-framerate)
          const simTick = this.simReader.getTick();
          this.cameraSystem.updateLook(
            this.mouseDelta,
            simTick,
            heading,
            pitch,
            cameraMode,
          );
        }
      }
    }

    // Process input → write to input buffer
    this.processInput();
    this.onInputProcessed?.();

    // Tick particle system once per frame (spawn + update)
    if (this.particleSystem && this.simReader && this.simReader.isValid()) {
      const weatherType = this.simReader.getWeatherType() as WeatherType;
      const playerSlot0 = this.simReader.getPlayerSlot(0);
      const camPos = this.pooledDummyCamPos;
      if (playerSlot0) {
        camPos[0] = playerSlot0.f32[PLR.POS_X];
        camPos[1] = playerSlot0.f32[PLR.POS_Y];
        camPos[2] = playerSlot0.f32[PLR.POS_Z];
      } else {
        camPos[0] = 0; camPos[1] = 10; camPos[2] = 0;
      }
      const dummyCamera = this.pooledDummyCamera;
      dummyCamera.target[0] = camPos[0];
      dummyCamera.target[1] = camPos[1];
      dummyCamera.target[2] = camPos[2] - 1;
      dummyCamera.aspect = this.canvas.width / this.canvas.height;
      this.particleSystem.tick(dt, dummyCamera, weatherType);
    }

    // Render each viewport
    const usePixelation = this.pixelationSystem?.isEnabled() ?? false;
    const usePostProcess = this.postProcessStack?.hasEnabledEffects() ?? false;

    if (usePixelation) {
      this.pixelationSystem!.ensureTargets(this.canvas.width, this.canvas.height);
      for (let v = 0; v < this.viewportCount; v++) {
        this.renderViewport(v, dt, "pixelation");
      }
      const canvasView = this.context!.getCurrentTexture().createView();
      const postEncoder = this.device!.createCommandEncoder();
      this.pixelationSystem!.applyPostprocess(postEncoder, canvasView, this.canvas.width, this.canvas.height);
      this.device!.queue.submit([postEncoder.finish()]);
    } else if (usePostProcess) {
      this.postProcessStack!.ensureTargets(this.canvas.width, this.canvas.height);
      for (let v = 0; v < this.viewportCount; v++) {
        this.renderViewport(v, dt, "postprocess");
      }
      const canvasView = this.context!.getCurrentTexture().createView();
      const postEncoder = this.device!.createCommandEncoder();
      this.postProcessStack!.applyChain(
        postEncoder,
        this.postProcessStack!.getSceneDepthView(),
        canvasView,
        this.canvas.width, this.canvas.height,
      );
      this.device!.queue.submit([postEncoder.finish()]);
    } else {
      for (let v = 0; v < this.viewportCount; v++) {
        this.renderViewport(v, dt, "none");
      }
    }

    requestAnimationFrame(this.render);
  };

  private renderViewport(viewportIdx: number, dt: number, offscreenMode: "none" | "pixelation" | "postprocess" = "none"): void {
    if (!this.device || !this.context || !this.simReader) return;
    if (!this.simReader.isValid()) {
      if (this.simWasValid && viewportIdx === 0 && performance.now() - (this.lastInvalidLog ?? 0) > 2000) {
        this.lastInvalidLog = performance.now();
        console.warn("[RENDERER] Sim buffer invalid — not rendering. Sim may not be ready or SAB corrupted.");
      }
      return;
    }
    this.simWasValid = true;

    const origViewport = this.viewports[viewportIdx];
    if (!origViewport) return;

    const useOffscreen = offscreenMode !== "none";
    const viewport = offscreenMode === "pixelation"
      ? this.pixelationSystem!.scaleViewport(origViewport)
      : origViewport;

    // Get camera for this viewport/player
    const playerSlot = this.simReader.getPlayerSlot(viewportIdx);
    if (!playerSlot) {
      if (this.debugMode && performance.now() - (this.lastDebugLog ?? 0) > 1000) {
        console.log("[Render] No player slot for viewport", viewportIdx);
        this.lastDebugLog = performance.now();
      }
      return;
    }

    const playerF32 = playerSlot.f32;
    const playerU32 = playerSlot.u32;

    const playerPos = this.pooledViewportPlayerPos;
    playerPos.x = Number.isFinite(playerF32[PLR.POS_X]) ? playerF32[PLR.POS_X] : 0;
    playerPos.y = Number.isFinite(playerF32[PLR.POS_Y]) ? playerF32[PLR.POS_Y] : 0;
    playerPos.z = Number.isFinite(playerF32[PLR.POS_Z]) ? playerF32[PLR.POS_Z] : 0;

    const heading = Number.isFinite(playerF32[PLR.HEADING]) ? playerF32[PLR.HEADING] : 0;
    const pitch = Number.isFinite(playerF32[PLR.PITCH] ?? NaN) ? playerF32[PLR.PITCH] : 0;
    const cameraMode = playerU32[PLR.CAMERA_MODE] as CameraMode;

    // Sync third-person distance from SAB to CameraSystem
    if (this.cameraSystem) {
      const sabDist = playerF32[PLR.THIRD_PERSON_DISTANCE] ?? 12;
      this.cameraSystem.setThirdPersonDistance(sabDist);
    }

    // Third-person zoom: = zooms in, - zooms out
    if (cameraMode === CameraMode.ThirdPerson && this.cameraSystem) {
      const zoomSpeed = 100 * dt;
      if (this.keysDown.has(187)) {
        this.cameraSystem.setThirdPersonDistance(this.cameraSystem.getThirdPersonDistance() - zoomSpeed);
      }
      if (this.keysDown.has(189)) {
        this.cameraSystem.setThirdPersonDistance(this.cameraSystem.getThirdPersonDistance() + zoomSpeed);
      }
    }

    // Calculate camera
    const aspect = viewport.w / viewport.h;
    const camera = this.cameraSystem!.calculateCamera(
      playerPos,
      heading,
      pitch,
      cameraMode,
      viewportIdx,
      dt,
      aspect,
    );

    // Update debug raycast (only in non-first-person modes)
    if (this.debugRaycast && cameraMode !== CameraMode.FirstPerson) {
      this.debugRaycast.update(
        this.simReader,
        this.boatReader,
        camera,
        this.cameraSystem!.getLookHeading(),
        this.cameraSystem!.getLookPitch(),
        cameraMode,
      );
    }

    // Debug log once per second — only when debug mode is enabled
    if (this.debugMode && performance.now() - (this.lastDebugLog ?? 0) > 1000) {
      const entityCount = this.simReader.getEntityCount();
      const playerCount = this.simReader.getPlayerCount();
      const tick = this.simReader.getTick();
      const waterValid = this.waterReader?.isValid() ?? false;
      const waterGrid = this.waterReader?.getGridSize() ?? 0;
      const keys = Array.from(this.keysDown).map(k => String.fromCharCode(k)).join(",");
      const entDetails = [];
      for (let e = 0; e < Math.min(entityCount, 4); e++) {
        const es = this.simReader.getEntitySlot(e);
        if (es) entDetails.push(`type=${es.u32[ENT.TYPE]} id=${es.u32[ENT.ID]} pos=(${es.f32[ENT.POS_X].toFixed(1)},${es.f32[ENT.POS_Y].toFixed(1)},${es.f32[ENT.POS_Z].toFixed(1)}) scale=${es.f32[ENT.SCALE].toFixed(1)}`);
      }
      console.log(`[Render] tick=${tick} entities=${entityCount} players=${playerCount} pos=(${playerPos.x.toFixed(1)},${playerPos.y.toFixed(1)},${playerPos.z.toFixed(1)}) heading=${heading.toFixed(2)} pitch=${pitch.toFixed(2)} camMode=${cameraMode} waterValid=${waterValid} waterGrid=${waterGrid} camPos=(${camera.position[0].toFixed(1)},${camera.position[1].toFixed(1)},${camera.position[2].toFixed(1)}) camTarget=(${camera.target[0].toFixed(1)},${camera.target[1].toFixed(1)},${camera.target[2].toFixed(1)}) keys=[${keys}] playerId=${playerU32[PLR.ENTITY_ID]} canvas=${this.canvas.width}x${this.canvas.height} viewport=${viewport.w}x${viewport.h} ents=[${entDetails.join(" | ")}]`);
      this.lastDebugLog = performance.now();
    }

    // Get weather for rendering
    const weatherType = this.simReader.getWeatherType() as WeatherType;
    const timeOfDay = this.simReader.getTimeOfDay();
    const visibility = this.simReader.getVisibility();
    const windSpeed = this.simReader.getWindSpeed();
    const windDir = this.simReader.getWindDir();
    const weatherIntensity = this.simReader.getWeatherIntensity();

    // Prepare entity uniforms before render pass (writeBuffer is a queue op,
    // so all writes must happen before submit for the render pass to see them)
    const entityCount = this.simReader.getEntityCount();
    const playerId = playerU32[PLR.ENTITY_ID];
    const lightingParams = this.lightingSystem!.getLightingParams(timeOfDay, weatherType, visibility);
    this.entityRenderer!.beginFrame(camera, viewport.w, viewport.h, {
      sunDir: lightingParams.sunDir,
      sunIntensity: lightingParams.sunIntensity,
      ambient: lightingParams.ambient,
      fogColor: lightingParams.fogColor,
    });

    // Begin dynamic light frame — collect lights during entity iteration
    this.lightingSystem!.beginFrame();

    // Player flashlight (toggle with F): spot light from camera position toward look direction
    if (this.flashlightOn) {
      const lookDir: [number, number, number] = [
        camera.target[0] - camera.position[0],
        camera.target[1] - camera.position[1],
        camera.target[2] - camera.position[2],
      ];
      const lookLen = Math.sqrt(lookDir[0] ** 2 + lookDir[1] ** 2 + lookDir[2] ** 2);
      if (lookLen > 0.001) {
        const dir: [number, number, number] = [lookDir[0] / lookLen, lookDir[1] / lookLen, lookDir[2] / lookLen];
        this.lightingSystem!.addSpotLight(
          [camera.position[0], camera.position[1], camera.position[2]],
          dir,
          [1.0, 0.95, 0.8],   // warm white
          1.5,                 // intensity (dimmed)
          25.0,                // radius (shrunk)
          Math.cos(Math.PI / 10),  // cosInner (18° half-angle, narrower)
          Math.cos(Math.PI / 8),   // cosOuter (22.5° half-angle, narrower)
        );
      }
    }

    // Update skeleton animator for skinned player model
    const animator = this.entityRenderer!.getSkeletonAnimator();
    if (animator) {
      const playerFlags = playerU32[PLR.FLAGS] ?? 0;
      // Compute velocity from position delta
      const prevPos = this.prevPlayerPos[viewportIdx] ?? { x: playerPos.x, y: playerPos.y, z: playerPos.z };
      const velX = (playerPos.x - prevPos.x) / dt;
      const velZ = (playerPos.z - prevPos.z) / dt;
      const velocity = Math.sqrt(velX * velX + velZ * velZ);
      this.prevPlayerPos[viewportIdx] = { x: playerPos.x, y: playerPos.y, z: playerPos.z };

      animator.update(dt, playerFlags, velocity);
      this.entityRenderer!.updateBoneLocalTransforms();
    }

    const drawEntityCount: number[] = [];
    let drawIdx = 0;
    let wakeCount = 0;
    let shoreCount = 0;
    for (let i = 0; i < entityCount; i++) {
      const entSlot = this.simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      if (entId === playerId && cameraMode === CameraMode.FirstPerson) continue;
      const type = entSlot.u32[ENT.TYPE] as EntityType;
      const ePos = {
        x: Number.isFinite(entSlot.f32[ENT.POS_X]) ? entSlot.f32[ENT.POS_X] : 0,
        y: Number.isFinite(entSlot.f32[ENT.POS_Y]) ? entSlot.f32[ENT.POS_Y] : 0,
        z: Number.isFinite(entSlot.f32[ENT.POS_Z]) ? entSlot.f32[ENT.POS_Z] : 0,
      };
      const scale = Number.isFinite(entSlot.f32[ENT.SCALE]) ? entSlot.f32[ENT.SCALE] : 1;
      const eRot = {
        x: Number.isFinite(entSlot.f32[ENT.ROT_X]) ? entSlot.f32[ENT.ROT_X] : 0,
        y: Number.isFinite(entSlot.f32[ENT.ROT_Y]) ? entSlot.f32[ENT.ROT_Y] : 0,
        z: Number.isFinite(entSlot.f32[ENT.ROT_Z]) ? entSlot.f32[ENT.ROT_Z] : 0,
        w: Number.isFinite(entSlot.f32[ENT.ROT_W]) ? entSlot.f32[ENT.ROT_W] : 1,
      };
      // For boat entities, find the matching boat buffer slot
      let boatSlot = -1;
      if ((type === EntityType.Ship || type === EntityType.SmallCraft) && this.boatReader && this.boatReader.isValid()) {
        const boatCount = this.boatReader.getBoatCount();
        for (let bs = 0; bs < boatCount; bs++) {
          if (this.boatReader.getBoatEntityId(bs) === entId) {
            boatSlot = bs;
            break;
          }
        }
        if (boatSlot < 0) {
          // entity not found in boat buffer — will render as cube
        }
      }

      // Register dynamic lights: boat lanterns + bioluminescent entities
      const lightTime = performance.now() / 1000;
      const entFlags = entSlot.u32[ENT.FLAGS];
      if (boatSlot >= 0 && this.boatReader) {
        const cells = this.boatReader.getBoatCells(boatSlot);
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          if (cell.type === BoatCellType.LANTERN) {
            // Local cell position in boat space
            const lx = cell.gridX * BOAT_CELL_WORLD_SIZE;
            const ly = cell.gridY * BOAT_LAYER_HEIGHT + 0.5;
            const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
            // Transform local → world using entity quaternion
            const qx = eRot.x, qy = eRot.y, qz = eRot.z, qw = eRot.w;
            // v' = q * v * q^-1  (rotate local point by quaternion)
            const tx = (1 - 2 * (qy * qy + qz * qz)) * lx + 2 * (qx * qy - qw * qz) * lz + 2 * (qx * qz + qw * qy) * ly;
            const ty = 2 * (qx * qy + qw * qz) * lx + (1 - 2 * (qx * qx + qz * qz)) * ly + 2 * (qy * qz - qw * qx) * lz;
            const tz = 2 * (qx * qz - qw * qy) * lx + 2 * (qy * qz + qw * qx) * ly + (1 - 2 * (qx * qx + qy * qy)) * lz;
            // Lantern flicker: fast sinusoidal + hash-based noise
            const flickerSeed = cell.gridX * 12.9898 + cell.gridZ * 78.233;
            const flicker = 0.85 + 0.1 * Math.sin(lightTime * 12.0 + flickerSeed) + 0.05 * Math.sin(lightTime * 27.0 + flickerSeed * 2.0);
            this.lightingSystem!.addPointLight(
              [ePos.x + tx, ePos.y + ty, ePos.z + tz],
              [1.0, 0.8, 0.4],  // warm orange lantern
              2.5 * flicker,     // intensity with flicker
              25.0,              // radius
            );
          }
        }
      }
      // Bioluminescent entities — per-species day/night gating
      // Deep water species always glow; surface species only at night
      if (entFlags & EntityFlags.Bioluminescent) {
        const isDeepWaterSpecies =
          type === EntityType.Jellyfish ||
          type === EntityType.Eel ||
          type === EntityType.DevilShrimp ||
          type === EntityType.Coral ||
          type === EntityType.Reef;
        const isNight = timeOfDay < 0.25 || timeOfDay > 0.75;
        if (isDeepWaterSpecies || isNight) {
          // Bioluminescent pulse: slow sinusoidal
          const pulseSeed = entId * 0.1;
          const pulse = 0.7 + 0.3 * Math.sin(lightTime * 2.0 + pulseSeed);
          this.lightingSystem!.addPointLight(
            [ePos.x, ePos.y, ePos.z],
            [0.2, 0.8, 1.0],  // cyan bioluminescent glow
            3.0 * pulse,       // intensity with pulse
            20.0,              // radius
          );
        }
      }
      // Port lights — dock illumination, pier lights, lighthouse sweep
      if (type === EntityType.Port) {
        const portSize = entSlot.f32[ENT.DATA + PORT_DATA.SIZE] ?? 0;
        const portFlicker = 0.9 + 0.1 * Math.sin(lightTime * 8.0 + entId * 0.7);

        // Central dock light — warm illumination over the dock area
        this.lightingSystem!.addPointLight(
          [ePos.x, ePos.y + scale * 0.3, ePos.z],
          [1.0, 0.85, 0.5],
          2.0 * portFlicker,
          scale * 1.5,
        );

        if (portSize >= PortSize.Medium) {
          // Pier end light — guides ships approaching at night
          this.lightingSystem!.addPointLight(
            [ePos.x, ePos.y + scale * 0.15, ePos.z + scale * 0.6],
            [1.0, 0.8, 0.4],
            1.5 * portFlicker,
            scale * 0.8,
          );
        }

        if (portSize >= PortSize.Large) {
          // Lighthouse — bright sweeping beam, high above the port
          const sweepAngle = lightTime * 0.5;
          const lhRadius = scale * 0.9;
          const lhHeight = scale * 1.2;
          this.lightingSystem!.addPointLight(
            [
              ePos.x + Math.cos(sweepAngle) * lhRadius * 0.3,
              ePos.y + lhHeight,
              ePos.z + Math.sin(sweepAngle) * lhRadius * 0.3,
            ],
            [0.9, 0.95, 1.0],
            4.0,
            scale * 3.0,
          );
        }
      }

      // Pass island metadata for decoration generation
      let islandMeta: { chunkX: number; chunkZ: number; biome: number; islandSize: number } | undefined;
      let portMeta: { chunkX: number; chunkZ: number; biome: number } | undefined;
      if (type === EntityType.Island) {
        // Distance cull: skip island mesh generation if beyond render distance
        const dx = ePos.x - camera.position[0];
        const dz = ePos.z - camera.position[2];
        const distSq = dx * dx + dz * dz;
        const renderDist = scale * 4 + 200; // 4x island radius + 200 unit margin
        if (distSq > renderDist * renderDist) {
          // Still count shore effect for water rendering
          if (shoreCount < 128) {
            const si = shoreCount * 4;
            this.shoreArray[si] = ePos.x;
            this.shoreArray[si + 1] = ePos.z;
            this.shoreArray[si + 2] = scale;
            this.shoreArray[si + 3] = 0.0; // cutoutRadius = 0
            shoreCount++;
          }
          continue;
        }
        islandMeta = {
          chunkX: entSlot.u32[ENT.CHUNK_X],
          chunkZ: entSlot.u32[ENT.CHUNK_Z],
          biome: entSlot.f32[ENT.DATA + ISLAND_DATA.BIOME],
          islandSize: entSlot.f32[ENT.DATA + ISLAND_DATA.SIZE],
        };
      } else if (type === EntityType.Port) {
        // Distance cull for port terrain (same logic as islands)
        const dx = ePos.x - camera.position[0];
        const dz = ePos.z - camera.position[2];
        const distSq = dx * dx + dz * dz;
        const renderDist = scale * 4 + 200;
        if (distSq <= renderDist * renderDist) {
          portMeta = {
            chunkX: entSlot.u32[ENT.CHUNK_X],
            chunkZ: entSlot.u32[ENT.CHUNK_Z],
            biome: entSlot.f32[ENT.DATA + 5], // PORT_DATA.BIOME
          };
        }
      }

      // Route entity to instanced or individual render path
      if (EntityRenderer.isInstancedType(type)) {
        // Instanced entities (fish, sharks, jellyfish, pirates, etc.) — batch into one draw call
        this.entityRenderer!.writeInstanceData(ePos, scale, eRot, type, entFlags);
        if (this.entityRenderer!.isHitboxVisible()) {
          this.entityRenderer!.writeInstancedHitbox(ePos, scale, eRot);
        }
      } else {
        // Non-instanced entities (players, ships, islands, ports) — individual draw calls
        this.entityRenderer!.writeEntityUniforms(drawIdx, type, ePos, scale, eRot, boatSlot, islandMeta, portMeta, entFlags);
        drawEntityCount.push(i);
        drawIdx++;
      }

      // Collect dynamic wave sources
      if (wakeCount < 16 && (type === EntityType.Ship || type === EntityType.SmallCraft || type === EntityType.PirateShip)) {
        const vx = entSlot.f32[ENT.VEL_X] || 0;
        const vz = entSlot.f32[ENT.VEL_Z] || 0;
        const speed = Math.sqrt(vx * vx + vz * vz);
        if (speed > 0.5) {
          // Extract heading (yaw around Y) from quaternion
          const qx = eRot.x, qy = eRot.y, qz = eRot.z, qw = eRot.w;
          const yaw = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz));
          const wi = wakeCount * 6;
          this.wakeArray[wi] = ePos.x;
          this.wakeArray[wi + 1] = ePos.z;
          this.wakeArray[wi + 2] = Math.cos(yaw);
          this.wakeArray[wi + 3] = Math.sin(yaw);
          this.wakeArray[wi + 4] = speed;
          this.wakeArray[wi + 5] = 0; // pad
          wakeCount++;
        }
      }
      if (shoreCount < 128 && (type === EntityType.Island || type === EntityType.Port)) {
        const si = shoreCount * 4;
        this.shoreArray[si] = ePos.x;
        this.shoreArray[si + 1] = ePos.z;
        this.shoreArray[si + 2] = scale;
        // Port: cutout water in dock area for shoreline blend; Island: no cutout here
        this.shoreArray[si + 3] = type === EntityType.Port ? scale * 0.25 : 0.0;
        shoreCount++;

        // For islands, push one cutout source per peak blob
        if (type === EntityType.Island) {
          const chunkX = entSlot.u32[ENT.CHUNK_X];
          const chunkZ = entSlot.u32[ENT.CHUNK_Z];
          const blobs = generateIslandBlobs(chunkX, chunkZ);
          for (let b = 0; b < blobs.length; b++) {
            if (shoreCount >= 128) break;
            const blob = blobs[b];
            if (blob.heightMul <= 0.1) continue; // only peak blobs get cutouts
            const bi = shoreCount * 4;
            this.shoreArray[bi] = blob.x * scale + ePos.x;
            this.shoreArray[bi + 1] = blob.z * scale + ePos.z;
            this.shoreArray[bi + 2] = 0.0; // radius = 0 (no damping)
            this.shoreArray[bi + 3] = blob.radius * scale; // cutoutRadius
            shoreCount++;
          }
        }
      }
    }

    // Update water dynamic sources (wakes + shores) before render pass
    if (viewportIdx === 0) {
      this.waterSystem!.updateDynamics(this.wakeArray, wakeCount, this.shoreArray, shoreCount);
    }

    // Process pending island chunk streaming and terrain deformations before the render pass
    // (only on first viewport to avoid multiplying time budget across viewports)
    if (viewportIdx === 0) {
      this.entityRenderer!.processPendingDeformations();
      this.entityRenderer!.processIslandChunkStream(camera.position[0], camera.position[2]);
    }

    // Update cloud system (wind drift, slot recycling, mesh streaming)
    if (viewportIdx === 0 && this.cloudSystem) {
      this.cloudSystem.update(
        dt, playerPos, windDir.x, windDir.z, windSpeed, weatherType,
      );
    }

    // Upload dynamic lights to GPU (cull by distance, sort nearest-first, write to storage buffer)
    this.lightingSystem!.upload([camera.position[0], camera.position[1], camera.position[2]]);

    // Upload instanced entity data to GPU storage buffer (one bulk write for all instanced entities)
    this.entityRenderer!.uploadInstanceData();

    // Render
    const encoder = this.device.createCommandEncoder();

    // Dispatch GPU skinning compute shader before render pass
    this.entityRenderer!.dispatchSkinningCompute(encoder);

    // Render pass: sky + water + terrain + entities + particles
    const colorView = offscreenMode === "pixelation"
      ? this.pixelationSystem!.getOffscreenColorView()
      : offscreenMode === "postprocess"
      ? this.postProcessStack!.getSceneColorView()
      : this.context!.getCurrentTexture().createView();

    const depthView = offscreenMode === "pixelation"
      ? this.pixelationSystem!.getOffscreenDepthView()
      : offscreenMode === "postprocess"
      ? this.postProcessStack!.getSceneDepthView()
      : this.createDepthTexture(origViewport.w, origViewport.h);

    // First viewport clears the offscreen target; subsequent viewports load
    // to preserve previously rendered viewports.
    const isFirst = viewportIdx === 0;
    const loadOp: GPULoadOp = useOffscreen && !isFirst ? "load" : "clear";

    const passEncoder = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 },
        loadOp,
        storeOp: "store" as GPUStoreOp,
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: loadOp,
        depthStoreOp: "store" as GPUStoreOp,
      },
    });

    passEncoder.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
    passEncoder.setScissorRect(viewport.x, viewport.y, viewport.w, viewport.h);

    // Render sky
    this.skySystem!.render(passEncoder, camera, timeOfDay, weatherType, this.elapsedTime);

    // Render terrain (before water so terrain writes depth first)
    this.terrainSystem!.render(passEncoder, camera, playerPos);

    // Render entities before water so boat hulls write depth first.
    // This prevents the water plane from clipping through the far side of the boat —
    // water inside the hull fails the depth test and isn't drawn.
    // Water (semi-transparent) still blends over submerged hull parts correctly.

    // Instanced entities (fish, sharks, jellyfish, pirates, etc.) — single draw call
    this.entityRenderer!.renderInstanced(passEncoder);

    // Non-instanced entities (players, ships, islands, ports) — individual draw calls
    for (let d = 0; d < drawEntityCount.length; d++) {
      this.entityRenderer!.render(passEncoder, d);
    }
    // Render anchor 3D meshes before water (proper depth-tested, lit geometry)
    this.entityRenderer!.renderAnchors(passEncoder, this.simReader);

    // Render clouds (semi-transparent, depth-tested, no depth write)
    // After terrain and entities so clouds blend over them;
    // before water so water can blend over clouds at the horizon.
    if (this.cloudSystem) {
      // Compute moon direction (opposite of sun)
      const moonDir: [number, number, number] = [
        -lightingParams.sunDir[0],
        -lightingParams.sunDir[1],
        -lightingParams.sunDir[2],
      ];
      const moonIntensity = Math.max(0, -Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2));
      this.cloudSystem.render(
        passEncoder, camera, timeOfDay, weatherType,
        windSpeed, windDir.x, windDir.z, this.elapsedTime, playerPos,
        lightingParams.sunDir, lightingParams.sunIntensity,
        moonDir, moonIntensity,
        lightingParams.fogColor, 0.0008,
      );
    }

    // Render water (semi-transparent, blends over terrain and submerged entities)
    if (this.waterReader) {
      this.waterSystem!.render(
        passEncoder, camera, this.waterReader, timeOfDay, weatherType, visibility,
        windSpeed, windDir.x, windDir.z, weatherIntensity,
        lightingParams.sunDir, lightingParams.sunIntensity,
      );
    }

    // Render hitbox debug overlay
    this.entityRenderer!.renderHitboxes(passEncoder);

    // Render debug raycast (aim line + target highlight)
    this.debugRaycast?.render(passEncoder);

    // Render light debug gizmos (wireframe spheres showing light radius)
    this.lightingSystem!.renderDebugGizmos(passEncoder, camera);

    // Sync sim entities to scene store (for DevTools inspector) — throttled to 2fps
    if (viewportIdx === 0) {
      const now = performance.now();
      if (now - this.lastSceneSyncTime > 500) {
        this.lastSceneSyncTime = now;
        this.syncSceneEntities();
      }
    }

    // Update dev label overlay (only for first viewport to avoid duplicate labels)
    if (this.labelOverlay && viewportIdx === 0) {
      const storeState = useSceneStore.getState();
      const shouldBeActive = storeState.showLabels;
      if (shouldBeActive !== this.labelOverlay.isActive()) {
        this.labelOverlay.setActive(shouldBeActive);
      }
      if (shouldBeActive) {
        this.labelOverlay.update(camera, this.simReader, origViewport);
      }
    }

    // Update debug overlay (chunk grid + velocity arrows)
    if (this.debugOverlay && viewportIdx === 0) {
      this.debugOverlay.update(camera, this.simReader, origViewport);
    }

    // Render imported models
    if (this.modelRenderer && viewportIdx === 0) {
      this.modelRenderer.beginFrame(camera);
      const sceneState = useSceneStore.getState();
      for (const nodeId of sceneState.rootIds) {
        const node = sceneState.nodes[nodeId];
        if (!node || !node.visible || node.type !== "model") continue;
        this.modelRenderer.render(
          passEncoder,
          node.id,
          node.position,
          node.rotation,
          node.scale,
        );
      }
    }

    // Render holo preview for boat building (if player is onboard a ship)
    if (this.boatReader && this.boatReader.isValid()) {
      // Find the ship entity to get its position/rotation
      for (let i = 0; i < entityCount; i++) {
        const entSlot = this.simReader.getEntitySlot(i);
        if (!entSlot) continue;
        const type = entSlot.u32[ENT.TYPE] as EntityType;
        if (type !== EntityType.Ship) continue;
        const sPos = {
          x: entSlot.f32[ENT.POS_X],
          y: entSlot.f32[ENT.POS_Y],
          z: entSlot.f32[ENT.POS_Z],
        };
        const sRot = {
          x: entSlot.f32[ENT.ROT_X],
          y: entSlot.f32[ENT.ROT_Y],
          z: entSlot.f32[ENT.ROT_Z],
          w: entSlot.f32[ENT.ROT_W],
        };
        this.entityRenderer!.renderHoloPreview(passEncoder, sPos, sRot);
        break; // only one ship for now
      }
    }

    // Render particles (rain, snow, etc.)
    this.particleSystem!.render(passEncoder, camera, weatherType, timeOfDay);

    // Render transform gizmo (always on top, no depth test)
    if (this.transformGizmo && this.transformGizmo.isVisible() && viewportIdx === 0) {
      this.transformGizmo.render(passEncoder, camera);
    }

    // Underwater fog overlay — only when the camera itself is below the water surface
    const camWaterHeight = this.sampleWaterHeightAt(camera.position[0], camera.position[2]);
    const camDepth = camWaterHeight - camera.position[1];
    if (camDepth > 0) {
      this.underwaterFogSystem!.render(passEncoder, camDepth, this.elapsedTime);
    }

    passEncoder.end();

    this.device.queue.submit([encoder.finish()]);

    // Only clean up stale meshes after the LAST viewport's submit.
    // Destroying buffers between viewports causes "buffer used in submit while
    // destroyed" errors because subsequent viewports still reference them.
    if (viewportIdx === this.viewportCount - 1) {
      this.entityRenderer!.cleanupStaleDecorations();
      this.entityRenderer!.cleanupStaleIslandMeshes();
    }
  }

  private depthTextures = new Map<string, GPUTexture>();

  private createDepthTexture(w: number, h: number): GPUTextureView {
    if (!this.device) throw new Error("No device");
    const key = `${w}x${h}`;
    let tex = this.depthTextures.get(key);
    if (!tex) {
      tex = this.device.createTexture({
        size: [w, h],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthTextures.set(key, tex);
    }
    return tex.createView();
  }

  private processInput(): void {
    if (!this.inputWriter) return;

    // Keyboard
    const keysDown = this.getKeysDown();
    for (let p = 0; p < this.viewportCount; p++) {
      // Reset all keys for this player
      for (let k = 0; k < 256; k++) {
        this.inputWriter.setKey(p, k, false);
      }
      // Set pressed keys
      for (let j = 0; j < keysDown.length; j++) {
        this.inputWriter.setKey(p, keysDown[j], true);
      }
    }

    // Mouse
    const mouse = this.getMouseState();
    const md = this.mouseDelta;
    for (let p = 0; p < this.viewportCount; p++) {
      this.inputWriter.setMousePos(p, mouse.x, mouse.y);
      this.inputWriter.setMouseButton(p, 0, mouse.left);
      this.inputWriter.setMouseButton(p, 2, mouse.right);
      this.inputWriter.setWheel(p, mouse._wheel);
      this.inputWriter.setMouseDelta(p, md.dx, md.dy);
    }
    this.mouseDelta.dx = 0;
    this.mouseDelta.dy = 0;

    // Write current third-person zoom distance to input buffer
    if (this.cameraSystem) {
      const zoom = this.cameraSystem.getThirdPersonDistance();
      const lookHeading = this.cameraSystem.getLookHeading();
      const lookPitch = this.cameraSystem.getLookPitch();
      for (let p = 0; p < this.viewportCount; p++) {
        this.inputWriter.setCameraZoom(p, zoom);
        this.inputWriter.setLookHeading(p, lookHeading);
        this.inputWriter.setLookPitch(p, lookPitch);
      }
    }

    // Write builder cell type and rotation from gameStore
    const gs = useGameStore.getState();
    const builderCellType = gs.builderCellType;
    const builderRotation = gs.builderRotation;
    for (let p = 0; p < this.viewportCount; p++) {
      this.inputWriter.setBuilderCellType(p, builderCellType);
      this.inputWriter.setBuilderRotation(p, builderRotation);
    }

    this.inputWriter.setPlayerCount(this.viewportCount);
    this.inputWriter.incrementSequence();
  }

  // Input state tracking
  private keysDown = new Set<number>();
  private mouseState = { x: 0, y: 0, left: false, right: false, wheel: 0, _wheel: 0 };
  private mouseDelta = { dx: 0, dy: 0 };
  private pointerLocked = false;
  private prevKeysDown = new Set<number>();
  private prevCameraMode: CameraMode = CameraMode.FirstPerson;
  private pointerLockRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerLockRetryCount = 0;

  lockPointer(): void {
    if (this.pointerLocked) return;
    this.pointerLockRetryCount = 0;
    this.tryLockPointer();
  }

  private tryLockPointer(): void {
    if (this.pointerLocked) return;
    if (this.pointerLockRetryCount >= 20) return;
    this.pointerLockRetryCount++;
    try {
      this.canvas.requestPointerLock();
    } catch (_e) {
      // ignore — fallback timer below will retry
    }
    // Always schedule a check: if pointerlockchange doesn't fire within
    // 300ms (silent failure during ESC cooldown), retry.
    if (this.pointerLockRetryTimer) clearTimeout(this.pointerLockRetryTimer);
    this.pointerLockRetryTimer = setTimeout(() => {
      this.pointerLockRetryTimer = null;
      if (!this.pointerLocked) this.tryLockPointer();
    }, 300);
  }

  private schedulePointerLockRetry(): void {
    if (this.pointerLockRetryTimer) clearTimeout(this.pointerLockRetryTimer);
    if (this.pointerLockRetryCount >= 10) return;
    this.pointerLockRetryCount++;
    this.pointerLockRetryTimer = setTimeout(() => this.tryLockPointer(), 200);
  }

  private getKeysDown(): number[] {
    return Array.from(this.keysDown);
  }

  private getMouseState() {
    const wheel = this.mouseState.wheel;
    this.mouseState.wheel = 0; // reset after read
    this.mouseState._wheel = wheel; // store non-reset wheel for caller
    return this.mouseState;
  }

  private lastBuilderWheelTime = 0;

  private tryOpenBuilderWheel(): void {
    // Debounce: mousedown and contextmenu can both fire for the same right-click
    const now = performance.now();
    if (now - this.lastBuilderWheelTime < 200) return;
    this.lastBuilderWheelTime = now;

    const gs = useGameStore.getState();
    if (gs.showBuilderWheel) return;
    if (!this.simReader?.isValid()) return;
    const slot = this.simReader.getPlayerSlot(0);
    if (!slot) return;
    const activeSlot = slot.u32[PLR.ACTIVE_SLOT] ?? 0;
    const flags = slot.u32[PLR.FLAGS];
    if (activeSlot !== 0 || (flags & PLR_FLAG.ONBOARD) === 0) return;
    // Don't open if any other overlay is open
    const anyOverlay = gs.showSettings || gs.showPauseMenu || gs.showInventory ||
      gs.showMap || gs.showBuildMenu || gs.showCraftMenu || gs.showFishingMinigame ||
      gs.showTradeMenu || gs.showCharacterCustomization;
    if (anyOverlay) return;
    gs.setSuppressPauseMenu(true);
    gs.setShowBuilderWheel(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private tryBuilderRotate(direction: number): void {
    if (!this.simReader?.isValid()) return;
    const slot = this.simReader.getPlayerSlot(0);
    if (!slot) return;
    const activeSlot = slot.u32[PLR.ACTIVE_SLOT] ?? 0;
    const flags = slot.u32[PLR.FLAGS];
    if (activeSlot !== 0 || (flags & PLR_FLAG.ONBOARD) === 0) return;
    const gs = useGameStore.getState();
    const anyOverlay = gs.showSettings || gs.showPauseMenu || gs.showInventory ||
      gs.showMap || gs.showBuildMenu || gs.showCraftMenu || gs.showFishingMinigame ||
      gs.showTradeMenu || gs.showCharacterCustomization ||
      gs.showBuilderWheel;
    if (anyOverlay) return;
    gs.setBuilderRotation(gs.builderRotation + direction);
  }

  setupInputListeners(): void {
    window.addEventListener("keydown", (e) => {
      this.keysDown.add(e.keyCode);
      // Builder rotation: R or ] = rotate CW, [ = rotate CCW (only when builder tool active)
      if (!e.repeat && (e.keyCode === KEY.R || e.keyCode === KEY.BRACKET_LEFT || e.keyCode === KEY.BRACKET_RIGHT)) {
        this.tryBuilderRotate(e.keyCode === KEY.BRACKET_LEFT ? -1 : 1);
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.keyCode);
    });
    this.canvas.addEventListener("click", () => {
      if (!this.pointerLocked) {
        this.pointerLockRetryCount = 0;
        this.tryLockPointer();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      const wasLocked = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      console.log(`[PointerLock] change: locked=${this.pointerLocked} wasLocked=${wasLocked} element=${document.pointerLockElement?.tagName ?? 'null'}`);
      if (this.pointerLocked) {
        this.pointerLockRetryCount = 0;
        if (this.pointerLockRetryTimer) {
          clearTimeout(this.pointerLockRetryTimer);
          this.pointerLockRetryTimer = null;
        }
      } else if (wasLocked) {
        this.keysDown.clear();
        this.mouseState.left = false;
        this.mouseState.right = false;
        this.mouseDelta.dx = 0;
        this.mouseDelta.dy = 0;
      }
    });
    document.addEventListener("pointerlockerror", () => {
      // No action needed — tryLockPointer's fallback timer will retry.
    });
    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.mouseState.left = false;
      this.mouseState.right = false;
      this.mouseDelta.dx = 0;
      this.mouseDelta.dy = 0;
    });
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseState.x = e.clientX - rect.left;
      this.mouseState.y = e.clientY - rect.top;
      if (this.pointerLocked) {
        this.mouseDelta.dx += e.movementX;
        this.mouseDelta.dy += e.movementY;
      }
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseState.left = true;
      if (e.button === 2) {
        this.mouseState.right = true;
        this.tryOpenBuilderWheel();
      }
    });
    this.canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseState.left = false;
      if (e.button === 2) this.mouseState.right = false;
    });
    this.canvas.addEventListener("wheel", (e) => {
      this.mouseState.wheel = e.deltaY;
    });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.tryOpenBuilderWheel();
    });
  }

  toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
  }

  getFPS(): number {
    return this.fps;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  setShowHitboxes(show: boolean): void {
    this.entityRenderer?.setShowHitboxes(show);
  }

  setShowLightGizmos(show: boolean): void {
    if (this.lightingSystem) this.lightingSystem.showDebugGizmos = show;
  }

  setShowRaycast(show: boolean): void {
    this.debugRaycast?.setShow(show);
  }

  getEntityRenderer(): EntityRenderer | null {
    return this.entityRenderer;
  }

  setHitboxLineWidth(width: number): void {
    this.entityRenderer?.setHitboxLineWidth(width);
  }

  getHitboxLineWidth(): number {
    return this.entityRenderer?.getHitboxLineWidth() ?? 3;
  }

  setShowChunkGrid(show: boolean): void {
    this.debugOverlay?.setShowChunkGrid(show);
  }

  isChunkGridVisible(): boolean {
    return this.debugOverlay?.isChunkGridVisible() ?? false;
  }

  setShowVelocityArrows(show: boolean): void {
    this.debugOverlay?.setShowVelocityArrows(show);
  }

  isVelocityArrowsVisible(): boolean {
    return this.debugOverlay?.isVelocityArrowsVisible() ?? false;
  }

  getSimReader(): SimBufferReader | null { return this.simReader; }
  getWaterReader(): WaterBufferReader | null { return this.waterReader; }
  getCanvasWidth(): number { return this.canvas.width; }
  getCanvasHeight(): number { return this.canvas.height; }
  getViewportWidth(idx: number): number { return this.viewports[idx]?.w ?? 0; }
  getViewportHeight(idx: number): number { return this.viewports[idx]?.h ?? 0; }

  setPixelationEnabled(enabled: boolean): void {
    this.pixelationSystem?.setEnabled(enabled);
  }

  setPixelSize(size: number): void {
    this.pixelationSystem?.setPixelSize(size);
  }

  setDepthEdgeStrength(strength: number): void {
    this.pixelationSystem?.setDepthEdgeStrength(strength);
  }

  setPostProcessEnabled(id: "fxaa" | "dof" | "sobel" | "afterimage" | "bloom" | "ascii", enabled: boolean): void {
    this.postProcessStack?.setEnabled(id, enabled);
  }

  setDOFFocusDist(v: number): void { this.postProcessStack?.setDOFFocusDist(v); }
  setDOFFocusRange(v: number): void { this.postProcessStack?.setDOFFocusRange(v); }
  setDOFMaxBlur(v: number): void { this.postProcessStack?.setDOFMaxBlur(v); }
  setAfterimageDamp(v: number): void { this.postProcessStack?.setAfterimageDamp(v); }
  setBloomThreshold(v: number): void { this.postProcessStack?.setBloomThreshold(v); }
  setBloomStrength(v: number): void { this.postProcessStack?.setBloomStrength(v); }
  setASCIICellSize(v: number): void { this.postProcessStack?.setASCIICellSize(v); }
  setASCIIUseColor(v: boolean): void { this.postProcessStack?.setASCIIUseColor(v); }

  setFirstPersonSensitivity(v: number): void { this.cameraSystem?.setFirstPersonSensitivity(v); }
  setThirdPersonSensitivity(v: number): void { this.cameraSystem?.setThirdPersonSensitivity(v); }
  setFreecamSensitivity(v: number): void { this.cameraSystem?.setFreecamSensitivity(v); }

  private sampleWaterHeightAt(x: number, z: number): number {
    if (!this.waterReader || !this.waterReader.isValid()) return 0;
    const patchSize = this.waterReader.getPatchSize() || 4;
    const origin = this.waterReader.getOrigin();
    const gx = ((x - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const gz = ((z - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    return this.waterReader.sampleHeight(gx, gz);
  }

  // --- Scene Inspector / DevTools Integration ---

  private syncSceneEntities(): void {
    if (!this.simReader || !this.simReader.isValid()) return;
    const entityCount = this.simReader.getEntityCount();
    const entities = [];
    for (let i = 0; i < entityCount; i++) {
      const entSlot = this.simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      const type = entSlot.u32[ENT.TYPE] as EntityType;
      entities.push({
        id: entId,
        type,
        typeName: EntityTypeNames[type] ?? `Type${type}`,
        position: [entSlot.f32[ENT.POS_X], entSlot.f32[ENT.POS_Y], entSlot.f32[ENT.POS_Z]] as [number, number, number],
        rotation: [entSlot.f32[ENT.ROT_X], entSlot.f32[ENT.ROT_Y], entSlot.f32[ENT.ROT_Z], entSlot.f32[ENT.ROT_W]] as [number, number, number, number],
        scale: entSlot.f32[ENT.SCALE],
      });
    }
    useSceneStore.getState().syncSimEntities(entities);

    // Sync gizmo visibility and position from store state
    const storeState = useSceneStore.getState();
    if (this.transformGizmo) {
      const selectedNode = storeState.selectedId ? storeState.getNode(storeState.selectedId) : null;
      const shouldBeVisible = storeState.gizmoVisible && storeState.selectedId !== null && selectedNode !== null && !selectedNode.locked;
      if (shouldBeVisible !== this.transformGizmo.isVisible()) {
        this.transformGizmo.setVisible(shouldBeVisible);
      }
      const selectedId = storeState.selectedId;
      if (selectedId) {
        const node = storeState.getNode(selectedId);
        if (node) {
          this.transformGizmo.setPosition(node.position);
        }
      }
    }
  }

  uploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    this.modelRenderer?.uploadModel(nodeId, meshes, materials);
  }

  removeModel(nodeId: string): void {
    this.modelRenderer?.removeModel(nodeId);
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.transformGizmo?.setMode(mode);
  }

  setGizmoVisible(visible: boolean): void {
    this.gizmoEnabled = visible;
    this.transformGizmo?.setVisible(visible);
  }

  setGizmoPosition(pos: [number, number, number]): void {
    this.transformGizmo?.setPosition(pos);
  }

  getPlayerWorldPos(viewportIdx: number): { x: number; y: number; z: number } | null {
    if (!this.simReader || !this.simReader.isValid()) return null;
    const playerSlot = this.simReader.getPlayerSlot(viewportIdx);
    if (!playerSlot) return null;
    return {
      x: playerSlot.f32[PLR.POS_X],
      y: playerSlot.f32[PLR.POS_Y],
      z: playerSlot.f32[PLR.POS_Z],
    };
  }

  // Gizmo mouse interaction — called from canvas mouse events when gizmo is active
  handleGizmoMouseDown(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
  ): boolean {
    if (!this.transformGizmo || !this.transformGizmo.isVisible() || !this.cameraSystem) return false;
    if (!this.simReader || !this.simReader.isValid()) return false;

    const playerSlot = this.simReader.getPlayerSlot(0);
    if (!playerSlot) return false;

    const playerPos = {
      x: playerSlot.f32[PLR.POS_X],
      y: playerSlot.f32[PLR.POS_Y],
      z: playerSlot.f32[PLR.POS_Z],
    };
    const heading = playerSlot.f32[PLR.HEADING];
    const pitch = playerSlot.f32[PLR.PITCH] ?? 0;
    const cameraMode = playerSlot.u32[PLR.CAMERA_MODE] as CameraMode;
    const aspect = canvasW / canvasH;
    const camera = this.cameraSystem.calculateCamera(
      playerPos, heading, pitch, cameraMode, 0, 0, aspect,
    );

    const hit = this.transformGizmo.hitTest(mouseX, mouseY, canvasW, canvasH, camera);
    if (hit) {
      const selectedId = useSceneStore.getState().selectedId;
      if (!selectedId) return false;
      const node = useSceneStore.getState().getNode(selectedId);
      if (!node || node.locked) return false;
      this.transformGizmo.startDrag(hit, mouseX, mouseY, canvasW, canvasH, camera, {
        position: node.position,
        rotation: node.rotation,
        scale: node.scale,
      });
      this.gizmoDragging = true;
      return true;
    }
    return false;
  }

  handleGizmoMouseMove(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
  ): void {
    if (!this.transformGizmo || !this.simReader || !this.simReader.isValid()) return;

    const playerSlot = this.simReader.getPlayerSlot(0);
    if (!playerSlot) return;

    const playerPos = {
      x: playerSlot.f32[PLR.POS_X],
      y: playerSlot.f32[PLR.POS_Y],
      z: playerSlot.f32[PLR.POS_Z],
    };
    const heading = playerSlot.f32[PLR.HEADING];
    const pitch = playerSlot.f32[PLR.PITCH] ?? 0;
    const cameraMode = playerSlot.u32[PLR.CAMERA_MODE] as CameraMode;
    const aspect = canvasW / canvasH;
    const camera = this.cameraSystem!.calculateCamera(
      playerPos, heading, pitch, cameraMode, 0, 0, aspect,
    );

    if (this.gizmoDragging) {
      this.transformGizmo.updateDrag(mouseX, mouseY, canvasW, canvasH, camera);
    }
  }

  handleGizmoMouseUp(): void {
    if (this.transformGizmo && this.gizmoDragging) {
      this.transformGizmo.endDrag();
      this.gizmoDragging = false;
    }
  }

  isGizmoDragging(): boolean {
    return this.gizmoDragging;
  }

  getBoatReader(): BoatBufferReader | null {
    return this.boatReader;
  }

  destroy(): void {
    this.running = false;
    this.resizeWatcher?.destroy();
    this.resizeWatcher = null;
    this.pixelationSystem?.destroy();
    this.postProcessStack?.destroy();
    this.modelRenderer?.destroy();
    this.transformGizmo?.destroy();
    this.labelOverlay?.destroy();
    this.debugOverlay?.destroy();
    this.debugRaycast?.destroy();
    this.device = null;
    for (const tex of this.depthTextures.values()) {
      tex.destroy();
    }
    this.depthTextures.clear();
  }
}
