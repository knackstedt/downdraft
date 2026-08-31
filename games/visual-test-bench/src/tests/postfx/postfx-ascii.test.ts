// ============================================================================
// PostFX Test — ASCII Rendering
//
// Uses @downdraft/library-postfx's AsciiSystem — a standalone post-process
// that renders the scene as ASCII characters. Renders a rotating 3D cube grid
// into the system's offscreen color texture, then applies the ASCII effect.
// Toggle color mode (green terminal vs. colored) and adjust cell size.
// ============================================================================

import { AsciiSystem } from "@downdraft/library-postfx";
import { registerTest, type ITestRenderer, type TestContext, type TestControl } from "../../test-registry";
import { CubeRenderer, type CameraConfig } from "../helpers/cube-renderer";

// ── Test controls state ──

let asciiEnabled = true;
let cellSize = 8;
let useColor = false;
let rotationSpeed = 0.5;

function buildCubeGrid(): { position: [number, number, number]; color: [number, number, number]; size: number }[] {
  const cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[] = [];
  const colors: [number, number, number][] = [
    [1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.5, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1],
  ];
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const colorIdx = (x + z) % colors.length;
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

class PostfxAsciiRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private asciiSystem: AsciiSystem;
  private depthTexture: GPUTexture | null = null;
  private cubes: { position: [number, number, number]; color: [number, number, number]; size: number }[];
  private rotationAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as CubeRenderer;
    this.asciiSystem = null as unknown as AsciiSystem;
    this.cubes = buildCubeGrid();
  }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new CubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.asciiSystem = new AsciiSystem(this.device, this.format);
    this.asciiSystem.init();
    this.asciiSystem.setEnabled(asciiEnabled);
    this.asciiSystem.setCellSize(cellSize);
    this.asciiSystem.setUseColor(useColor);
  }

  render(ctx: TestContext): void {
    this.rotationAngle += ctx.dt * rotationSpeed;

    // Sync control state.
    this.asciiSystem.setEnabled(asciiEnabled);
    this.asciiSystem.setCellSize(cellSize);
    this.asciiSystem.setUseColor(useColor);

    // Ensure offscreen targets.
    this.asciiSystem.ensureTargets(ctx.width, ctx.height);

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
      target: [0, 2, 0],
      up: [0, 1, 0],
      fov: Math.PI / 4,
      near: 0.1,
      far: 200,
      aspect: ctx.width / ctx.height,
    };

    // Phase 1: Render scene into ASCII system's offscreen color texture.
    const sceneEncoder = this.device.createCommandEncoder();
    const scenePass = sceneEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.asciiSystem.getSceneColorView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    this.cubeRenderer.drawCubes(scenePass, this.cubes, camera);
    scenePass.end();
    this.device.queue.submit([sceneEncoder.finish()]);

    // Phase 2: Apply ASCII effect (or blit if disabled) → canvas.
    const postEncoder = this.device.createCommandEncoder();
    const canvasView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();
    this.asciiSystem.apply(postEncoder, canvasView, ctx.width, ctx.height);
    this.device.queue.submit([postEncoder.finish()]);
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.asciiSystem?.destroy();
    this.depthTexture = null;
  }
}

registerTest({
  id: "postfx-ascii",
  name: "PostFX: ASCII",
  category: "PostFX",
  description: "Standalone ASCII rendering from @downdraft/library-postfx. Renders a 3D cube grid as ASCII characters using a 10-glyph atlas (\" .:-=+*#%@\"). Toggle color mode (green terminal vs. colored) and adjust cell size.",
  requiresWebGPU: true,
  createRenderer: (canvas) => new PostfxAsciiRenderer(canvas),
  getControls: (): TestControl[] => [
    { key: "enabled", label: "ASCII enabled", type: "checkbox", value: asciiEnabled, onChange: (v) => { asciiEnabled = v as boolean; } },
    { key: "cellSize", label: "Cell size (px)", type: "slider", min: 2, max: 32, step: 1, value: cellSize, onChange: (v) => { cellSize = v as number; } },
    { key: "useColor", label: "Use color (vs. green)", type: "checkbox", value: useColor, onChange: (v) => { useColor = v as boolean; } },
    { key: "rotationSpeed", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
