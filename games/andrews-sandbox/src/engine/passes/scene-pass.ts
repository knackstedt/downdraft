// ============================================================================
// SceneRenderPass — FrameGraph wrapper around the sandbox's scene draw.
//
// Mirrors games/to-the-ocean's SceneRenderPass: declares the imported
// color/depth texture views as attachments and delegates the actual draw
// (sky → ground → builtin props → model props) to a caller-supplied
// drawFn so the renderer keeps its scene logic in one place.
// ============================================================================

import { PassType, RenderPass, type FrameGraphBuilder, type RenderContext, type TextureHandle } from "@downdraft/core";

export interface ScenePassState {
  viewportIdx: number;
  /** Full-canvas viewport rect (the sandbox is single-viewport). */
  viewport: { x: number; y: number; w: number; h: number };
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
    near: number;
    far: number;
    aspect: number;
  };
  viewProj: Float32Array;
  loadOp: GPULoadOp;
  clearValue: GPUColor;
}

export type SceneDrawFn = (
  passEncoder: GPURenderPassEncoder,
  state: ScenePassState,
  encoder: GPUCommandEncoder,
) => void;

export class SceneRenderPass extends RenderPass {
  name = "Scene";
  passType = PassType.Render;

  private colorHandle: TextureHandle;
  private depthHandle: TextureHandle;
  private loadOp: GPULoadOp;
  private clearValue: GPUColor;
  private state: ScenePassState;
  private drawFn: SceneDrawFn;

  constructor(
    colorHandle: TextureHandle,
    depthHandle: TextureHandle,
    state: ScenePassState,
    drawFn: SceneDrawFn,
  ) {
    super();
    this.colorHandle = colorHandle;
    this.depthHandle = depthHandle;
    this.loadOp = state.loadOp;
    this.clearValue = state.clearValue;
    this.state = state;
    this.drawFn = drawFn;
  }

  setup(builder: FrameGraphBuilder): void {
    builder.colorAttachment({
      handle: this.colorHandle,
      loadOp: this.loadOp,
      storeOp: "store",
      clearValue: this.clearValue,
    });
    builder.depthAttachment({
      handle: this.depthHandle,
      depthLoadOp: this.loadOp,
      depthStoreOp: "store",
      depthClearValue: 1.0,
    });
  }

  prepare(): void {}

  execute(ctx: RenderContext): void {
    if (!ctx.pass) return;
    const raw = ctx.pass.getRawPass() as GPURenderPassEncoder;
    const vp = this.state.viewport;
    raw.setViewport(vp.x, vp.y, vp.w, vp.h, 0, 1);
    raw.setScissorRect(vp.x, vp.y, vp.w, vp.h);
    this.drawFn(raw, this.state, ctx.encoder);
  }
}
