import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class PostProcessPass extends RenderPass {
  name = "post-process";

  prepare(_device: GPUDevice): void {}

  execute(_ctx: RenderPassContext): void {}
}
