import { RenderPass, type RenderPassContext } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import type { DebugDrawQueue } from "../../debug-draw/queue.ts";

export class DebugRenderPass extends RenderPass {
  name = "debug";
  private debugQueue: DebugDrawQueue | null = null;

  setDebugQueue(queue: DebugDrawQueue): void {
    this.debugQueue = queue;
  }

  prepare(_device: GPUDevice): void {}

  execute(ctx: RenderPassContext): void {
    if (!this.debugQueue || this.debugQueue.isEmpty()) return;
    // TODO: Upload line vertices + render as LINE_LIST
    // For now, debug draw is a no-op in the render pipeline
  }
}
