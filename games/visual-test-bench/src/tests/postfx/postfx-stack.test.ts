// ============================================================================
// PostFX Test — PostProcess Stack (FXAA, DOF, Bloom, Sobel, Afterimage, ASCII)
//
// Uses @downdraft/core's PostProcessStack — a standalone class that chains
// multiple post-processing effects. Renders a rotating 3D cube grid into the
// stack's offscreen color+depth, then applies the enabled effect chain to the
// canvas.
// ============================================================================

import { PostProcessStack } from "@downdraft/core";
import { registerTest, type ITestRenderer, type TestContext, type TestControl } from "../../test-registry";
import { CubeRenderer, type CameraConfig } from "../helpers/cube-renderer";

// ── Test controls state ──

let fxaaEnabled = false;
let dofEnabled = false;
let bloomEnabled = false;
let sobelEnabled = false;
let afterimageEnabled = false;
let asciiEnabled = false;

let dofFocusDist = 0.5;
let dofFocusRange = 0.3;
let dofMaxBlur = 8;
let bloomThreshold = 0.8;
let bloomStrength = 1.0;
let afterimageDamp = 0.96;
let asciiCellSize = 8;
let asciiUseColor = true;

let rotationSpeed = 0.5;

function buildCubeGrid(): { position: [number, number, number]; color: [number, number, number]; size: number }[] {
  const cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[] = [];
  const colors: [number, number, number][] = [
    [1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.5, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1],
  ];
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const colorIdx = (x + z) % colors.length;
      // Vary heights to make DOF + bloom more interesting.
      const height = 1 + ((x + z * 3) % 4);
      cubes.push({
        position: [(x - 2) * 4, 0, (z - 2) * 4],
        color: colors[colorIdx],
        size: height,
      });
    }
  }
  return cubes;
}

class PostfxStackRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private stack: PostProcessStack;
  private cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[];
  private rotationAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as CubeRenderer;
    this.stack = null as unknown as PostProcessStack;
    this.cubes = buildCubeGrid();
  }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new CubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.stack = new PostProcessStack(this.device, this.format);
    this.stack.init();
  }

  render(ctx: TestContext): void {
    this.rotationAngle += ctx.dt * rotationSpeed;

    // Sync control state → stack.
    this.stack.setEnabled("fxaa", fxaaEnabled);
    this.stack.setEnabled("dof", dofEnabled);
    this.stack.setEnabled("bloom", bloomEnabled);
    this.stack.setEnabled("sobel", sobelEnabled);
    this.stack.setEnabled("afterimage", afterimageEnabled);
    this.stack.setEnabled("ascii", asciiEnabled);
    this.stack.setDOFFocusDist(dofFocusDist);
    this.stack.setDOFFocusRange(dofFocusRange);
    this.stack.setDOFMaxBlur(dofMaxBlur);
    this.stack.setBloomThreshold(bloomThreshold);
    this.stack.setBloomStrength(bloomStrength);
    this.stack.setAfterimageDamp(afterimageDamp);
    this.stack.setASCIICellSize(asciiCellSize);
    this.stack.setASCIIUseColor(asciiUseColor);

    const anyEnabled = fxaaEnabled || dofEnabled || bloomEnabled || sobelEnabled || afterimageEnabled || asciiEnabled;

    const camera: CameraConfig = {
      eye: [Math.cos(this.rotationAngle) * 30, 20, Math.sin(this.rotationAngle) * 30],
      target: [0, 2, 0],
      up: [0, 1, 0],
      fov: Math.PI / 4,
      near: 0.1,
      far: 200,
      aspect: ctx.width / ctx.height,
    };

    const canvasView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();

    if (!anyEnabled) {
      // No effects — render directly to canvas.
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: this.getDepthView(ctx),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      this.cubeRenderer.drawCubes(pass, this.cubes, camera);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return;
    }

    // Effects enabled — render to stack's offscreen, then apply chain.
    this.stack.ensureTargets(ctx.width, ctx.height);

    const sceneEncoder = this.device.createCommandEncoder();
    const scenePass = sceneEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.stack.getSceneColorView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.stack.getSceneDepthView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    this.cubeRenderer.drawCubes(scenePass, this.cubes, camera);
    scenePass.end();
    this.device.queue.submit([sceneEncoder.finish()]);

    // Apply post-process chain → canvas.
    const postEncoder = this.device.createCommandEncoder();
    this.stack.applyChain(postEncoder, this.stack.getSceneDepthView(), canvasView, ctx.width, ctx.height);
    this.device.queue.submit([postEncoder.finish()]);
  }

  private depthTexture: GPUTexture | null = null;
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

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.stack?.destroy();
    this.depthTexture = null;
  }
}

registerTest({
  id: "postfx-stack",
  name: "PostFX: Effect Stack",
  category: "PostFX",
  description: "PostProcessStack from @downdraft/core — chainable FXAA, Depth of Field, Bloom, Sobel edge detection, Afterimage trails, and ASCII rendering. Toggle each effect independently.",
  requiresWebGPU: true,
  createRenderer: (canvas) => new PostfxStackRenderer(canvas),
  getControls: (): TestControl[] => [
    { key: "fxaa", label: "FXAA (anti-aliasing)", type: "checkbox", value: fxaaEnabled, onChange: (v) => { fxaaEnabled = v as boolean; } },
    { key: "dof", label: "Depth of Field", type: "checkbox", value: dofEnabled, onChange: (v) => { dofEnabled = v as boolean; } },
    { key: "dofFocus", label: "DOF focus distance", type: "slider", min: 0, max: 1, step: 0.01, value: dofFocusDist, onChange: (v) => { dofFocusDist = v as number; } },
    { key: "dofRange", label: "DOF focus range", type: "slider", min: 0, max: 1, step: 0.01, value: dofFocusRange, onChange: (v) => { dofFocusRange = v as number; } },
    { key: "dofBlur", label: "DOF max blur", type: "slider", min: 1, max: 20, step: 0.5, value: dofMaxBlur, onChange: (v) => { dofMaxBlur = v as number; } },
    { key: "bloom", label: "Bloom", type: "checkbox", value: bloomEnabled, onChange: (v) => { bloomEnabled = v as boolean; } },
    { key: "bloomThresh", label: "Bloom threshold", type: "slider", min: 0, max: 2, step: 0.05, value: bloomThreshold, onChange: (v) => { bloomThreshold = v as number; } },
    { key: "bloomStr", label: "Bloom strength", type: "slider", min: 0, max: 3, step: 0.05, value: bloomStrength, onChange: (v) => { bloomStrength = v as number; } },
    { key: "sobel", label: "Sobel edge detection", type: "checkbox", value: sobelEnabled, onChange: (v) => { sobelEnabled = v as boolean; } },
    { key: "afterimage", label: "Afterimage trails", type: "checkbox", value: afterimageEnabled, onChange: (v) => { afterimageEnabled = v as boolean; } },
    { key: "afterimageDamp", label: "Afterimage damping", type: "slider", min: 0, max: 0.99, step: 0.01, value: afterimageDamp, onChange: (v) => { afterimageDamp = v as number; } },
    { key: "ascii", label: "ASCII rendering", type: "checkbox", value: asciiEnabled, onChange: (v) => { asciiEnabled = v as boolean; } },
    { key: "asciiCell", label: "ASCII cell size", type: "slider", min: 2, max: 32, step: 1, value: asciiCellSize, onChange: (v) => { asciiCellSize = v as number; } },
    { key: "asciiColor", label: "ASCII color", type: "checkbox", value: asciiUseColor, onChange: (v) => { asciiUseColor = v as boolean; } },
    { key: "rotationSpeed", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
