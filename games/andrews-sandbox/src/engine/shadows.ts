// ============================================================================
// SandboxShadows — single-cascade sun shadow mapping for the sandbox.
//
// Wraps the engine's ShadowMapSystem (which owns the depth texture + bind group
// + light VP matrix) with a depth-only render pass that renders the sandbox's
// procedural geometry + model props from the sun's perspective.
//
// The shadow bind group is bound at @group(3) in the procedural shaders and at
// @group(2) in the model shader (shared with the frame-lighting bind group —
// the shadow UBO is appended to the lighting UBO). To keep the integration
// simple and avoid changing the model pipeline's group layout, we instead
// expose the shadow bind group via a separate binding slot the caller wires.
//
// For the sandbox we use a dedicated shadow bind group layout at group(3) for
// the procedural pipelines (which use auto-layout) and add shadow sampling to
// the procedural shaders. The model shader gets shadow sampling via a separate
// shadow bind group bound at group(2) alongside the lighting UBO — but since
// group(2) is already the frame-lighting layout, we instead fold the shadow
// map + sampler into the frame-lighting layout as additional bindings.
// ============================================================================

import { ShadowMapSystem } from "@downdraft/core";

export interface ShadowRenderContext {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  /** Render the scene depth-only into the given pass encoder. */
  renderDepth: (pass: GPURenderPassEncoder) => void;
}

export class SandboxShadows {
  private shadowSystem: ShadowMapSystem;
  private device: GPUDevice;
  private enabled = true;
  private shadowMapSize = 2048;

  constructor(device: GPUDevice) {
    this.device = device;
    this.shadowSystem = new ShadowMapSystem(device, {
      shadowMapSize: this.shadowMapSize,
      shadowDistance: 400,
      shadowRadius: 120,
    });
    this.shadowSystem.init();
  }

  getShadowSystem(): ShadowMapSystem { return this.shadowSystem; }
  getBindGroup(): GPUBindGroup | null { return this.shadowSystem.getBindGroup(); }
  getBindGroupLayout(): GPUBindGroupLayout | null { return this.shadowSystem.getBindGroupLayout(); }
  getLightVP(): Float32Array { return this.shadowSystem.getLightVP(); }
  getShadowMapSize(): number { return this.shadowMapSize; }
  isEnabled(): boolean { return this.enabled; }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Update the light VP matrix from the sun direction + camera target. */
  updateLightVP(sunDir: [number, number, number], cameraTarget: [number, number, number]): void {
    this.shadowSystem.updateLightVP(sunDir, cameraTarget);
  }

  /** Render the shadow map depth pass. Call before the main scene render. */
  renderShadowMap(ctx: ShadowRenderContext): void {
    if (!this.enabled) return;
    const depthView = this.shadowSystem.getShadowDepthView();
    if (!depthView) return;

    const pass = ctx.encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    ctx.renderDepth(pass);
    pass.end();
  }

  destroy(): void {
    this.shadowSystem.destroy();
  }
}
