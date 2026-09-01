// ============================================================================
// PostfxTestRenderer — shared renderer for all PostFX subcategory tests
//
// Renders a rotating cube grid into the PostProcessStack's offscreen targets
// (with optional normals/velocity/mask MRT), then applies the effect chain.
// Each subcategory test configures which effects are available and their
// controls.
// ============================================================================

import { PostProcessStack, type EffectId } from "@downdraft/core";
import type { ITestRenderer, TestContext } from "../../test-registry";
import { MrtCubeRenderer, buildCubeGrid, buildCubeGridWithSelection, mat4LookAt, mat4Perspective, type CameraConfig, type CubeInstance } from "./mrt-cube-renderer";

export interface PostfxTestConfig {
  /** Effects available in this test (for the "anyEnabled" check). */
  effects: EffectId[];
  /** Whether this test needs normals MRT (SSAO, SSR, Edges). Dynamic — checked each frame. */
  needsNormals: () => boolean;
  /** Whether this test needs velocity MRT (TAA, Motion Blur). Dynamic — checked each frame. */
  needsVelocity: () => boolean;
  /** Whether this test needs mask MRT (Outline, Highlight, Glow). Dynamic — checked each frame. */
  needsMask: () => boolean;
  /** Whether to pre-select cubes for mask-based effects. */
  useSelection: boolean;
  /** Sync function: read control state → stack setters. Called each frame. */
  syncState: (stack: PostProcessStack) => void;
  /** Check if any effect is enabled (from control state). */
  anyEnabled: () => boolean;
}

export class PostfxTestRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: MrtCubeRenderer;
  private stack: PostProcessStack;
  private cubes: CubeInstance[];
  private config: PostfxTestConfig;
  private rotationAngle = 0;
  private rotationSpeed = 0.5;
  private prevCamera: CameraConfig | null = null;
  private depthTexture: GPUTexture | null = null;

  constructor(canvas: HTMLCanvasElement, config: PostfxTestConfig) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as MrtCubeRenderer;
    this.stack = null as unknown as PostProcessStack;
    this.cubes = config.useSelection ? buildCubeGridWithSelection() : buildCubeGrid();
    this.config = config;
  }

  setRotationSpeed(v: number): void { this.rotationSpeed = v; }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new MrtCubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.stack = new PostProcessStack(this.device, this.format);
    this.stack.init();
  }

  render(ctx: TestContext): void {
    this.rotationAngle += ctx.dt * this.rotationSpeed;
    this.stack.update(ctx.dt);
    this.config.syncState(this.stack);

    const anyEnabled = this.config.anyEnabled();
    const camera: CameraConfig = {
      eye: [Math.cos(this.rotationAngle) * 30, 20, Math.sin(this.rotationAngle) * 30],
      target: [0, 2, 0],
      up: [0, 1, 0],
      fov: Math.PI / 4,
      near: 0.1,
      far: 200,
      aspect: ctx.width / ctx.height,
    };

    // Provide camera matrices to stack (for SSAO, SSR)
    this.stack.setCameraMatrices(
      this.computeProj(camera),
      this.computeInvProj(camera),
      this.computeView(camera),
    );

    const canvasView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();

    if (!anyEnabled) {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: canvasView, clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: { view: this.getDepthView(ctx), depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      pass.setPipeline(this.cubeRenderer.colorPipeline);
      this.cubeRenderer.drawCubes(pass, this.cubes, camera, this.prevCamera);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      this.prevCamera = { ...camera };
      return;
    }

    this.stack.ensureTargets(ctx.width, ctx.height);

    // Scene pass: render into stack's color + depth (+ optional MRT)
    const sceneEncoder = this.device.createCommandEncoder();
    const colorAttachments: GPURenderPassColorAttachment[] = [{
      view: this.stack.getSceneColorView(),
      clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
      loadOp: "clear", storeOp: "store",
    }];

    // Scene color pass: render cubes into the stack's color + depth targets
    const scenePass = this.beginPass(sceneEncoder, colorAttachments, this.stack.getSceneDepthView());
    scenePass.setViewport(0, 0, ctx.width, ctx.height, 0, 1);
    this.cubeRenderer.drawCubes(scenePass, this.cubes, camera, this.prevCamera);
    scenePass.end();

    // Optional MRT passes
    if (this.config.needsNormals()) {
      try {
        const nView = this.stack.getSceneNormalsView();
        const nPass = sceneEncoder.beginRenderPass({
          colorAttachments: [{ view: nView, clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: this.stack.getSceneDepthView(), depthClearValue: 1.0, depthLoadOp: "load", depthStoreOp: "store" },
        });
        nPass.setViewport(0, 0, ctx.width, ctx.height, 0, 1);
        nPass.setPipeline(this.cubeRenderer.normalPipeline_);
        this.cubeRenderer.drawCubes(nPass, this.cubes, camera, this.prevCamera);
        nPass.end();
      } catch (e) { console.error("[postfx] normals MRT pass failed:", e); }
    }

    if (this.config.needsVelocity()) {
      try {
        const vView = this.stack.getSceneVelocityView();
        const vPass = sceneEncoder.beginRenderPass({
          colorAttachments: [{ view: vView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: this.stack.getSceneDepthView(), depthClearValue: 1.0, depthLoadOp: "load", depthStoreOp: "store" },
        });
        vPass.setViewport(0, 0, ctx.width, ctx.height, 0, 1);
        vPass.setPipeline(this.cubeRenderer.velocityPipeline_);
        this.cubeRenderer.drawCubes(vPass, this.cubes, camera, this.prevCamera);
        vPass.end();
      } catch (e) { console.error("[postfx] velocity MRT pass failed:", e); }
    }

    if (this.config.needsMask()) {
      try {
        const mView = this.stack.getSceneMaskView();
        const mPass = sceneEncoder.beginRenderPass({
          colorAttachments: [{ view: mView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: this.stack.getSceneDepthView(), depthClearValue: 1.0, depthLoadOp: "load", depthStoreOp: "store" },
        });
        mPass.setViewport(0, 0, ctx.width, ctx.height, 0, 1);
        mPass.setPipeline(this.cubeRenderer.maskPipeline_);
        this.cubeRenderer.drawCubes(mPass, this.cubes, camera, this.prevCamera);
        mPass.end();
      } catch (e) { console.error("[postfx] mask MRT pass failed:", e); }
    }

    this.device.queue.submit([sceneEncoder.finish()]);

    // Apply post-process chain → canvas
    const postEncoder = this.device.createCommandEncoder();
    this.stack.applyChain(postEncoder, this.stack.getSceneDepthView(), canvasView, ctx.width, ctx.height);
    this.device.queue.submit([postEncoder.finish()]);

    this.prevCamera = { ...camera };
  }

  private beginPass(
    encoder: GPUCommandEncoder,
    colorAttachments: GPURenderPassColorAttachment[],
    depthView: GPUTextureView,
  ): GPURenderPassEncoder {
    const pass = encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    // Use the HDR pipeline (rgba16float) for scene rendering into the PostProcessStack
    pass.setPipeline(this.cubeRenderer.sceneColorPipeline_);
    return pass;
  }

  private getDepthView(ctx: TestContext): GPUTextureView {
    if (!this.depthTexture || this.depthTexture.width !== ctx.width || this.depthTexture.height !== ctx.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [ctx.width, ctx.height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    return this.depthTexture.createView();
  }

  private computeProj(cam: CameraConfig): Float32Array {
    return mat4Perspective(cam.fov, cam.aspect, cam.near, cam.far);
  }

  private computeView(cam: CameraConfig): Float32Array {
    return mat4LookAt(cam.eye, cam.target, cam.up);
  }

  private computeInvProj(cam: CameraConfig): Float32Array {
    // Compute inverse of the perspective projection matrix
    const proj = this.computeProj(cam);
    // For a standard perspective matrix, the inverse can be computed analytically:
    // proj = [f/aspect, 0, 0, 0]
    //        [0, f, 0, 0]
    //        [0, 0, (f+n)/(n-f), -1]
    //        [0, 0, 2fn/(n-f), 0]
    // inv = [aspect/f, 0, 0, 0]
    //       [0, 1/f, 0, 0]
    //       [0, 0, 0, (n-f)/(2fn)]
    //       [0, 0, -1, (f+n)/(2fn)]
    const f = 1.0 / Math.tan(cam.fov / 2);
    const nf = 1 / (cam.near - cam.far);
    const inv = new Float32Array(16);
    inv[0] = cam.aspect / f;
    inv[5] = 1 / f;
    inv[10] = 0;
    inv[11] = -1;
    inv[14] = (cam.near - cam.far) / (2 * cam.far * cam.near * nf);
    inv[15] = (cam.far + cam.near) * nf / (2 * cam.far * cam.near * nf);
    return inv;
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.stack?.destroy();
    this.depthTexture = null;
  }
}
