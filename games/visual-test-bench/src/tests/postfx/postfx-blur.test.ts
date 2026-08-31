// ============================================================================
// PostFX Test — Gaussian Blur
//
// Renders a rotating 3D scene (cube grid + ground) to an offscreen texture,
// then applies a two-pass Gaussian blur via GaussianBlurSystem. Toggle blur
// on/off and adjust radius via controls.
// ============================================================================

import { GaussianBlurSystem } from "@downdraft/library-postfx";
import { registerTest, type ITestRenderer, type TestContext, type TestControl } from "../../test-registry";
import { CubeRenderer, type CameraConfig } from "../helpers/cube-renderer";

// ── Test controls state ──

let blurEnabled = true;
let blurRadius = 4;
let rotationSpeed = 0.5;

function buildCubeGrid(): { position: [number, number, number]; color: [number, number, number]; size: number }[] {
  const cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[] = [];
  const colors: [number, number, number][] = [
    [1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.5, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1],
  ];
  // 5x5 grid of cubes on the ground.
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const colorIdx = (x + z) % colors.length;
      cubes.push({
        position: [(x - 2) * 4, 0, (z - 2) * 4],
        color: colors[colorIdx],
        size: 2,
      });
    }
  }
  return cubes;
}

class PostfxBlurRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private blurSystem: GaussianBlurSystem;
  private depthTexture: GPUTexture | null = null;
  private cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[];
  private rotationAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as CubeRenderer;
    this.blurSystem = null as unknown as GaussianBlurSystem;
    this.cubes = buildCubeGrid();
  }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new CubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.blurSystem = new GaussianBlurSystem(this.device, this.format);
    this.blurSystem.init();
    this.blurSystem.setEnabled(blurEnabled);
    this.blurSystem.setRadius(blurRadius);
  }

  render(ctx: TestContext): void {
    this.rotationAngle += ctx.dt * rotationSpeed;

    // Ensure blur targets match canvas size.
    this.blurSystem.ensureTargets(ctx.width, ctx.height);

    // Ensure depth texture.
    if (!this.depthTexture || this.depthTexture.width !== ctx.width || this.depthTexture.height !== ctx.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [ctx.width, ctx.height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    const camera: CameraConfig = {
      eye: [Math.cos(this.rotationAngle) * 30, 20, Math.sin(this.rotationAngle) * 30],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: Math.PI / 4,
      near: 0.1,
      far: 200,
      aspect: ctx.width / ctx.height,
    };

    // Phase 1: Render the scene into the blur system's offscreen color texture.
    const sceneEncoder = this.device.createCommandEncoder();
    const sceneColorView = this.blurSystem.getSceneColorView();
    const sceneDepthView = this.depthTexture.createView();

    const scenePass = sceneEncoder.beginRenderPass({
      colorAttachments: [{
        view: sceneColorView,
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: sceneDepthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    this.cubeRenderer.drawCubes(scenePass, this.cubes, camera);
    scenePass.end();
    this.device.queue.submit([sceneEncoder.finish()]);

    // Phase 2: Apply blur (or blit if disabled) → canvas.
    const blurEncoder = this.device.createCommandEncoder();
    const canvasView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();
    this.blurSystem.apply(blurEncoder, canvasView, ctx.width, ctx.height);
    this.device.queue.submit([blurEncoder.finish()]);
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.blurSystem?.destroy();
    this.depthTexture = null;
  }
}

registerTest({
  id: "postfx-blur",
  name: "PostFX: Gaussian Blur",
  category: "PostFX",
  description: "A rotating 3D cube grid with a two-pass separable Gaussian blur post-process. Toggle blur and adjust radius.",
  requiresWebGPU: true,
  createRenderer: (canvas) => new PostfxBlurRenderer(canvas),
  getControls: (): TestControl[] => [
    { key: "blurEnabled", label: "Blur enabled", type: "checkbox", value: blurEnabled, onChange: (v) => { blurEnabled = v as boolean; } },
    { key: "blurRadius", label: "Blur radius", type: "slider", min: 0, max: 20, step: 0.5, value: blurRadius, onChange: (v) => { blurRadius = v as number; } },
    { key: "rotationSpeed", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
