import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class DepthPrepass extends RenderPass {
  name = "depth-prepass";

  prepare(_device: GPUDevice): void {}

  execute(_ctx: RenderPassContext): void {}
}
