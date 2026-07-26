import { mat4, type Mat4 } from "wgpu-matrix";
import type { DebugDrawQueue } from "../debug-draw/queue.ts";
import type { MeshData } from "../mesh/builder.ts";
import { HighResTimer } from "../platform/time.ts";
import { Camera } from "../scene/camera.ts";
import { TelemetryCollector } from "../telemetry/collector.ts";
import { createLogger } from "../util/logger.ts";
import { GPUDeviceManager } from "./device.ts";
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
import { RenderGraph } from "./render-graph.ts";
import { SurfaceManager } from "./surface.ts";
import { TrackedRenderPass } from "./tracked-render-pass.ts";

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
  private renderGraph: RenderGraph | null = null;

  constructor(config: RenderLoopConfig) {
    this.deviceManager = new GPUDeviceManager();
    this.config = config;
    this.timer = new HighResTimer();
    this.lightData = config.lightData ?? createDefaultLightUniform();
    this.postProcessSettings = { ...DEFAULT_POST_PROCESS_SETTINGS, ...config.postProcessSettings };
    this.useDeferred = (config.mode ?? "gbuffer") === "gbuffer";
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

    this.prevViewProj = this.config.camera.getViewProjectionMatrix();

    this.buildRenderGraph();

    this.deviceManager.onDeviceLost(() => {
      log.warn("RenderLoop", "Device lost, attempting reinit...");
      this.handleDeviceLost();
    });

    return true;
  }

  private buildRenderGraph(): void {
    this.renderGraph = new RenderGraph();

    if (this.useDeferred) {
      // External resources (canvas surface)
      this.renderGraph.registerResource({ name: "surface", type: "texture", format: "surface" });

      // Pass: depth-prepass
      this.renderGraph.addPass({ name: "depth-prepass", inputs: [], outputs: ["gbuffer_depth"] });

      // Pass: shadow
      this.renderGraph.addPass({ name: "shadow", inputs: [], outputs: ["shadow_map"] });

      // Pass: gbuffer-opaque
      this.renderGraph.addPass({
        name: "gbuffer-opaque",
        inputs: ["gbuffer_depth"],
        outputs: ["gbuffer_albedo", "gbuffer_normal", "gbuffer_metallic_emissive", "gbuffer_velocity", "gbuffer_depth"],
      });

      // Pass: deferred-lighting
      this.renderGraph.addPass({
        name: "deferred-lighting",
        inputs: ["gbuffer_albedo", "gbuffer_normal", "gbuffer_metallic_emissive", "gbuffer_depth", "shadow_map"],
        outputs: ["hdr_texture"],
      });

      // Pass: skybox
      this.renderGraph.addPass({ name: "skybox", inputs: ["gbuffer_depth"], outputs: ["hdr_texture"] });

      // Pass: transparent
      this.renderGraph.addPass({ name: "transparent", inputs: ["gbuffer_depth"], outputs: ["hdr_texture"] });

      // Pass: post-process
      this.renderGraph.addPass({
        name: "post-process",
        inputs: ["hdr_texture", "gbuffer_velocity"],
        outputs: ["surface"],
      });

      // Pass: debug
      this.renderGraph.addPass({ name: "debug", inputs: ["surface"], outputs: ["surface"] });
    } else {
      this.renderGraph.registerResource({ name: "surface", type: "texture", format: "surface" });
      this.renderGraph.addPass({ name: "opaque", inputs: [], outputs: ["surface"] });
      this.renderGraph.addPass({ name: "transparent", inputs: [], outputs: ["surface"] });
      this.renderGraph.addPass({ name: "debug", inputs: [], outputs: ["surface"] });
    }

    this.renderGraph.resolveAliasing();
    this.renderGraph.syncUsageFlags();

    const errors = this.renderGraph.validate();
    if (errors.length > 0) {
      log.warn("RenderLoop", `Render graph validation errors: ${errors}`);
    }
  }

  getRenderGraph(): RenderGraph | null {
    return this.renderGraph;
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
      this.buildRenderGraph();
      this.start();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.render();
  };

  private render(): void {
    const device = this.deviceManager.getDevice();
    if (!device || !this.surface || !this.opaquePass) return;

    const dt = this.timer.delta();
    this.timer.tick(dt);

    if (this.config.camera.aspect !== this.width / this.height) {
      this.config.camera.setAspect(this.width, this.height);
    }
    const viewProj = this.config.camera.getViewProjectionMatrix();

    const texture = this.surface.getCurrentTexture();
    if (!texture) return;

    if (this.useDeferred) {
      this.renderDeferred(device, texture, viewProj);
    } else {
      this.renderSimple(device, texture, viewProj);
    }

    if (this.config.telemetry) {
      this.config.telemetry.recordFrame(dt * 1000);
    }
  }

  private renderSimple(device: GPUDevice, texture: GPUTexture, viewProj: Mat4): void {
    this.opaquePass!.updateCamera(viewProj);

    const depthTexture = this.opaquePass!.ensureDepthTexture(this.width, this.height);
    if (!depthTexture) return;

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: this.config.clearColor ?? { r: 0.1, g: 0.1, b: 0.12, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    const tracked = new TrackedRenderPass(pass);
    this.opaquePass!.execute({ device, pass: tracked });

    if (this.transparentPass) {
      this.transparentPass.setLightData(this.lightData);
      this.transparentPass.setCameraViewProj(viewProj, [this.config.camera.position[0], this.config.camera.position[1], this.config.camera.position[2]]);
      this.transparentPass.execute({ device, pass: tracked });
      this.transparentPass.clearItems();
    }

    if (this.debugPass) {
      this.debugPass.setScreenSize(this.width, this.height);
      this.debugPass.setCameraViewProj(viewProj);
      this.debugPass.execute({ device, pass: tracked });
    }

    if (this.debugVizPass && this.debugVizPass.getMode()) {
      this.debugVizPass.setCamera(viewProj);
      const vb = this.opaquePass!.getVertexBuffer();
      const ib = this.opaquePass!.getIndexBuffer();
      const indexCount = this.opaquePass!.getIndexCount();
      if (vb && ib && indexCount > 0) {
        this.debugVizPass.renderMesh({ device, pass: tracked }, vb, ib, indexCount);
      }
    }

    tracked.end();
    device.queue.submit([encoder.finish()]);
  }

  private renderDeferred(device: GPUDevice, texture: GPUTexture, viewProj: Mat4): void {
    if (!this.gbuffer || !this.depthPrepass || !this.shadowPass || !this.deferredPass || !this.postProcessPass) return;

    const invViewProj = mat4.inverse(viewProj);
    const cameraPos = this.config.camera.position;

    // Update prev matrices for velocity
    this.opaquePass!.setPrevViewProj(this.prevViewProj);
    this.opaquePass!.updateCamera(viewProj);

    // 1. Depth prepass
    const depthView = this.gbuffer.getViews()!.depth;
    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      const tracked = new TrackedRenderPass(pass);
      this.depthPrepass.setCameraViewProj(viewProj);
      this.depthPrepass.execute({ device, pass: tracked }, this.config.mesh, mat4.identity());
      tracked.end();
      device.queue.submit([encoder.finish()]);
    }

    // 2. Shadow pass
    const lightDir = this.lightData.directional.direction;
    const lightViewProj = this.shadowPass.computeLightViewProj(
      [lightDir[0], lightDir[1], lightDir[2]],
      [0, 0, 0],
      20,
    );
    this.shadowPass.setLightViewProj(lightViewProj);
    if (this.shadowsEnabled) {
      const ctx = { device, pass: null as unknown as GPURenderPassEncoder };
      this.shadowPass.execute(ctx, this.config.mesh, mat4.identity());
    }

    // 3. G-Buffer opaque pass (load depth from prepass)
    {
      const encoder = device.createCommandEncoder();
      const colorAttachments = this.gbuffer.getColorAttachments().map(a => ({
        ...a,
        loadOp: "clear" as GPULoadOp,
      }));
      const pass = encoder.beginRenderPass({
        colorAttachments,
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
      });
      const tracked = new TrackedRenderPass(pass);
      this.opaquePass!.execute({ device, pass: tracked });
      tracked.end();
      device.queue.submit([encoder.finish()]);
    }

    // 4. Deferred lighting
    const gbufferViews = this.gbuffer.getViews()!;
    const shadowView = this.shadowPass.getShadowView();
    const deferredBindGroup = this.deferredPass.createBindGroup(
      gbufferViews,
      shadowView,
      this.shadowSampler,
    ) ?? undefined;
    this.deferredPass.updateCamera(viewProj, this.prevViewProj, invViewProj, [cameraPos[0], cameraPos[1], cameraPos[2]]);
    this.deferredPass.updateLightViewProj(lightViewProj);
    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.hdrView!,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      this.deferredPass.execute({ device, pass }, deferredBindGroup);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // 5. Skybox (depth-tested against G-Buffer depth, no write)
    {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.hdrView!,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "load",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
      });
      if (this.skyboxPass) {
        this.skyboxPass.setCamera(viewProj, invViewProj, [cameraPos[0], cameraPos[1], cameraPos[2]]);
        this.skyboxPass.execute({ device, pass });
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // 6. Transparent objects (blend into HDR)
    if (this.transparentPass && this.transparentPass.hasItems()) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.hdrView!,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "load",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
      });
      this.transparentPass.setLightData(this.lightData);
      this.transparentPass.setCameraViewProj(viewProj, [cameraPos[0], cameraPos[1], cameraPos[2]]);
      this.transparentPass.execute({ device, pass });
      this.transparentPass.clearItems();
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // 7. Post-process: TAA → Bloom → Tonemap → surface
    {
      const ctx = { device, pass: null as unknown as GPURenderPassEncoder };
      const taaOutput = this.postProcessPass.executeTAA(ctx, this.hdrView!, gbufferViews.velocity, this.hdrView!);
      const bloomOutput = this.bloomEnabled
        ? this.postProcessPass.executeBloom(ctx, taaOutput)
        : taaOutput;
      this.postProcessPass.executeTonemap(ctx, taaOutput, bloomOutput, texture.createView());
    }

    // 8. Debug render (on top of final image)
    if (this.debugPass && this.config.debugQueue && !this.config.debugQueue.isEmpty()) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "load",
          storeOp: "store",
        }],
      });
      this.debugPass.setScreenSize(this.width, this.height);
      this.debugPass.setCameraViewProj(viewProj);
      this.debugPass.execute({ device, pass });
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    // 9. Debug visualization (on top of final image)
    if (this.debugVizPass && this.debugVizPass.getMode()) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "load",
          storeOp: "store",
        }],
      });
      this.debugVizPass.setCamera(viewProj);
      const vb = this.opaquePass!.getVertexBuffer();
      const ib = this.opaquePass!.getIndexBuffer();
      const indexCount = this.opaquePass!.getIndexCount();
      if (vb && ib && indexCount > 0) {
        this.debugVizPass.renderMesh({ device, pass }, vb, ib, indexCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    this.prevViewProj = viewProj;
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
    this.gbuffer = null;
    this.hdrTexture = null;
    this.hdrView = null;
    this.renderGraph = null;
  }

  destroy(): void {
    this.stop();
    this.destroyPasses();
  }
}
