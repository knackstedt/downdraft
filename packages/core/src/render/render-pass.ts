import type { RenderBackend } from "./backend/render-backend.ts";
import type { FrameGraphBuilder, GraphRenderContext } from "./frame-graph.ts";
import { PassType } from "./frame-graph.ts";

export type { FrameGraphBuilder, GraphRenderContext, PassType } from "./frame-graph.ts";

/**
 * @deprecated Use GraphRenderContext instead. Kept for backward compatibility.
 */
export interface RenderPassContext {
  device: GPUDevice | null;
  backend: RenderBackend | null;
  pass: GPURenderPassEncoder | import("./tracked-render-pass.ts").ITrackedRenderPass;
}

export abstract class RenderPass {
  abstract name: string;
  passType: PassType = PassType.Render;
  abstract prepare(device: GPUDevice, backend?: RenderBackend | null): void;

  /** Declare resource reads/writes and attachments. Called during graph build. */
  setup(builder: FrameGraphBuilder): void {
    void builder;
  }

  /** Execute the pass. ctx.pass is a TrackedRenderPass for Render-type passes, null for Custom. */
  abstract execute(ctx: GraphRenderContext): void;

  destroy(): void {}
}
