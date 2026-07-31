import type { UIRoot } from "../../ui/element.ts";
import { LayoutEngine } from "../../ui/layout.ts";
import type { UIRenderer } from "../../ui/renderer.ts";
import { RenderPass, type RenderPassContext } from "../render-pass.ts";

export class UICompositePass extends RenderPass {
  name = "ui-composite";
  private renderer: UIRenderer | null = null;
  private root: UIRoot | null = null;
  private layoutEngine: LayoutEngine = new LayoutEngine();
  private needsLayout: boolean = true;

  setRenderer(renderer: UIRenderer): void {
    this.renderer = renderer;
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

  execute(ctx: RenderPassContext): void {
    if (!this.renderer || !this.root) return;

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
