// ============================================================================
// CharacterPreview — a self-contained mini model-viewer that renders a
// slowly-rotating preview of a character model on a dedicated canvas, using
// its own GPUDevice + ModelRenderer. Used for character-select screens.
//
// Generalized from andrews-sandbox's CharacterPreview: the game injects a
// model loader + def lookup + animator factory; the preview owns the WebGPU
// device, orbit camera, depth buffer, and rAF loop.
// ============================================================================

import {
    BindlessFrameBindings,
    BindlessMaterialManager,
    BindlessTextureRegistry,
    DEPTH_FORMAT,
} from "@downdraft/engine";
import { ModelRenderer } from "@downdraft/engine/libraries/entities";
import type { ModelData } from "@downdraft/engine/libraries/models";
import { createLogger } from "@downdraft/engine/util/logger";
import { mat4 } from "wgpu-matrix";
import type { CharacterAnimator } from "./character-animator";

const log = createLogger("info");

export interface CharacterPreviewOptions {
  /** Resolve a model id to its ModelData (e.g. createCharacterModelLoader). */
  loadModel(modelId: string): Promise<{ modelData: ModelData; meshBaseUrl: string } | null>;
  /** Build the animator for a loaded model. */
  createAnimator(modelData: ModelData): CharacterAnimator;
  /** Orbit distance (default 3.5). */
  orbitDistance?: number;
  /** Camera eye height (default 1.2) and look-at height (default 0.9). */
  cameraHeight?: number;
  targetHeight?: number;
  /** Radians/sec rotation speed (default 0.5). */
  rotationSpeed?: number;
  /** Clear color (default dark slate). */
  clearColor?: { r: number; g: number; b: number; a: number };
}

const UP: [number, number, number] = [0, 1, 0];

export class CharacterPreview {
  private canvas: HTMLCanvasElement;
  private opts: CharacterPreviewOptions;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private modelRenderer: ModelRenderer | null = null;
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessFrameBindings: BindlessFrameBindings | null = null;
  private animator: CharacterAnimator | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthW = 0;
  private depthH = 0;
  private rafHandle = 0;
  private rotationAngle = 0;
  private lastTime = performance.now();
  private currentModelId: string | null = null;
  private running = false;
  // Scale + Y-offset to fit the model to a ~1.8m capsule (matches the game's
  // playerScale logic — some rigs are authored in cm and span ~200 units).
  private modelScale = 1;
  private modelYOffset = 0;

  constructor(canvas: HTMLCanvasElement, opts: CharacterPreviewOptions) {
    this.canvas = canvas;
    this.opts = opts;
  }

  /** Initialize the GPU device + ModelRenderer. Must be called before setModel. */
  async init(): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("[CharacterPreview] No WebGPU adapter");
    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      log.warn("CharacterPreview", `GPUDevice LOST: ${info.reason} ${info.message}`);
    });
    this.device.addEventListener("uncapturederror", (e) => {
      log.error("CharacterPreview", `uncaptured GPU error: ${(e as GPUUncapturedErrorEvent).error?.message}`);
    });
    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
    });

    this.bindlessRegistry = new BindlessTextureRegistry(this.device);
    this.bindlessMaterialManager = new BindlessMaterialManager(this.device);
    this.bindlessFrameBindings = new BindlessFrameBindings(
      this.device,
      this.bindlessRegistry,
      this.bindlessMaterialManager,
    );

    this.modelRenderer = new ModelRenderer(this.device, this.format);
    this.modelRenderer.setBindlessDeps({
      registry: this.bindlessRegistry,
      materialManager: this.bindlessMaterialManager,
      bindGroupLayout: this.bindlessFrameBindings.getBindGroupLayout(),
    });
    await this.modelRenderer.init();
  }

  /** Load (or swap) the model shown in the preview. */
  async setModel(modelId: string): Promise<void> {
    if (!this.device || !this.modelRenderer) return;
    if (this.currentModelId === modelId) return;

    const loaded = await this.opts.loadModel(modelId);
    if (!loaded) return;

    try {
      if (this.modelRenderer.hasModel("preview")) {
        this.modelRenderer.removeModel("preview");
      }
      this.modelRenderer.uploadModel("preview", loaded.modelData.meshes, loaded.modelData.materials, loaded.meshBaseUrl);
      const bounds = loaded.modelData.bounds;
      if (bounds && bounds.max[1] - bounds.min[1] > 0) {
        this.modelScale = 1.8 / (bounds.max[1] - bounds.min[1]);
        this.modelYOffset = -bounds.min[1] * this.modelScale;
      } else {
        this.modelScale = 1;
        this.modelYOffset = 0;
      }
      this.animator?.dispose();
      this.animator = this.opts.createAnimator(loaded.modelData);
      this.currentModelId = modelId;
    } catch (err) {
      log.error("CharacterPreview", `Failed to load model ${modelId}: ${err}`);
    }
  }

  /** Start the rAF render loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.render();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  /** Stop the render loop. */
  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private getDepthTexture(w: number, h: number): GPUTexture {
    if (this.depthTexture && this.depthW === w && this.depthH === h) return this.depthTexture;
    this.depthTexture?.destroy();
    this.depthTexture = this.device!.createTexture({
      label: "character-preview-depth",
      size: [w, h, 1],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthW = w;
    this.depthH = h;
    return this.depthTexture;
  }

  private render(): void {
    if (!this.device || !this.context || !this.modelRenderer || !this.bindlessFrameBindings) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W === 0 || H === 0) return;

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // Auto-rotate
    this.rotationAngle += dt * (this.opts.rotationSpeed ?? 0.5);

    // Camera: orbit around the model center at eye height.
    const dist = this.opts.orbitDistance ?? 3.5;
    const pos: [number, number, number] = [
      Math.sin(this.rotationAngle) * dist,
      this.opts.cameraHeight ?? 1.2,
      Math.cos(this.rotationAngle) * dist,
    ];
    const target: [number, number, number] = [0, this.opts.targetHeight ?? 0.9, 0];
    const proj = mat4.perspective(Math.PI / 4, W / H, 0.1, 100);
    const view = mat4.lookAt(pos, target, UP);
    const camera = {
      position: pos,
      target,
      up: [0, 1, 0] as [number, number, number],
      fov: 45,
      near: 0.1,
      far: 100,
      aspect: W / H,
      viewMatrix: view,
      projectionMatrix: proj,
    };

    // Advance the animation (idle by default) + upload skin matrices.
    if (this.animator && this.modelRenderer.hasModel("preview")) {
      this.animator.animator.advance(dt);
      const skinMats = this.animator.computeSkinMatrices();
      this.modelRenderer.updateSkinMatrices(skinMats);
    }

    this.modelRenderer.beginFrame(camera as any);
    this.modelRenderer.setBindlessBindGroup(this.bindlessFrameBindings.prepareFrame());

    const encoder = this.device.createCommandEncoder();
    const colorView = this.context.getCurrentTexture().createView();
    const depthView = this.getDepthTexture(W, H).createView();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: this.opts.clearColor ?? { r: 0.1, g: 0.12, b: 0.15, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    if (this.currentModelId && this.modelRenderer.hasModel("preview")) {
      const yaw = this.rotationAngle;
      const halfYaw = yaw * 0.5;
      const rot: [number, number, number, number] = [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)];
      this.modelRenderer.render(
        pass,
        "preview",
        [0, this.modelYOffset, 0],
        rot,
        [this.modelScale, this.modelScale, this.modelScale],
      );
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Dispose all GPU resources and stop the loop. */
  dispose(): void {
    this.stop();
    this.animator?.dispose();
    this.animator = null;
    if (this.modelRenderer && this.currentModelId) {
      this.modelRenderer.removeModel("preview");
    }
    this.currentModelId = null;
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.modelRenderer?.destroy();
    this.modelRenderer = null;
    this.device?.destroy();
    this.device = null;
  }
}
