import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class TransparentPass extends RenderPass {
  name = "transparent";

  prepare(_device: GPUDevice): void {}

  execute(_ctx: RenderPassContext): void {}
}
