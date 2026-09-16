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
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import type { ModelData } from "@downdraft/library-models";
import type { CharacterAnimator } from "./character-animator";

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

// Simple look-at camera (perspective).
function mat4Perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4LookAt(eye: [number, number, number], target: [number, number, number]): Float32Array {
  const z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  let zl = Math.hypot(z[0], z[1], z[2]) || 1;
  z[0] /= zl; z[1] /= zl; z[2] /= zl;
  const x = [z[1] * 0 - z[2] * 1, z[2] * 0 - z[0] * 0, z[0] * 1 - z[1] * 0]; // up=(0,1,0)
  let xl = Math.hypot(x[0], x[1], x[2]) || 1;
  x[0] /= xl; x[1] /= xl; x[2] /= xl;
  const y = [z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0], z[1] * x[2] - z[2] * x[1]];
  const m = new Float32Array(16);
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
}

function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
    }
  }
  return out;
}

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

  constructor(canvas: HTMLCanvasElement, opts: CharacterPreviewOptions) {
    this.canvas = canvas;
    this.opts = opts;
  }

  /** Initialize the GPU device + ModelRenderer. Must be called before setModel. */
  async init(): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("[CharacterPreview] No WebGPU adapter");
    this.device = await adapter.requestDevice();
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
      this.animator?.dispose();
      this.animator = this.opts.createAnimator(loaded.modelData);
      this.currentModelId = modelId;
    } catch (err) {
      console.error(`[CharacterPreview] Failed to load model ${modelId}:`, err);
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
      format: "depth24plus",
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
    const proj = mat4Perspective(Math.PI / 4, W / H, 0.1, 100);
    const view = mat4LookAt(pos, target);
    const viewProj = mat4Mul(proj, view);

    const camera = {
      position: pos,
      viewProj,
      view,
      proj,
      target,
      width: W,
      height: H,
      time: now / 1000,
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
      this.modelRenderer.render(pass, "preview", [0, 0, 0], rot, [1, 1, 1], 0, 0);
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
