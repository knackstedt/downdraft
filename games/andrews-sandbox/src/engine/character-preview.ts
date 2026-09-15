// ============================================================================
// CharacterPreview — a self-contained mini model-viewer that renders a
// slowly-rotating preview of a player model on a dedicated canvas, using its
// own GPUDevice + ModelRenderer. Used by the ESC menu's "Character" tab.
//
// Mirrors the init + render pattern from games/model-viewer/src/main.tsx at a
// smaller scale (no grid, no skeleton, no profiler — just the model + a
// simple camera + depth buffer).
// ============================================================================

import {
    BindlessFrameBindings,
    BindlessMaterialManager,
    BindlessTextureRegistry,
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { PlayerAnimator } from "./player-animator";
import { loadPlayerModel } from "./player-model-loader";
import { getPlayerModelDef } from "./player-models";

// Simple look-at camera (perspective).
interface PreviewCamera {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

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
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private modelRenderer: ModelRenderer | null = null;
  private bindlessRegistry: BindlessTextureRegistry | null = null;
  private bindlessMaterialManager: BindlessMaterialManager | null = null;
  private bindlessFrameBindings: BindlessFrameBindings | null = null;
  private animator: PlayerAnimator | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthW = 0;
  private depthH = 0;
  private rafHandle = 0;
  private rotationAngle = 0;
  private lastTime = performance.now();
  private currentModelId: string | null = null;
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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

    const def = getPlayerModelDef(modelId);
    if (!def) return;

    try {
      const modelData = await loadPlayerModel(def);
      if (this.modelRenderer.hasModel("preview")) {
        this.modelRenderer.removeModel("preview");
      }
      this.modelRenderer.uploadModel("preview", modelData.meshes, modelData.materials, def.meshBaseUrl);
      this.animator?.dispose();
      this.animator = new PlayerAnimator(modelData);
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
    this.rotationAngle += dt * 0.5;

    // Camera: orbit around the model center at eye height.
    const dist = 3.5;
    const cam: PreviewCamera = {
      pos: [Math.sin(this.rotationAngle) * dist, 1.2, Math.cos(this.rotationAngle) * dist],
      target: [0, 0.9, 0],
      fov: Math.PI / 4,
      aspect: W / H,
      near: 0.1,
      far: 100,
    };
    const proj = mat4Perspective(cam.fov, cam.aspect, cam.near, cam.far);
    const view = mat4LookAt(cam.pos, cam.target);
    const viewProj = mat4Mul(proj, view);

    const camera = {
      position: cam.pos,
      viewProj,
      view,
      proj,
      target: cam.target,
      width: W,
      height: H,
      time: now / 1000,
    };

    // Sample the idle animation + upload skin matrices.
    if (this.animator && this.modelRenderer.hasModel("preview")) {
      const skinMats = this.animator.update(dt, true, 0, 0, false);
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
        clearValue: { r: 0.1, g: 0.12, b: 0.15, a: 1 },
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
