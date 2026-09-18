// ============================================================================
// RenderPass — base class for all FrameGraph-driven render passes
// Passes declare resources in setup() and are executed by FrameGraph.
// ============================================================================

import type { FrameGraphBuilder, RenderContext } from "./frame-graph";
import { PassType } from "./frame-graph";

export type { FrameGraphBuilder, PassType, RenderContext } from "./frame-graph";

/**
 * @deprecated Use RenderContext instead. Kept for backward compatibility.
 */
export type { RenderContext as GraphRenderContext } from "./frame-graph";

export abstract class RenderPass {
  abstract name: string;
  passType: PassType = PassType.Render;
  abstract prepare(device: GPUDevice): void;

  /** Declare resource reads/writes and attachments. Called during graph build. */
  setup(builder: FrameGraphBuilder): void {
    void builder;
  }

  /** Execute the pass. ctx.pass is a TrackedRenderPass for Render-type passes, null for Custom. */
  abstract execute(ctx: RenderContext): void;

  destroy(): void {}
}
