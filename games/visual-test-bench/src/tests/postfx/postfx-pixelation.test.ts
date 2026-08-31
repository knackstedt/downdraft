// ============================================================================
// PostFX Test — Pixelation
//
// Renders a rotating 3D cube grid, then applies the existing PixelationSystem
// from @downdraft/library-postfx. Adjust pixel size and edge detection strength.
// ============================================================================

import { PixelationSystem } from "@downdraft/library-postfx";
import { registerTest, type ITestRenderer, type TestContext, type TestControl } from "../../test-registry";
import { CubeRenderer, type CameraConfig } from "../helpers/cube-renderer";

// ── Test controls state ──

let pixelSize = 6;
let depthEdgeStrength = 0.4;
let pixelationEnabled = true;
let rotationSpeed = 0.5;

function buildCubeGrid(): { position: [number, number, number]; color: [number, number, number]; size: number }[] {
  const cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[] = [];
  const colors: [number, number, number][] = [
    [1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.5, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1],
  ];
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

class PostfxPixelationRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private pixelation: PixelationSystem;
  private cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[];
  private rotationAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as CubeRenderer;
    this.pixelation = null as unknown as PixelationSystem;
    this.cubes = buildCubeGrid();
  }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new CubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.pixelation = new PixelationSystem(this.device, this.format);
    this.pixelation.init();
    this.pixelation.setPixelSize(pixelSize);
    this.pixelation.setDepthEdgeStrength(depthEdgeStrength);
    this.pixelation.setEnabled(pixelationEnabled);
  }

  render(ctx: TestContext): void {
    this.rotationAngle += ctx.dt * rotationSpeed;

    // Sync control state.
    this.pixelation.setPixelSize(pixelSize);
    this.pixelation.setDepthEdgeStrength(depthEdgeStrength);
    this.pixelation.setEnabled(pixelationEnabled);

    // Ensure pixelation offscreen targets.
    this.pixelation.ensureTargets(ctx.width, ctx.height);

    const camera: CameraConfig = {
      eye: [Math.cos(this.rotationAngle) * 30, 20, Math.sin(this.rotationAngle) * 30],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: Math.PI / 4,
      near: 0.1,
      far: 200,
      aspect: ctx.width / ctx.height,
    };

    // Phase 1: Render scene into pixelation's low-res offscreen.
    const lowResW = Math.max(1, Math.floor(ctx.width / pixelSize));
    const lowResH = Math.max(1, Math.floor(ctx.height / pixelSize));

    const sceneEncoder = this.device.createCommandEncoder();
    const scenePass = sceneEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.pixelation.getOffscreenColorView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.pixelation.getOffscreenDepthView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    // Adjust camera aspect for low-res rendering.
    const lowResCamera: CameraConfig = { ...camera, aspect: lowResW / lowResH };
    this.cubeRenderer.drawCubes(scenePass, this.cubes, lowResCamera);
    scenePass.end();
    this.device.queue.submit([sceneEncoder.finish()]);

    // Phase 2: Apply pixelation post-process → canvas.
    const postEncoder = this.device.createCommandEncoder();
    const canvasView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();
    this.pixelation.applyPostprocess(postEncoder, canvasView, ctx.width, ctx.height);
    this.device.queue.submit([postEncoder.finish()]);
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.cubeRenderer?.dispose();
    this.pixelation?.destroy();
  }
}

registerTest({
  id: "postfx-pixelation",
  name: "PostFX: Pixelation",
  category: "PostFX",
  description: "A rotating 3D cube grid with pixelation + depth edge detection. Adjust pixel size and edge strength.",
  requiresWebGPU: true,
  createRenderer: (canvas) => new PostfxPixelationRenderer(canvas),
  getControls: (): TestControl[] => [
    { key: "enabled", label: "Enabled", type: "checkbox", value: pixelationEnabled, onChange: (v) => { pixelationEnabled = v as boolean; } },
    { key: "pixelSize", label: "Pixel size", type: "slider", min: 1, max: 20, step: 1, value: pixelSize, onChange: (v) => { pixelSize = v as number; } },
    { key: "depthEdge", label: "Depth edge strength", type: "slider", min: 0, max: 1, step: 0.05, value: depthEdgeStrength, onChange: (v) => { depthEdgeStrength = v as number; } },
    { key: "rotationSpeed", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
