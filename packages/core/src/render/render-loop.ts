import { mat4, type Mat4 } from "wgpu-matrix";
import type { DebugDrawQueue } from "../debug-draw/queue.ts";
import type { MeshData } from "../mesh/builder.ts";
import { HighResTimer } from "../platform/time.ts";
import { Camera } from "../scene/camera.ts";
import { TelemetryCollector } from "../telemetry/collector.ts";
import { UIRenderer } from "../ui/renderer.ts";
import { createLogger } from "../util/logger.ts";
import { GPUDeviceManager } from "./device.ts";
import { FrameGraph } from "./frame-graph.ts";
import { GBuffer } from "./g-buffer.ts";
import { createDefaultLightUniform, type LightUniformData } from "./lighting.ts";
import { DebugVizPass, type DebugVizMode } from "./passes/debug-viz.ts";
import { DebugRenderPass } from "./passes/debug.ts";
import { DeferredLightingPass } from "./passes/deferred-lighting.ts";
import { DepthPrepass } from "./passes/depth-prepass.ts";
import { OpaquePass, type OpaquePassMode, type PBRMaterialResources } from "./passes/opaque.ts";
import { DEFAULT_POST_PROCESS_SETTINGS, PostProcessPass, type PostProcessSettings } from "./passes/post-process.ts";
import { ShadowPass } from "./passes/shadow.ts";
import { SkyboxPass } from "./passes/skybox.ts";
import { TransparentPass } from "./passes/transparent.ts";
import { UICompositePass } from "./passes/ui-composite.ts";
import { SurfaceManager } from "./surface.ts";

const log = createLogger();

export interface RenderLoopConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  mesh: MeshData;
  camera: Camera;
  telemetry?: TelemetryCollector;
  clearColor?: { r: number; g: number; b: number; a: number };
  mode?: OpaquePassMode;
  debugQueue?: DebugDrawQueue;
  lightData?: LightUniformData;
  postProcessSettings?: Partial<PostProcessSettings>;
  pbrMaterial?: PBRMaterialResources;
}

export interface DebugToggleState {
  wireframe: boolean;
  hitboxes: boolean;
  normals: boolean;
  velocity: boolean;
  shadows: boolean;
  bloom: boolean;
  aabbs: boolean;
  overdraw: boolean;
  lod: boolean;
  depth: boolean;
  tangents: boolean;
  raycast: boolean;
}

export class RenderLoop {
  private deviceManager: GPUDeviceManager;
  private surface: SurfaceManager | null = null;
  private opaquePass: OpaquePass | null = null;
  private depthPrepass: DepthPrepass | null = null;
  private shadowPass: ShadowPass | null = null;
  private deferredPass: DeferredLightingPass | null = null;
  private transparentPass: TransparentPass | null = null;
  private skyboxPass: SkyboxPass | null = null;
  private postProcessPass: PostProcessPass | null = null;
  private debugPass: DebugRenderPass | null = null;
  private debugVizPass: DebugVizPass | null = null;
  private uiCompositePass: UICompositePass | null = null;
  private shadowsEnabled: boolean = true;
  private bloomEnabled: boolean = true;
  private gbuffer: GBuffer | null = null;
  private hdrTexture: GPUTexture | null = null;
  private hdrView: GPUTextureView | null = null;
  private shadowSampler: GPUSampler | null = null;
  private config: RenderLoopConfig;
  private timer: HighResTimer;
  private running: boolean = false;
  private rafId: number = 0;
  private width: number = 0;
  private height: number = 0;
  private prevViewProj: Mat4 = mat4.identity();
  private lightData: LightUniformData;
  private postProcessSettings: PostProcessSettings;
  private useDeferred: boolean;
  private frameGraph: FrameGraph | null = null;
  private autonomous: boolean;
  private alpha: number = 0;
  private frameDrawCalls: number = 0;
  private frameTriangles: number = 0;

  constructor(config: RenderLoopConfig) {
    this.deviceManager = new GPUDeviceManager();
    this.config = config;
    this.timer = new HighResTimer();
    this.lightData = config.lightData ?? createDefaultLightUniform();
    this.postProcessSettings = { ...DEFAULT_POST_PROCESS_SETTINGS, ...config.postProcessSettings };
    this.useDeferred = (config.mode ?? "gbuffer") === "gbuffer";
    this.autonomous = true;
  }

  async init(): Promise<boolean> {
    const device = await this.deviceManager.requestDevice();
    if (!device) {
      log.error("RenderLoop", "Failed to get GPU device");
      return false;
    }

    this.surface = new SurfaceManager(device);
    this.surface.configure(this.config.canvas, {
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const surfaceFormat = this.surface.getFormat() ?? "bgra8unorm";
    const canvas = this.config.canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    this.config.camera.setAspect(this.width, this.height);

    // Opaque pass
    this.opaquePass = new OpaquePass(device, surfaceFormat, this.useDeferred ? "gbuffer" : "simple");
    this.opaquePass.setMesh(this.config.mesh);
    if (this.config.pbrMaterial) {
      this.opaquePass.setPBRMaterial(this.config.pbrMaterial);
    }
    this.opaquePass.prepare(device);

    if (this.useDeferred) {
      // G-Buffer
      this.gbuffer = new GBuffer(device, this.width, this.height);

      // HDR intermediate texture for deferred output
      this.hdrTexture = device.createTexture({
        size: [this.width, this.height],
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      this.hdrView = this.hdrTexture.createView();

      // Depth prepass
      this.depthPrepass = new DepthPrepass(device);
      this.depthPrepass.prepare(device);

      // Shadow pass
      this.shadowPass = new ShadowPass(device);
      this.shadowPass.prepare(device);
      this.shadowSampler = device.createSampler({ compare: "less" });

      // Deferred lighting
      this.deferredPass = new DeferredLightingPass(device, "rgba16float", this.width, this.height);
      this.deferredPass.prepare(device);
      this.deferredPass.updateLights(this.lightData);

      // Skybox
      this.skyboxPass = new SkyboxPass(device, "rgba16float");
      this.skyboxPass.prepare(device);

      // Post-process
      this.postProcessPass = new PostProcessPass(device, surfaceFormat, this.width, this.height);
      this.postProcessPass.prepare(device);
      this.postProcessPass.setSettings(this.postProcessSettings);
    }

    // Transparent pass (works in both modes)
    this.transparentPass = new TransparentPass(device, this.useDeferred ? "rgba16float" : surfaceFormat);
    this.transparentPass.prepare(device);

    // Debug pass
    this.debugPass = new DebugRenderPass(surfaceFormat);
    if (this.config.debugQueue) {
      this.debugPass.setDebugQueue(this.config.debugQueue);
    }
    this.debugPass.prepare(device);

    // Debug visualization pass
    this.debugVizPass = new DebugVizPass(surfaceFormat);
    this.debugVizPass.prepare(device);

    // UI composite pass
    this.uiCompositePass = new UICompositePass();
    this.uiCompositePass.setRenderer(new UIRenderer(surfaceFormat));
    this.uiCompositePass.prepare(device);

    this.prevViewProj = this.config.camera.getViewProjectionMatrix();

    this.deviceManager.onDeviceLost(() => {
      log.warn("RenderLoop", "Device lost, attempting reinit...");
      this.handleDeviceLost();
    });

    return true;
  }

  private buildFrameGraph(surfaceTexture: GPUTexture): FrameGraph {
    const device = this.deviceManager.getDevice()!;
    const fg = new FrameGraph();

    // Import the canvas surface texture
    const surfaceHandle = fg.importTexture("surface", surfaceTexture);

    if (this.useDeferred) {
      // Import GBuffer textures
      const gbufferTextures = this.gbuffer!.getTextures()!;
      const gbufferAlbedoHandle = fg.importTexture("gbuffer_albedo", gbufferTextures.albedo);
      const gbufferNormalHandle = fg.importTexture("gbuffer_normal", gbufferTextures.normal);
      const gbufferMetallicEmissiveHandle = fg.importTexture("gbuffer_metallic_emissive", gbufferTextures.metallicEmissive);
      const gbufferVelocityHandle = fg.importTexture("gbuffer_velocity", gbufferTextures.velocity);
      const gbufferDepthHandle = fg.importTexture("gbuffer_depth", gbufferTextures.depth);

      // Import HDR texture
      const hdrHandle = fg.importTexture("hdr", this.hdrTexture!);

      // Import shadow map
      const shadowHandle = this.shadowPass!.getShadowTexture()
        ? fg.importTexture("shadow_map", this.shadowPass!.getShadowTexture()!)
        : null;

      // Set handles on passes
      this.depthPrepass!.depthHandle = gbufferDepthHandle;

      this.opaquePass!.gbufferAlbedoHandle = gbufferAlbedoHandle;
      this.opaquePass!.gbufferNormalHandle = gbufferNormalHandle;
      this.opaquePass!.gbufferMetallicEmissiveHandle = gbufferMetallicEmissiveHandle;
      this.opaquePass!.gbufferVelocityHandle = gbufferVelocityHandle;
      this.opaquePass!.gbufferDepthHandle = gbufferDepthHandle;

      this.deferredPass!.gbufferAlbedoHandle = gbufferAlbedoHandle;
      this.deferredPass!.gbufferNormalHandle = gbufferNormalHandle;
      this.deferredPass!.gbufferMetallicEmissiveHandle = gbufferMetallicEmissiveHandle;
      this.deferredPass!.gbufferDepthHandle = gbufferDepthHandle;
      this.deferredPass!.shadowHandle = shadowHandle;
      this.deferredPass!.hdrHandle = hdrHandle;

      if (this.shadowPass) this.shadowPass.shadowHandle = shadowHandle;

      this.skyboxPass!.depthHandle = gbufferDepthHandle;
      this.skyboxPass!.hdrHandle = hdrHandle;

      this.transparentPass!.depthHandle = gbufferDepthHandle;
      this.transparentPass!.hdrHandle = hdrHandle;

      this.postProcessPass!.hdrHandle = hdrHandle;
      this.postProcessPass!.velocityHandle = gbufferVelocityHandle;
      this.postProcessPass!.surfaceHandle = surfaceHandle;

      this.debugPass!.surfaceHandle = surfaceHandle;
      this.debugPass!.depthHandle = gbufferDepthHandle;

      this.debugVizPass!.surfaceHandle = surfaceHandle;
      this.debugVizPass!.depthHandle = gbufferDepthHandle;

      this.uiCompositePass!.surfaceHandle = surfaceHandle;

      // Add passes in order
      fg.addPass(this.depthPrepass!);
      if (this.shadowPass) fg.addPass(this.shadowPass);
      fg.addPass(this.opaquePass!);
      fg.addPass(this.deferredPass!);
      if (this.skyboxPass) fg.addPass(this.skyboxPass);
      if (this.transparentPass && this.transparentPass.hasItems()) fg.addPass(this.transparentPass);
      fg.addPass(this.postProcessPass!);
      if (this.debugPass && this.config.debugQueue && !this.config.debugQueue.isEmpty()) fg.addPass(this.debugPass);
      if (this.debugVizPass && this.debugVizPass.getMode()) fg.addPass(this.debugVizPass);
      if (this.uiCompositePass) fg.addPass(this.uiCompositePass);
    } else {
      // Simple mode
      const depthTexture = this.opaquePass!.ensureDepthTexture(this.width, this.height);
      const depthHandle = depthTexture ? fg.importTexture("depth", depthTexture) : null;

      this.opaquePass!.surfaceHandle = surfaceHandle;
      this.opaquePass!.depthHandle = depthHandle;

      this.transparentPass!.surfaceHandle = surfaceHandle;
      this.transparentPass!.depthHandle = depthHandle;

      this.debugPass!.surfaceHandle = surfaceHandle;
      this.debugPass!.depthHandle = depthHandle;

      this.debugVizPass!.surfaceHandle = surfaceHandle;
      this.debugVizPass!.depthHandle = depthHandle;

      this.uiCompositePass!.surfaceHandle = surfaceHandle;

      fg.addPass(this.opaquePass!);
      if (this.transparentPass && this.transparentPass.hasItems()) fg.addPass(this.transparentPass);
      if (this.debugPass && this.config.debugQueue && !this.config.debugQueue.isEmpty()) fg.addPass(this.debugPass);
      if (this.debugVizPass && this.debugVizPass.getMode()) fg.addPass(this.debugVizPass);
      if (this.uiCompositePass) fg.addPass(this.uiCompositePass);
    }

    fg.compile(device, this.width, this.height);
    return fg;
  }

  getFrameGraph(): FrameGraph | null {
    return this.frameGraph;
  }

  private async handleDeviceLost(): Promise<void> {
    this.stop();
    this.destroyPasses();
    const device = await this.deviceManager.reinit();
    if (device) {
      this.surface = new SurfaceManager(device);
      this.surface.configure(this.config.canvas);
      const surfaceFormat = this.surface.getFormat() ?? "bgra8unorm";
      this.opaquePass = new OpaquePass(device, surfaceFormat, this.useDeferred ? "gbuffer" : "simple");
      this.opaquePass.setMesh(this.config.mesh);
      if (this.config.pbrMaterial) {
        this.opaquePass.setPBRMaterial(this.config.pbrMaterial);
      }
      this.opaquePass.prepare(device);

      if (this.useDeferred) {
        this.gbuffer = new GBuffer(device, this.width, this.height);
        this.hdrTexture = device.createTexture({
          size: [this.width, this.height],
          format: "rgba16float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.hdrView = this.hdrTexture.createView();
        this.depthPrepass = new DepthPrepass(device);
        this.depthPrepass.prepare(device);
        this.shadowPass = new ShadowPass(device);
        this.shadowPass.prepare(device);
        this.shadowSampler = device.createSampler({ compare: "less" });
        this.deferredPass = new DeferredLightingPass(device, "rgba16float", this.width, this.height);
        this.deferredPass.prepare(device);
        this.deferredPass.updateLights(this.lightData);
        this.skyboxPass = new SkyboxPass(device, "rgba16float");
        this.skyboxPass.prepare(device);
        this.postProcessPass = new PostProcessPass(device, surfaceFormat, this.width, this.height);
        this.postProcessPass.prepare(device);
        this.postProcessPass.setSettings(this.postProcessSettings);
      }
      this.transparentPass = new TransparentPass(device, this.useDeferred ? "rgba16float" : surfaceFormat);
      this.transparentPass.prepare(device);
      this.debugPass = new DebugRenderPass(surfaceFormat);
      if (this.config.debugQueue) {
        this.debugPass.setDebugQueue(this.config.debugQueue);
      }
      this.debugPass.prepare(device);
      this.debugVizPass = new DebugVizPass(surfaceFormat);
      this.debugVizPass.prepare(device);
      this.uiCompositePass = new UICompositePass();
      this.uiCompositePass.setRenderer(new UIRenderer(surfaceFormat));
      this.uiCompositePass.prepare(device);
      this.start();
    }
  }

  setAutonomous(autonomous: boolean): void {
    this.autonomous = autonomous;
  }

  isAutonomous(): boolean {
    return this.autonomous;
  }

  setAlpha(alpha: number): void {
    this.alpha = alpha;
  }

  getAlpha(): number {
    return this.alpha;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    if (this.autonomous) {
      this.loop();
    }
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private loop = (): void => {
    if (!this.running || !this.autonomous) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.renderFrame();
  };

  renderFrame(alpha?: number): void {
    if (alpha !== undefined) {
      this.alpha = alpha;
    }
    const device = this.deviceManager.getDevice();
    if (!device || !this.surface || !this.opaquePass) return;

    this.frameDrawCalls = 0;
    this.frameTriangles = 0;

    const dt = this.timer.delta();
    this.timer.tick(dt);

    if (this.config.camera.aspect !== this.width / this.height) {
      this.config.camera.setAspect(this.width, this.height);
    }
    const viewProj = this.config.camera.getViewProjectionMatrix();

    const texture = this.surface.getCurrentTexture();
    if (!texture) return;

    // Build and execute the frame graph
    this.frameGraph?.destroy();
    this.frameGraph = this.buildFrameGraph(texture);

    const cameraPos = this.config.camera.position;
    const invViewProj = mat4.inverse(viewProj);
    const lightDir = this.lightData.directional.direction;
    const lightViewProj = this.shadowPass
      ? this.shadowPass.computeLightViewProj([lightDir[0], lightDir[1], lightDir[2]], [0, 0, 0], 20)
      : mat4.identity();

    const frameCtx: FrameContext = {
      device,
      width: this.width,
      height: this.height,
      viewProj,
      invViewProj,
      prevViewProj: this.prevViewProj,
      cameraPos: [cameraPos[0], cameraPos[1], cameraPos[2]],
      lightData: this.lightData,
      lightViewProj,
      mesh: this.config.mesh,
      modelMatrix: mat4.identity(),
      shadowsEnabled: this.shadowsEnabled,
      bloomEnabled: this.bloomEnabled,
      shadowSampler: this.shadowSampler,
      debugQueue: this.config.debugQueue ?? null,
      opaqueVertexBuffer: this.opaquePass.getVertexBuffer(),
      opaqueIndexBuffer: this.opaquePass.getIndexBuffer(),
      opaqueIndexCount: this.opaquePass.getIndexCount(),
      opaqueIndexFormat: this.config.mesh.indices instanceof Uint16Array ? "uint16" : "uint32",
      addDrawCalls: (n: number) => { this.frameDrawCalls += n; },
      addTriangles: (n: number) => { this.frameTriangles += n; },
    };

    this.frameGraph.execute(frameCtx);

    // Clear transparent items after frame
    this.transparentPass?.clearItems();

    this.prevViewProj = viewProj;

    if (this.config.telemetry) {
      this.config.telemetry.recordFrame(dt * 1000);
      this.config.telemetry.recordDrawStats(this.frameDrawCalls, this.frameTriangles);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.surface?.reconfigure(width, height);
    this.config.camera.setAspect(width, height);
    if (this.useDeferred) {
      this.gbuffer?.resize(width, height);
      this.hdrTexture?.destroy();
      const device = this.deviceManager.getDevice();
      if (device) {
        this.hdrTexture = device.createTexture({
          size: [width, height],
          format: "rgba16float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.hdrView = this.hdrTexture.createView();
      }
      this.deferredPass?.resize(width, height);
      this.postProcessPass?.resize(width, height);
    }
  }

  setLightData(data: LightUniformData): void {
    this.lightData = data;
    this.deferredPass?.updateLights(data);
    this.transparentPass?.setLightData(data);
  }

  setPostProcessSettings(settings: Partial<PostProcessSettings>): void {
    this.postProcessSettings = { ...this.postProcessSettings, ...settings };
    this.postProcessPass?.setSettings(settings);
  }

  setPBRMaterial(resources: PBRMaterialResources): void {
    this.config.pbrMaterial = resources;
    this.opaquePass?.setPBRMaterial(resources);
  }

  setDebugToggles(toggles: DebugToggleState): void {
    const modeMap: Array<{ key: keyof DebugToggleState; mode: DebugVizMode }> = [
      { key: "wireframe", mode: "wireframe" },
      { key: "normals", mode: "normals" },
      { key: "overdraw", mode: "overdraw" },
      { key: "depth", mode: "depth" },
      { key: "tangents", mode: "tangents" },
      { key: "lod", mode: "lod" },
      { key: "aabbs", mode: "aabbs" },
      { key: "hitboxes", mode: "aabbs" },
    ];
    let activeMode: DebugVizMode | null = null;
    for (const { key, mode } of modeMap) {
      if (toggles[key]) {
        activeMode = mode;
        break;
      }
    }
    this.debugVizPass?.setMode(activeMode);
    this.shadowsEnabled = toggles.shadows;
    this.bloomEnabled = toggles.bloom;
  }

  getTransparentPass(): TransparentPass | null {
    return this.transparentPass;
  }

  getDebugPass(): DebugRenderPass | null {
    return this.debugPass;
  }

  getSkyboxPass(): SkyboxPass | null {
    return this.skyboxPass;
  }

  getUICompositePass(): UICompositePass | null {
    return this.uiCompositePass;
  }

  isRunning(): boolean {
    return this.running;
  }

  getDeviceManager(): GPUDeviceManager {
    return this.deviceManager;
  }

  private destroyPasses(): void {
    this.opaquePass?.destroy();
    this.depthPrepass?.destroy();
    this.shadowPass?.destroy();
    this.deferredPass?.destroy();
    this.transparentPass?.destroy();
    this.skyboxPass?.destroy();
    this.postProcessPass?.destroy();
    this.debugPass?.destroy();
    this.debugVizPass?.destroy();
    this.uiCompositePass?.destroy();
    this.gbuffer?.destroy();
    this.hdrTexture?.destroy();
    this.opaquePass = null;
    this.depthPrepass = null;
    this.shadowPass = null;
    this.deferredPass = null;
    this.transparentPass = null;
    this.skyboxPass = null;
    this.postProcessPass = null;
    this.debugPass = null;
    this.debugVizPass = null;
    this.uiCompositePass = null;
    this.gbuffer = null;
    this.hdrTexture = null;
    this.hdrView = null;
    this.frameGraph?.destroy();
    this.frameGraph = null;
  }

  destroy(): void {
    this.stop();
    this.destroyPasses();
  }
}
