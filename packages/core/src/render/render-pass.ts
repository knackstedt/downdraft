import type { TrackedRenderPass } from "./tracked-render-pass.ts";

export interface RenderPassContext {
  device: GPUDevice;
  pass: GPURenderPassEncoder | TrackedRenderPass;
}

export abstract class RenderPass {
  abstract name: string;
  abstract prepare(device: GPUDevice): void;
  abstract execute(ctx: RenderPassContext): void;
}
