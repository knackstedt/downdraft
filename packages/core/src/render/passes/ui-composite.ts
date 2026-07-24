import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class UICompositePass extends RenderPass {
  name = "ui-composite";

  prepare(_device: GPUDevice): void {}

  execute(_ctx: RenderPassContext): void {}
}
