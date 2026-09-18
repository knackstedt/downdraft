import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../../frame-graph";
import { PassType } from "../../frame-graph";
import { RenderPass } from "../../render-pass";
import { HzbBuilder } from "../hzb";

export class HzbBuildPass extends RenderPass {
  name = "hzb-build";
  passType = PassType.Custom;

  private device: GPUDevice | null = null;
  private hzbBuilder: HzbBuilder | null = null;
  private depthHandle: TextureHandle | null = null;

  setDepthHandle(handle: TextureHandle | null): void {
    this.depthHandle = handle;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.hzbBuilder = new HzbBuilder(device);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) {
      builder.read(this.depthHandle);
    }
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.hzbBuilder || !this.depthHandle || !this.device) return;
    const depthTexture = ctx.getTexture(this.depthHandle);
    if (!depthTexture) return;

    const w = ctx.width;
    const h = ctx.height;
    this.hzbBuilder.ensureSize(w, h);

    const encoder = this.device.createCommandEncoder({ label: "hzb-build-encoder" });
    this.hzbBuilder.build(encoder, depthTexture.createView(), w, h);
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.hzbBuilder?.destroy();
    this.hzbBuilder = null;
  }
}
