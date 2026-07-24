import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class ShadowPass extends RenderPass {
  name = "shadow";

  prepare(_device: GPUDevice): void {}

  execute(_ctx: RenderPassContext): void {}
}
