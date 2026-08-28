import type { UIRenderer, UIRoot } from "@downdraft/library-imui";
import { LayoutEngine } from "@downdraft/library-imui";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

export class UICompositePass extends RenderPass {
  name = "ui-composite";
  surfaceHandle: TextureHandle | null = null;
  private renderer: UIRenderer | null = null;
  private root: UIRoot | null = null;
  private layoutEngine: LayoutEngine = new LayoutEngine();
  private needsLayout: boolean = true;

  setRenderer(renderer: UIRenderer): void {
    this.renderer = renderer;
    this.layoutEngine.setTextCache(renderer.getTextCache());
  }

  setRoot(root: UIRoot | null): void {
    this.root = root;
    this.needsLayout = true;
  }

  markLayoutDirty(): void {
    this.needsLayout = true;
  }

  prepare(device: GPUDevice): void {
    this.renderer?.prepare(device);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.surfaceHandle) builder.colorAttachment({ handle: this.surfaceHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.renderer || !this.root || !ctx.pass) return;

    if (this.needsLayout) {
      this.layoutEngine.layout(this.root);
      this.needsLayout = false;
    }

    const drawables = this.root.getDrawable();
    if (drawables.length === 0) return;

    this.renderer.render(ctx, drawables);
  }

  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
    this.root = null;
  }
}
