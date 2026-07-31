import type { FrameGraphBuilder, GraphRenderContext } from "./frame-graph.ts";
import { PassType } from "./frame-graph.ts";

export type { FrameGraphBuilder, GraphRenderContext, PassType } from "./frame-graph.ts";

/**
 * @deprecated Use GraphRenderContext instead. Kept for backward compatibility.
 */
export interface RenderPassContext {
  device: GPUDevice;
  pass: GPURenderPassEncoder | import("./tracked-render-pass.ts").TrackedRenderPass;
}

export abstract class RenderPass {
  abstract name: string;
  passType: PassType = PassType.Render;
  abstract prepare(device: GPUDevice): void;

  /** Declare resource reads/writes and attachments. Called during graph build. */
  setup(builder: FrameGraphBuilder): void {
    void builder;
  }

  /** Execute the pass. ctx.pass is a TrackedRenderPass for Render-type passes, null for Custom. */
  abstract execute(ctx: GraphRenderContext): void;

  destroy(): void {}
}
